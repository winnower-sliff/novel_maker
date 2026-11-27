import type { ModelSlot } from '../../shared/providers.js'
import type {
  Book,
  ChatMessage,
  ContentBlock,
  LintReport,
  SampleInfo,
  ToolDef
} from '../../shared/types.js'
import { callJson, callRaw, isAbortError, StepError } from '../director/callJson.js'
import {
  bookBasics,
  directorPersona,
  redlineBlock,
  styleBlock,
  wordListBlock
} from '../director/prompts.js'
import { applyRevisePlan, genRevisePlan } from '../director/steps.js'
import { noteRevisedChapter } from '../director/storyRecap.js'
import { lintChapter, stripHtmlComments } from '../lint.js'
import * as store from '../store.js'
import {
  execTool,
  READ_TOOLS,
  type ToolCtx,
  type ToolInterceptor,
  type ToolResult,
  toolDefs
} from './tools.js'
import {
  briefProblem,
  createWriter,
  receiptData,
  receiptSummary,
  type WriterReceipt
} from './writer.js'

/**
 * M6 agent 主循环：自由 LLM 工具循环（用户拍板「全面 agent 化」）。
 * - 普通工具（CRUD）走 execTool；主智能体的拦截工具在本文件：
 *   write_chapter_draft（派写作子智能体）/ read_last_draft / commit_chapter（落章）/ finish（收工）等。
 * - 同一个循环也是子智能体的运行器（runSubagent）：嵌套跑在父任务之下，对作者不可见。
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
  /** 作者对本章的倾向（计划模式下留空，计划另给）：进写作子智能体提示的「作者对本章的交代」 */
  chapterDirection?: string
  /** 计划模式下作者已批准的本章计划：进写作子智能体的记忆简报 */
  chapterPlan?: string
  /** 对话历史（ChatMessage 文本投影；写章任务通常为空） */
  history: ChatMessage[]
  /** agent 可用工具（含拦截工具的 ToolDef） */
  tools: ToolDef[]
  /** 场景：写章（有 commit 链）或自由（无 commit） */
  mode: 'chapter' | 'free'
  maxTurns?: number
  /** 覆盖系统提示（子智能体用自己的提示；默认导演人格 agentSystem） */
  system?: string
  /** 模型槽（默认 director；写作子智能体走 writer 槽） */
  slot?: ModelSlot
  /** 每轮输出预算（默认：思考关 4000、思考开 16384；截断补救轮翻倍） */
  maxTokens?: number
  /**
   * 子智能体运行形态（runSubagent 设置）：只能调自己 tools 清单里的工具；
   * intercept 接子循环自己的拦截工具，回 null 走默认拦截表与普通工具
   */
  subagent?: { intercept?: ToolInterceptor }
  /** 导演白话流式（chat 气泡预览；正文/改章不走这里——见 onProgress） */
  onDelta?: (t: string) => void
  /** 思考链流式（chat 折叠区；正文/改章不接） */
  onThinking?: (t: string) => void
  /** 思考模式：默认 disabled（思考 token 计入 max_tokens 吃工具循环预算）；仅 chat 链路开 */
  thinking?: 'enabled' | 'disabled'
  /** 取消信号（jobs 层在作者取消/看门狗触发时 abort）：每轮与每个工具执行前检查，并透传给全部 LLM 调用 */
  signal?: AbortSignal
  /** 每轮回调（jobs 层喂看门狗：有真实进展就续命，挂死不喂→照杀） */
  onTurn?: () => void
  /** 本轮流式输出中途断线、将从头重试时回调（jobs 层借此清空已推给前端的半截内容） */
  onRestart?: () => void
  /** 生成进度（正文/改章字数计数，聚合条显示；正文不进聊天流） */
  onProgress?: (p: { phase: 'draft' | 'revise'; chars: number }) => void
  /** 落一条 assistant 消息（agent 白话/工具卡） */
  say: (content: string, meta?: Record<string, unknown>) => void
  /** 落章后回调（note chapter 消息/recap 进 payload/前情梗概合并/审计排队——jobs.ts 注入） */
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
          '派写作子智能体写本章正文。brief=你写好的任务简报（60-4000 字，一般 300-1500 字够用）：本章要发生什么、出场人物与各自要点、要埋/收的伏笔、基调与节奏、想模仿的句子与要避免的。写手带着记忆简报自己查人设/设定/前文/范文，分段交稿，自检不过会被退回自己改。只回传章题/字数/自检报告/纪要与沉淀线索（不回灌全文，要看用 read_last_draft）。',
        input_schema: {
          type: 'object',
          properties: {
            brief: { type: 'string', description: '任务简报（60-4000 字）' },
            title: { type: 'string', description: '章题' },
            targetWords: {
              type: 'number',
              description: '可选：本章目标字数（不传用书的章节目标字数）'
            }
          },
          required: ['brief']
        }
      },
      {
        name: 'commit_chapter',
        description:
          '正文定稿入书（调它之前必须已有一稿通过或你判断可接受的 write_chapter_draft）。纪要可省略：缺省用写手回执里的纪要。',
        input_schema: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: '可选：本章纪要（100-200字，并进前情梗概）；不传用写手回执里的纪要'
            }
          },
          quickActions: {
            type: 'array',
            description: '2-3 个本章专属快捷改章建议 [{label:4-8字, instruction:具体指令}]',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, instruction: { type: 'string' } },
              required: ['label', 'instruction']
            }
          }
        }
      },
      {
        name: 'read_last_draft',
        description:
          '读最近一稿（写手交的正文，入书前可读）：默认从头 2000 字；from=从第几字起；maxChars 最多 8000。写手回执不回灌全文，要核对细节时用它。',
        input_schema: {
          type: 'object',
          properties: {
            from: { type: 'number', description: '从第几字起读（0 起）' },
            maxChars: { type: 'number', description: '本次取多少字（默认 2000，上限 8000）' }
          }
        }
      }
    )
  }
  return defs
}

