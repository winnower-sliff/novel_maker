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
import { chapterNoOfLabel } from '../sampleParse.js'
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
        '列当前线的完整章节序列（含分叉前祖先线的章），返回序号/标题/字数/每章摘要。掌握进度用。brief=true 只列序号+标题+字数（大书盘点省字数）。',
      input_schema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '可选，按标题/摘要过滤' },
          brief: { type: 'boolean', description: 'true=只列序号+标题+字数，不带摘要' }
        }
      }
    },
    {
      name: 'read_chapter',
      description:
        '读一章正文。默认从头截 6000 字；q=关键词定位读（跳到命中处读前后文，找原句/查接缝用）；from=从第几字起读；需要全文传 full:true。',
      input_schema: {
        type: 'object',
        properties: {
          chapterId: { type: 'string', description: '章节 id（来自 list_chapters）' },
          q: { type: 'string', description: '关键词定位：跳到该词首次出现处读前后文' },
          from: { type: 'number', description: '从第几字起读（0 起）' },
          full: { type: 'boolean', description: 'true=不截断全文' }
        },
        required: ['chapterId']
      }
    },
    {
      name: 'list_cards',
      description:
        '按类别筛选查看当前线设定卡：kind=类别；brief=true 只列标题清单（省字数，适合盘点），false/不传带 100 字摘要。',
      input_schema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description:
              '内置类别 slug：geography 地理/faction 势力/history 历史/power 力量体系/item 物品/custom 其他；也可用自定义类别名'
          },
          q: { type: 'string', description: '标题/正文关键词' },
          brief: { type: 'boolean', description: 'true=只列【类别】标题+id，不带正文摘要' }
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
      name: 'list_card_kinds',
      description:
        '列当前线设定卡类别清单+各类卡数（类别由卡派生：无卡的类别自动消失；新建类别=用新类别名存卡）。',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'rename_card_kind',
      description:
        '整类重命名/合并：oldKind 全部卡迁移到 newKind（如把自定义类别改成规范 slug、或两个类别合并）。迁移后旧类别无卡自动消失。',
      input_schema: {
        type: 'object',
        properties: {
          oldKind: { type: 'string', description: '现有类别名' },
          newKind: { type: 'string', description: '目标类别名' }
        },
        required: ['oldKind', 'newKind']
      }
    },
    {
      name: 'list_characters',
      description:
        '列当前线全部人物：人设卡+活状态（位置/身心/目标/所知）+关系。brief=true 只列【定位】名字+id（人物多时盘点省字数），详情用 get_character。',
      input_schema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '名字/人设关键词' },
          brief: { type: 'boolean', description: 'true=只列【定位】名字+id，不带状态' }
        }
      }
    },
    {
      name: 'get_character',
      description:
        '读单个人物完整详情：人设卡 card 全文+活状态+关系网。人设卡内容多时用它精读（比 list_characters 全量省）。',
      input_schema: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: '优先用 list_characters 返回的 id' },
          name: { type: 'string', description: '人物名兜底（没有 id 时按名匹配当前线）' }
        }
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
      name: 'list_samples',
      description: '列范文库（作者导入的完整参考书）。绑定本书的范文标 ★。',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'read_sample',
      description:
        '节选阅读范文（像翻参考书），四种读法：⓪toc 看目录（列出全部卷名/章节名+字数，不知道要读的位置时先看它）①chapter 章号直达（读第 5 章原文）②query 关键词检索（自动定位含该词的章/资料段，如「登船」「风俗店」）③offsetPct 百分比翻页。模仿句式节奏用，不要抄内容。',
      input_schema: {
        type: 'object',
        properties: {
          sampleId: {
            type: 'string',
            description: '范文 id（来自 list_samples，可省略=本书绑定的范文）'
          },
          name: { type: 'string', description: '范文全名兜底（没有 id 时按名匹配）' },
          toc: { type: 'boolean', description: 'true=只看目录（卷名/章节名清单），不读正文' },
          chapter: { type: 'number', description: '章号直达（如 5=读第 5 章）' },
          query: { type: 'string', description: '关键词检索，定位含该词的章或资料段' },
          offsetPct: { type: 'number', description: '起始位置百分比 0-100（默认 0=开头）' },
          maxChars: { type: 'number', description: '本次取多少字（默认 4000）' }
        }
      }
    },
    {
      name: 'search_project',
      description:
        '跨板块关键词搜索：设定卡/人物/伏笔/章节正文一次全查（章节命中给摘句）。scope 可限定单板块（cards/characters/foreshadows/chapters）。找前文原句/设定出处用。',
      input_schema: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          scope: {
            type: 'string',
            enum: ['cards', 'characters', 'foreshadows', 'chapters'],
            description: '可选：限定搜索板块，缺省全查'
          }
        },
        required: ['q']
      }
    },
    {
      name: 'save_card',
      description:
        '建/改设定卡（传 id=改，不传=建）。写作中沉淀新设定、维护旧设定都用它；改卡时传新 kind=把卡调整到别的类别（如把归错的地理卡挪成势力卡），改卡可不传 title（保留原名）。可选字段不传保留原值。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '改卡时传' },
          kind: {
            type: 'string',
            description:
              '内置 slug（geography/faction/history/power/item/custom）或自定义类别名（2-6 字中文词，如「官制」「美食」）——用新类别名存卡即新建该类别'
          },
          title: { type: 'string' },
          readerText: { type: 'string', description: '读者已知层：读者此刻能看到的设定' },
          authorText: { type: 'string', description: '作者真相层：只有你知道的底细' },
          revealPlan: { type: 'string', description: '计划在哪一章/how 揭示真相层' },
          data: {
            type: 'object',
            description:
              '结构化数据：键名=表名，值为对象数组即渲染成表格。如 {"成员":[{"姓名":"老船工","立场":"摇摆"}]}。表内行级增删改=读旧 data 改数组后整键写回'
          },
          pinned: { type: 'boolean', description: 'true=钉选（每章上下文必带）' }
        }
      }
    },
    {
      name: 'save_character',
      description:
        '建人物档案（不传 id=新建，name 必填）或改元信息（传 id：改名/改定位/改关系网/钉选）。人设正文用 update_character_data、标签用 update_character_tags、活状态用 patch_character_state。部分更新：只需传要改的字段，未传字段保持原值。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '改人物时传' },
          name: { type: 'string', description: '人物名（新建必填；改名时传新名）' },
          role: { type: 'string', description: '一句话定位（主角/对手/导师…）' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '标签（仅新建时全量传入；已有人物改标签用 update_character_tags）'
          },
          data: {
            type: 'object',
            description: '人设数据初值（仅新建时可带；已有人物改数据用 update_character_data）'
          },
          state: {
            type: 'object',
            description:
              '初始活状态。七要素字段收字符串：{location?,body?,mood?,items?,knows?,goal?}；也可加任意自定义键（对象/数组皆可，设定页递归渲染）',
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
      name: 'update_character_tags',
      description:
        '增量改人物标签：add 加（去重）、delete 删。前端按标签筛选人物，标签宜短（2-6 字，如「盐帮」「反派」「复仇者」）。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'list_characters 返回的 id' },
          add: { type: 'array', items: { type: 'string' }, description: '要加的标签' },
          delete: { type: 'array', items: { type: 'string' }, description: '要删的标签' }
        },
        required: ['id']
      }
    },
    {
      name: 'update_character_data',
      description:
        '改人物人设数据（你是谁：背景/外貌/性格/口癖等自由键值）。浅合并：只传要改的顶层键，未传键保留原值。整键替换语义——复杂键先 list_characters 读旧值改完再写。',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'list_characters 返回的 id' },
          merge: {
            type: 'object',
            description: '要合并进去的键值对（如 {"外貌":"高瘦","口癖":"啧"}）'
          }
        },
        required: ['id', 'merge']
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
            description:
              '只传要改的键，其余保留。七要素（location/body/mood/items/knows/goal）收字符串；自定义键可放对象/数组（设定页递归渲染，整键替换语义——复杂键先 list_characters 读旧值改完再写）',
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
        '建/改伏笔（传 id=改）。部分更新：只需传要改的字段，未传字段保持原值。埋设 planted→计划回收 planned→已回收 resolved 三态流转；priority 越大越优先。',
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
        '从某章之后开剧情新线并切入（分叉树）。设定整体拷贝到新线各自演化。大转折实验/换走法时用。开线前可 list_lines 看现有线。',
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
      name: 'list_lines',
      description:
        '列本书全部剧情线（分叉树全貌）：线名/各自章数/分叉点章/★激活线。开线/切线前先看它。',
      input_schema: { type: 'object', properties: {} }
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
        .map(({ c, i }) =>
          input.brief ? `${i + 1}. 《${c.title}》(${c.wordCount}字, id=${c.id})` : chapterLine(c, i)
        )
      return {
        ok: true,
        summary: `查章节序列（共 ${chapters.length} 章${input.brief ? '，仅标题' : ''}）`,
        data: rows.length ? rows.join(N) : '（当前线还没有章节）'
      }
    }
    case 'read_chapter': {
      const id = String(input.chapterId ?? '')
      const c = store.getChapter(id)
      if (!c) return { ok: false, summary: '章节不存在', data: `章节 ${id} 不存在` }
      // 定位起点：q 关键词命中处 / from 字数 / 默认开头
      let start = 0
      let loc = ''
      const q = typeof input.q === 'string' ? input.q.trim() : ''
      if (q) {
        const idx = c.content.indexOf(q)
        if (idx < 0)
          return {
            ok: false,
            summary: `《${c.title}》里没有「${q}」`,
            data: `本章没搜到「${q}」。可用 search_project 全书找，或去掉 q 从头读。`
          }
        start = Math.max(0, idx - 600)
        loc = `（「${q}」命中处附近，第 ${idx + 1} 字起）`
      } else if (typeof input.from === 'number' && input.from > 0) {
        start = Math.min(Math.floor(input.from), Math.max(0, c.content.length - 1))
        loc = `（从第 ${start + 1} 字起）`
      }
      const full = input.full === true
      const body =
        full || c.content.length <= 6000
          ? c.content
          : start > 0
            ? `${c.content.slice(start, start + 6000)}${N}…（第 ${start + 1}-${start + 6000} 字；继续往后传 from:${start + 6000}）`
            : `${c.content.slice(0, 6000)}${N}…（截断，需要全文传 full:true 或 from:6000 续读）`
      return {
        ok: true,
        summary: `读《${c.title}》${loc ? '片段' : ''}`,
        data: `《${c.title}》（${c.wordCount}字）${loc}${N}${body}`
      }
    }
    case 'list_cards': {
      const { lineId } = ctxLine(ctx)
      const kind = typeof input.kind === 'string' ? input.kind : undefined
      const q = typeof input.q === 'string' ? input.q : undefined
      const cards = store.listCards(lineId, { kind, q })
      const rows = input.brief
        ? cards.map((c) => `【${c.kind}${c.pinned ? '·钉' : ''}】${c.title} (id=${c.id})`)
        : cards.map(
            (c) =>
              `【${c.kind}${c.pinned ? '·钉' : ''}】${c.title} (id=${c.id})：${brief(c.readerText, 100)}`
          )
      return {
        ok: true,
        summary: `查设定卡 ${cards.length} 张${input.brief ? '（仅标题）' : ''}`,
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
    case 'list_card_kinds': {
      const { lineId } = ctxLine(ctx)
      const kinds = store.listCardKinds(lineId)
      return {
        ok: true,
        summary: `${kinds.length} 个类别`,
        data: kinds.length
          ? kinds.map((k) => `【${k.kind}】${k.count} 张`).join(N)
          : '（还没有设定卡，用 save_card 存第一张即建类别）'
      }
    }
    case 'rename_card_kind': {
      const { lineId } = ctxLine(ctx)
      const oldKind = String(input.oldKind ?? '')
      const newKind = String(input.newKind ?? '')
      if (!oldKind || !newKind)
        return { ok: false, summary: '要传 oldKind 和 newKind', data: '要传 oldKind 和 newKind' }
      const n = store.renameCardKind(lineId, oldKind, newKind)
      return {
        ok: n > 0,
        summary:
          n > 0 ? `「${oldKind}」已并入「${newKind}」（${n} 张）` : `类别「${oldKind}」不存在`,
        data:
          n > 0
            ? `已把 ${n} 张卡从「${oldKind}」迁移到「${newKind}」。旧类别无卡后自动消失。`
            : `没有找到类别「${oldKind}」的卡（list_card_kinds 先看现有类别）`
      }
    }
    case 'list_characters': {
      const { lineId } = ctxLine(ctx)
      const q = typeof input.q === 'string' ? input.q : undefined
      const chars = store.listCharacters(lineId, { q })
      const rows = input.brief
        ? chars.map((c) => `【${c.role || '人物'}】${c.name} (id=${c.id})`)
        : chars.map((c) => {
            const st = Object.entries(c.state)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')
            const rel = c.relations.map((r) => `${r.to}(${r.label})`).join(' ')
            return `【${c.role || '人物'}${c.pinned ? '·钉' : ''}】${c.name} (id=${c.id})：${st}${rel ? ` 关系：${rel}` : ''}`
          })
      return {
        ok: true,
        summary: `查人物 ${chars.length} 人${input.brief ? '（仅名单）' : ''}`,
        data: rows.length ? rows.join(N) : '（没有匹配的人物）'
      }
    }
    case 'get_character': {
      const { lineId } = ctxLine(ctx)
      const id = typeof input.characterId === 'string' ? input.characterId : ''
      let target = id ? store.getCharacter(id) : null
      if (!target && typeof input.name === 'string' && input.name) {
        target = store.listCharacters(lineId).find((c) => c.name === input.name) ?? null
      }
      if (!target || target.lineId !== lineId) {
        return {
          ok: false,
          summary: '人物不存在',
          data: `人物 ${id || String(input.name ?? '')} 不存在（或不在当前线），先 list_characters 看名单`
        }
      }
      const rel = target.relations.map((r) => `${r.to}（${r.label}）`).join('；')
      const card = Object.keys(target.data).length
        ? JSON.stringify(target.data, null, 1)
        : '（无人设内容）'
      return {
        ok: true,
        summary: `读人物「${target.name}」详情`,
        data: `【${target.role || '人物'}${target.pinned ? '·钉选' : ''}】${target.name} (id=${target.id})${N}〔标签〕${target.tags.join('、') || '（无）'}${N}〔人设〕${N}${card}${N}〔当前状态〕${N}${JSON.stringify(target.state, null, 1)}${N}〔关系〕${rel || '（无）'}`
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
      const scope =
        input.scope === 'cards' ||
        input.scope === 'characters' ||
        input.scope === 'foreshadows' ||
        input.scope === 'chapters'
          ? input.scope
          : undefined
      const rows: string[] = []
      if (!scope || scope === 'cards')
        for (const c of store.listCards(lineId, { q }))
          rows.push(`[设定卡] ${c.title} (id=${c.id})`)
      if (!scope || scope === 'characters')
        for (const c of store.listCharacters(lineId, { q }))
          rows.push(`[人物] ${c.name} (id=${c.id})`)
      if (!scope || scope === 'foreshadows')
        for (const f of store.listForeshadows(lineId))
          if (f.title.includes(q) || f.detail.includes(q))
            rows.push(`[伏笔] ${f.title} (id=${f.id})`)
      if (!scope || scope === 'chapters') {
        store.effectiveChapters(lineId).forEach((c, i) => {
          const idx = c.content.indexOf(q)
          if (c.title.includes(q) || c.summary.includes(q) || idx >= 0) {
            const snip =
              idx >= 0
                ? `：…${c.content.slice(Math.max(0, idx - 30), idx + 50).replace(/\n/g, ' ')}…`
                : ''
            rows.push(`[章节] 第${i + 1}章《${c.title}》 (id=${c.id})${snip}`)
          }
        })
      }
      return {
        ok: true,
        summary: `搜「${q}」命中 ${rows.length} 条${scope ? `（${scope}）` : ''}`,
        data: rows.length ? rows.slice(0, 30).join(N) : `没有找到与「${q}」相关的内容`
      }
    }
    case 'list_samples': {
      const book = ctxBook(ctx)
      const all = store.listSamples()
      const rows = all.map((s) => {
        const bound = book.sampleSources.includes(s.id) ? ' ★本书绑定' : ''
        const chapters = s.chapterCount ? `，${s.chapterCount} 章` : ''
        return `${s.name}（${s.chars}字${chapters}, id=${s.id}）${bound}`
      })
      return {
        ok: true,
        summary: `查范文库 ${all.length} 本`,
        data: rows.length ? rows.join(N) : '（范文库为空）'
      }
    }
    case 'read_sample': {
      const book = ctxBook(ctx)
      const all = store.listSamples()
      const target = all.find(
        (s) =>
          (typeof input.sampleId === 'string' && s.id === input.sampleId) ||
          (typeof input.name === 'string' && s.name.includes(input.name))
      )
      const chosen = target ?? all.find((s) => book.sampleSources.includes(s.id))
      if (!chosen)
        return {
          ok: false,
          summary: '范文不存在',
          data: '没有匹配的范文，先 list_samples 看看有哪些'
        }
      const full = store.getSample(chosen.id)
      if (!full) return { ok: false, summary: '范文读取失败', data: `范文 ${chosen.name} 读取失败` }
      const total = full.content.length
      // 目录读法：先看卷名/章节名再定位
      if (input.toc === true) {
        const secs = store.listSampleSections(chosen.id)
        if (!secs.length)
          return {
            ok: true,
            summary: `《${chosen.name}》无章节目录`,
            data: `《${chosen.name}》共 ${total} 字，未解析出章节结构。可用 query 关键词检索或 offsetPct 百分比翻页。`
          }
        const chN = secs.filter((s) => s.kind === 'chapter').length
        const lines = secs
          .slice(0, 200)
          .map((s) => `${s.kind === 'chapter' ? '' : '§ '}${s.label}（${s.chars} 字）`)
        return {
          ok: true,
          summary: `《${chosen.name}》目录 ${chN} 章`,
          data: `《${chosen.name}》目录（${chN} 章，全文 ${total} 字；看完后用 chapter 章号直达对应章）：${N}${lines.join(N)}${secs.length > 200 ? `${N}…（节选前 200 节）` : ''}`
        }
      }
      const maxChars =
        typeof input.maxChars === 'number' ? Math.max(500, Math.min(8000, input.maxChars)) : 4000
      // 三种定位：章号直达 / 关键词搜节 / 百分比翻页
      let start = 0
      let loc = ''
      if (typeof input.chapter === 'number') {
        const secs = store.listSampleSections(chosen.id).filter((s) => s.kind === 'chapter')
        const sec = secs.find((s) => chapterNoOfLabel(s.label) === input.chapter)
        if (!sec)
          return {
            ok: false,
            summary: `《${chosen.name}》没有第 ${input.chapter} 章`,
            data: `没找到第 ${input.chapter} 章。该书共 ${secs.length} 章：${secs
              .slice(0, 30)
              .map((s) => s.label)
              .join('；')}${secs.length > 30 ? '…' : ''}`
          }
        start = sec.start
        loc = `【范文《${chosen.name}》· ${sec.label}】`
      } else if (typeof input.query === 'string' && input.query.trim()) {
        const hit = store.searchSampleSections(chosen.id, full.content, input.query.trim())
        if (hit.offset < 0)
          return {
            ok: false,
            summary: `《${chosen.name}》里没有「${input.query}」`,
            data: `没搜到「${input.query}」。可用 list_samples 换一本，或用 offsetPct 翻页。`
          }
        start = hit.offset
        loc = hit.snippet
          ? `【范文《${chosen.name}》· 「${input.query}」命中片段：…${hit.snippet}…】`
          : `【范文《${chosen.name}》· ${hit.section?.label ?? ''}（含「${input.query}」）】`
      } else {
        const pct =
          typeof input.offsetPct === 'number' ? Math.max(0, Math.min(99, input.offsetPct)) : 0
        start = Math.floor((total * pct) / 100)
        loc = `【范文《${chosen.name}》第 ${start + 1} 字起 / 共 ${total} 字（${pct}% 处）】`
      }
      const end = Math.min(total, start + maxChars)
      const pos = loc || `【范文《${chosen.name}》第 ${start + 1}-${end} 字 / 共 ${total} 字】`
      return {
        ok: true,
        summary: `读《${chosen.name}》${start + 1}-${end} 字`,
        data: `${pos}${N}${full.content.slice(start, end)}`
      }
    }
    case 'save_card': {
      const { lineId } = ctxLine(ctx)
      const card = store.saveCard({
        id: typeof input.id === 'string' && input.id ? input.id : undefined,
        lineId,
        kind: typeof input.kind === 'string' ? (input.kind as CardKind) : undefined,
        title: typeof input.title === 'string' ? input.title : undefined,
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
      const isNew = !(typeof input.id === 'string' && input.id)
      const ch = store.saveCharacter({
        id: isNew ? undefined : (input.id as string),
        lineId,
        name: typeof input.name === 'string' && input.name ? input.name : undefined,
        role: typeof input.role === 'string' ? input.role : undefined,
        // data/tags 仅新建时作初值；已有人物走 update_character_data/tags（防全量覆盖）
        data: isNew ? ((input.data as Record<string, unknown>) ?? undefined) : undefined,
        tags: isNew && Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
        state: (input.state as CharacterState) ?? undefined,
        relations: (input.relations as Character['relations']) ?? undefined,
        pinned: typeof input.pinned === 'boolean' ? input.pinned : undefined
      })
      if (!ch) return { ok: false, summary: '保存人物失败', data: '保存失败：人物不存在或参数无效' }
      return {
        ok: true,
        summary: `${isNew ? '建' : '改'}人物「${ch.name}」`,
        data: `已保存 ${ch.name}（${ch.role || '人物'}）(id=${ch.id})`
      }
    }
    case 'update_character_tags': {
      const { lineId } = ctxLine(ctx)
      const id = typeof input.id === 'string' ? input.id : ''
      const target = store.getCharacter(id)
      if (!target || target.lineId !== lineId) {
        return { ok: false, summary: '人物不存在', data: `人物 ${id} 不存在（或不在当前线）` }
      }
      const ch = store.updateCharacterTags(id, {
        add: Array.isArray(input.add) ? (input.add as string[]) : undefined,
        delete: Array.isArray(input.delete) ? (input.delete as string[]) : undefined
      })
      return {
        ok: true,
        summary: `改「${target.name}」标签`,
        data: `已更新 ${target.name} 标签：${JSON.stringify(ch?.tags ?? [])}`
      }
    }
    case 'update_character_data': {
      const { lineId } = ctxLine(ctx)
      const id = typeof input.id === 'string' ? input.id : ''
      const target = store.getCharacter(id)
      if (!target || target.lineId !== lineId) {
        return { ok: false, summary: '人物不存在', data: `人物 ${id} 不存在（或不在当前线）` }
      }
      const merge = (input.merge as Record<string, unknown>) ?? {}
      const ch = store.updateCharacterData(id, merge)
      return {
        ok: true,
        summary: `改「${target.name}」人设`,
        data: `已合并人设键：${Object.keys(merge).join('、') || '(空)'}；现有人设键：${Object.keys(ch?.data ?? {}).join('、')}`
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
        title: typeof input.title === 'string' && input.title ? input.title : undefined,
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
    case 'list_lines': {
      const b = ctxBook(ctx)
      const lines = store.listLines(ctx.bookId)
      const rows = lines.map((l) => {
        const forkCh = l.forkChapterId ? store.getChapter(l.forkChapterId) : null
        const fork = forkCh ? `，分叉自《${forkCh.title}》之后` : l.parentLineId ? '' : '（主干）'
        const star = l.id === b.activeLineId ? '★当前 ' : ''
        return `${star}「${l.name}」 ${store.listChapters(l.id).length} 章${fork} (id=${l.id})${l.note ? ` 备注：${brief(l.note, 60)}` : ''}`
      })
      return {
        ok: true,
        summary: `查剧情线 ${lines.length} 条`,
        data: `《${b.title}》剧情线（★=正在写的线）：${N}${rows.join(N)}${N}写作发生在激活线尾部；切线用 switch_line，从某章后开新线用 fork_line。`
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
