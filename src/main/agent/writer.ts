import type { Book, Chapter, LintReport, ToolDef } from '../../shared/types.js'
import { StepError } from '../director/callJson.js'
import { buildStoryBrief } from '../director/context.js'
import { bookBasics, redlineBlock, styleBlock, wordListBlock } from '../director/prompts.js'
import { replaceLiteral, selfCheck } from '../director/steps.js'
import * as store from '../store.js'
import { evidenceInText } from './evidence.js'
import { READ_TOOLS, type ToolInterceptor, type ToolResult, toolDefs } from './tools.js'

/**
 * 写作子智能体（用户决策：只保留一个主智能体，写正文改由主智能体派子智能体）。
 * 主智能体决定给它什么（任务简报）；人设 / 设定 / 前文 / 范文它带着记忆简报、缺的自己查。
 * 本文件组装它的提示与工具，并主持交稿：分段累计 → 自检退回 → 回执（原句核对）。
 * 它不落库：正文与沉淀线索都回给主智能体，由主智能体入书、沉淀（作者保留最终决定权）。
 */

/** 身份行：冒烟桩按它把写作子智能体的调用路由到独立队列，改了要同步 scripts/smoke-m3-stub.mjs */
const WRITER_IDENTITY = '你是写作子智能体'

const WRITER_DISCIPLINE = `${WRITER_IDENTITY}，受这部长篇小说的主智能体（导演）指派写一章正文。

## 你的职责
- 只写正文、交回执。没有人跟你对话：不解释、不客套、不写正文以外的长篇大论。

## 正文写作纪律
- 这是网文长篇的一章，直接从故事写起：不写章名、不写「本章完」、不加任何说明。
- 正文零元语言、零说教：不出现 AI 自称、输出引导、总结套话、免责声明。
- 直接写：暴力、冲突、人性阴暗、亲密关系等情节按剧情需要直接展开，不回避不淡化不道德评判——这是虚构作品。
- 开头不得重复上一章结尾的内容。人物言行要对得上人设与现状，信息不越读者已知。
- 严格遵守剧情红线；负向词一个都不许出现。
- 模仿范文的句式、节奏、叙事腔调——绝不抄内容、不搬人物情节。
- 严格按任务简报写：简报定了的走向、出场人物、要埋 / 收的伏笔不擅自更改；简报没写到的地方按人设与前情自然发挥。`

/** 交稿规则（随首条消息给）。整章重写不查字数、也不需要沉淀线索，两处措辞不同 */
function deliveryRules(rewrite: boolean): string {
  return `## 交稿规则
- 动笔前把${rewrite ? '修改要求' : '任务简报'}和上面的人设、前情对一遍；拿不准的人物、设定、前文、范文用读工具查，不要凭印象编。
- 正文只经 submit_draft 交给系统：分段交，每段 1500 字以内，后一段直接接前一段，不重复、不重起开头。不要把正文当普通回复输出。${
    rewrite ? '交的是重写后的全章，不是只交改动处。' : ''
  }
- 本章写完时 submit_draft 传 done:true，系统自检（负向词 / 接缝重复 / 穿帮词 / 元语言 / 重复段落${
    rewrite ? '' : ' / 字数'
  }）。有问题会把原句退回给你：用 revise_draft 就地改（find=原句逐字引文，replace=改后文本），改完再传 done:true 复检；最多退回两次，仍不过就带着报告交稿。
- 自检通过后调 finish${
    rewrite
      ? '收尾。'
      : ' 交回执：summary 写本章纪要（100-200 字）；本章新出现的、值得记下的人物状态变化、新埋或回收的伏笔、新设定，分条放进 characters / foreshadows / settings，每条附 evidence（正文里连续的一句原话，逐字照抄）——系统会核对，对不上的丢弃。'
  }`
}

