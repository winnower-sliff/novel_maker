import {
  buildOutlineNoIndex,
  formatChapterRef,
  isDanglingRef,
  resolveChapterRefToOutline
} from '../../shared/foreRef'
import { splitTags } from '../../shared/tags'
import type { OutlineItem, ToolDef } from '../../shared/types'
import { chatStream, pickRatelimitHeaders } from '../llm'
import { applyVolumeSummaryResult, buildVolumeSummaryRequest } from '../pipeline'
import { resolveRequestAuth } from '../settings'
import * as store from '../store'
import { appendUsage } from '../usage'
import {
  getInstructionsView,
  writeGlobalInstructions,
  writeProjectInstructions,
  writingRulesFor
} from './instructions'
import { runSubAgent } from './subagent'
import {
  type AgentTool,
  briefOf,
  clip,
  FULL_PAGE_DEFAULT,
  getOutlineOwned,
  MAX_CHAPTER_CHARS,
  n,
  optArr,
  optB,
  optBool,
  optN,
  optNum,
  optS,
  optStr,
  optStrArr,
  reqStr,
  s,
  schema
} from './toolkit'

/** 大纲生成页的向导参数存档（projects.wizard_plan JSON）：主进程侧读-合并-写，保留未知字段 */
interface PlanRaw {
  [key: string]: unknown
  volumePlans?: Record<string, unknown>
}

function readPlanRaw(projectId: string): { raw: PlanRaw; currentVolume: number } {
  const p = store.listProjects().find((x) => x.id === projectId)
  if (!p) throw new Error('项目不存在')
  let raw: PlanRaw = {}
  try {
    const v = JSON.parse(p.wizardPlan || '{}') as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) raw = v as PlanRaw
  } catch {
    raw = {}
  }
  if (!raw.volumePlans || typeof raw.volumePlans !== 'object' || Array.isArray(raw.volumePlans))
    raw.volumePlans = {}
  const currentVolume =
    typeof raw.volume === 'number' && raw.volume >= 1 ? Math.floor(raw.volume) : 1
  return { raw, currentVolume }
}