/** agent 系统提示（每轮重建，红线/正负词/文风随库内最新值注入） */
function sampleBlock(book: Book): string {
  if (!book.sampleSources.length) return ''
  // 每轮都重建系统提示：只取摘要，不把范文全文读进内存
  const byId = new Map(store.listSamples().map((s) => [s.id, s]))
  const bounds = book.sampleSources
    .map((id) => byId.get(id))
    .filter((s): s is SampleInfo => Boolean(s))
  if (!bounds.length) return ''
  const list = bounds
    .map(
      (s) =>
        `- 《${s.name}》（全文 ${s.chars} 字${s.chapterCount ? `，${s.chapterCount} 章` : ''}）`
    )
    .join('\n')
  return `

## 绑定范文
${list}
- read_sample 支持四种读法：toc 看目录（卷名/章节名清单，找不到位置时先用它）、chapter 章号直达（如第 3 章）、query 关键词检索（如「登船」「林岸」）、offsetPct 百分比翻页。
- 用途：模仿句式/节奏/叙事腔调——绝不抄内容、不搬人物情节。动笔前按本章要素检索一段找语感（派写手时系统也会自动检索一段范文起点带给写手，写手自己还能 read_sample）。`
}

/**
 * 范文起点检索（用户决策：不固定截开头，动笔前按本章内容主动检索注入；
 * 检索词由 LLM 决定——按本章的场景/动作/意象/情绪自选，而非程序硬提人名）。
 * 一次轻量 LLM 调用出词 → 取首个命中片段（约 1200 字）给写作子智能体当起点；
 * 要更多语感由写手自己 read_sample，不再多段注入。
 * 出词失败或全 miss 返回 ''（不注入，不阻断写章）。
 */
