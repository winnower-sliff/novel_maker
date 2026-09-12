import type { WebContents } from 'electron'
import type { AgentDonePayload, ChatMessage, ContentBlock, OutlineItem, ToolDef, UsageInfo } from '../shared/types'
import { splitTags } from '../shared/tags'
import { chatStream, pickRatelimitHeaders } from './llm'
import { getApiKey, getBaseUrl, getPromptCacheEnabled } from './settings'
import * as store from './store'
import { appendUsage } from './usage'

const MAX_TURNS = 24
const MAX_CHAPTER_CHARS = 8000
const MAX_RESULT_CHARS = 6000

export const AGENT_MAX_TOKENS = 8192

interface ToolInput {
  [key: string]: unknown
}

interface AgentTool {
  def: ToolDef
  danger: boolean
  handler: (input: ToolInput, projectId: string) => unknown
  dangerCheck?: (input: ToolInput, projectId: string) => string | null
}

function schema(
  props: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return { type: 'object', properties: props, required }
}

function s(desc: string): Record<string, unknown> {
  return { type: 'string', description: desc }
}

function optS(desc: string): Record<string, unknown> {
  return { type: 'string', description: `${desc}（可选）` }
}

function optN(desc: string): Record<string, unknown> {
  return { type: 'number', description: `${desc}（可选）` }
}

function reqStr(input: ToolInput, key: string): string {
  const v = input[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${key} 缺失或为空`)
  return v
}

function optStr(input: ToolInput, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' ? v : undefined
}

function reqNum(input: ToolInput, key: string): number {
  const v = input[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${key} 必须为数字`)
  return v
}