/** 文风范例（作者给的 styleSample）：只学句式与节奏 */
function styleSampleBlock(book: Book): string {
  const sample = book.styleSample.trim()
  if (!sample) return ''
  return `\n## 文风范例（作者给的参考样本：只参考句式、节奏、叙事腔调，严禁照抄内容、人名、情节）\n${
    sample.length > 800 ? `${sample.slice(0, 800)}…` : sample
  }\n`
}

/** 任务简报的硬性范围：太短写手只能自己瞎编，太长反而稀释重点——都退回让主智能体重提 */
export const BRIEF_MIN = 60
export const BRIEF_MAX = 4000

/** 只有上限的检查（整章重写的修改要求可以很短：原章全文都给了，一句话也能改） */
export function briefTooLong(brief: string): string | null {
  return brief.length > BRIEF_MAX
    ? `任务简报有 ${brief.length} 字，超过上限 ${BRIEF_MAX} 字：只留必须发生的、人物要点和硬约束，其余交给写手按人设与前情发挥。`
    : null
}

export function briefProblem(brief: string): string | null {
  if (brief.length < BRIEF_MIN) {
    return `任务简报只有 ${brief.length} 字，太短（至少 ${BRIEF_MIN} 字，一般 300-1500 字）。写清本章要发生什么、出场人物与各自要点、要埋 / 收的伏笔、基调与节奏、想模仿的句子与要避免的。`
  }
  return briefTooLong(brief)
}

export interface WriterInput {
  book: Book
  lineId: string
  /** 任务简报（主智能体写；整章重写时是修改要求） */
  brief: string
  /** 作者对本章的倾向（计划模式下留空，计划另给） */
  direction?: string
  /** 计划模式下作者已批准的本章计划 */
  plan?: string
  /** 目标字数（缺省书的章节目标）；0 = 不查字数 */
  targetWords?: number
  /** 范文起点（按简报检索到的一段；没有就不带） */
  styleRefs?: string
  /** 整章重写时的原章（新章不传）：写手看着它改，没点名处保持原样 */
  original?: Chapter
}

/** 作者交代最多带这么多字：倾向是一句话的事，长了说明主智能体该把它写进简报 */
const DIRECTION_MAX = 300
/** 原章正文最多带这么多字（超长章截断，写手要后文自己 read_chapter） */
const ORIGINAL_MAX = 14000

/** 「第 N 章」= 本线有效章序列里的位置（分叉线里章序号从 1 重排，orderNo 不可比） */
function positionOf(lineId: string, chapterId: string): number {
  return store.effectiveChapters(lineId).findIndex((c) => c.id === chapterId) + 1
}

/**
 * 写作子智能体的提示。纯组装、不调模型；稳定内容在前、每章都变的在后
 * （与主智能体同一份记忆简报：简报里点名的人物带人设、提到的设定卡带全文）。
 */
export function buildWriterPrompt(input: WriterInput): { system: string; user: string } {
  const { book } = input
  const original = input.original
  const targetWords = input.targetWords ?? book.targetWords
  const targetBlock = original
    ? `原章 ${original.wordCount} 字。重写不查字数，长短按修改要求来。`
    : targetWords > 0
      ? `目标 ${targetWords} 字（可上下浮动 20%；不足六成自检判「字数不足」）`
      : '本章不查字数，长短按任务简报的要求'
  const refBlock = input.styleRefs
    ? `\n\n## 范文起点（按本章内容自动检索注入；模仿句式、节奏、对话密度，严禁照抄内容或人名地名；要更多语感自己 read_sample）\n${input.styleRefs}`
    : ''
  const direction = input.direction?.trim() ?? ''
  const directionBlock = direction
    ? `\n\n## 作者对本章的交代\n${direction.slice(0, DIRECTION_MAX)}`
    : ''
  const task = original
    ? `## 任务
把第 ${positionOf(original.lineId, original.id)} 章《${original.title}》整章重写。按下面的修改要求改；没点名的情节、人物、走向保持原样。

## 修改要求（主智能体写的）
${input.brief}

## 原章正文
${clip(original.content, ORIGINAL_MAX)}`
    : `## 任务简报（主智能体写的，按它写）
${input.brief}${directionBlock}`
  return {
    system: `${WRITER_DISCIPLINE}

${bookBasics(book)}
${redlineBlock(book)}
${wordListBlock(book)}
${styleBlock(book)}
${styleSampleBlock(book)}

## 本章目标字数
${targetBlock}

## 记忆简报（钉选设定 / 前情梗概 / 人物 / 伏笔 / 近章；要细节用读工具查）
${buildStoryBrief(book, input.lineId, { text: input.brief, plan: input.plan })}${refBlock}`,
    user: `${task}

${deliveryRules(Boolean(original))}`
  }
}

