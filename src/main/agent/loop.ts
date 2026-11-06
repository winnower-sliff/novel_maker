import type {
  Book,
  ChatMessage,
  ContentBlock,
  LintReport,
  Scene,
  ToolDef
} from '../../shared/types.js'
import { callJson, callRaw } from '../director/callJson.js'
import { bookBasics, directorPersona, redlineBlock, wordListBlock } from '../director/prompts.js'
import {
  applyRevisePlan,
  autoFixDraft,
  genDraft,
  genRevisePlan,
  selfCheck
} from '../director/steps.js'
import { lintChapter, stripHtmlComments } from '../lint.js'
import * as store from '../store.js'
import { execTool, type ToolCtx, type ToolResult, toolDefs } from './tools.js'

/**
 * M6 agent 主循环：自由 LLM 工具循环（用户拍板「全面 agent 化」）。
 * - 普通工具（CRUD）走 execTool；三个拦截工具在本文件：
 *   write_chapter_draft（流式写正文+lint+自动修一轮）/ commit_chapter（落章）/ finish（收工）。
 * - 工具卡=messages 表独立行（meta={kind:'tool',jobId,name,summary}），聊天流即工作日志。
 * - 每轮系统提示重新注入红线/正负词/文风（防长程遗忘）。
 */

/** 消息字符量（blocks 逐块累计），供上下文压缩阈值判断 */
function messageChars(m: ChatMessage): number {
  if (typeof m.content === 'string') return m.content.length
  return m.content.reduce((n, b) => {
    if (b.type === 'text') return n + b.text.length
    if (b.type === 'tool_use') return n + b.name.length + JSON.stringify(b.input).length
    return n + b.content.length
  }, 0)
}

/** 压缩用的消息概览行：角色+文本/工具名+参数摘要/工具结果摘要 */
function messageToBrief(m: ChatMessage): string {
  if (typeof m.content === 'string') return `${m.role}: ${m.content}`
  return m.content
    .map((b) => {
      if (b.type === 'text') return `${m.role}: ${b.text.slice(0, 200)}`
      if (b.type === 'tool_use')
        return `${m.role}→工具 ${b.name}(${JSON.stringify(b.input).slice(0, 200)})`
      return `${m.role}←结果: ${b.content.slice(0, 300)}`
    })
    .join('\n')
}

/** 摘要调用失败时的降级：逐条截断保平铺信息 */
function fallbackDigest(mid: ChatMessage[]): string {
  return mid
    .map((m) => messageToBrief(m).slice(0, 120))
    .join('\n')
    .slice(0, 2400)
}

export interface LoopOpts {
  jobId: string
  bookId: string
  /** 给 agent 的任务指令（写章/聊天/自由任务） */
  task: string
  /** 对话历史（ChatMessage 文本投影；写章任务通常为空） */
  history: ChatMessage[]
  /** agent 可用工具（含拦截工具的 ToolDef） */
  tools: ToolDef[]
  /** 场景：写章（有 commit 链）或自由（无 commit） */
  mode: 'chapter' | 'free'
  maxTurns?: number
  /** 覆盖系统提示（子代理用调查员提示；默认导演人格 agentSystem） */
  system?: string
  /** 导演白话流式（chat 气泡预览；正文/改章不走这里——见 onProgress） */
  onDelta?: (t: string) => void
  /** 思考链流式（chat 折叠区；正文/改章不接） */
  onThinking?: (t: string) => void
  /** 生成进度（正文/改章字数计数，聚合条显示；正文不进聊天流） */
  onProgress?: (p: { phase: 'draft' | 'revise'; chars: number }) => void
  /** 落一条 assistant 消息（agent 白话/工具卡） */
  say: (content: string, meta?: Record<string, unknown>) => void
  /** 落章后回调（note chapter 消息/recap 进 payload/记忆压缩/审计排队——jobs.ts 注入） */
  onChapterCommitted?: (
    chapter: { id: string; title: string; wordCount: number; orderNo: number; content: string },
    extra: { summary: string; quickActions: Array<{ label: string; instruction: string }> }
  ) => void
  /** 意图动作（free 模式对话驱动；jobs.ts 注入避免循环依赖） */
  actions?: {
    startChapter?: (directionHint?: string) => string
    review?: (chapterId?: string) => Promise<string>
    audit?: () => Promise<string>
  }
}