function readPlanEntry(raw: PlanRaw, volume: number): Record<string, unknown> {
  const v = raw.volumePlans?.[String(volume)]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

const TOOLS: AgentTool[] = [
  {
    def: {
      name: 'get_project',
      description: '读取当前项目的元信息（标题、类型、风格指南、目标字数）',
      input_schema: schema({}, [])
    },
    danger: false,
    handler: (_input, projectId) => {
      const p = store.listProjects().find((x) => x.id === projectId)
      if (!p) throw new Error('项目不存在')
      return {
        title: p.title,
        genre: p.genre,
        styleGuide: p.styleGuide,
        targetWords: p.targetWords,
        status: p.status
      }
    }
  },
  {
    def: {
      name: 'update_project',
      description: '修改当前项目的元信息。只传需要修改的字段',
      input_schema: schema(
        {
          title: optS('新标题'),
          genre: optS('新类型'),
          styleGuide: optS('新风格指南'),
          targetWords: optN('新目标字数')
        },
        []
      )
    },
    danger: false,
    handler: (input, projectId) => {
      store.updateProject(projectId, {
        title: optStr(input, 'title'),
        genre: optStr(input, 'genre'),
        styleGuide: optStr(input, 'styleGuide'),
        targetWords: optNum(input, 'targetWords')
      })
      return { ok: true }
    }
  },
  {
    def: {
      name: 'list_characters',
      description:
        '列出人物卡。默认摘要模式：每条含 id、姓名、定位、标签、卡面摘要（前 200 字）与总字数；detail=full 返回卡面全文（每条截断 3000 字）。可选 offset/limit 分页（summary 默认全部、full 默认每页 20 条）。做全局检查类任务时应分批读取直至 hasMore=false',
      input_schema: schema(
        {
          detail: optS('summary（默认，摘要）/ full（全文）'),
          offset: optN('分页起始下标，默认 0'),
          limit: optN('每页条数：summary 默认全部，full 默认 20')
        },
        []
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const all = store.listCharacters(projectId)
      const full = (optStr(input, 'detail') ?? 'summary') === 'full'
      const offset = optNum(input, 'offset') ?? 0
      const limit = optNum(input, 'limit') ?? (full ? FULL_PAGE_DEFAULT : all.length)
      const page = all.slice(offset, offset + limit)
      return {
        total: all.length,
        returned: page.length,
        hasMore: offset + page.length < all.length,
        items: page.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          tags: c.tags,
          ...(full
            ? { card: clip(c.card, 3000).text }
            : { brief: briefOf(c.card), cardChars: c.card.length })
        }))
      }
    }
  },
  {
    def: {
      name: 'get_entity',
      description:
        '按 id 读取单条内容全文（修改前取原文用）。kind=character 返回人物卡（含动态状态 state）；kind=worldbuild 返回世界观词条全文（含 category/tags/keys）；kind=chapter 传大纲条目 id，返回该章正文全文（超长会截断）',
      input_schema: schema(
        {
          kind: s('内容类型：character / worldbuild / chapter'),
          id: s('条目 id（chapter 传大纲条目 id）')
        },
        ['kind', 'id']
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const kind = reqStr(input, 'kind')
      const id = reqStr(input, 'id')
      if (kind === 'character') {
        const c = store.listCharacters(projectId).find((x) => x.id === id)
        if (!c) throw new Error('未找到该人物')
        return {
          kind,
          id: c.id,
          name: c.name,
          role: c.role,
          tags: c.tags,
          card: c.card,
          state: c.state
        }
      }
      if (kind === 'worldbuild') {
        const e = store.listWorldbuild(projectId).find((x) => x.id === id)
        if (!e) throw new Error('未找到该词条')
        return {
          kind,
          id: e.id,
          category: e.category,
          title: e.title,
          tags: e.tags,
          keys: e.keys,
          relation: e.relation,
          content: e.content
        }
      }
      if (kind === 'chapter') {
        const o = getOutlineOwned(id, projectId)
        const chapter = store.getChapterByOutline(o.id)
        if (!chapter) return { kind, exists: false, note: '该章节还没有正文' }
        const c = clip(chapter.content, MAX_CHAPTER_CHARS)
        return {
          kind,
          exists: true,
          chapterNo: o.chapterNo,
          title: o.title,
          wordCount: chapter.wordCount,
          truncated: c.truncated,
          content: c.text
        }
      }
      throw new Error("kind 必须是 'character' / 'worldbuild' / 'chapter'")
    }
  },
  {
    def: {
      name: 'save_character',
      description:
        '新建或修改人物卡。传 id 表示修改既有人物；不传 id 表示新建。tags 为标签（逗号分隔，2-4 个；新建时建议提供，修改时省略则保留原标签；优先复用已有标签，没有合适的就新建可被多个人物共享的主题标签）。card 文末建议带「关联：」行（[[世界观条目|关系短语]]，1-3 个）；链接只允许指向世界观条目，严禁 [[ ]] 链人物名。修改时应先 list_characters 取原文再改',
      input_schema: schema(
        {
          id: optS('要修改的人物 id（新建时省略）'),
          name: s('姓名'),
          role: optS('定位，如 主角/反派/配角'),
          tags: optS('标签'),
          card: optS('人物卡正文（markdown）')
        },
        ['name']
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const saved = store.saveCharacter({
        id: optStr(input, 'id'),
        projectId,
        name: reqStr(input, 'name'),
        role: optStr(input, 'role'),
        tags: optStr(input, 'tags'),
        card: optStr(input, 'card')
      })
      return { ok: true, id: saved.id, name: saved.name, created: !optStr(input, 'id') }
    }
  },
  {
    def: {
      name: 'delete_entity',
      description:
        '删除内容（不可恢复，需用户确认）。kind=character 删人物卡；kind=worldbuild 删世界观词条；kind=outline 删大纲条目；kind=foreshadow 删伏笔',
      input_schema: schema(
        {
          kind: s('内容类型：character / worldbuild / outline / foreshadow'),
          id: s('要删除的条目 id')
        },
        ['kind', 'id']
      )
    },
    danger: true,
    handler: (input, projectId) => {
      const kind = reqStr(input, 'kind')
      const id = reqStr(input, 'id')
      if (kind === 'character') {
        const c = store.listCharacters(projectId).find((x) => x.id === id)
        if (!c) throw new Error('未找到该人物')
        store.deleteCharacter(c.id)
        return { ok: true, kind, deleted: c.name }
      }
      if (kind === 'worldbuild') {
        const e = store.listWorldbuild(projectId).find((x) => x.id === id)
        if (!e) throw new Error('未找到该词条')
        store.deleteWorldbuild(e.id)
        return { ok: true, kind, deleted: e.title }
      }
      if (kind === 'outline') {
        const o = getOutlineOwned(id, projectId)
        store.deleteOutline(o.id)
        return { ok: true, kind, deleted: `第${o.chapterNo}章 ${o.title}` }
      }
      if (kind === 'foreshadow') {
        const f = store.listForeshadows(projectId).find((x) => x.id === id)
        if (!f) throw new Error('未找到该伏笔')
        store.deleteForeshadow(f.id)
        return { ok: true, kind, deleted: f.content }
      }
      throw new Error("kind 必须是 'character' / 'worldbuild' / 'outline' / 'foreshadow'")
    }
  },
  {
    def: {
      name: 'list_worldbuild',
      description:
        '列出世界观词条。默认摘要模式：返回各类型条数分布（byCategory）与每条的 id、类型、标题、标签、人物/剧情关联（relation）、内容摘要（前 200 字）及总字数；detail=full 返回内容全文（每条截断 3000 字）。可选 category 按类型过滤、offset/limit 分页（summary 默认全部、full 默认每页 20 条）。做全局检查类任务时应分批读取直至 hasMore=false',
      input_schema: schema(
        {
          category: optS('按类型精确过滤（如 力量体系）'),
          detail: optS('summary（默认，摘要）/ full（全文）'),
          offset: optN('分页起始下标，默认 0'),
          limit: optN('每页条数：summary 默认全部，full 默认 20')
        },
        []
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const all = store.listWorldbuild(projectId)
      const byCategory: Record<string, number> = {}
      for (const e of all) byCategory[e.category] = (byCategory[e.category] ?? 0) + 1
      const category = optStr(input, 'category')
      const filtered = category ? all.filter((e) => e.category === category) : all
      const full = (optStr(input, 'detail') ?? 'summary') === 'full'
      const offset = optNum(input, 'offset') ?? 0
      const limit = optNum(input, 'limit') ?? (full ? FULL_PAGE_DEFAULT : filtered.length)
      const page = filtered.slice(offset, offset + limit)
      return {
        total: filtered.length,
        returned: page.length,
        hasMore: offset + page.length < filtered.length,
        byCategory,
        items: page.map((e) => ({
          id: e.id,
          category: e.category,
          title: e.title,
          tags: e.tags,
          keys: e.keys,
          relation: e.relation || undefined,
          ...(full
            ? { content: clip(e.content, 3000).text }
            : { brief: briefOf(e.content), contentChars: e.content.length })
        }))
      }
    }
  },
  {
    def: {
      name: 'save_worldbuild',
      description:
        '新建或修改世界观词条。传 id 表示修改；不传 id 表示新建。category 为类型（每条目一个，优先复用现有类型，不轻易新建）；tags 为标签（逗号分隔，2-6 个；新建时必填，修改时省略则保留原标签；优先复用现有标签，没有合适的就新建可被多个条目共享的上位主题标签，禁止无标签条目，且不得与类型重名）；keys 为检索别名（逗号分隔，同一概念的其他叫法/简称/别称，供写作上下文按名命中，如「青云宗,青云,青宗」）；relation 为人物/剧情关联（一句话说明该条目与哪个人物或哪条剧情线绑定、是什么关系，可含 [[世界观条目]] 链接；修改时省略保留原值，传空串清空）。正文 [[ ]] 链接只允许指向世界观条目标题，严禁链人物名（提及人物直接写名字）',
      input_schema: schema(
        {
          id: optS('要修改的词条 id（新建时省略）'),
          category: s('类型，优先复用现有类型'),
          title: s('标题'),
          tags: optS('标签，逗号分隔（如：精灵,森林,魔法）'),
          keys: optS('检索别名，逗号分隔（同一概念的其他叫法）'),
          content: optS('正文内容'),
          relation: optS(
            '人物/剧情关联（该条目与人物或剧情线的关系说明，可含 [[世界观条目]] 链接）'
          )
        },
        ['category', 'title']
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const knownTypes = new Set(store.listWorldbuildTypes(projectId))
      const category = reqStr(input, 'category').slice(0, 12)
      if (!knownTypes.has(category)) {
        try {
          store.createWorldbuildType(projectId, category)
        } catch {
          /* 与现有类型/标签冲突时保持原值，由 saveWorldbuild 兜底 */
        }
      }
      const rawTags = optStr(input, 'tags')
      const tags =
        rawTags === undefined
          ? undefined
          : splitTags(rawTags)
              .filter((t) => !knownTypes.has(t) && t !== category)
              .slice(0, 6)
              .join(',')
      const saved = store.saveWorldbuild({
        id: optStr(input, 'id'),
        projectId,
        category,
        title: reqStr(input, 'title'),
        tags: tags || undefined,
        keys: optStr(input, 'keys'),
        content: optStr(input, 'content'),
        relation: optStr(input, 'relation')
      })
      return { ok: true, id: saved.id, title: saved.title, created: !optStr(input, 'id') }
    }
  },
  {
    def: {
      name: 'worldbuild_type',
      description:
        '管理世界观类型（op 三选一）。op=create 新建类型，可同时带 before/after/first/last 之一插到语义相邻位置（省一轮 reorder；内置顺序：地理、势力、历史、力量体系、物品在前，「其他」恒最后，新建类型默认排在「其他」之前）；op=delete 删除空类型——类型下还有条目时报错，先用 set_worldbuild_category 把条目迁走；op=reorder 调整类型在筛选栏中的显示顺序，before/after/first/last 恰好提供一个',
      input_schema: schema(
        {
          op: s("操作：'create' / 'delete' / 'reorder'"),
          name: s('类型名'),
          before: optS('create/reorder：移到该类型之前'),
          after: optS('create/reorder：移到该类型之后（不能是「其他」）'),
          first: optB('create/reorder：移到最前'),
          last: optB('create/reorder：移到最后（「其他」之前）')
        },
        ['op', 'name']
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const op = reqStr(input, 'op')
      const name = reqStr(input, 'name')
      const pos = {
        before: optStr(input, 'before'),
        after: optStr(input, 'after'),
        first: optBool(input, 'first') === true,
        last: optBool(input, 'last') === true
      }
      const hasPos = [pos.before, pos.after, pos.first, pos.last].some(Boolean)
      if (op === 'create') {
        store.createWorldbuildType(projectId, name)
        if (hasPos) store.reorderWorldbuildType(projectId, name, pos)
        return { ok: true, op, created: name, order: store.listWorldbuildTypes(projectId) }
      }
      if (op === 'delete') {
        store.deleteWorldbuildType(projectId, name)
        return { ok: true, op, deleted: name, order: store.listWorldbuildTypes(projectId) }
      }
      if (op === 'reorder') {
        const order = store.reorderWorldbuildType(projectId, name, pos)
        return { ok: true, op, order }
      }
      throw new Error("op 必须是 'create' / 'delete' / 'reorder'")
    }
  },
  {
    def: {
      name: 'set_worldbuild_category',
      description:
        '只改某条世界观词条的类型（不动正文与标签）。目标类型不存在时自动创建（与现有标签重名会报错）。用 id 定位词条，改前可先 list_worldbuild 确认',
      input_schema: schema({ id: s('词条 id'), category: s('新类型名') }, ['id', 'category'])
    },
    danger: false,
    handler: (input, projectId) => {
      const e = store.listWorldbuild(projectId).find((x) => x.id === reqStr(input, 'id'))
      if (!e) throw new Error('未找到该词条')
      const category = reqStr(input, 'category').slice(0, 12)
      if (!store.listWorldbuildTypes(projectId).includes(category)) {
        try {
          store.createWorldbuildType(projectId, category)
        } catch {
          /* 与现有类型/标签冲突时交由 saveWorldbuild 保持原值兜底 */
        }
      }
      const saved = store.saveWorldbuild({ id: e.id, projectId, category, title: e.title })
      return { ok: true, id: saved.id, title: saved.title, category: saved.category }
    }
  },
  {
    def: {
      name: 'list_outlines',
      description:
        '列出大纲条目（id、卷号、章号、标题、梗概、场景序列 scenes、状态），按卷号与章号排序。可选 volume 按卷过滤、offset/limit 分页（默认全部）。做全局检查类任务时应分批读取直至 hasMore=false',
      input_schema: schema(
        {
          volume: optN('按卷号过滤'),
          offset: optN('分页起始下标，默认 0'),
          limit: optN('每页条数，默认全部')
        },
        []
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const all = store.listOutlines(projectId)
      const volume = optNum(input, 'volume')
      const filtered = volume === undefined ? all : all.filter((o) => o.volume === volume)
      const offset = optNum(input, 'offset') ?? 0
      const limit = optNum(input, 'limit') ?? filtered.length
      const page = filtered.slice(offset, offset + limit)
      return {
        total: filtered.length,
        returned: page.length,
        hasMore: offset + page.length < filtered.length,
        items: page.map((o) => ({
          id: o.id,
          volume: o.volume,
          chapterNo: o.chapterNo,
          title: o.title,
          synopsis: o.synopsis,
          scenes: o.scenes,
          role: o.role,
          suspense: o.suspense,
          twist: o.twist,
          hook: o.hook,
          foreshadowOps: o.foreshadowOps,
          status: o.status
        }))
      }
    }
  },
  {
    def: {
      name: 'save_outline',
      description:
        '新建或修改大纲条目。传 id 表示修改既有条目；不传 id 表示新建：volume 必填，chapterNo=插到该章号之前（0 或缺省=追加到全书末尾），也可传 afterOutlineId 精确插到某章之后；章号由系统按位置自动重排，无需关心绝对编号。可选元数据：title（章节标题）、synopsis（梗概：50字纯剧情概要，只回答「这章讲什么」）、scenes（场景序列 string[]：2-4 条「人物+动作/冲突」场景句，回答「这章怎么演」，主要戏份排前面）、role（章节定位）、suspense（悬念密度）、twist（认知颠覆1-5）、hook（结尾钩子设计）、foreshadowOps（伏笔操作，如 埋设(A)→回收(B)）；修改时未传字段保留原值，scenes 传空数组表示清空；修改时传 chapterNo 表示移动到该章号位置、afterOutlineId 表示移动到该章之后。注意 foreshadowOps 仅是人读注记，不会联动伏笔台账；要更新伏笔的计划回收点必须另调 save_foreshadow（写「第N章」）',
      input_schema: schema(
        {
          id: optS('要修改的大纲 id（新建时省略）'),
          volume: optN('卷号（新建必填）'),
          chapterNo: optN('新建=插到该章号之前（0/缺省=追加末尾）；修改=移动到该章号位置'),
          afterOutlineId: optS('新建=插到此章 id 之后；修改=移动到此章之后（优先于 chapterNo）'),
          title: optS('章节标题'),
          synopsis: optS('章节梗概'),
          scenes: optArr('场景序列，每条一句「人物+动作/冲突」'),
          role: optS('章节定位（情节推进/人物深化/氛围营造/过渡衔接/高潮转折）'),
          suspense: optS('悬念密度（紧凑/渐进/爆发）'),
          twist: optN('认知颠覆强度 1-5'),
          hook: optS('结尾钩子设计'),
          foreshadowOps: optS('伏笔操作'),
          status: optS('状态：draft/approved/written/polished')
        },
        []
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const id = optStr(input, 'id')
      const afterOutlineId = optStr(input, 'afterOutlineId')
      let volume = optNum(input, 'volume')
      let chapterNo = optNum(input, 'chapterNo')
      const twist = optNum(input, 'twist')
      const status = optStr(input, 'status')
      if (status !== undefined && !['draft', 'approved', 'written', 'polished'].includes(status))
        throw new Error("status 必须是 'draft' / 'approved' / 'written' / 'polished'")
      const fields = {
        title: optStr(input, 'title'),
        synopsis: optStr(input, 'synopsis'),
        scenes: optStrArr(input, 'scenes'),
        role: optStr(input, 'role'),
        suspense: optStr(input, 'suspense'),
        twist: twist === undefined ? undefined : Math.min(5, Math.max(0, Math.round(twist))),
        hook: optStr(input, 'hook'),
        foreshadowOps: optStr(input, 'foreshadowOps'),
        status: status as never
      }
      if (!id) {
        if (volume === undefined) throw new Error('新建时 volume 必填')
        const afterWinsNew =
          afterOutlineId !== undefined && chapterNo !== undefined && chapterNo > 0
        let beforeOutlineId: string | undefined
        if (!afterOutlineId && chapterNo !== undefined && chapterNo > 0) {
          const target = store.listOutlines(projectId).find((o) => o.chapterNo === chapterNo)
          if (!target)
            throw new Error(
              `章号 ${chapterNo} 不存在（新建时 chapterNo=插到该章号之前，0 或缺省=追加末尾）`
            )
          beforeOutlineId = target.id
        }
        const created = store.insertOutline({
          projectId,
          volume,
          beforeOutlineId,
          afterOutlineId: afterOutlineId || undefined
        })
        const saved = store.saveOutline({
          id: created.id,
          projectId,
          volume,
          chapterNo: created.chapterNo,
          ...fields
        })
        return {
          ok: true,
          id: saved.id,
          chapterNo: saved.chapterNo,
          title: saved.title,
          created: true,
          ...(afterWinsNew ? { note: 'chapterNo 已被忽略，按 afterOutlineId 插入' } : {})
        }
      }
      const cur = getOutlineOwned(id, projectId)
      // afterOutlineId 优先：避免与 chapterNo 双重移动
      const afterWinsMove = afterOutlineId !== undefined && chapterNo !== undefined
      chapterNo = afterOutlineId ? cur.chapterNo : (chapterNo ?? cur.chapterNo)
      volume = volume ?? cur.volume
      const saved = store.saveOutline({ id, projectId, volume, chapterNo, ...fields })
      if (afterOutlineId) store.moveOutline({ id, afterOutlineId })
      return {
        ok: true,
        id: saved.id,
        chapterNo: saved.chapterNo,
        title: saved.title,
        created: false,
        ...(afterWinsMove ? { note: 'chapterNo 已被忽略，按 afterOutlineId 移动' } : {})
      }
    }
  },
  {
    def: {
      name: 'get_outline_plan',
      description:
        '读取大纲生成页的卷创意与规则参数（存在项目向导存档里，非正式大纲条目）：outlineRules 全书通用规则、currentVolume 向导当前卷、指定卷的 idea 本卷创意（多自然段软分段形态）/rules 本卷节奏规则/count 计划章数。volume 缺省读当前卷；该卷尚无参数时 hasPlan=false',
      input_schema: schema({ volume: optN('卷号，缺省=向导当前卷') }, [])
    },
    danger: false,
    handler: (input, projectId) => {
      const { raw, currentVolume } = readPlanRaw(projectId)
      const volume = optNum(input, 'volume') ?? currentVolume
      if (!Number.isInteger(volume) || volume < 1) throw new Error('volume 必须为正整数卷号')
      const memo = readPlanEntry(raw, volume)
      return {
        volume,
        currentVolume,
        outlineRules: typeof raw.outlineRules === 'string' ? raw.outlineRules : '',
        hasPlan: Object.keys(memo).length > 0,
        idea: typeof memo.idea === 'string' ? memo.idea : '',
        rules: typeof memo.rules === 'string' ? memo.rules : '',
        count: typeof memo.count === 'number' ? memo.count : undefined,
        startNo: typeof memo.startNo === 'number' ? memo.startNo : undefined
      }
    }
  },
  {
    def: {
      name: 'save_outline_plan',
      description:
        '保存大纲生成页的卷创意与规则参数（只改参数，不生成大纲条目）：idea=某卷的本卷创意（应为 3-5 个自然段的软分段卷创意：每段以「开篇章（卷首）：」等相对位置短语开头，禁写死章号）、rules=该卷节奏规则、outlineRules=全书通用规则。volume 缺省为向导当前卷；未传字段保留原值，传空串清空；生成正式大纲条目用 save_outline',
      input_schema: schema(
        {
          volume: optN('目标卷号，缺省=向导当前卷'),
          idea: optS('本卷创意全文'),
          rules: optS('本卷节奏规则'),
          outlineRules: optS('全书通用规则')
        },
        []
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const idea = optStr(input, 'idea')
      const rules = optStr(input, 'rules')
      const outlineRules = optStr(input, 'outlineRules')
      if (idea === undefined && rules === undefined && outlineRules === undefined)
        throw new Error('未提供任何要保存的字段（idea/rules/outlineRules 至少传一个）')
      const { raw, currentVolume } = readPlanRaw(projectId)
      const volume = optNum(input, 'volume') ?? currentVolume
      if (!Number.isInteger(volume) || volume < 1) throw new Error('volume 必须为正整数卷号')
      if (outlineRules !== undefined) raw.outlineRules = outlineRules
      const saved: Record<string, unknown> = {}
      if (idea !== undefined || rules !== undefined) {
        const plans = raw.volumePlans ?? {}
        // 新建条目必须补 count 基底：Outline.tsx 换卷预填会把 undefined count 写进输入框变 NaN
        const next = { ...readPlanEntry(raw, volume) }
        if (idea !== undefined) next.idea = idea
        if (rules !== undefined) next.rules = rules
        if (typeof next.count !== 'number') {
          const owned = store.listOutlines(projectId).filter((o) => o.volume === volume).length
          next.count = owned > 0 ? owned : 30
        }
        plans[String(volume)] = next
        raw.volumePlans = plans
        saved.volume = volume
        saved.idea = next.idea
        saved.rules = next.rules
        saved.count = next.count
      }
      store.updateProject(projectId, { wizardPlan: JSON.stringify(raw) })
      return { ok: true, ...saved, ...(outlineRules !== undefined ? { outlineRules } : {}) }
    }
  },
  {
    def: {
      name: 'delete_outline',
      description: '删除大纲条目（不可恢复，需用户确认）',
      input_schema: schema({ id: s('要删除的大纲 id') }, ['id'])
    },
    danger: true,
    handler: (input, projectId) => {
      const o = getOutlineOwned(reqStr(input, 'id'), projectId)
      store.deleteOutline(o.id)
      return { ok: true, deleted: `第${o.chapterNo}章 ${o.title}` }
    }
  },
  {
    def: {
      name: 'list_chapter_briefs',
      description: '列出各章的写作状态（是否有草稿、字数、章节状态），用于概览全书进度',
      input_schema: schema({}, [])
    },
    danger: false,
    handler: (_input, projectId) =>
      store.listChapterBriefs(projectId).map((b) => ({
        id: b.id,
        chapterNo: b.chapterNo,
        title: b.title,
        status: b.status,
        hasDraft: b.hasDraft,
        wordCount: b.wordCount
      }))
  },
  {
    def: {
      name: 'get_chapter_tail',
      description:
        '读取某一章正文的结尾片段（默认 800 字）。写新章前用它回读上一章结尾，找回语气、悬念与情绪落点',
      input_schema: schema(
        { outlineId: s('大纲条目 id'), chars: optN('要读取的结尾字数，默认 800') },
        ['outlineId']
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const o = getOutlineOwned(reqStr(input, 'outlineId'), projectId)
      const chapter = store.getChapterByOutline(o.id)
      if (!chapter) return { exists: false, note: '该章节还没有正文' }
      const n = Math.min(4000, Math.max(200, optNum(input, 'chars') ?? 800))
      return {
        exists: true,
        chapterNo: o.chapterNo,
        title: o.title,
        wordCount: chapter.wordCount,
        tail: chapter.content.slice(-n)
      }
    }
  },
  {
    def: {
      name: 'list_summaries',
      description:
        '按章列出已定稿的结构化摘要（概要/关键事件/时间线/人物状态/硬账 ledger），供检索前情与数字对账。可选 volume 按卷过滤；默认返回全部',
      input_schema: schema({ volume: optN('按卷号过滤') }, [])
    },
    danger: false,
    handler: (input, projectId) => {
      const volume = optNum(input, 'volume')
      const outlines = store
        .listOutlines(projectId)
        .filter((o) => (volume === undefined ? true : o.volume === volume))
      const items: unknown[] = []
      for (const o of outlines) {
        const chapter = store.getChapterByOutline(o.id)
        if (!chapter) continue
        const s = store.getSummary(chapter.id)
        if (!s) continue
        items.push({
          outlineId: o.id,
          chapterNo: o.chapterNo,
          title: o.title,
          summary: s.summary,
          events: s.events,
          timeline: s.timeline,
          characterStates: s.characterStates,
          ledger: s.ledger
        })
      }
      return { count: items.length, items }
    }
  },
  {
    def: {
      name: 'search_project',
      description:
        '跨板块语义搜索（本地嵌入模型驱动）：在世界观/人物/章节摘要中按含义检索相关内容并返回命中列表。找"和某主题相关的设定/章节"时优先用它，比翻页浏览高效；模型不可用时返回空结果，应回退 list_* 工具',
      input_schema: schema({ query: s('检索语句，如：主角身世相关的伏笔') }, ['query'])
    },
    danger: false,
    handler: async (input, projectId) => {
      const { semanticSearch } = await import('../embedding')
      const hits = await semanticSearch(
        projectId,
        reqStr(input, 'query'),
        ['worldbuild', 'character', 'summary'],
        8
      )
      if (hits.length === 0) return { results: [], note: '无命中或语义检索不可用' }
      const wb = new Map(store.listWorldbuild(projectId).map((e) => [e.id, e]))
      const chs = new Map(store.listCharacters(projectId).map((c) => [c.id, c]))
      const ols = new Map(store.listOutlines(projectId).map((o) => [o.id, o]))
      return {
        results: hits
          .map((h) => {
            if (h.kind === 'worldbuild') {
              const e = wb.get(h.refId)
              return e
                ? {
                    kind: 'worldbuild',
                    id: e.id,
                    title: `[${e.category}] ${e.title}`,
                    snippet: e.content.slice(0, 200),
                    score: h.score
                  }
                : null
            }
            if (h.kind === 'character') {
              const c = chs.get(h.refId)
              return c
                ? {
                    kind: 'character',
                    id: c.id,
                    title: `${c.name}（${c.role || '未定位'}）`,
                    snippet: c.card.slice(0, 200),
                    score: h.score
                  }
                : null
            }
            const o = ols.get(h.refId)
            const chapter = o ? store.getChapterByOutline(o.id) : null
            const sm = chapter ? store.getSummary(chapter.id) : null
            return o && sm
              ? {
                  kind: 'chapter',
                  id: o.id,
                  title: `第${o.chapterNo}章 ${o.title}`,
                  snippet: sm.summary,
                  score: h.score
                }
              : null
          })
          .filter(Boolean)
      }
    }
  },
  {
    def: {
      name: 'grep_project',
      description:
        '全项目字面量搜索：在世界观（标题/标签/检索别名/正文）、人物（姓名/卡面/动态状态）、章节正文（含章节标题）中查找包含 pattern 的条目。要找「哪些地方写了某个确切字符串」（如 [[链接名]] 的引用处、改名前的旧标题、专名统计）用它，比逐条翻页快得多；按含义找相关内容用 search_project。默认字面量子串匹配（区分大小写）；regex=true 时按 JS 正则解释。scope 可限定板块。返回每条命中（命中字段、上下文片段、命中次数）与 matchedItems/totalMatches/byKind 汇总',
      input_schema: schema(
        {
          pattern: s('要查找的字符串（regex=true 时为正则表达式）'),
          regex: optB('按 JS 正则解释 pattern（默认字面量子串）'),
          scope: optS('限定板块：worldbuild / character / chapter（默认全部）'),
          limit: optN('最多返回的命中条目数，默认 30')
        },
        ['pattern']
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const pattern = reqStr(input, 'pattern')
      if (!pattern.trim()) throw new Error('pattern 不能为空')
      const scopeRaw = optStr(input, 'scope')?.trim()
      if (scopeRaw && !['worldbuild', 'character', 'chapter'].includes(scopeRaw))
        throw new Error("scope 必须是 'worldbuild' / 'character' / 'chapter'")
      const scopes = new Set(scopeRaw ? [scopeRaw] : ['worldbuild', 'character', 'chapter'])
      let re: RegExp | null = null
      if (optBool(input, 'regex') === true) {
        try {
          re = new RegExp(pattern, 'g')
        } catch (err) {
          throw new Error(`正则表达式不合法：${(err as Error)?.message ?? String(err)}`)
        }
      }
      // 正则执行时间预算：防灾难性回溯长时间阻塞主进程（单次 exec 内部的回溯无法中断，
      // 时间预算至少能把「每个字段都慢」的多调用场景拦住）
      const REGEX_TIME_BUDGET_MS = 2000
      const regexDeadline = Date.now() + REGEX_TIME_BUDGET_MS
      const matcher = (text: string): Array<{ index: number; length: number }> => {
        const out: Array<{ index: number; length: number }> = []
        if (re) {
          re.lastIndex = 0
          let m: RegExpExecArray | null = re.exec(text)
          while (m) {
            out.push({ index: m.index, length: m[0].length || 1 })
            if (m.index === re.lastIndex) re.lastIndex++
            if (out.length >= 50) break
            if (Date.now() > regexDeadline)
              throw new Error('正则执行超时（疑似灾难性回溯），请化简正则或改用字面量匹配')
            m = re.exec(text)
          }
        } else {
          let i = text.indexOf(pattern)
          while (i !== -1) {
            out.push({ index: i, length: pattern.length })
            i = text.indexOf(pattern, i + pattern.length)
          }
        }
        return out
      }
      const sources: Array<{
        kind: string
        id: string
        title: string
        fields: Array<{ field: string; text: string }>
      }> = []
      if (scopes.has('worldbuild'))
        for (const e of store.listWorldbuild(projectId))
          sources.push({
            kind: 'worldbuild',
            id: e.id,
            title: `[${e.category}] ${e.title}`,
            fields: [
              { field: 'title', text: e.title },
              { field: 'tags', text: e.tags },
              { field: 'keys', text: e.keys },
              { field: 'content', text: e.content }
            ]
          })
      if (scopes.has('character'))
        for (const c of store.listCharacters(projectId))
          sources.push({
            kind: 'character',
            id: c.id,
            title: c.name,
            fields: [
              { field: 'name', text: c.name },
              { field: 'card', text: c.card },
              { field: 'state', text: c.state }
            ]
          })
      if (scopes.has('chapter'))
        for (const o of store.listOutlines(projectId)) {
          const ch = store.getChapterByOutline(o.id)
          if (!ch) continue
          sources.push({
            kind: 'chapter',
            id: o.id,
            title: `第${o.chapterNo}章 ${o.title}`,
            fields: [
              { field: 'title', text: o.title },
              { field: 'content', text: ch.content }
            ]
          })
        }
      const limit = Math.min(100, Math.max(1, optNum(input, 'limit') ?? 30))
      const FRAGMENT_CTX = 40
      const MAX_HITS_PER_ITEM = 3
      const items: unknown[] = []
      let matchedItems = 0
      let totalMatches = 0
      const byKind: Record<string, number> = {}
      for (const src of sources) {
        let count = 0
        const hits: Array<{ field: string; fragment: string }> = []
        for (const f of src.fields) {
          if (!f.text) continue
          for (const m of matcher(f.text)) {
            count++
            if (hits.length < MAX_HITS_PER_ITEM) {
              const start = Math.max(0, m.index - FRAGMENT_CTX)
              const end = Math.min(f.text.length, m.index + m.length + FRAGMENT_CTX)
              hits.push({
                field: f.field,
                fragment: `${start > 0 ? '…' : ''}${f.text.slice(start, end)}${end < f.text.length ? '…' : ''}`
              })
            }
          }
        }
        if (count === 0) continue
        matchedItems++
        totalMatches += count
        byKind[src.kind] = (byKind[src.kind] ?? 0) + 1
        if (items.length < limit)
          items.push({ kind: src.kind, id: src.id, title: src.title, count, hits })
      }
      return {
        matchedItems,
        returned: items.length,
        hasMore: matchedItems > items.length,
        totalMatches,
        byKind,
        items,
        ...(matchedItems > items.length
          ? { note: '命中条目超出 limit，可缩小 scope 或加大 limit 继续' }
          : {})
      }
    }
  },
  {
    def: {
      name: 'save_chapter',
      description: '写入某一章的正文（新建草稿或覆盖已有正文）。覆盖已有正文需用户确认',
      input_schema: schema({ outlineId: s('大纲条目 id'), content: s('完整正文内容') }, [
        'outlineId',
        'content'
      ])
    },
    danger: false,
    handler: (input, projectId) => {
      const o = getOutlineOwned(reqStr(input, 'outlineId'), projectId)
      const chapter = store.saveChapter({
        outlineId: o.id,
        projectId,
        content: reqStr(input, 'content')
      })
      return {
        ok: true,
        chapterNo: o.chapterNo,
        wordCount: chapter.wordCount,
        version: chapter.version
      }
    },
    dangerCheck: (input, projectId) => {
      const outline = store.getOutline(reqStr(input, 'outlineId'))
      if (!outline || outline.projectId !== projectId) return null
      const chapter = store.getChapterByOutline(outline.id)
      if (chapter?.content.trim()) {
        return `将覆盖第${outline.chapterNo}章《${outline.title}》已有正文（${chapter.wordCount} 字，当前版本 v${chapter.version}）`
      }
      return null
    }
  },
  {
    def: {
      name: 'get_book_digest',
      description:
        '获取全书级概览（本地聚合，零成本）：各卷摘要、卷级大纲骨架（每卷首末章与章数）、主要人物当前状态、未回收伏笔统计、最新章节摘要。回答“全书整体脉络/主题/走向”这类全局问题前先调用它，再按需深入具体卷/章',
      input_schema: schema({}, [])
    },
    danger: false,
    handler: (_input, projectId) => {
      const outlines = store.listOutlines(projectId)
      const volumeSummaries = store.listVolumeSummaries(projectId)
      const byVolume = new Map<number, OutlineItem[]>()
      for (const o of outlines) {
        const list = byVolume.get(o.volume) ?? []
        list.push(o)
        byVolume.set(o.volume, list)
      }
      const volumes = [...byVolume.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([vol, list]) => {
          const sorted = list.sort((a, b) => a.chapterNo - b.chapterNo)
          const first = sorted[0]
          const last = sorted[sorted.length - 1]
          const written = sorted.filter((o) => store.getChapterByOutline(o.id)).length
          const vs = volumeSummaries.find((v) => v.volume === vol)
          return {
            volume: vol,
            chapters: list.length,
            written,
            range: `第${first.chapterNo}章 ${first.title} ~ 第${last.chapterNo}章 ${last.title}`,
            summary: vs?.summary ?? null
          }
        })
      const characters = store
        .listCharacters(projectId)
        .filter((c) => c.state.trim())
        .map((c) => ({ name: c.name, role: c.role, state: clip(c.state, 300).text }))
      const openForeshadows = store.listForeshadows(projectId).filter((f) => f.status === 'open')
      const lastWritten = outlines
        .slice()
        .sort((a, b) => a.volume - b.volume || a.chapterNo - b.chapterNo)
        .reverse()
        .find((o) => store.getChapterByOutline(o.id))
      const latest = lastWritten ? store.getChapterByOutline(lastWritten.id) : null
      const latestSummary = latest ? store.getSummary(latest.id) : null
      return {
        totalChapters: outlines.length,
        volumes,
        charactersWithState: characters,
        openForeshadows: {
          count: openForeshadows.length,
          top: openForeshadows
            .slice(0, 12)
            .map((f) => `${f.content}（${f.plantedChapter}${f.priority ? `·${f.priority}` : ''}）`)
        },
        latest: latestSummary
          ? {
              chapterNo: lastWritten?.chapterNo,
              title: lastWritten?.title,
              summary: latestSummary.summary
            }
          : null
      }
    }
  },
  {
    def: {
      name: 'update_character_state',
      description:
        '更新一个人物的“动态状态”字段（物品/能力/身心状态/关系/最近事件）。只改状态、不动人物卡；写章节正文任务完成后，若人物状态发生变化应顺手调用。可用 id 或姓名指定（姓名需唯一）',
      input_schema: schema(
        {
          id: optS('人物 id'),
          name: optS('人物姓名（与 id 二选一）'),
          state: s('更新后的完整状态文档（markdown 要点式）')
        },
        ['state']
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const list = store.listCharacters(projectId)
      const id = optStr(input, 'id')
      const name = optStr(input, 'name')?.trim()
      const hit = id
        ? list.find((c) => c.id === id)
        : name
          ? list.find((c) => c.name.trim() === name || c.name.includes(name))
          : undefined
      if (!hit) throw new Error('未找到该人物（请提供正确的 id 或唯一姓名）')
      store.saveCharacter({ id: hit.id, projectId, name: hit.name, state: reqStr(input, 'state') })
      return { ok: true, id: hit.id, name: hit.name }
    }
  },
  {
    def: {
      name: 'list_foreshadows',
      description:
        '列出当前项目伏笔（含 id、内容、埋设章节、状态、计划回收点、优先级）。章节值随大纲重排实时解析；plannedResolve 为空 = 未安排回收；plannedDangling/plannedResolveDangling=true 表示关联的大纲行已不存在，需要重设。可选 status 过滤：open=未回收（写章前核对台账用）/resolved=已回收',
      input_schema: schema(
        {
          status: optS('按状态过滤：open / resolved，缺省返回全部')
        },
        []
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const nosById = buildOutlineNoIndex(store.listOutlines(projectId))
      const status = optStr(input, 'status')
      if (status !== undefined && !['open', 'resolved'].includes(status))
        throw new Error("status 必须是 'open' / 'resolved'")
      return store
        .listForeshadows(projectId)
        .filter((f) => status === undefined || f.status === status)
        .map((f) => {
          const fallback = (text: string) => (text.trim() ? `第?章(原:${text})` : '')
          return {
            id: f.id,
            content: f.content,
            plantedChapter:
              formatChapterRef(f.plantedChapter, f.plantedOutlineId, nosById) ??
              fallback(f.plantedChapter),
            plantedDangling: isDanglingRef(f.plantedOutlineId, nosById),
            status: f.status,
            resolvedChapter:
              formatChapterRef(f.resolvedChapter, f.resolvedOutlineId, nosById) ??
              fallback(f.resolvedChapter),
            plannedResolve:
              formatChapterRef(f.plannedResolve, f.plannedResolveOutlineId, nosById) ??
              fallback(f.plannedResolve),
            plannedResolveDangling: isDanglingRef(f.plannedResolveOutlineId, nosById),
            priority: f.priority
          }
        })
    }
  },
  {
    def: {
      name: 'save_foreshadow',
      description:
        '新建或修改伏笔。传 id 表示修改；不传 id 表示新建。新建前必须先 list_foreshadows 对照，语义相同的伏笔改为传既有 id 更新，禁止重复登记。可选：plannedResolve（计划回收点）、priority（优先级：主线/人物/氛围）；埋设/回收/计划回收章节写「第N章」或「第V卷N章」会自动关联对应大纲行，重排后自动跟随；区间或模糊写法（如 第30-35章、第30章前后）仅存文本不关联；显式传空串清除该字段（含关联）。修改时未传字段保留原值',
      input_schema: schema(
        {
          id: optS('要修改的伏笔 id（新建时省略）'),
          content: s('伏笔内容'),
          plantedChapter: optS('埋设章节（如 第3章）'),
          status: optS('状态：open/resolved'),
          resolvedChapter: optS('回收章节'),
          plannedResolve: optS('计划回收点'),
          priority: optS('优先级：主线/人物/氛围')
        },
        ['content']
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const status = optStr(input, 'status')
      if (status !== undefined && !['open', 'resolved'].includes(status))
        throw new Error("status 必须是 'open' / 'resolved'")
      const outlines = store.listOutlines(projectId)
      const resolveRef = (text: string): string =>
        resolveChapterRefToOutline(text, outlines)?.id ?? ''
      const plantedChapter = optStr(input, 'plantedChapter')
      const resolvedChapter = optStr(input, 'resolvedChapter')
      const plannedResolve = optStr(input, 'plannedResolve')
      const saved = store.saveForeshadow({
        id: optStr(input, 'id'),
        projectId,
        content: reqStr(input, 'content'),
        plantedChapter,
        plantedOutlineId: plantedChapter === undefined ? undefined : resolveRef(plantedChapter),
        status,
        resolvedChapter,
        resolvedOutlineId: resolvedChapter === undefined ? undefined : resolveRef(resolvedChapter),
        plannedResolve,
        plannedResolveOutlineId:
          plannedResolve === undefined ? undefined : resolveRef(plannedResolve),
        priority: optStr(input, 'priority')
      })
      return {
        ok: true,
        id: saved.id,
        created: !optStr(input, 'id'),
        linked: {
          plantedChapter: saved.plantedOutlineId !== '',
          resolvedChapter: saved.resolvedOutlineId !== '',
          plannedResolve: saved.plannedResolveOutlineId !== ''
        }
      }
    }
  },
  {
    def: {
      name: 'spawn_subagent',
      description:
        '委派一个只读子智能体独立完成调研/分析类子任务。子智能体拥有独立上下文与步数预算（仅只读工具：get_project/list_*/get_entity/grep_project/search_project/get_book_digest），不能写入；适合「通读全书找矛盾」「批量核对设定与人物一致性」「大范围语义调研」这类会耗尽你上下文的任务。task 必须自带完整上下文（调查范围、判断标准、期望报告格式），子智能体看不到你们的对话历史。返回其最终报告',
      input_schema: schema(
        {
          task: s(
            '子任务完整描述：调查什么、范围（哪些卷/章/板块）、判断标准、期望报告格式（如：列出矛盾点，每条含涉及章节与原文依据）'
          ),
          role: optS('角色侧重，如 连续性审校/设定考据/时间线核查，默认通用调研')
        },
        ['task']
      )
    },
    danger: false,
    handler: () => {
      throw new Error('spawn_subagent 需要流式上下文，当前环境不支持')
    },
    execCtx: (input, ctx) =>
      runSubAgent({
        ...ctx,
        task: reqStr(input, 'task'),
        role: optStr(input, 'role')?.trim() ?? ''
      })
  },
  {
    def: {
      name: 'refresh_volume_summary',
      description:
        '重新生成并落库某一卷的卷摘要（走与自动写作相同的生成链：汇总该卷各章已定稿摘要+未回收伏笔+末章人物状态，覆盖旧摘要）。写完一卷/批量改稿后刷新，get_book_digest 里的卷摘要随之更新。该卷没有大纲或没有任何已定稿章节摘要时报错。生成需要一些时间，期间无输出属正常',
      input_schema: schema({ volume: n('卷号，如 1') }, ['volume'])
    },
    danger: false,
    handler: () => {
      throw new Error('refresh_volume_summary 需要流式上下文，当前环境不支持')
    },
    execCtx: async (input, ctx) => {
      const volume = optNum(input, 'volume')
      if (volume === undefined || !Number.isInteger(volume) || volume < 1)
        throw new Error('volume 必须为正整数卷号')
      const request = buildVolumeSummaryRequest(ctx.projectId, volume)
      const auth = await resolveRequestAuth(request.purpose)
      if (!auth.apiKey && auth.needsKey) throw new Error('未配置 API Key，请先在设置中填写')
      const result = await chatStream(
        {
          ...request,
          model: auth.model,
          cacheSystem: auth.promptCache
        },
        { apiKey: auth.apiKey, baseUrl: auth.baseUrl, protocol: auth.protocol },
        () => {},
        ctx.signal
      )
      ctx.usage.inputTokens += result.usage.inputTokens
      ctx.usage.outputTokens += result.usage.outputTokens
      ctx.usage.cacheReadTokens += result.usage.cacheReadTokens
      ctx.usage.cacheCreationTokens += result.usage.cacheCreationTokens
      appendUsage({
        ts: Date.now(),
        model: result.model,
        purpose: 'summary',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        durationMs: result.durationMs,
        ratelimit: pickRatelimitHeaders(result.headers)
      })
      const saved = applyVolumeSummaryResult(ctx.projectId, volume, result.text)
      if (!saved.parsed) throw new Error('卷摘要生成结果为空，请稍后重试或检查模型配置')
      return {
        ok: true,
        volume,
        summaryChars: saved.summaryChars,
        note: `第 ${volume} 卷卷摘要已重新生成并保存（${saved.summaryChars} 字）${auth.fallbackReason ? `。注意：${auth.fallbackReason}` : ''}`
      }
    }
  },
  {
    def: {
      name: 'get_agent_instructions',
      description:
        '读取智能体行为指令：globalText=全局指令（userData/agents.md，所有项目生效）、projectText=本项目指令（用户在界面配置），两者均注入系统提示且项目级优先。用户让你「记住/调整你自己的工作方式」时，先读再改',
      input_schema: schema({}, [])
    },
    danger: false,
    handler: (_input, projectId) => getInstructionsView(projectId)
  },
  {
    def: {
      name: 'set_agent_instructions',
      description:
        '写入智能体行为指令（用户确认后生效，下次任务起注入系统提示）：scope=global 写全局 agents.md（所有项目生效，放跨项目偏好），scope=project 写本项目指令（仅当前项目）。语义为整体替换：把完整的新全文传入 text；只想追加一行时先 get_agent_instructions 取回全文再改。不要用它记录任务内容或项目设定（那些有专门的板块）',
      input_schema: schema(
        {
          scope: s("'global' 或 'project'，写入全局还是本项目"),
          text: s('指令全文（Markdown，整体替换现有内容；清空传空串）')
        },
        ['scope', 'text']
      )
    },
    danger: false,
    dangerCheck: () => '将整体替换智能体行为指令（agents.md / 项目指令）',
    handler: (input, projectId) => {
      const scope = reqStr(input, 'scope')
      const text = reqStr(input, 'text')
      if (scope !== 'global' && scope !== 'project')
        throw new Error("scope 必须是 'global' 或 'project'")
      if (text.length > 20000) throw new Error('指令过长（上限 20000 字），请精简')
      if (scope === 'global') {
        writeGlobalInstructions(text)
        return { ok: true, scope, chars: text.length, note: '全局 agents.md 已更新，下次任务生效' }
      }
      writeProjectInstructions(projectId, text)
      return { ok: true, scope, chars: text.length, note: '本项目指令已更新，下次任务生效' }
    }
  },
  {
    def: {
      name: 'get_writing_rules',
      description:
        '读取全局写作规则（agents.md）中与当前任务相关的分节，返回规则全文。动笔前必须调用：写正文/大纲/人物卡/世界观/伏笔/润色等创作任务按任务类型传 tags，把返回的细则作为本次写作的硬性要求执行。tags 可选值：chapter（章节与结构）、prose（行文与去AI味）、dialogue（对话）、hooks（钩子与节奏）、character（人物塑造）、plot（情节推进）、continuity（视角与对账）、outline（大纲写法）、worldbuild（命名与设定/链接规则）、fore（伏笔维护）、polish（修改与润色）、agent（批量任务与审校）；核心节总会返回。常用组合：写正文传 chapter,prose,dialogue,hooks,plot,continuity,character；改稿传 polish,prose,dialogue,hooks,continuity；大纲传 outline,plot,fore',
      input_schema: schema(
        {
          tags: s('要加载的分节标签数组（如 ["chapter","prose","dialogue"]），也接受逗号分隔字符串')
        },
        []
      )
    },
    danger: false,
    handler: (input) => {
      const tags = (optStrArr(input, 'tags') ?? [])
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
      const rules = writingRulesFor(tags)
      if (!rules) return { tags, rules: '', note: '全局写作规则为空（agents.md 未配置）' }
      return { tags, rules }
    }
  },
  {
    def: {
      name: 'compact_context',
      description:
        '压缩对话历史：把此前全部对话替换为你写的 summary（单段进展摘要）。长任务（批量改写、全书检查、跨卷校对）收到「上下文过大」系统提示、或感觉早前细节已处理完时应主动调用，再轻装继续。调用前把后续仍需要的关键信息写进 summary：任务目标与范围、已完成的修改（含条目 id 与新值）、待办事项、重要发现与决定。summary 写得越完整，压缩后信息损失越小。压缩完成后不要输出确认性文字，直接继续调用工具执行下一步',
      input_schema: schema(
        { summary: s('此前对话的进展摘要（任务目标/已完成修改含 id/待办/关键发现）') },
        ['summary']
      )
    },
    danger: false,
    handler: () => {
      throw new Error('compact_context 由运行时直接处理，不应到达 handler')
    }
  }
]

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.def.name, t]))

export function getToolDefs(): ToolDef[] {
  return TOOLS.map((t) => t.def)
}

export const READ_TOOLS = new Set([
  'get_project',
  'list_characters',
  'get_entity',
  'list_worldbuild',
  'list_outlines',
  'get_outline_plan',
  'list_chapter_briefs',
  'get_chapter_tail',
  'list_summaries',
  'search_project',
  'grep_project',
  'get_book_digest',
  'get_agent_instructions',
  'get_writing_rules',
  'list_foreshadows'
])

export const SUB_TOOLS = TOOLS.filter((t) => READ_TOOLS.has(t.def.name))
export const SUB_TOOL_MAP = new Map(SUB_TOOLS.map((t) => [t.def.name, t]))