// ── 回执 ─────────────────────────────────────────────────────────────────────

/** 回执里的一条线索（人物状态 / 伏笔 / 设定），evidence 是核对过的草稿原句 */
export type ReceiptItem = Record<string, unknown>

/** 回执：写手交稿时给主智能体的结构化小结 */
export interface WriterReceipt {
  /** 本章纪要（100-200 字；写手没给则为空串） */
  summary: string
  characters: ReceiptItem[]
  foreshadows: ReceiptItem[]
  settings: ReceiptItem[]
  /** 原句对不上草稿而被丢弃的线索（标出来，免得主智能体照抄） */
  rejected: Array<{ list: ReceiptList; name: string; reason: string }>
  /** 写手没交回执 / 没走交稿工具时的说明；正常交稿为空串 */
  note: string
}

type ReceiptList = 'characters' | 'foreshadows' | 'settings'

export interface WriterOutcome {
  ok: true
  content: string
  report: LintReport
  receipt: WriterReceipt
}

const RECEIPT_LABEL: Record<ReceiptList, string> = {
  characters: '人物状态',
  foreshadows: '伏笔',
  settings: '设定'
}
const SUMMARY_MAX = 600
/** 每类线索的上限：回执是线索不是档案，多了主智能体也用不完 */
const ITEMS_MAX = 12

/** 没走交稿工具、直接把正文当回复吐出来时，至少这个长度才当成一章收下 */
const PLAIN_TEXT_MIN = 200
/** 自检最多退回这么多次，仍 major 就带着报告入书（取代旧的「自动修一轮」） */
const MAX_RETURNS = 2

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function refuse(summary: string, data: string): ToolResult {
  return { ok: false, summary, data }
}

/** 原句能不能作证据：与 save_card / save_foreshadow 的沉淀证据同一套归一化规则 */
function evidenceProblem(evidence: unknown, text: string): string | null {
  if (typeof evidence !== 'string' || !evidence.trim()) return '缺少 evidence 原句'
  const verdict = evidenceInText(evidence, text)
  if (verdict === 'too_short') return '原句太短（去空白后不足 6 个字）'
  if (verdict === 'not_found') return '原句对不上草稿'
  return null
}

/** 去掉没给的键，回执里只留模型确实写了的字段 */
function pickFields(entry: Record<string, unknown>, keys: string[]): ReceiptItem {
  const item: ReceiptItem = {}
  for (const key of keys) {
    const v = entry[key]
    if (typeof v === 'string' && v.trim()) item[key] = v.trim()
    else if (key === 'patch' && isRecord(v)) item[key] = v
  }
  return item
}

/** 解析回执：每条线索核对原句确在草稿里，对不上的丢掉并标出 */
function parseReceipt(input: Record<string, unknown>, text: string): WriterReceipt {
  const receipt: WriterReceipt = {
    summary: '',
    characters: [],
    foreshadows: [],
    settings: [],
    rejected: [],
    note: ''
  }
  receipt.summary =
    typeof input.summary === 'string' ? input.summary.trim().slice(0, SUMMARY_MAX) : ''
  const take = (list: ReceiptList, need: string, keys: string[]): void => {
    const raw = input[list]
    if (!Array.isArray(raw)) return
    for (const entry of raw.slice(0, ITEMS_MAX)) {
      const name = isRecord(entry) ? String(entry[need] ?? '').trim() : ''
      const reason = !name
        ? `缺少 ${need}`
        : evidenceProblem((entry as Record<string, unknown>).evidence, text)
      if (reason) {
        receipt.rejected.push({ list, name: name || '（未命名）', reason })
        continue
      }
      receipt[list].push(pickFields(entry as Record<string, unknown>, keys))
    }
  }
  take('characters', 'name', ['name', 'patch', 'evidence'])
  take('foreshadows', 'title', ['title', 'detail', 'status', 'evidence'])
  take('settings', 'title', ['kind', 'title', 'readerText', 'authorText', 'evidence'])
  return receipt
}