export async function genStyleRefs(
  book: Book,
  chapter: { title: string; text: string },
  signal?: AbortSignal
): Promise<string> {
  if (!book.sampleSources.length) return ''
  const samples = book.sampleSources
    .map((id) => store.getSample(id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
  if (!samples.length) return ''
  let queries: Array<{ sample: string; q: string }> = []
  try {
    const res = await callJson<{ queries?: Array<{ sample?: string; q?: string }> }>({
      slot: 'utility',
      system: '你是范文检索助手，只输出 JSON。',
      user: `你将为小说写作挑选范文参考段的检索词。

## 绑定范文
${samples.map((s, i) => `${i + 1}. 《${s.name}》`).join('\n')}

## 本章信息
标题：${chapter.title}
任务简报：${chapter.text.slice(0, 800)}

## 任务
针对每一本范文，给出 1-2 个用于在其全文中检索参考段的**关键词**。
- 词要来自本章的场景/动作/意象/情绪/桥段类型（如「夜袭」「审讯」「重逢」「暴雨中的对峙」），不要用本书人名（范文是另一部作品，人名大概率不存在）。
- 想模仿哪类写法（打斗节奏/对话密度/环境烘托），就检索那类桥段。

输出 JSON：{"queries":[{"sample":"范文名","q":"关键词"}]}，总数不超过 ${Math.min(4, samples.length * 2)} 个。`,
      jsonHint: '{"queries":[{"sample":"范文名","q":"关键词"}]}',
      signal
    })
    queries = (res.queries ?? [])
      .filter((x) => x.sample && x.q)
      .map((x) => ({ sample: x.sample ?? '', q: x.q ?? '' }))
  } catch (err) {
    if (isAbortError(err)) throw err
    return '' // 出词失败静默跳过
  }
  for (const s of samples) {
    const words = queries
      .filter((x) => x.sample.includes(s.name) || s.name.includes(x.sample))
      .map((x) => x.q)
    for (const q of words) {
      const hit = store.searchSampleSections(s.id, s.content, q)
      if (hit.offset < 0) continue
      return `◆ 《${s.name}》（检索词「${q}」）\n${s.content.slice(hit.offset, hit.offset + 1200)}`
    }
  }
  return ''
}

/** 记忆简报（紧凑版）：前情梗概 + 主要人物名单。细节靠工具拉，这里只保证导演每轮都记得书写到哪了 */
function memoryBrief(lineId: string): string {
  if (!lineId) return ''
  const parts: string[] = []
  const running = store.getRunningMemory(lineId)
  if (running) parts.push(`前情梗概（覆盖到第 ${running.toOrder} 章）：\n${running.content}`)
  const roster = store
    .listCharacters(lineId)
    .slice(0, 12)
    .map((c) => `${c.name}${c.role ? `（${c.role}）` : ''}`)
    .join('、')
  if (roster) parts.push(`主要人物：${roster}`)
  return parts.length
    ? `\n\n## 记忆简报（全貌用 get_write_context 取，细节用读类工具查）\n${parts.join('\n')}`
    : ''
}

/** agent 系统提示（每轮重建，红线/正负词/文风/记忆简报随库内最新值注入） */
function agentSystem(book: Book, lineId: string, mode: 'chapter' | 'free'): string {
  const chapterDiscipline =
    mode === 'chapter'
      ? `

## 写章任务纪律（当前处于写章流程；走向由作者在聊天里给出或由你自主拟定）
1. 先 get_write_context 拿上下文（钉选设定/前情梗概/伏笔/人物现状/近章），定本章走向。${book.sampleSources.length ? '需要找语感可用 read_sample 按本章要素检索一段范文（派写手时系统也会自动检索一段带给写手）。' : ''}
2. 写任务简报，调 write_chapter_draft 派写作子智能体：简报 60-4000 字，写清本章要发生什么、出场人物与各自要点、要埋/收的伏笔、基调与节奏、想模仿的句子与要避免的；带上章题。写手带着记忆简报自己查人设/设定/前文/范文，分段交稿，自检不过会被退回自己改。你拿到的只有章题/字数/自检报告/纪要与沉淀线索，不回灌全文——要核对细节用 read_last_draft。
3. 回执的自检报告仍有 major、或走向写偏了：先 read_last_draft 看一眼再定。写手自检不过会被退回自己改，只在需要整章重来时再派一次 write_chapter_draft；自检退回两轮仍 major 的字数/接缝问题，若你判断无法两全→commit 前在 finish 里说明，或与作者商量（作者接受瑕疵）。
4. commit_chapter（纪要可省略，缺省用回执里的纪要）后立即做沉淀，evidence 照抄回执里的原句：新设定 save_card、人物动向 patch_character_state、伏笔三态 save_foreshadow。save_card / save_foreshadow 必须附 evidence（本章正文里连续的一句原话，逐字照抄）——系统会核对原句确在正文里，对不上会退回让你重提；正文里没有写到的不许存；回执里标明「已丢弃」的线索不要照抄，先 read_last_draft 找到正确原句。这是纪律，不许跳过。
5. 全部做完 finish 收尾（汇报+建议下一章走向）。`
      : `

## 自由任务纪律
- 先查再答：凡涉及书里已发生的事、人物、设定、伏笔（谁做过什么、关系如何、某个设定是什么），先用工具核对（get_write_context / get_character / get_card / list_foreshadows / search_project），再回答。你对这本书的记忆只有末尾的记忆简报，简报里没有的不能凭印象说。
- 查不到就明说「书里还没写到」或「我不确定」，并告诉作者怎么核实；不许编细节圆场。
- 作者表达的长期偏好（文风、节奏、口味、禁忌、终局方向）必须落库，不能只聊不记：当轮用 save_card 存成钉选卡（pinned=true、kind=custom、标题写明是作者偏好如「作者口味：不要感情线」、内容写进 authorText），之后每章写作都会带上；能进书配置的（文风/红线/正负词）同时用 update_book_config 写进去。
- 你没有 commit_chapter/write_chapter_draft 权限（写新章走「写下一章」流程，由写章任务里的主智能体自主定走向）。
- 作者要在已有章上改稿→revise_chapter；维护设定/人物/伏笔/红线/正负词→对应工具。
- 作者要写新章→直接调 propose_chapter（可带方向提示）排进写章队列，并告诉作者「已开章」；界面上没有「写下一章」按钮，不要让作者去找。
- 承诺即执行：凡对作者说「这就改/马上改/现在就动手」，必须在同一轮调用对应工具完成，只说不做是违规；改不动就明说原因，不许空头承诺。`
  // 稳定内容在前、每章都变的记忆简报在后（DeepSeek 前缀缓存按前缀整体命中）
  return `${directorPersona()}

${bookBasics(book)}
${redlineBlock(book)}
${wordListBlock(book)}
${styleBlock(book)}
${sampleBlock(book)}
${chapterDiscipline}

## 工具纪律
- 每次工具调用都会以小卡形式给作者看，大方用。
- 删除类工具已自动快照兜底，但删除前仍要确认作者意图。
- 工具结果太长会被截断，需要细节就用读类工具分页看。
- 要翻大量资料但只需要结论（摸人物关系、查伏笔现状、找前文原句）时，派 spawn_subagent 去调查——它只把最终结论带回你的上下文，省你自己的空间。日常单点查询不必派。${memoryBrief(lineId)}`
}

/** 调查员系统提示（fresh 会话，只读，静默执行）；身份行也是冒烟桩路由子智能体调用的依据 */
const SUB_SYSTEM = `你是只读调查员，受导演指派调查小说项目的资料，只输出调查结论。

## 纪律
1. 你只有读类工具：绝不改动任何东西（也没有写类工具可用）。
2. 自己多轮翻资料凑齐证据（章节/设定/人物/伏笔/范文/检索），调查是你一个人的事，不要中途交半成品。
3. 材料够就 finish 汇报：按任务要求给要点/清单/原文摘录；需要原文的地方给准确引句；不要写调查流水账，不要客套。`

const MAX_DATA = 30000
const N = '\n'
/** read_last_draft：默认取 2000 字，一次最多 8000 字（全文回灌正是要省的开销） */
const READ_DRAFT_DEFAULT = 2000
const READ_DRAFT_MAX = 8000

/** 即时执行承诺信号：这就改/马上删/现在就写…（拦「光说不练」：承诺了却不在本轮调工具） */
const ACT_NOW_RE = /(这就|现在就|马上|立刻|立即)[^。！？!?\n]{0,10}(改|删|建|写|加|换|存|更新|动)/

/** 调查员可用工具：只读类 + finish */
function researchTools(): ToolDef[] {
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

/** 调查员规格：固定提示 + 读工具，没有自己的拦截工具 */
function researchSpec(task: string): SubagentSpec {
  return { kind: 'research', task, system: SUB_SYSTEM, tools: researchTools(), slot: 'director' }
}

function clipData(s: string): string {
  return s.length > MAX_DATA ? `${s.slice(0, MAX_DATA)}\n…（结果过长已截断）` : s
}

/** 子智能体规格：research=只读调查员；write=写作子智能体 */
export interface SubagentSpec {
  kind: 'research' | 'write'
  /** 首条 user 消息：任务本身 */
  task: string
  system: string
  tools: ToolDef[]
  /** 模型槽：调查员与导演同槽；写手走 writer 槽 */
  slot: ModelSlot
  /** 每轮输出预算；不传用循环默认值 */
  maxTokens?: number
  intercept?: ToolInterceptor
}

/** 子智能体的宿主：父任务的取消信号、看门狗喂狗与进度出口，嵌套循环原样透传 */
export interface SubagentHost {
  jobId: string
  bookId: string
  signal?: AbortSignal
  onTurn?: () => void
  onProgress?: LoopOpts['onProgress']
}

/** 调查翻十几轮资料、写手分段交稿带两轮回改都够用；再多多半是在打转 */
const SUBAGENT_MAX_TURNS = 12
const SUBAGENT_LABEL = { research: '调查员', write: '写作子智能体' } as const

/**
 * 子智能体运行器：调查员与写手共用一套嵌套循环。
 * - 对作者不可见（say 空操作；要给作者看的由父循环的工具卡代劳）
 * - 透传父循环的取消信号与喂狗：子循环卡死，父任务的看门狗照杀
 * - 只能调自己清单里的工具：模型幻觉出清单外的写工具也拒
 */
async function runSubagent(spec: SubagentSpec, host: SubagentHost): Promise<LoopResult> {
  const child = await runAgentLoop({
    jobId: host.jobId,
    bookId: host.bookId,
    task: spec.task,
    history: [],
    tools: spec.tools,
    mode: 'free',
    maxTurns: SUBAGENT_MAX_TURNS,
    system: spec.system,
    slot: spec.slot,
    maxTokens: spec.maxTokens,
    say: () => {},
    signal: host.signal,
    onTurn: host.onTurn,
    onProgress: host.onProgress,
    subagent: { intercept: spec.intercept }
  })
  if (child.turns >= SUBAGENT_MAX_TURNS) {
    console.warn(
      `[agent] jobId=${host.jobId} ${SUBAGENT_LABEL[spec.kind]}跑满 ${SUBAGENT_MAX_TURNS} 轮`
    )
  }
  return child
}

export async function runAgentLoop(opts: LoopOpts): Promise<LoopResult> {
  const { jobId, bookId, task, mode } = opts
  const maxTurns = opts.maxTurns ?? 30
  // 写章任务里沉淀设定/伏笔必须附本章原句，服务端核对（M5）；聊天模式由作者点名，不强制
  const ctx: ToolCtx = { bookId, requireEvidence: mode === 'chapter' }

  let book: Book
  {
    const initial = store.getBook(bookId)
    if (!initial) throw new Error('书不存在')
    book = initial
  }

  // 写章会话内暂存的最近一稿（commit_chapter / read_last_draft 用）：全文只在这里，不回灌给主智能体
  let lastDraft: {
    title: string
    /** 主智能体给写手的任务简报（入书时存进章的 meta） */
    brief: string
    content: string
    report: LintReport
    receipt: WriterReceipt
  } | null = null
  let chaptersCommitted = 0
  let finishText = ''
  let lastFinishMessage = ''
  // 子智能体只能调自己清单里的工具（runOne 里核对）
  const allowedTools = new Set(opts.tools.map((t) => t.name))

  const messages: ChatMessage[] = [...opts.history, { role: 'user', content: task }]
  const historyLen = opts.history.length
  let taskNote = '' // 并入 task 消息尾部的历次〔前情工作纪要〕
  const signal = opts.signal
  // 派子智能体时的宿主：取消信号、喂狗与进度出口都挂在父任务上
  const subHost: SubagentHost = {
    jobId,
    bookId,
    signal,
    onTurn: opts.onTurn,
    onProgress: opts.onProgress
  }

  /** 取消检查：jobs 层 abort（作者取消/看门狗）后不再发起任何调用、不再执行任何工具 */
  function throwIfAborted(): void {
    if (signal?.aborted) throw new StepError('任务已取消', 'aborted')
  }

  /**
   * 上下文压缩：累计超 60000 字时，把 task 之后、末尾 8 条之前的中间段摘要成〔前情工作纪要〕，
   * 并入 task 消息（任务原文永远保留）。可重复触发——长任务一次压不住，只压一次上下文仍会涨爆。
   * 摘要失败退回逐条截断，保证调用必达。
   */
  async function compactIfNeeded(): Promise<void> {
    const chars = messages.reduce((n, m) => n + messageChars(m), 0)
    if (chars <= 60000) return
    const head = historyLen + 2
    const tailStart = Math.max(head, messages.length - 8)
    if (tailStart - head < 4) return // 中段太薄不值得压（兼作重复触发的节流）
    // 尾段必须从 assistant 消息起：tool_use 与其 tool_result 要么一起进纪要、要么一起留在尾段，不能被切开
    let safe = tailStart
    while (safe > head && messages[safe]?.role !== 'assistant') safe--
    if (safe <= head) return
    const mid = messages.slice(head, safe)
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
        jsonHint: '{"digest":"纪要文本"}',
        signal
      })
      digest = (res.digest ?? '').slice(0, 600) || fallbackDigest(mid)
    } catch (err) {
      if (isAbortError(err)) throw err
      digest = fallbackDigest(mid)
    }
    messages.splice(head, safe - head)
    taskNote += `${N}${N}〔前情工作纪要（${mid.length} 条已压缩）〕${N}${digest}`
    messages[historyLen + 1] = { role: 'user', content: `${task}${taskNote}` }
  }

  let truncNudges = 0 // 思考耗尽输出预算的补救次数（实锤：deepseek thinking 吃满 8192 token，正文/工具全空静默退出）
  let promiseNudges = 0 // 「光说不练」补救次数（实锤：白话承诺「这就改」但本轮无 tool_use，纯文本路径直接结束任务）
  /** 回灌 assistant 历史：思考模式开着时把这一轮的思考链一并带上（DeepSeek 带工具续轮的硬性要求）；思考关闭不带 */
  const assistantMessage = (content: ChatMessage['content'], thinking?: string): ChatMessage =>
    opts.thinking === 'enabled' && thinking?.trim()
      ? { role: 'assistant', content, reasoning: thinking }
      : { role: 'assistant', content }
  for (let turn = 0; turn < maxTurns; turn++) {
    throwIfAborted()
    opts.onTurn?.() // 每轮喂狗：有真实进展就续看门狗（挂死/死循环不喂→照杀）
    book = store.getBook(bookId) ?? book // 每轮重读（agent 可能改了配置/切了线）
    await compactIfNeeded()
    const line = store.activeLine(book)
    // 输出预算：思考计入输出 token（DeepSeek/GPT 系皆然），上限必须盖住「思考+正文」，只按实际生成计费；
    // 截断补救轮翻倍（8192 顶格实锤过三次静默中断，2026-11）
    const baseMax = opts.maxTokens ?? (opts.thinking === 'enabled' ? 16384 : 4000)
    const res = await callRaw(
      {
        slot: opts.slot ?? 'director',
        system: opts.system ?? agentSystem(book, line?.id ?? '', mode),
        user: task,
        jsonHint: '',
        params: {
          messages,
          tools: opts.tools,
          responseFormat: 'text',
          maxTokens: truncNudges > 0 ? baseMax * 2 : baseMax
        },
        onThinking: opts.onThinking,
        thinking: opts.thinking,
        signal,
        onRestart: opts.onRestart
      },
      opts.onDelta
    )
    // 思考块独立成卡（opencode 式交错：思考→工具→对话按真实顺序上墙）
    if ((res.thinking ?? '').trim()) {
      opts.say((res.thinking ?? '').trim().slice(0, 4000), { kind: 'thinking', jobId })
    }
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
      messages.push(assistantMessage(blocks, res.thinking))
    }
    if (!res.toolUses.length) {
      if (!res.text.trim() && res.stopReason === 'max_tokens' && truncNudges < 2) {
        // 输出预算被思考耗尽（finish=length、无正文无工具）：不静默退出，推提示让模型直接作答
        truncNudges++
        console.warn(
          `[agent] jobId=${jobId} 第 ${turn + 1} 轮输出被截断（思考占满 max_tokens），第 ${truncNudges} 次补救`
        )
        messages.push({
          role: 'user',
          content:
            '（系统提示：你上一轮把输出 token 全部耗在思考上，正文没有任何产出。现在压缩思考、直接给最终答复；要动手就调工具，不要重新展开长推理。）'
        })
        continue
      }
      if (!res.text.trim() && res.stopReason === 'max_tokens') {
        console.warn(`[agent] jobId=${jobId} 截断补救 ${truncNudges} 次后仍空响应，放弃`)
        return {
          text: '（这轮回复被截断了：模型的思考占满输出上限，重试两次仍未产出。请把指令拆小一点再发，或稍后再试。）',
          turns: turn + 1,
          chaptersCommitted
        }
      }
      // 光说不练检测：本轮承诺执行（这就改/马上删…）却没带任何工具调用——不放过，逼一轮
      if (res.text.trim() && promiseNudges < 2 && ACT_NOW_RE.test(res.text)) {
        promiseNudges++
        console.warn(
          `[agent] jobId=${jobId} 第 ${turn + 1} 轮口头承诺执行但未调工具，第 ${promiseNudges} 次追问`
        )
        // 承诺原文先进历史，否则模型只看到「你刚才承诺了」却不知道自己承诺了什么
        messages.push(assistantMessage(res.text.trim(), res.thinking))
        messages.push({
          role: 'user',
          content:
            '（系统提示：你刚才口头承诺要执行操作，但本轮没有调用任何工具。现在要么立即调用对应工具执行，要么向作者明确说明为什么暂不执行——禁止空头承诺。）'
        })
        continue
      }
      return { text: finishText || '（导演没有说话）', turns: turn + 1, chaptersCommitted }
    }

    // 执行工具
    const resultBlocks: ContentBlock[] = []
    let finished = false
    for (const tu of res.toolUses) {
      throwIfAborted() // 已取消：本轮剩余工具不再执行
      let result: ToolResult
      if (tu.inputError || typeof tu.input !== 'object' || tu.input === null) {
        result = {
          ok: false,
          summary: `${tu.name} 参数无效`,
          data: `参数 JSON ${tu.inputError === 'truncated' ? '被截断' : '解析失败'}，请重发完整参数`
        }
      } else {
        try {
          result = await runOne(tu.name, tu.input as Record<string, unknown>)
        } catch (err) {
          // 额度/网络/取消是整任务层面的失败，上抛由 jobs 层定终态；其余是工具内部异常，转成失败结果让模型自救
          if (err instanceof StepError) throw err
          // 中文报错是工具自己抛的业务提示（如「章节不存在」），只回给模型；其余才是内部异常，留堆栈
          if (!/[\u4e00-\u9fff]/.test(String((err as Error)?.message ?? ''))) {
            console.error(`[agent] jobId=${jobId} 工具 ${tu.name} 执行异常`, err)
          }
          result = {
            ok: false,
            summary: `${tu.name} 执行出错`,
            data: `工具执行时发生内部错误：${
              err instanceof Error ? err.message : String(err)
            }。可换个方式完成，或向作者说明。`
          }
        }
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
    if (opts.subagent) {
      // 模型幻觉出清单外的工具（写类居多）：拒掉，不给子智能体越权落库的机会
      if (!allowedTools.has(name)) {
        return {
          ok: false,
          summary: `${name} 不可用`,
          data: `你没有 ${name} 这个工具，只能用工具清单里的工具。`
        }
      }
      const taken = await opts.subagent.intercept?.(name, input)
      if (taken) return taken
    }
    switch (name) {
      case 'finish': {
        lastFinishMessage = String(input.message ?? '')
        return { ok: true, summary: '收工', data: '已收尾' }
      }
      case 'write_chapter_draft': {
        const b = store.getBook(bookId) ?? book
        const line = store.activeLine(b)
        if (!line) return { ok: false, summary: '没有激活线', data: '当前书没有激活线' }
        const brief = String(input.brief ?? '').trim()
        const problem = briefProblem(brief)
        if (problem) return { ok: false, summary: '任务简报不合格', data: problem }
        const title = String(input.title ?? '').trim() || '未命名'
        const targetWords =
          typeof input.targetWords === 'number' &&
          Number.isFinite(input.targetWords) &&
          input.targetWords > 0
            ? Math.trunc(input.targetWords)
            : b.targetWords
        const styleRefs = await genStyleRefs(b, { title, text: brief }, signal)
        const writer = createWriter({
          book: b,
          lineId: line.id,
          brief,
          // 走向卡早已废除：写手看的是作者的真实倾向（或已批准的计划），不是任务指令原文
          direction: opts.chapterDirection,
          plan: opts.chapterPlan,
          targetWords,
          styleRefs: styleRefs || undefined,
          signal,
          onProgress: opts.onProgress
        })
        const child = await runSubagent(writer.spec, subHost)
        const outcome = writer.session.settle(child.text)
        if (!outcome.ok) return { ok: false, summary: outcome.summary, data: outcome.data }
        lastDraft = {
          title,
          brief,
          content: outcome.content,
          report: outcome.report,
          receipt: outcome.receipt
        }
        return {
          ok: true,
          summary: receiptSummary(title, outcome),
          data: receiptData(title, targetWords, outcome)
        }
      }
      case 'read_last_draft': {
        if (!lastDraft) {
          return {
            ok: false,
            summary: '没有草稿',
            data: '现在没有草稿：先 write_chapter_draft 派写手；已入书的章用 read_chapter 读。'
          }
        }
        const total = lastDraft.content.length
        const from = Math.min(
          Math.max(0, Math.trunc(Number(input.from) || 0)),
          Math.max(0, total - 1)
        )
        const want =
          typeof input.maxChars === 'number' && input.maxChars > 0
            ? Math.trunc(input.maxChars)
            : READ_DRAFT_DEFAULT
        const end = Math.min(total, from + Math.min(want, READ_DRAFT_MAX))
        const more = end < total ? `\n…（第 ${from + 1}-${end} 字；继续往后传 from:${end}）` : ''
        return {
          ok: true,
          summary: `读草稿第 ${from + 1}-${end} 字`,
          data: `${lastDraft.content.slice(from, end)}${more}`
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
            brief: lastDraft.brief.slice(0, 2000)
          }
        })
        // 纪要缺省用写手回执里的
        const summary = String(input.summary ?? '').trim() || lastDraft.receipt.summary
        if (summary) store.updateChapterSummary(chapter.id, summary)
        const quickActions = Array.isArray(input.quickActions)
          ? (input.quickActions as Array<{ label: string; instruction: string }>).filter(
              (a) => a && typeof a.label === 'string' && typeof a.instruction === 'string'
            )
          : []
        chaptersCommitted++
        lastDraft = null
        opts.onChapterCommitted?.(chapter, { summary, quickActions })
        // 「第 N 章」按本线有效章序列的位置计（分叉线里章序号从 1 重排，orderNo 不可比）；
        // 带上章节 id：沉淀时 save_card / save_foreshadow 的证据要指向这一章
        const position = store.effectiveChapters(line.id).length
        return {
          ok: true,
          summary: `《${chapter.title}》已入书`,
          data: `已入书：第 ${position} 章《${chapter.title}》（${chapter.wordCount} 字，id=${chapter.id}）。纪要已记录。继续沉淀（save_card/patch_character_state/save_foreshadow；save_card 与 save_foreshadow 必须带 evidence 原句），完成后 finish。`
        }
      }
      case 'revise_chapter': {
        const chapterId = String(input.chapterId ?? '')
        const chapter = store.getChapter(chapterId)
        if (!chapter) return { ok: false, summary: '章节不存在', data: `章节 ${chapterId} 不存在` }
        const instruction = String(input.instruction ?? '')
        const segment = typeof input.segment === 'string' ? input.segment : undefined
        const plan = await genRevisePlan(
          {
            book: store.getBook(bookId) ?? book,
            lineId: chapter.lineId,
            chapter,
            instruction,
            segment
          },
          signal
        )
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
        throwIfAborted()
        store.replaceChapterContent(chapterId, clean)
        // 后台按新正文重写该章纪要，并把前情梗概里涉及本章的说法更正（fire-and-forget，失败只记日志）
        noteRevisedChapter(chapterId)
        const missed = applied.total - applied.applied
        return {
          ok: true,
          summary: `改好《${chapter.title}》`,
          data: `《${chapter.title}》已按「${briefOf(instruction)}」${
            applied.mode === 'rewrite'
              ? '整章重写'
              : `局部修改 ${applied.applied}/${applied.total} 处${
                  applied.hits > applied.applied
                    ? `（引文在全文重复出现，共改动 ${applied.hits} 处）`
                    : ''
                }${missed > 0 ? `；${missed} 处引文未在原文中找到` : ''}`
          }并替换，本章纪要与前情梗概会在后台按新正文刷新。lint：${report.issues.length ? report.issues.map((i) => `[${i.rule}]${i.advice}`).join('；') : '干净'}`
        }
      }
      case 'spawn_subagent': {
        const t = String(input.task ?? '').trim()
        if (!t) return { ok: false, summary: '调查任务为空', data: 'spawn_subagent 需要 task 参数' }
        const child = await runSubagent(researchSpec(t), subHost)
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
          data: msg ?? '写章任务已排进队列，我会自主完成全章。现在可以跟作者说「已开章」。'
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
}

function briefOf(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}
