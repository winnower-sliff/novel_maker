import type {
  Book,
  CardKind,
  Chapter,
  Character,
  CharacterState,
  ForeshadowStatus,
  ToolDef
} from '../../shared/types.js'
import { snapshotDb } from '../db.js'
import { buildWriteContext } from '../director/context.js'
import * as store from '../store.js'

/**
 * M6 agent 工具集：绑定 store 的全 CRUD（用户拍板「全都给，crud权限都给」）。
 * 普通工具（读/写/删/线操作）在这里；流式拦截工具（write_chapter_draft/commit_chapter/finish）
 * 在 loop.ts——它们要广播与落消息，不走纯函数协议。
 * 每个工具返回 {ok, summary, data}：summary 喂作者的工具卡，data 喂 LLM。
 */

export interface ToolCtx {
  bookId: string
}

export interface ToolResult {
  ok: boolean
  /** 给作者看的一句话摘要（工具卡标题） */
  summary: string
  /** 给 LLM 看的详细结果 */
  data: string
}

function ctxBook(ctx: ToolCtx): Book {
  const book = store.getBook(ctx.bookId)
  if (!book) throw new Error('书不存在')
  return book
}

/** 当前激活线（agent 切线后以库内激活线为准） */
function ctxLine(ctx: ToolCtx): { book: Book; lineId: string } {
  const book = ctxBook(ctx)
  const line = store.activeLine(book)
  if (!line) throw new Error('当前书没有激活线')
  return { book, lineId: line.id }
}

const N = '\n'

// ── 工具定义（input_schema 精简，描述里带使用纪律） ──────────────────────────