function itemLine(list: ReceiptList, item: ReceiptItem): string {
  const evidence = `｜原句：「${item.evidence}」`
  if (list === 'characters') {
    const patch = isRecord(item.patch) ? item.patch : {}
    const fields = Object.entries(patch)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('；')
    return `- ${item.name}：${fields || '（没有写具体改动）'}${evidence}`
  }
  if (list === 'foreshadows') {
    return `- ${item.title}${item.status ? `（${item.status}）` : ''}：${item.detail || '（没有写内容）'}${evidence}`
  }
  return `- ${item.kind ? `【${item.kind}】` : ''}${item.title}：读者已知 ${item.readerText || '—'}${
    item.authorText ? `；作者真相 ${item.authorText}` : ''
  }${evidence}`
}

function sectionOf(items: ReceiptItem[], list: ReceiptList): string {
  return items.length ? `\n${items.map((item) => itemLine(list, item)).join('\n')}` : '（无）'
}

/** 回给主智能体的回执文本：只有标题 / 字数 / 自检报告 / 纪要与线索，不含全文 */
export function receiptData(title: string, targetWords: number, outcome: WriterOutcome): string {
  const { report, receipt, content } = outcome
  return [
    `《${title}》写手交稿 ${report.wordCount} 字（目标 ${targetWords} 字）。自检：${
      report.pass
        ? '通过'
        : `仍有 ${report.issues.filter((i) => i.level === 'major').length} 个 major 问题`
    }`,
    ...report.issues.map(
      (i) => `  [${i.level}/${i.rule}] ${i.quote ? `「${i.quote}」` : ''}${i.advice}`
    ),
    receipt.note ? `注意：${receipt.note}` : '',
    `纪要：${receipt.summary || '（写手没有给纪要。commit_chapter 时自己写一条 100-200 字的）'}`,
    `人物状态线索（核对后用 patch_character_state 落库，evidence 照抄原句）：${sectionOf(receipt.characters, 'characters')}`,
    `伏笔线索（用 save_foreshadow，evidence 照抄原句）：${sectionOf(receipt.foreshadows, 'foreshadows')}`,
    `设定线索（用 save_card，evidence 照抄原句）：${sectionOf(receipt.settings, 'settings')}`,
    receipt.rejected.length
      ? `原句对不上草稿、已丢弃的线索（不要照抄；要存先 read_last_draft 找到正确原句）：\n${receipt.rejected
          .map((r) => `  - ${RECEIPT_LABEL[r.list]}「${r.name}」：${r.reason}`)
          .join('\n')}`
      : '',
    `开头：${content.slice(0, 300)}`,
    `结尾：…${content.slice(-300)}`,
    '全文没有带回：要核对细节用 read_last_draft。'
  ]
    .filter(Boolean)
    .join('\n')
}

/** 工具卡标题 */
export function receiptSummary(title: string, outcome: WriterOutcome): string {
  const { report } = outcome
  const majors = report.issues.filter((i) => i.level === 'major').length
  return `派写手《${title}》${report.wordCount} 字（${report.pass ? '自检通过' : `自检仍有 ${majors} 个 major`}）`
}

// ── 交稿主持 ─────────────────────────────────────────────────────────────────

/** 写手的读工具：调查员那 11 个之外再看人设（出场人物言行要对得上人设，精读靠它） */
const WRITER_READ = new Set([...READ_TOOLS, 'get_character'])