export interface LoopResult {
  /** agent 最终白话（finish 的 message 或最后一轮文本） */
  text: string
  turns: number
  /** 本次会话写章次数 */
  chaptersCommitted: number
}

/** 拦截工具的 ToolDef（拼在普通工具后） */
export function interceptorDefs(mode: 'chapter' | 'free'): ToolDef[] {
  const defs: ToolDef[] = [
    {
      name: 'finish',
      description:
        '任务完成时调用：带一句给作者的收尾白话（写完章=汇报本章成果+下一步建议；聊天=你的回答已说清则直接 finish）。',
      input_schema: {
        type: 'object',
        properties: { message: { type: 'string', description: '给作者的收尾白话' } },
        required: ['message']
      }
    },
    {
      name: 'revise_chapter',
      description:
        '按指令改已有章（整章或选段）。默认做局部替换（只动点名处，未点名一字不动），直接替换旧版不留档；只有作者明确要求推倒重写才整章重写。',
      input_schema: {
        type: 'object',
        properties: {
          chapterId: { type: 'string' },
          instruction: {
            type: 'string',
            description: '改稿指令（如「更狠：把打斗写实，收尾更冷」）'
          },
          segment: { type: 'string', description: '可选：只改这段原文（选段改）' }
        },
        required: ['chapterId', 'instruction']
      }
    },
    {
      name: 'spawn_subagent',
      description:
        '派只读调查员帮你翻资料（省你的上下文）：它自己多轮读章节/设定/人物/伏笔/范文/检索，只把最终结论带回来，调查过程不占你的空间。适合「把某线人物关系摸一遍」「查某伏笔现状」「找前文原句」这类读书量大的活；单点查询直接自己调读工具更快。',
      input_schema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: '调查任务，要具体：查什么、按什么格式返回（一个子代理一个任务）'
          }
        },
        required: ['task']
      }
    }
  ]
  if (mode === 'free') {
    defs.push(
      {
        name: 'propose_chapter',
        description:
          '作者想写新章时调用：把写章任务排进队列，agent 据作者倾向（未给则综合现状）自主完成全章。当前有任务在跑则自动排队。',
        input_schema: {
          type: 'object',
          properties: {
            directionHint: {
              type: 'string',
              description: '可选：作者提到的方向倾向，会作为本章走向依据'
            }
          },
          required: []
        }
      },
      {
        name: 'request_review',
        description:
          '审读指定章（七维报告带引文）。不传 chapterId 默认审最近一章。报告直接返回给你，向作者转述要点。',
        input_schema: {
          type: 'object',
          properties: { chapterId: { type: 'string', description: '默认最近一章' } },
          required: []
        }
      },
      {
        name: 'request_audit',
        description:
          '全书审计（文风漂移/剧情空转/连续性）。章数少于 2 会直接失败。报告返回给你，向作者转述要点。',
        input_schema: { type: 'object', properties: {}, required: [] }
      }
    )
  }
  if (mode === 'chapter') {
    defs.unshift(
      {
        name: 'write_chapter_draft',
        description:
          '写本章正文：传你拟好的章题+梗概+3-6 拍点（可选分镜）。系统会流式写作+自动自检（负向词/接缝/穿帮/字数），不过自动修一轮。返回最终稿与报告，你审阅后决定 commit_chapter 或重写。',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '章题' },
            synopsis: { type: 'string', description: '本章梗概（150-300字）' },
            beats: {
              type: 'array',
              items: { type: 'string' },
              description: '拍点序列（3-6 拍）'
            },
            scenes: {
              type: 'array',
              description: '可选分镜 [{summary,viewpoint,pace}]',
              items: {
                type: 'object',
                properties: {
                  summary: { type: 'string' },
                  viewpoint: { type: 'string' },
                  pace: { type: 'string' }
                },
                required: ['summary']
              }
            }
          },
          required: ['title', 'synopsis', 'beats']
        }
      },
      {
        name: 'commit_chapter',
        description:
          '正文定稿入书（调它之前必须已有一稿通过或你判断可接受的 write_chapter_draft）。传入本章 100-200 字纪要。',
        input_schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '本章纪要（100-200字，进滚动记忆）' }
          },
          quickActions: {
            type: 'array',
            description: '2-3 个本章专属快捷改章建议 [{label:4-8字, instruction:具体指令}]',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, instruction: { type: 'string' } },
              required: ['label', 'instruction']
            }
          },
          required: ['summary']
        }
      }
    )
  }
  return defs
}