export function toolDefs(): ToolDef[] {
  return [
    {
      name: 'get_book_config',
      description: '读本书全部配置：简介/文风/目标字数/剧情红线/正向词/负向词。改配置前先读。',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'list_chapters',
      description:
        '列当前线的完整章节序列（含分叉前祖先线的章），返回序号/标题/字数/每章摘要。掌握进度用。',
      input_schema: {
        type: 'object',
        properties: { q: { type: 'string', description: '可选，按标题/摘要过滤' } }
      }
    },
    {
      name: 'read_chapter',
      description: '读一章正文。默认截断到前 6000 字；需要全文传 full:true。',
      input_schema: {
        type: 'object',
        properties: {
          chapterId: { type: 'string', description: '章节 id（来自 list_chapters）' },
          full: { type: 'boolean', description: 'true=不截断全文' }
        },
        required: ['chapterId']
      }
    },
    {
      name: 'list_cards',
      description: '列当前线设定卡（世界观/势力/物品等），支持按类型与关键词过滤。',
      input_schema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['geography', 'faction', 'history', 'power', 'item', 'custom'],
            description: '卡类型'
          },
          q: { type: 'string', description: '标题/正文关键词' }
        }
      }
    },
    {
      name: 'get_card',
      description: '读一张设定卡详情（读者已知层/作者真相层/揭示计划/钉选）。',
      input_schema: {
        type: 'object',
        properties: { cardId: { type: 'string' } },
        required: ['cardId']
      }
    },
    {
      name: 'list_characters',
      description: '列当前线全部人物：人设卡+活状态（位置/身心/目标/所知）+关系。',
      input_schema: {
        type: 'object',
        properties: { q: { type: 'string', description: '名字/人设关键词' } }
      }
    },
    {
      name: 'list_foreshadows',
      description: '列当前线伏笔台账（埋设中/已计划/已回收）。',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'planned', 'resolved'] }
        }
      }
    },
    {
      name: 'get_write_context',
      description:
        '取写作上下文装配（钉选设定+未闭合伏笔+人物现状+最近5章细记+上一章结尾+远端压缩记忆）。动笔前必读。',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'search_project',
      description: '跨板块关键词搜索：设定卡/人物/伏笔一次全查。',
      input_schema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q']
      }
    },
    {
      name: 'save_card',
      description:
        '建/改设定卡（传 id=改，不传=建）。写作中沉淀新设定、维护旧设定都用它。可选字段不传保留原值。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '改卡时传' },
          kind: {
            type: 'string',
            enum: ['geography', 'faction', 'history', 'power', 'item', 'custom']
          },
          title: { type: 'string' },
          readerText: { type: 'string', description: '读者已知层：读者此刻能看到的设定' },
          authorText: { type: 'string', description: '作者真相层：只有你知道的底细' },
          revealPlan: { type: 'string', description: '计划在哪一章/how 揭示真相层' },
          pinned: { type: 'boolean', description: 'true=钉选（每章上下文必带）' }
        },
        required: ['title']
      }
    },
    {
      name: 'save_character',
      description: '建/改人物（传 id=改，不传=建）。人设卡/初始状态/关系网。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '改人物时传' },
          name: { type: 'string' },
          role: { type: 'string', description: '一句话定位（主角/对手/导师…）' },
          card: { type: 'object', description: '自由结构人设卡' },
          state: {
            type: 'object',
            description: '活状态：{location?,body?,mood?,items?,knows?,goal?}',
            properties: {
              location: { type: 'string' },
              body: { type: 'string', description: '身体状态（伤病等）' },
              mood: { type: 'string' },
              items: { type: 'string', description: '随身关键物品' },
              knows: { type: 'string', description: '已知关键信息' },
              goal: { type: 'string', description: '当下目标' }
            }
          },
          relations: {
            type: 'array',
            description: '关系网 [{to:"另一人物名",label:"关系"}]',
            items: {
              type: 'object',
              properties: { to: { type: 'string' }, label: { type: 'string' } },
              required: ['to', 'label']
            }
          },
          pinned: { type: 'boolean', description: 'true=钉选（每章上下文必带）' }
        },
        required: ['name']
      }
    },
    {
      name: 'patch_character_state',
      description:
        '更新人物活状态（章后必做）：只传要改的字段，其余保留。如位置变化/受伤/心态转变/获得物品/获知信息。',
      input_schema: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: '优先用 list_characters 返回的 id' },
          name: { type: 'string', description: '人物名兜底（没有 id 时按名匹配当前线）' },
          patch: {
            type: 'object',
            properties: {
              location: { type: 'string' },
              body: { type: 'string' },
              mood: { type: 'string' },
              items: { type: 'string' },
              knows: { type: 'string' },
              goal: { type: 'string' }
            }
          }
        },
        required: ['patch']
      }
    },
    {
      name: 'save_foreshadow',
      description:
        '建/改伏笔（传 id=改）。埋设 planted→计划回收 planned→已回收 resolved 三态流转；priority 越大越优先。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '改伏笔时传' },
          title: { type: 'string' },
          detail: { type: 'string', description: '伏笔内容与回收思路' },
          plannedChapterId: { type: 'string', description: '计划在哪章回收' },
          resolvedChapterId: { type: 'string', description: '实际在哪章回收' },
          status: { type: 'string', enum: ['open', 'planned', 'resolved'] },
          priority: { type: 'number' }
        },
        required: ['title']
      }
    },
    {
      name: 'update_book_config',
      description:
        '改书配置：标题/简介/文风/目标字数/剧情红线/正向词/负向词。正负词与红线是写作硬约束，作者提出增删时用。可选字段不传保留原值。',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          intro: { type: 'string' },
          styleName: { type: 'string' },
          styleNotes: { type: 'string' },
          styleSample: { type: 'string', description: '文风参考样本' },
          targetWords: { type: 'number' },
          redlines: { type: 'array', items: { type: 'string' } },
          positiveWords: { type: 'array', items: { type: 'string' } },
          negativeWords: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    {
      name: 'fork_line',
      description:
        '从某章之后开剧情新线并切入（分叉树）。设定整体拷贝到新线各自演化。大转折实验/换走法时用。',
      input_schema: {
        type: 'object',
        properties: {
          forkChapterId: { type: 'string', description: '从哪章之后分叉' },
          name: { type: 'string', description: '线名（如「复仇线」），不传我自动起' }
        },
        required: ['forkChapterId']
      }
    },
    {
      name: 'switch_line',
      description: '切换激活线（写作永远发生在激活线尾部）。',
      input_schema: {
        type: 'object',
        properties: { lineId: { type: 'string' } },
        required: ['lineId']
      }
    },
    {
      name: 'delete_card',
      description: '删除设定卡（删除前自动做数据库快照兜底）。',
      input_schema: {
        type: 'object',
        properties: { cardId: { type: 'string' } },
        required: ['cardId']
      }
    },
    {
      name: 'delete_character',
      description: '删除人物（删除前自动做数据库快照兜底）。',
      input_schema: {
        type: 'object',
        properties: { characterId: { type: 'string' } },
        required: ['characterId']
      }
    },
    {
      name: 'delete_foreshadow',
      description: '删除伏笔（删除前自动做数据库快照兜底）。',
      input_schema: {
        type: 'object',
        properties: { foreshadowId: { type: 'string' } },
        required: ['foreshadowId']
      }
    },
    {
      name: 'delete_last_chapter',
      description:
        '删除当前线最后一章（写作回退用：刚入书的章不满意可撤回重写；只允许删末章）。删除前自动做数据库快照兜底。',
      input_schema: { type: 'object', properties: {} }
    }
  ]
}