function optNum(input: ToolInput, key: string): number | undefined {
  const v = input[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}\n…[已截断，原文共 ${text.length} 字]`, truncated: true }
}

function getOutlineOwned(outlineId: string, projectId: string): OutlineItem {
  const outline = store.getOutline(outlineId)
  if (!outline || outline.projectId !== projectId) throw new Error(`大纲条目 ${outlineId} 不存在`)
  return outline
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
      return { title: p.title, genre: p.genre, styleGuide: p.styleGuide, targetWords: p.targetWords, status: p.status }
    }
  },
  {
    def: {
      name: 'update_project',
      description: '修改当前项目的元信息。只传需要修改的字段',
      input_schema: schema(
        { title: optS('新标题'), genre: optS('新类型'), styleGuide: optS('新风格指南'), targetWords: optN('新目标字数') },
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
      description: '列出当前项目全部人物卡（含 id、姓名、定位、标签与人物卡正文）',
      input_schema: schema({}, [])
    },
    danger: false,
    handler: (_input, projectId) =>
      store.listCharacters(projectId).map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        tags: c.tags,
        card: clip(c.card, 3000).text
      }))
  },
  {
    def: {
      name: 'save_character',
      description: '新建或修改人物卡。传 id 表示修改既有人物；不传 id 表示新建。修改时应先 list_characters 取原文再改',
      input_schema: schema(
        { id: optS('要修改的人物 id（新建时省略）'), name: s('姓名'), role: optS('定位，如 主角/反派/配角'), tags: optS('标签'), card: optS('人物卡正文（markdown）') },
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
      name: 'delete_character',
      description: '删除人物卡（不可恢复，需用户确认）',
      input_schema: schema({ id: s('要删除的人物 id') }, ['id'])
    },
    danger: true,
    handler: (input, projectId) => {
      const c = store.listCharacters(projectId).find((x) => x.id === reqStr(input, 'id'))
      if (!c) throw new Error('未找到该人物')
      store.deleteCharacter(c.id)
      return { ok: true, deleted: c.name }
    }
  },
  {
    def: {
      name: 'list_worldbuild',
      description: '列出当前项目全部世界观词条（含 id、类型、标题、标签与内容）',
      input_schema: schema({}, [])
    },
    danger: false,
    handler: (_input, projectId) =>
      store.listWorldbuild(projectId).map((e) => ({
        id: e.id,
        category: e.category,
        title: e.title,
        tags: e.tags,
        content: clip(e.content, 3000).text
      }))
  },
  {
    def: {
      name: 'save_worldbuild',
      description:
        '新建或修改世界观词条。传 id 表示修改；不传 id 表示新建。category 为类型（每条目一个，优先复用现有类型，不轻易新建）；tags 为标签（逗号分隔，2-6 个，优先复用现有标签，不轻易新建，且不得与类型重名）',
      input_schema: schema(
        {
          id: optS('要修改的词条 id（新建时省略）'),
          category: s('类型，优先复用现有类型'),
          title: s('标题'),
          tags: optS('标签，逗号分隔（如：精灵,森林,魔法）'),
          content: optS('正文内容')
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
      const rawTags = optStr(input, 'tags') ?? ''
      const tags = splitTags(rawTags).filter((t) => !knownTypes.has(t) && t !== category).slice(0, 6)
      const saved = store.saveWorldbuild({
        id: optStr(input, 'id'),
        projectId,
        category,
        title: reqStr(input, 'title'),
        tags: tags.join(','),
        content: optStr(input, 'content')
      })
      return { ok: true, id: saved.id, title: saved.title, created: !optStr(input, 'id') }
    }
  },
  {
    def: {
      name: 'delete_worldbuild',
      description: '删除世界观词条（不可恢复，需用户确认）',
      input_schema: schema({ id: s('要删除的词条 id') }, ['id'])
    },
    danger: true,
    handler: (input, projectId) => {
      const e = store.listWorldbuild(projectId).find((x) => x.id === reqStr(input, 'id'))
      if (!e) throw new Error('未找到该词条')
      store.deleteWorldbuild(e.id)
      return { ok: true, deleted: e.title }
    }
  },
  {
    def: {
      name: 'list_outlines',
      description: '列出当前项目全部大纲条目（含 id、卷号、章号、标题、梗概、状态）',
      input_schema: schema({}, [])
    },
    danger: false,
    handler: (_input, projectId) =>
      store.listOutlines(projectId).map((o) => ({
        id: o.id,
        volume: o.volume,
        chapterNo: o.chapterNo,
        title: o.title,
        synopsis: o.synopsis,
        status: o.status
      }))
  },
  {
    def: {
      name: 'save_outline',
      description: '新建或修改大纲条目。传 id 表示修改既有条目；不传 id 表示新建（volume 与 chapterNo 必填）',
      input_schema: schema(
        {
          id: optS('要修改的大纲 id（新建时省略）'),
          volume: optN('卷号（新建必填）'),
          chapterNo: optN('章号（新建必填）'),
          title: optS('章节标题'),
          synopsis: optS('章节梗概'),
          status: optS("状态：draft/approved/written/polished")
        },
        []
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const id = optStr(input, 'id')
      let volume = optNum(input, 'volume')
      let chapterNo = optNum(input, 'chapterNo')
      if (id) {
        const cur = getOutlineOwned(id, projectId)
        volume = volume ?? cur.volume
        chapterNo = chapterNo ?? cur.chapterNo
      }
      if (volume === undefined || chapterNo === undefined) throw new Error('新建时 volume 与 chapterNo 必填')
      const saved = store.saveOutline({
        id,
        projectId,
        volume,
        chapterNo,
        title: optStr(input, 'title'),
        synopsis: optStr(input, 'synopsis'),
        status: optStr(input, 'status') as never
      })
      return { ok: true, id: saved.id, chapterNo: saved.chapterNo, title: saved.title, created: !id }
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
      name: 'get_chapter',
      description: '读取某一章的正文全文（超长会截断）',
      input_schema: schema({ outlineId: s('大纲条目 id') }, ['outlineId'])
    },
    danger: false,
    handler: (input, projectId) => {
      const o = getOutlineOwned(reqStr(input, 'outlineId'), projectId)
      const chapter = store.getChapterByOutline(o.id)
      if (!chapter) return { exists: false, note: '该章节还没有正文' }
      const c = clip(chapter.content, MAX_CHAPTER_CHARS)
      return { exists: true, chapterNo: o.chapterNo, title: o.title, wordCount: chapter.wordCount, truncated: c.truncated, content: c.text }
    }
  },
  {
    def: {
      name: 'save_chapter',
      description: '写入某一章的正文（新建草稿或覆盖已有正文）。覆盖已有正文需用户确认',
      input_schema: schema({ outlineId: s('大纲条目 id'), content: s('完整正文内容') }, ['outlineId', 'content'])
    },
    danger: false,
    handler: (input, projectId) => {
      const o = getOutlineOwned(reqStr(input, 'outlineId'), projectId)
      const chapter = store.saveChapter({
        outlineId: o.id,
        projectId,
        content: reqStr(input, 'content')
      })
      return { ok: true, chapterNo: o.chapterNo, wordCount: chapter.wordCount, version: chapter.version }
    },
    dangerCheck: (input, projectId) => {
      const outline = store.getOutline(reqStr(input, 'outlineId'))
      if (!outline || outline.projectId !== projectId) return null
      const chapter = store.getChapterByOutline(outline.id)
      if (chapter && chapter.content.trim()) {
        return `将覆盖第${outline.chapterNo}章《${outline.title}》已有正文（${chapter.wordCount} 字，当前版本 v${chapter.version}）`
      }
      return null
    }
  },
  {
    def: {
      name: 'list_foreshadows',
      description: '列出当前项目全部伏笔（含 id、内容、埋设章节、状态）',
      input_schema: schema({}, [])
    },
    danger: false,
    handler: (_input, projectId) =>
      store.listForeshadows(projectId).map((f) => ({
        id: f.id,
        content: f.content,
        plantedChapter: f.plantedChapter,
        status: f.status,
        resolvedChapter: f.resolvedChapter
      }))
  },
  {
    def: {
      name: 'save_foreshadow',
      description: '新建或修改伏笔。传 id 表示修改；不传 id 表示新建',
      input_schema: schema(
        {
          id: optS('要修改的伏笔 id（新建时省略）'),
          content: s('伏笔内容'),
          plantedChapter: optS('埋设章节（如 第3章）'),
          status: optS('状态：open/resolved'),
          resolvedChapter: optS('回收章节')
        },
        ['content']
      )
    },
    danger: false,
    handler: (input, projectId) => {
      const saved = store.saveForeshadow({
        id: optStr(input, 'id'),
        projectId,
        content: reqStr(input, 'content'),
        plantedChapter: optStr(input, 'plantedChapter'),
        status: optStr(input, 'status'),
        resolvedChapter: optStr(input, 'resolvedChapter')
      })
      return { ok: true, id: saved.id, created: !optStr(input, 'id') }
    }
  },
  {
    def: {
      name: 'delete_foreshadow',
      description: '删除伏笔（不可恢复，需用户确认）',
      input_schema: schema({ id: s('要删除的伏笔 id') }, ['id'])
    },
    danger: true,
    handler: (input, projectId) => {
      const f = store.listForeshadows(projectId).find((x) => x.id === reqStr(input, 'id'))
      if (!f) throw new Error('未找到该伏笔')
      store.deleteForeshadow(f.id)
      return { ok: true, deleted: f.content }
    }
  }
]

const TOOL_MAP = new Map(TOOLS.map((t) => [t.def.name, t]))

const READ_TOOLS = new Set([
  'get_project',
  'list_characters',
  'list_worldbuild',
  'list_outlines',
  'list_chapter_briefs',
  'get_chapter',
  'list_foreshadows'
])

export function getAgentToolDefs(): ToolDef[] {
  return TOOLS.map((t) => t.def)
}

interface RunState {
  confirms: Map<string, { resolve: (allow: boolean) => void; toolName: string }>
  alwaysAllowed: Set<string>
}

const activeRuns = new Map<string, RunState>()

export function resolveAgentConfirm(
  requestId: string,
  confirmId: string,
  allow: boolean,
  always: boolean
): boolean {
  const run = activeRuns.get(requestId)
  if (!run) return false
  const pending = run.confirms.get(confirmId)
  if (!pending) return false
  run.confirms.delete(confirmId)
  if (always && allow) run.alwaysAllowed.add(pending.toolName)
  pending.resolve(allow)
  return true
}

export function cancelAgentConfirms(requestId: string): void {
  const run = activeRuns.get(requestId)
  if (!run) return
  for (const pending of run.confirms.values()) pending.resolve(false)
  run.confirms.clear()
}

function buildSystemPrompt(projectId: string): string {
  const project = store.listProjects().find((p) => p.id === projectId)
  if (!project) throw new Error('项目不存在，无法启动智能体')
  return [
    '你是小说项目的智能体编辑助理，通过工具直接读写当前项目的资料库（人物、世界观、大纲、章节正文、伏笔）。',
    '',
    `当前项目：《${project.title}》${project.genre ? `（类型：${project.genre}）` : ''}`,
    project.styleGuide ? `风格指南：\n${project.styleGuide}` : '（未配置风格指南）',
    '',
    '工作规则：',
    '1. 修改前先用读工具核实目标（例如按名字找到准确 id），禁止凭记忆猜测 id',
    '2. 修改既有内容时，先取回原文，在原文基础上修改，不要凭空整段重写',
    '3. 新建条目时不传 id；修改时必须传 id',
    '4. 每完成一个任务，用简短中文总结做了什么；不要输出与任务无关的内容',
    '5. 若某操作被用户拒绝，不要重试同一操作，改为说明原因并询问下一步建议',
    '6. 用户要求模糊时（如"优化一下大纲"），先读取现状再决定改法，必要时先说明你的计划'
  ].join('\n')
}

function serializeResult(data: unknown): string {
  let text: string
  if (typeof data === 'string') text = data
  else text = JSON.stringify(data, null, 0)
  return clip(text, MAX_RESULT_CHARS).text
}

export async function runAgent(opts: {
  win: WebContents
  requestId: string
  projectId: string
  messages: ChatMessage[]
  model: string
  signal: AbortSignal
}): Promise<AgentDonePayload> {
  const { win, requestId, projectId, signal } = opts
  const send = (channel: string, ...args: unknown[]): void => {
    if (!win.isDestroyed()) win.send(channel, requestId, ...args)
  }

  const apiKey = await getApiKey()
  if (!apiKey) throw new Error('未配置 API Key，请先在设置中填写')
  const baseUrl = await getBaseUrl()
  const promptCache = await getPromptCacheEnabled()
  const system = buildSystemPrompt(projectId)

  const runState: RunState = { confirms: new Map(), alwaysAllowed: new Set() }
  activeRuns.set(requestId, runState)

  const usage: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  }
  const messages = [...opts.messages]
  const tools = getAgentToolDefs()
  let requests = 0
  let turnCount = 0
  let changed = false
  let denied = false
  let finalText = ''
  let lastModel = opts.model
  let hitLimit = false
  const started = Date.now()

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      turnCount = turn + 1
      const result = await chatStream(
        {
          model: opts.model,
          system,
          messages,
          tools,
          maxTokens: AGENT_MAX_TOKENS,
          purpose: 'agent',
          cacheSystem: promptCache
        },
        { apiKey, baseUrl },
        (text) => send('agent:delta', text),
        signal
      )
      requests++
      lastModel = result.model
      usage.inputTokens += result.usage.inputTokens
      usage.outputTokens += result.usage.outputTokens
      usage.cacheReadTokens += result.usage.cacheReadTokens
      usage.cacheCreationTokens += result.usage.cacheCreationTokens
      appendUsage({
        ts: Date.now(),
        model: result.model,
        purpose: 'agent',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        durationMs: result.durationMs,
        ratelimit: pickRatelimitHeaders(result.headers)
      })

      if (result.toolUses.length === 0) {
        finalText = result.text
        break
      }

      const assistantBlocks: ContentBlock[] = []
      if (result.text) assistantBlocks.push({ type: 'text', text: result.text })
      for (const tu of result.toolUses) {
        assistantBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
      }
      messages.push({ role: 'assistant', content: assistantBlocks })

      const resultBlocks: ContentBlock[] = []
      for (const tu of result.toolUses) {
        const tool = TOOL_MAP.get(tu.name)
        if (!tool) {
          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `错误: 未知工具 ${tu.name}`,
            is_error: true
          })
          send('agent:toolResult', { id: tu.id, ok: false, result: `未知工具 ${tu.name}` })
          continue
        }

        let dangerReason: string | null = null
        if (tool.danger) dangerReason = '删除操作不可恢复'
        if (tool.dangerCheck) {
          try {
            dangerReason = tool.dangerCheck(tu.input, projectId) ?? dangerReason
          } catch {
            /* 参数不合法时交给 handler 报错 */
          }
        }

        if (dangerReason && !runState.alwaysAllowed.has(tu.name)) {
          send('agent:toolCall', { id: tu.id, name: tu.name, input: tu.input, state: 'confirming', dangerReason })
          const allowed = await new Promise<boolean>((resolve) => {
            runState.confirms.set(tu.id, { resolve, toolName: tu.name })
          })
          if (!allowed) {
            denied = true
            const msg = '用户拒绝了该操作'
            resultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true })
            send('agent:toolResult', { id: tu.id, ok: false, result: msg, denied: true })
            continue
          }
        } else {
          send('agent:toolCall', { id: tu.id, name: tu.name, input: tu.input, state: 'running' })
        }

        let ok: boolean
        let out: string
        try {
          out = serializeResult(await tool.handler(tu.input, projectId))
          ok = true
          if (!READ_TOOLS.has(tu.name)) changed = true
        } catch (err) {
          out = `错误: ${(err as Error)?.message ?? String(err)}`
          ok = false
        }
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: out,
          is_error: ok ? undefined : true
        })
        send('agent:toolResult', { id: tu.id, ok, result: out })
      }
      messages.push({ role: 'user', content: resultBlocks })

      if (turn === MAX_TURNS - 1) hitLimit = true
    }
  } finally {
    cancelAgentConfirms(requestId)
    activeRuns.delete(requestId)
  }

  return {
    text: finalText,
    turns: turnCount,
    requests,
    changed,
    denied,
    hitLimit,
    usage,
    model: lastModel,
    durationMs: Date.now() - started
  }
}