/** agent 系统提示（每轮重建，红线/正负词/文风随库内最新值注入） */
function sampleBlock(book: Book): string {
  const bounds = book.sampleSources
    .map((id) => store.getSample(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
  if (!bounds.length) return ''
  const list = bounds
    .map((s) => {
      const secs = store.listSampleSections(s.id)
      const chN = secs.filter((x) => x.kind === 'chapter').length
      return `- 《${s.name}》（全文 ${s.chars} 字${chN ? `，${chN} 章` : ''}）`
    })
    .join('\n')
  return `

## 绑定范文
${list}
- read_sample 支持四种读法：toc 看目录（卷名/章节名清单，找不到位置时先用它）、chapter 章号直达（如第 3 章）、query 关键词检索（如「登船」「林岸」）、offsetPct 百分比翻页。
- 用途：模仿句式/节奏/叙事腔调——绝不抄内容、不搬人物情节。动笔前按本章要素检索一段找语感（write_chapter_draft 也会自动检索注入范文参考段）。`
}

/**
 * 范文参考段检索（用户决策：不固定截开头，动笔前按本章内容主动检索注入；
 * 检索词由 LLM 决定——按本章的场景/动作/意象/情绪自选，而非程序硬提人名）。
 * 一次轻量 LLM 调用出词 → 逐本搜节取片段；每本最多 2 段、总预算约 2400 字。
 * 出词失败或全 miss 返回 ''（不注入，不阻断写章）。
 */
export async function genStyleRefs(
  book: Book,
  outline: { title: string; synopsis: string; beats: string[] }
): Promise<string> {
  if (!book.sampleSources.length) return ''
  const samples = book.sampleSources
    .map((id) => store.getSample(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
  if (!samples.length) return ''
  const listTxt = samples.map((s) => `《${s.name}》`).join('、')
  let queries: Array<{ sample: string; q: string }> = []
  try {
    const res = await callJson<{ queries?: Array<{ sample?: string; q?: string }> }>({
      slot: 'utility',
      system: '你是范文检索助手，只输出 JSON。',
      user: `你将为小说写作挑选范文参考段的检索词。

## 绑定范文
${samples.map((s, i) => `${i + 1}. 《${s.name}》`).join('\n')}

## 本章信息
标题：${outline.title}
梗概：${outline.synopsis}
拍点：${outline.beats.join('；')}

## 任务
针对每一本范文，给出 1-3 个用于在其全文中检索参考段的**关键词**。
- 词要来自本章的场景/动作/意象/情绪/桥段类型（如「夜袭」「审讯」「重逢」「暴雨中的对峙」），不要用本书人名（范文是另一部作品，人名大概率不存在）。
- 想模仿哪类写法（打斗节奏/对话密度/环境烘托），就检索那类桥段。

输出 JSON：{"queries":[{"sample":"范文名","q":"关键词"}]}，总数不超过 ${Math.min(6, samples.length * 3)} 个。`,
      jsonHint: '{"queries":[{"sample":"范文名","q":"关键词"}]}'
    })
    queries = (res.queries ?? [])
      .filter((x) => x.sample && x.q)
      .map((x) => ({ sample: x.sample ?? '', q: x.q ?? '' }))
  } catch {
    return '' // 出词失败静默跳过
  }
  const BUDGET = 2400
  const parts: string[] = []
  let used = 0
  for (const s of samples) {
    const words = queries
      .filter((x) => x.sample.includes(s.name) || s.name.includes(x.sample))
      .map((x) => x.q)
    let hits = 0
    for (const q of words) {
      if (hits >= 2 || used >= BUDGET) break
      const hit = store.searchSampleSections(s.id, s.content, q)
      if (hit.offset < 0) continue
      const seg = s.content.slice(hit.offset, hit.offset + 1200)
      parts.push(`◆ 《${s.name}》（检索词「${q}」）\n${seg}`)
      used += seg.length
      hits++
    }
  }
  return parts.join('\n\n')
}

function agentSystem(book: Book, mode: 'chapter' | 'free'): string {
  const chapterDiscipline =
    mode === 'chapter'
      ? `

## 写章任务纪律（当前处于写章流程，作者已选定走向）
1. 先 get_write_context 拿上下文（钉选设定/伏笔/人物现状/近章），再动笔。${book.sampleSources.length ? '动笔前可用 read_sample 按本章要素检索一段范文找语感（draft 时系统也会自动检索注入）。' : ''}
2. write_chapter_draft 一次成型；报告有问题而你判断可修→再 draft 一次；系统已自动修过一轮仍 major 的字数/接缝问题，若你判断无法两全→commit 前在 finish 里说明，或与作者商量（作者接受瑕疵）。
3. commit_chapter 后立即做沉淀：新设定 save_card、人物动向 patch_character_state、伏笔三态 save_foreshadow。这是纪律，不许跳过。
4. 全部做完 finish 收尾（汇报+建议下一章走向）。`
      : `

## 自由任务纪律
- 你没有 commit_chapter/write_chapter_draft 权限（写新章走「写下一章」流程，作者会先选走向）。
- 作者要在已有章上改稿→revise_chapter；维护设定/人物/伏笔/红线/正负词→对应工具。
- 作者要写新章→白话引导他点「写下一章」按钮。`
  return `${directorPersona()}

${bookBasics(book)}
${redlineBlock(book)}
${wordListBlock(book)}
${sampleBlock(book)}
${chapterDiscipline}

## 工具纪律
- 每次工具调用都会以小卡形式给作者看，大方用。
- 删除类工具已自动快照兜底，但删除前仍要确认作者意图。
- 工具结果太长会被截断，需要细节就用读类工具分页看。
- 要翻大量资料但只需要结论（摸人物关系、查伏笔现状、找前文原句）时，派 spawn_subagent 去调查——它只把最终结论带回你的上下文，省你自己的空间。日常单点查询不必派。`
}

/** 子代理调查员系统提示（fresh 会话，只读，静默执行） */
const SUB_SYSTEM = `你是只读调查员，受导演指派调查小说项目的资料，只输出调查结论。

## 纪律
1. 你只有读类工具：绝不改动任何东西（也没有写类工具可用）。
2. 自己多轮翻资料凑齐证据（章节/设定/人物/伏笔/范文/检索），调查是你一个人的事，不要中途交半成品。
3. 材料够就 finish 汇报：按任务要求给要点/清单/原文摘录；需要原文的地方给准确引句；不要写调查流水账，不要客套。`

const MAX_DATA = 30000
const N = '\n'

/** 子代理可用工具：全部读类 + finish */
const READ_TOOLS = new Set([
  'get_book_config',
  'list_chapters',
  'read_chapter',
  'list_cards',
  'get_card',
  'list_characters',
  'list_foreshadows',
  'get_write_context',
  'list_samples',
  'read_sample',
  'search_project'
])

function subTools(): ToolDef[] {
  const defs = toolDefs().filter((d) => READ_TOOLS.has(d.name))
  defs.push({
    name: 'finish',
    description: '调查完成时调用：给出最终结论。',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string', description: '调查结论（要点/清单/原文摘录）' } },
      required: ['message']
    }
  })
  return defs
}

function clipData(s: string): string {
  return s.length > MAX_DATA ? `${s.slice(0, MAX_DATA)}\n…（结果过长已截断）` : s
}

export async function runAgentLoop(opts: LoopOpts): Promise<LoopResult> {
  const { jobId, bookId, task, mode } = opts
  const maxTurns = opts.maxTurns ?? 30
  const ctx: ToolCtx = { bookId }

  let book: Book
  {
    const initial = store.getBook(bookId)
    if (!initial) throw new Error('书不存在')
    book = initial
  }

  // 写章会话内暂存的最近草稿（commit_chapter 用）
  let lastDraft: {
    title: string
    synopsis: string
    beats: string[]
    content: string
    report: LintReport
  } | null = null
  let chaptersCommitted = 0
  let finishText = ''
  let lastFinishMessage = ''

  const messages: ChatMessage[] = [...opts.history, { role: 'user', content: task }]
  const historyLen = opts.history.length
  let compacted = false

  /**
   * 上下文压缩：一轮对话累计超 60000 字且未压缩过时，
   * 把 history 之后、末尾 8 条之前的中间段摘要成一条〔前情工作纪要〕。
   * 摘要失败退回逐条截断，保证调用必达。
   */
  async function compactIfNeeded(): Promise<void> {
    if (compacted) return
    const chars = messages.reduce((n, m) => n + messageChars(m), 0)
    if (chars <= 60000) return
    const tailStart = Math.max(historyLen + 1, messages.length - 8)
    if (tailStart - (historyLen + 1) < 4) return // 中段太薄不值得压
    // 尾段起点前移到安全边界（tool_result 必须紧跟对应 tool_use，不能被切开）
    let safe = tailStart
    while (safe > historyLen + 1 && messages[safe]?.role !== 'user') safe--
    if (safe <= historyLen + 1 || safe === tailStart) safe = tailStart
    const mid = messages.slice(historyLen + 1, safe)
    const rows = mid.map(messageToBrief).join('\n').slice(0, 12000)
    let digest: string
    try {
      const res = await callJson<{ digest?: string }>({
        slot: 'utility',
        system: '你是会话纪要助手，只输出 JSON。',
        user: `以下是一段小说写作智能体的工作过程记录（工具调用与结果）。
把它压缩成 ≤400 字的工作纪要：已做了什么、拿到了哪些关键结论/数据（章节名、人物状态变化、伏笔决定等）、尚待办什么。保留可执行的细节，不要空话。

${rows}

输出 JSON：{"digest":"纪要文本"}`,
        jsonHint: '{"digest":"纪要文本"}'
      })
      digest = (res.digest ?? '').slice(0, 600) || fallbackDigest(mid)
    } catch {
      digest = fallbackDigest(mid)
    }
    messages.splice(historyLen + 1, safe - (historyLen + 1), {
      role: 'user',
      content: `〔前情工作纪要（${mid.length} 条已压缩）〕\n${digest}`
    })
    compacted = true
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    book = store.getBook(bookId) ?? book // 每轮重读（agent 可能改了配置/切了线）
    await compactIfNeeded()
    const res = await callRaw(
      {
        slot: 'director',
        system: opts.system ?? agentSystem(book, mode),
        user: task,
        jsonHint: '',
        params: {
          messages,
          tools: opts.tools,
          responseFormat: 'text',
          maxTokens: 4000
        },
        onThinking: opts.onThinking
      },
      opts.onDelta
    )
    // 白话（有 tool_use 时通常为空，跳过落消息避免噪音）
    if (res.text.trim() && !res.toolUses.length) {
      opts.say(res.text.trim(), { kind: 'chat', jobId })
    }
    finishText = res.text.trim() || finishText

    if (res.toolUses.length) {
      // 重建 assistant blocks（text + tool_use），供下轮回灌
      const blocks: ContentBlock[] = []
      if (res.text.trim()) blocks.push({ type: 'text', text: res.text.trim() })
      for (const tu of res.toolUses) {
        blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
      }
      messages.push({ role: 'assistant', content: blocks })
    }
    if (!res.toolUses.length) {
      return { text: finishText || '（导演没有说话）', turns: turn + 1, chaptersCommitted }
    }

    // 执行工具
    const resultBlocks: ContentBlock[] = []
    let finished = false
    for (const tu of res.toolUses) {
      let result: ToolResult
      if (tu.inputError || typeof tu.input !== 'object' || tu.input === null) {
        result = {
          ok: false,
          summary: `${tu.name} 参数无效`,
          data: `参数 JSON ${tu.inputError === 'truncated' ? '被截断' : '解析失败'}，请重发完整参数`
        }
      } else {
        result = await runOne(tu.name, tu.input as Record<string, unknown>)
      }
      // 工具卡（作者可见的工作日志；content 截 2000 字防膨胀，全文走 resultBlocks 给 LLM）
      opts.say(result.data.slice(0, 2000), {
        kind: 'tool',
        jobId,
        tool: tu.name,
        summary: result.summary,
        ok: result.ok
      })
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: result.ok ? clipData(result.data) : `失败：${result.data}`,
        is_error: !result.ok
      } as ContentBlock)
      if (tu.name === 'finish' && result.ok) finished = true
    }

    messages.push({ role: 'user', content: resultBlocks })

    if (finished) {
      const finishMsg = lastFinishMessage
      return {
        text: finishMsg || finishText || '完成',
        turns: turn + 1,
        chaptersCommitted
      }
    }
  }
  opts.say(`已到最大轮数（${maxTurns}），我先停在这里。`, { kind: 'chat', jobId })
  return { text: finishText || '到达最大轮数', turns: maxTurns, chaptersCommitted }

  // ── 单工具执行（拦截工具内联） ──────────────────────────────────────────
  async function runOne(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'finish': {
        lastFinishMessage = String(input.message ?? '')
        return { ok: true, summary: '收工', data: '已收尾' }
      }
      case 'write_chapter_draft': {
        const b = store.getBook(bookId) ?? book
        const line = store.activeLine(b)
        if (!line) return { ok: false, summary: '没有激活线', data: '当前书没有激活线' }
        const direction = (opts.task.match(/走向[：:]\s*(.+)/)?.[1] ?? opts.task).slice(0, 200)
        const outline = {
          title: String(input.title ?? '未命名'),
          synopsis: String(input.synopsis ?? ''),
          beats: (input.beats as string[]) ?? ['']
        }
        const styleRefs = await genStyleRefs(b, outline)
        const input2 = {
          book: b,
          lineId: line.id,
          outline,
          scenes: (input.scenes as Scene[] | undefined) ?? null,
          direction: { source: 'free' as const, text: direction },
          styleRefs: styleRefs || undefined
        }
        let draft = await genDraft(input2, progressSaver('draft'))
        let report = selfCheck(b, line.id, draft, tailOf(line.id))
        if (report.issues.some((i) => i.level === 'major')) {
          // 自动修一轮（W6 纪律）
          draft = await autoFixDraft(input2, draft, report, progressSaver('draft'))
          report = selfCheck(b, line.id, draft, tailOf(line.id))
        }
        lastDraft = {
          title: input2.outline.title,
          synopsis: input2.outline.synopsis,
          beats: input2.outline.beats,
          content: draft,
          report
        }
        const majors = report.issues.filter((i) => i.level === 'major')
        const wordCount = draft.replace(/\s/g, '').length
        return {
          ok: true,
          summary: `写《${input2.outline.title}》${wordCount} 字（${majors.length ? `仍有 ${majors.length} 个 major 问题` : '自检通过'}）`,
          data:
            `《${input2.outline.title}》草稿完成（约 ${wordCount} 字）。自检报告：${N}` +
            (report.issues.length
              ? report.issues
                  .map(
                    (i) => `[${i.level}/${i.rule}] ${i.quote ? `「${i.quote}」` : ''}${i.advice}`
                  )
                  .join(N)
              : '全部通过') +
            `${N}${N}正文全文：${N}${draft}`
        }
      }
      case 'commit_chapter': {
        if (!lastDraft) {
          return {
            ok: false,
            summary: '没有可入书的草稿',
            data: '先 write_chapter_draft 再 commit_chapter'
          }
        }
        const b = store.getBook(bookId) ?? book
        const line = store.activeLine(b)
        if (!line) return { ok: false, summary: '没有激活线', data: '当前书没有激活线' }
        const prev = store.previousChapter(line.id)
        const clean = stripHtmlComments(lastDraft.content)
        const chapter = store.insertChapter({
          lineId: line.id,
          parentChapterId: prev?.id ?? '',
          title: lastDraft.title,
          content: clean,
          summary: '',
          meta: {
            direction: { source: 'free', text: opts.task.slice(0, 500) },
            outline: {
              title: lastDraft.title,
              synopsis: lastDraft.synopsis,
              beats: lastDraft.beats
            }
          }
        })
        const summary = String(input.summary ?? '')
        if (summary) store.updateChapterSummary(chapter.id, summary)
        const quickActions = Array.isArray(input.quickActions)
          ? (input.quickActions as Array<{ label: string; instruction: string }>).filter(
              (a) => a && typeof a.label === 'string' && typeof a.instruction === 'string'
            )
          : []
        chaptersCommitted++
        lastDraft = null
        opts.onChapterCommitted?.(chapter, { summary, quickActions })
        return {
          ok: true,
          summary: `《${chapter.title}》已入书`,
          data: `已入书：第 ${chapter.orderNo} 章《${chapter.title}》（${chapter.wordCount} 字）。纪要已记录。继续沉淀（save_card/patch_character_state/save_foreshadow），完成后 finish。`
        }
      }
      case 'revise_chapter': {
        const chapterId = String(input.chapterId ?? '')
        const chapter = store.getChapter(chapterId)
        if (!chapter) return { ok: false, summary: '章节不存在', data: `章节 ${chapterId} 不存在` }
        const instruction = String(input.instruction ?? '')
        const segment = typeof input.segment === 'string' ? input.segment : undefined
        const plan = await genRevisePlan({
          book: store.getBook(bookId) ?? book,
          lineId: chapter.lineId,
          chapter,
          instruction,
          segment
        })
        const applied = applyRevisePlan(chapter.content, plan)
        if ('noHit' in applied) {
          return {
            ok: false,
            summary: '改稿未命中原文',
            data: '修改定位失败：find 引文在原文中找不到，请重新引用原文逐字片段。'
          }
        }
        const clean = stripHtmlComments(applied.next)
        const report = lintChapter(clean, {
          bannedWords: (store.getBook(bookId) ?? book).negativeWords
        })
        store.replaceChapterContent(chapterId, clean)
        return {
          ok: true,
          summary: `改好《${chapter.title}》`,
          data: `《${chapter.title}》已按「${briefOf(instruction)}」${
            applied.mode === 'rewrite'
              ? '整章重写'
              : `局部修改 ${applied.applied}/${applied.total} 处`
          }并替换。lint：${report.issues.length ? report.issues.map((i) => `[${i.rule}]${i.advice}`).join('；') : '干净'}`
        }
      }
      case 'spawn_subagent': {
        const t = String(input.task ?? '').trim()
        if (!t) return { ok: false, summary: '调查任务为空', data: 'spawn_subagent 需要 task 参数' }
        const child = await runAgentLoop({
          jobId,
          bookId,
          task: t,
          history: [],
          tools: subTools(),
          mode: 'free',
          maxTurns: 12,
          system: SUB_SYSTEM,
          say: () => {}
        })
        return {
          ok: true,
          summary: `调查员回报（${child.turns} 轮）`,
          data: child.text
        }
      }
      case 'propose_chapter': {
        const hint = typeof input.directionHint === 'string' ? input.directionHint : undefined
        const msg = opts.actions?.startChapter?.(hint)
        return {
          ok: true,
          summary: '已开章排队',
          data:
            msg ??
            '写章任务已排进队列。等走向卡出来后作者选择，我会自主完成全章。现在可以跟作者说「已开章」。'
        }
      }
      case 'request_review': {
        const chapterId = typeof input.chapterId === 'string' ? input.chapterId : undefined
        const text = await opts.actions?.review?.(chapterId)
        return {
          ok: !!text,
          summary: '审读报告已出',
          data: text ?? '审读功能不可用'
        }
      }
      case 'request_audit': {
        const text = await opts.actions?.audit?.()
        return {
          ok: !!text,
          summary: '审计报告已出',
          data: text ?? '审计功能不可用'
        }
      }
      default:
        return execTool(name, input, ctx)
    }
  }

  /** 正文/改章进度：只报字数（正文不进聊天流），作者在聚合条看到「正在写正文·已 N 字」 */
  function progressSaver(phase: 'draft' | 'revise'): (t: string) => void {
    let chars = 0
    return (t) => {
      chars += t.replace(/\s/g, '').length
      opts.onProgress?.({ phase, chars })
    }
  }
}

function tailOf(lineId: string): string | undefined {
  const prev = store.previousChapter(lineId)
  return prev?.content.slice(-500)
}

function briefOf(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}