// ── 执行器 ───────────────────────────────────────────────────────────────────

function brief(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function chapterLine(c: Chapter, i: number): string {
  const sum = c.summary ? ` —— ${brief(c.summary, 60)}` : ''
  return `${i + 1}. 《${c.title}》(${c.wordCount}字, id=${c.id})${sum}`
}

export function execTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): ToolResult {
  switch (name) {
    case 'get_book_config': {
      const b = ctxBook(ctx)
      return {
        ok: true,
        summary: `读取《${b.title}》配置`,
        data: `${JSON.stringify(
          {
            title: b.title,
            intro: b.intro,
            genre: b.genre,
            styleName: b.styleName,
            styleNotes: b.styleNotes,
            targetWords: b.targetWords,
            redlines: b.redlines,
            positiveWords: b.positiveWords,
            negativeWords: b.negativeWords,
            activeLineId: b.activeLineId
          },
          null,
          1
        )}`
      }
    }
    case 'list_chapters': {
      const { lineId } = ctxLine(ctx)
      const q = typeof input.q === 'string' ? input.q : ''
      const chapters = store.effectiveChapters(lineId)
      const rows = chapters
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => !q || c.title.includes(q) || c.summary.includes(q))
        .map(({ c, i }) => chapterLine(c, i))
      return {
        ok: true,
        summary: `查章节序列（共 ${chapters.length} 章）`,
        data: rows.length ? rows.join(N) : '（当前线还没有章节）'
      }
    }
    case 'read_chapter': {
      const id = String(input.chapterId ?? '')
      const c = store.getChapter(id)
      if (!c) return { ok: false, summary: '章节不存在', data: `章节 ${id} 不存在` }
      const full = input.full === true
      const body =
        full || c.content.length <= 6000
          ? c.content
          : `${c.content.slice(0, 6000)}\n…（截断，需要全文传 full:true）`
      return {
        ok: true,
        summary: `读《${c.title}》`,
        data: `《${c.title}》（${c.wordCount}字）${N}${body}`
      }
    }
    case 'list_cards': {
      const { lineId } = ctxLine(ctx)
      const kind = typeof input.kind === 'string' ? (input.kind as CardKind) : undefined
      const q = typeof input.q === 'string' ? input.q : undefined
      const cards = store.listCards(lineId, { kind, q })
      const rows = cards.map(
        (c) =>
          `【${c.kind}${c.pinned ? '·钉' : ''}】${c.title} (id=${c.id})：${brief(c.readerText, 100)}`
      )
      return {
        ok: true,
        summary: `查设定卡 ${cards.length} 张`,
        data: rows.length ? rows.join(N) : '（没有匹配的设定卡）'
      }
    }
    case 'get_card': {
      const c = store.getCard(String(input.cardId ?? ''))
      if (!c) return { ok: false, summary: '设定卡不存在', data: '设定卡不存在' }
      return {
        ok: true,
        summary: `读设定卡「${c.title}」`,
        data: `【${c.kind}】${c.title}${c.pinned ? '（钉选）' : ''}${N}读者已知：${c.readerText}${N}作者真相：${c.authorText || '（无）'}${N}揭示计划：${c.revealPlan || '（无）'}`
      }
    }
    case 'list_characters': {
      const { lineId } = ctxLine(ctx)
      const q = typeof input.q === 'string' ? input.q : undefined
      const chars = store.listCharacters(lineId, { q })
      const rows = chars.map((c) => {
        const st = Object.entries(c.state)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
        const rel = c.relations.map((r) => `${r.to}(${r.label})`).join(' ')
        return `【${c.role || '人物'}${c.pinned ? '·钉' : ''}】${c.name} (id=${c.id})：${st}${rel ? ` 关系：${rel}` : ''}`
      })
      return {
        ok: true,
        summary: `查人物 ${chars.length} 人`,
        data: rows.length ? rows.join(N) : '（没有匹配的人物）'
      }
    }
    case 'list_foreshadows': {
      const { lineId } = ctxLine(ctx)
      const status =
        input.status === 'open' || input.status === 'planned' || input.status === 'resolved'
          ? (input.status as ForeshadowStatus)
          : undefined
      const list = store.listForeshadows(lineId, status)
      const rows = list.map(
        (f) => `[${f.status}] ${f.title} (id=${f.id}, 优先级${f.priority})：${brief(f.detail, 80)}`
      )
      return {
        ok: true,
        summary: `查伏笔 ${list.length} 条`,
        data: rows.length ? rows.join(N) : '（没有匹配的伏笔）'
      }
    }
    case 'get_write_context': {
      const { book, lineId } = ctxLine(ctx)
      // 动态 import 避免与 jobs.ts 循环依赖
      return {
        ok: true,
        summary: '取写作上下文',
        data: writeContextOf(book, lineId)
      }
    }
    case 'search_project': {
      const { lineId } = ctxLine(ctx)
      const q = String(input.q ?? '')
      if (!q) return { ok: false, summary: '搜索词为空', data: 'q 不能为空' }
      const cards = store.listCards(lineId, { q })
      const chars = store.listCharacters(lineId, { q })
      const fores = store
        .listForeshadows(lineId)
        .filter((f) => f.title.includes(q) || f.detail.includes(q))
      const rows = [
        ...cards.map((c) => `[设定卡] ${c.title} (id=${c.id})`),
        ...chars.map((c) => `[人物] ${c.name} (id=${c.id})`),
        ...fores.map((f) => `[伏笔] ${f.title} (id=${f.id})`)
      ]
      return {
        ok: true,
        summary: `搜「${q}」命中 ${rows.length} 条`,
        data: rows.length ? rows.join(N) : `没有找到与「${q}」相关的内容`
      }
    }
    case 'save_card': {
      const { lineId } = ctxLine(ctx)
      const card = store.saveCard({
        id: typeof input.id === 'string' && input.id ? input.id : undefined,
        lineId,
        kind: typeof input.kind === 'string' ? (input.kind as CardKind) : undefined,
        title: String(input.title ?? ''),
        readerText: typeof input.readerText === 'string' ? input.readerText : undefined,
        authorText: typeof input.authorText === 'string' ? input.authorText : undefined,
        revealPlan: typeof input.revealPlan === 'string' ? input.revealPlan : undefined,
        pinned: typeof input.pinned === 'boolean' ? input.pinned : undefined
      })
      if (!card)
        return { ok: false, summary: '保存设定卡失败', data: '保存失败：卡不存在或参数无效' }
      return {
        ok: true,
        summary: `${input.id ? '改' : '建'}设定卡「${card.title}」${card.pinned ? '（钉选）' : ''}`,
        data: `已保存【${card.kind}】${card.title} (id=${card.id})`
      }
    }
    case 'save_character': {
      const { lineId } = ctxLine(ctx)
      const ch = store.saveCharacter({
        id: typeof input.id === 'string' && input.id ? input.id : undefined,
        lineId,
        name: String(input.name ?? ''),
        role: typeof input.role === 'string' ? input.role : undefined,
        card: (input.card as Record<string, unknown>) ?? undefined,
        state: (input.state as CharacterState) ?? undefined,
        relations: (input.relations as Character['relations']) ?? undefined,
        pinned: typeof input.pinned === 'boolean' ? input.pinned : undefined
      })
      if (!ch) return { ok: false, summary: '保存人物失败', data: '保存失败：人物不存在或参数无效' }
      return {
        ok: true,
        summary: `${input.id ? '改' : '建'}人物「${ch.name}」`,
        data: `已保存 ${ch.name}（${ch.role || '人物'}）(id=${ch.id})`
      }
    }
    case 'patch_character_state': {
      const { lineId } = ctxLine(ctx)
      const patch = (input.patch as CharacterState) ?? {}
      let target = null
      const id = typeof input.characterId === 'string' ? input.characterId : ''
      if (id) target = store.getCharacter(id)
      if (!target && typeof input.name === 'string' && input.name) {
        target = store.listCharacters(lineId).find((c) => c.name === input.name) ?? null
      }
      if (!target || target.lineId !== lineId) {
        return {
          ok: false,
          summary: '人物不存在',
          data: `人物 ${id || String(input.name ?? '')} 不存在（或不在当前线）`
        }
      }
      store.patchCharacterStates([{ id: target.id, patch }])
      const after = store.getCharacter(target.id)
      return {
        ok: true,
        summary: `更新「${target.name}」状态`,
        data: `已更新 ${target.name} 活状态：${JSON.stringify(after?.state ?? {})}`
      }
    }
    case 'save_foreshadow': {
      const { lineId } = ctxLine(ctx)
      const f = store.saveForeshadow({
        id: typeof input.id === 'string' && input.id ? input.id : undefined,
        lineId,
        title: String(input.title ?? ''),
        detail: typeof input.detail === 'string' ? input.detail : undefined,
        plannedChapterId:
          typeof input.plannedChapterId === 'string' ? input.plannedChapterId : undefined,
        resolvedChapterId:
          typeof input.resolvedChapterId === 'string' ? input.resolvedChapterId : undefined,
        status:
          input.status === 'open' || input.status === 'planned' || input.status === 'resolved'
            ? (input.status as ForeshadowStatus)
            : undefined,
        priority: typeof input.priority === 'number' ? input.priority : undefined
      })
      if (!f) return { ok: false, summary: '保存伏笔失败', data: '保存失败：伏笔不存在或参数无效' }
      return {
        ok: true,
        summary: `${input.id ? '改' : '埋'}伏笔「${f.title}」（${f.status}）`,
        data: `已保存伏笔 [${f.status}] ${f.title} (id=${f.id})`
      }
    }
    case 'update_book_config': {
      const b = store.updateBook(ctx.bookId, {
        title: typeof input.title === 'string' ? input.title : undefined,
        intro: typeof input.intro === 'string' ? input.intro : undefined,
        styleName: typeof input.styleName === 'string' ? input.styleName : undefined,
        styleNotes: typeof input.styleNotes === 'string' ? input.styleNotes : undefined,
        styleSample: typeof input.styleSample === 'string' ? input.styleSample : undefined,
        targetWords: typeof input.targetWords === 'number' ? input.targetWords : undefined,
        redlines: Array.isArray(input.redlines) ? (input.redlines as string[]) : undefined,
        positiveWords: Array.isArray(input.positiveWords)
          ? (input.positiveWords as string[])
          : undefined,
        negativeWords: Array.isArray(input.negativeWords)
          ? (input.negativeWords as string[])
          : undefined
      })
      if (!b) return { ok: false, summary: '改配置失败', data: '更新书配置失败' }
      return {
        ok: true,
        summary: `改书配置`,
        data: `配置已更新：红线 ${b.redlines.length} 条 / 正向词 ${b.positiveWords.length} / 负向词 ${b.negativeWords.length} / 目标 ${b.targetWords} 字`
      }
    }
    case 'fork_line': {
      const b = ctxBook(ctx)
      const line = store.forkLine(
        ctx.bookId,
        String(input.forkChapterId ?? ''),
        typeof input.name === 'string' && input.name ? input.name : `新线${Date.now() % 1000}`,
        'agent 开线'
      )
      if (!line) return { ok: false, summary: '开线失败', data: '开新线失败：分叉章不存在' }
      return {
        ok: true,
        summary: `开新线「${line.name}」并切入`,
        data: `已从分叉点开出新线「${line.name}」(id=${line.id}) 并设为激活线，设定已整体拷贝，此后各线独立演化。当前书：${b.title}`
      }
    }
    case 'switch_line': {
      const ok = store.activateLine(ctx.bookId, String(input.lineId ?? ''))
      if (!ok) return { ok: false, summary: '切线失败', data: '切换激活线失败：线不存在' }
      const b = ctxBook(ctx)
      const line = store.activeLine(b)
      return {
        ok: true,
        summary: `切到「${line?.name ?? '?'}」`,
        data: `激活线已切换为「${line?.name}」(id=${line?.id})`
      }
    }
    case 'delete_card': {
      const id = String(input.cardId ?? '')
      const c = store.getCard(id)
      if (!c) return { ok: false, summary: '设定卡不存在', data: '设定卡不存在' }
      snapshotDb(`del-card`)
      store.deleteCard(id)
      return {
        ok: true,
        summary: `删设定卡「${c.title}」`,
        data: `已删除设定卡「${c.title}」（已自动快照）`
      }
    }
    case 'delete_character': {
      const id = String(input.characterId ?? '')
      const c = store.getCharacter(id)
      if (!c) return { ok: false, summary: '人物不存在', data: '人物不存在' }
      snapshotDb(`del-char`)
      store.deleteCharacter(id)
      return {
        ok: true,
        summary: `删人物「${c.name}」`,
        data: `已删除人物「${c.name}」（已自动快照）`
      }
    }
    case 'delete_foreshadow': {
      const id = String(input.foreshadowId ?? '')
      const f = store.getForeshadow(id)
      if (!f) return { ok: false, summary: '伏笔不存在', data: '伏笔不存在' }
      snapshotDb(`del-fore`)
      store.deleteForeshadow(id)
      return {
        ok: true,
        summary: `删伏笔「${f.title}」`,
        data: `已删除伏笔「${f.title}」（已自动快照）`
      }
    }
    case 'delete_last_chapter': {
      const { lineId } = ctxLine(ctx)
      const chapters = store.effectiveChapters(lineId)
      const last = store.listChapters(lineId).pop()
      if (!last) return { ok: false, summary: '没有可删的章', data: '当前线没有章节' }
      if (last.id !== chapters[chapters.length - 1]?.id) {
        return {
          ok: false,
          summary: '只能删本线末章',
          data: `末章《${last.title}》不是当前故事序列的最后一章（分叉线上有后续章节），不能删`
        }
      }
      snapshotDb(`del-chapter`)
      const removed = store.deleteLastChapter(lineId)
      if (!removed) return { ok: false, summary: '删除失败', data: '删除失败' }
      return {
        ok: true,
        summary: `撤回《${removed.title}》`,
        data: `已删除末章《${removed.title}》（已自动快照），可重新写这一章`
      }
    }
    default:
      return { ok: false, summary: `未知工具 ${name}`, data: `没有名为 ${name} 的工具` }
  }
}

function writeContextOf(book: Book, lineId: string): string {
  return `${book.title} 当前线写作上下文：${N}${buildWriteContext(book, lineId)}`
}