const SUBMIT_DRAFT: ToolDef = {
  name: 'submit_draft',
  description:
    '交一段正文（接在已交内容之后，每段 1500 字以内）。本章写完时传 done:true 触发自检：有问题会把原句和改法退回给你，revise_draft 改完再交；通过后调 finish。',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '这一段正文（只写正文，不要说明）' },
      done: { type: 'boolean', description: 'true=本章写完，跑自检' }
    }
  }
}

const REVISE_DRAFT: ToolDef = {
  name: 'revise_draft',
  description:
    '改已交的草稿：find=草稿里逐字连续的一段原句，replace=改后文本（空串=删除）。字面量精确替换，命中的每一处都换；找不到原句会失败，并回你草稿的开头与结尾。',
  input_schema: {
    type: 'object',
    properties: {
      find: { type: 'string', description: '原文逐字引文（不改字、不用省略号拼接两处）' },
      replace: { type: 'string', description: '改后的文本，空串=删除' }
    },
    required: ['find', 'replace']
  }
}

const EVIDENCE_PROP = {
  type: 'string',
  description: '正文原句：草稿里连续的一句原话，逐字照抄（至少 6 个字）'
}

const FINISH_RECEIPT: ToolDef = {
  name: 'finish',
  description:
    '交回执并收工（先等 submit_draft 自检通过）。summary=本章纪要（100-200 字）；characters / foreshadows / settings=本章新出现、值得主智能体记下的人物状态变化、伏笔、设定，每条附 evidence（正文里连续的一句原话，逐字照抄）——系统核对，对不上的丢弃。没有就不传。',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '本章纪要（100-200 字）' },
      characters: {
        type: 'array',
        description: '人物状态变化 [{name, patch, evidence}]',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '人物名' },
            patch: {
              type: 'object',
              description: '要改的活状态字段，如 {"location":"…","mood":"…"}'
            },
            evidence: EVIDENCE_PROP
          },
          required: ['name', 'patch', 'evidence']
        }
      },
      foreshadows: {
        type: 'array',
        description: '新埋 / 计划回收 / 已回收的伏笔 [{title, detail, status, evidence}]',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            detail: { type: 'string', description: '伏笔内容与回收思路' },
            status: { type: 'string', enum: ['open', 'planned', 'resolved'] },
            evidence: EVIDENCE_PROP
          },
          required: ['title', 'evidence']
        }
      },
      settings: {
        type: 'array',
        description: '新设定 [{kind, title, readerText, authorText, evidence}]',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              description: '内置 slug（geography/faction/history/power/item/custom）或自定义类别名'
            },
            title: { type: 'string' },
            readerText: { type: 'string', description: '读者已知层' },
            authorText: { type: 'string', description: '作者真相层' },
            evidence: EVIDENCE_PROP
          },
          required: ['title', 'evidence']
        }
      }
    },
    required: ['summary']
  }
}

/**
 * 退回时给写手看的问题清单。负向词补全全部出现位置：
 * lint 对每个负向词只报首处，重复出现会让写手改一处又被退一次，白白耗掉退回次数。
 */
function issuesForWriter(report: LintReport, text: string, banned: string[]): string {
  const lines = report.issues
    .filter((i) => i.rule !== '负向词')
    .map((i) => `[${i.level}/${i.rule}] ${i.quote ? `「${i.quote}」` : ''}${i.advice}`)
  for (const word of banned) {
    const w = word.trim()
    if (w.length < 2) continue // 与 lint 同口径：单字负向词不查
    const spots: string[] = []
    for (let at = text.indexOf(w); at >= 0; at = text.indexOf(w, at + w.length)) {
      spots.push(
        `  ${spots.length + 1}. …${text.slice(Math.max(0, at - 15), at + w.length + 15).replace(/\s+/g, ' ')}…`
      )
    }
    if (spots.length) {
      lines.push(
        `[major/负向词]「${w}」是本书禁用词，共 ${spots.length} 处，都要换掉：\n${spots.join('\n')}`
      )
    }
  }
  return lines.join('\n')
}

/** 接缝参考：新章看本线末章；重写旧章看它前面那一章（不一定是末章） */
function prevTailOf(lineId: string, chapterId?: string): string | undefined {
  const list = store.effectiveChapters(lineId)
  const at = chapterId ? list.findIndex((c) => c.id === chapterId) : -1
  const prev = chapterId ? list[at - 1] : list.at(-1)
  return prev?.content.slice(-500)
}

export interface WriterRun {
  /** 交给 loop.ts 的 runSubagent 跑（结构上就是 SubagentSpec 的 write 形态） */
  spec: {
    kind: 'write'
    task: string
    system: string
    tools: ToolDef[]
    slot: 'writer'
    maxTokens: number
    intercept: ToolInterceptor
  }
  session: WriterSession
}

export interface WriterSession {
  /** 收尾：写手没调 finish 就结束（跑满轮数 / 只说了句话）也要给出确定的结果 */
  settle: (childText: string) => WriterOutcome | { ok: false; summary: string; data: string }
}

/** 写作子智能体的提示、工具与交稿主持。每次派写手新建一份，草稿只在内存里，不落库 */
export function createWriter(
  input: WriterInput & {
    signal?: AbortSignal
    onProgress?: (p: { phase: 'draft' | 'revise'; chars: number }) => void
  }
): WriterRun {
  const { book } = input
  // 整章重写：接缝参考按原章的前一章算（不一定是末章），进度报成「改章」
  const rewriting = Boolean(input.original)
  const targetWords = input.targetWords ?? book.targetWords
  const prevTail = prevTailOf(input.lineId, input.original?.id)
  let content = ''
  let report: LintReport | null = null
  let stale = false // 草稿在上次自检之后又改过
  let returns = 0
  let receipt: WriterReceipt | null = null

  const words = (): number => content.replace(/\s/g, '').length
  const progress = (): void =>
    input.onProgress?.({ phase: rewriting ? 'revise' : 'draft', chars: words() })
  const abort = (): void => {
    if (input.signal?.aborted) throw new StepError('任务已取消', 'aborted')
  }
  const lint = (): LintReport => {
    const r = selfCheck({ ...book, targetWords }, input.lineId, content, prevTail)
    report = r
    stale = false
    return r
  }
  const issues = (r: LintReport): string => issuesForWriter(r, content, book.negativeWords)

  /** 自检闸：有 major 且还能退回就退回给写手改；通过或退回次数用完则放行（带着报告） */
  const gate = (): ToolResult | null => {
    if (!content.trim()) return refuse('还没有正文', '先 submit_draft 交正文。')
    const r = lint()
    if (r.pass || returns >= MAX_RETURNS) return null
    returns++
    return refuse(
      `自检退回（第 ${returns}/${MAX_RETURNS} 次）`,
      `自检退回（第 ${returns}/${MAX_RETURNS} 次），以下问题要改：\n${issues(r)}\n\n用 revise_draft 就地修改（find=原句逐字引文，replace=改后文本），改完再 submit_draft 传 done:true 复检。`
    )
  }
  const passed = (): ToolResult => {
    const r = report as LintReport
    const majors = r.issues.filter((i) => i.level === 'major').length
    return majors
      ? {
          ok: true,
          summary: `已收稿 ${words()} 字（自检仍有 ${majors} 个 major）`,
          data: `已收稿 ${words()} 字。自检仍有 ${majors} 个 major 问题，退回次数已用完——带着报告入书：\n${issues(r)}\n现在调用 finish 提交回执。`
        }
      : {
          ok: true,
          summary: `已收稿 ${words()} 字（自检通过）`,
          data: `已收稿 ${words()} 字，自检通过。现在调用 finish 提交回执。`
        }
  }

  const intercept: ToolInterceptor = async (name, toolInput) => {
    switch (name) {
      case 'submit_draft': {
        abort()
        const piece = typeof toolInput.text === 'string' ? toolInput.text.trim() : ''
        if (toolInput.text !== undefined && !piece) {
          return refuse(
            '这一段是空的',
            'submit_draft 的 text 是空白；只传 done:true 表示本章写完。'
          )
        }
        if (piece) {
          content = content ? `${content}\n\n${piece}` : piece
          stale = true
          progress()
        }
        if (toolInput.done !== true) {
          return {
            ok: true,
            summary: `已收一段（累计 ${words()} 字）`,
            data: `已累计 ${words()} 字。末尾：…${content.slice(-150)}\n继续交下一段；本章写完时传 done:true。`
          }
        }
        const fail = gate()
        return fail ?? passed()
      }
      case 'revise_draft': {
        abort()
        const find = typeof toolInput.find === 'string' ? toolInput.find : ''
        if (!find) {
          return refuse(
            '缺少原句',
            'revise_draft 要传 find（草稿里的原句，逐字照抄）和 replace（改后文本，空串=删除）。'
          )
        }
        if (!content) return refuse('还没有正文', '先 submit_draft 交正文。')
        const r = replaceLiteral(
          content,
          find,
          typeof toolInput.replace === 'string' ? toolInput.replace : ''
        )
        if (!r.hits) {
          return refuse(
            '改稿未命中原句',
            `草稿里找不到「${clip(find, 60)}」。草稿现有 ${words()} 字，逐字照抄其中的原句（不改字、不用省略号拼接两处）。\n开头：${content.slice(0, 300)}\n结尾：…${content.slice(-300)}`
          )
        }
        content = r.next
        stale = true
        progress()
        return {
          ok: true,
          summary: `改了 ${r.hits} 处（现 ${words()} 字）`,
          data: `已替换 ${r.hits} 处，现在 ${words()} 字。改完 submit_draft 传 done:true 复检，或直接 finish。`
        }
      }
      case 'finish': {
        abort()
        const fail = gate()
        if (fail) return fail
        receipt = parseReceipt(toolInput, content)
        return { ok: true, summary: '回执已交', data: '回执已收到，任务结束。' }
      }
      default:
        return null
    }
  }

  const prompt = buildWriterPrompt(input)
  const tools = [
    ...toolDefs().filter((d) => WRITER_READ.has(d.name)),
    SUBMIT_DRAFT,
    REVISE_DRAFT,
    FINISH_RECEIPT
  ]

  return {
    spec: {
      kind: 'write',
      task: prompt.user,
      system: prompt.system,
      tools,
      slot: 'writer',
      // 一段 1500 字要一口气出完，工具循环默认的 4000 不够
      maxTokens: 8000,
      intercept
    },
    session: {
      settle(childText) {
        let note = ''
        if (!content.trim()) {
          // 写手没走交稿工具、把正文当普通回复吐了：够一章的长度就收下，免得主智能体白跑一趟
          const prose = childText.trim()
          if (prose.replace(/\s/g, '').length < PLAIN_TEXT_MIN) {
            return {
              ok: false,
              summary: '写手没有交稿',
              data: '写作子智能体没有交出正文（既没调 submit_draft，输出也不够一章）。可以重派一次，任务简报写得更具体。'
            }
          }
          content = prose
          note = '写手没有走交稿工具，直接输出了正文：已按其输出整章收稿，没有经过退回自检。'
        }
        if (!receipt) {
          receipt = {
            summary: '',
            characters: [],
            foreshadows: [],
            settings: [],
            rejected: [],
            note:
              note ||
              '写手没有提交回执就结束了（多半是跑满轮数）：纪要与沉淀线索为空。纪要自己写；要沉淀的线索用 read_last_draft 读草稿后自己找原句。'
          }
        } else if (note) {
          receipt.note = note
        }
        if (stale || !report) lint()
        return { ok: true, content, report: report as LintReport, receipt }
      }
    }
  }
}
