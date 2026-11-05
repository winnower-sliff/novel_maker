import type {
  AgentReport,
  Book,
  Chapter,
  ChapterOutline,
  ChapterRecap,
  DirectionCard,
  JobPayload,
  LintReport,
  Scene
} from '../../shared/types.js'
import { lintChapter } from '../lint.js'
import { callJson, callRaw } from './callJson.js'
import { buildWriteContext } from './context.js'
import { bookBasics, directorPersona, redlineBlock, styleBlock, wordListBlock } from './prompts.js'

/**
 * 导演循环各步（W2/W3/W6）：
 * proposal 走向卡片 → outline 章级大纲 → scene 分镜 → draft 正文 → selfcheck/finalize。
 * 每步一次 LLM 调用（结构化 JSON / 流式正文），产物落 JobPayload。
 */

const WRITER_SLOT = 'writer' as const
const DIRECTOR_SLOT = 'director' as const

function base(book: Book, lineId: string): string {
  return `${bookBasics(book)}${redlineBlock(book)}${wordListBlock(book)}${styleBlock(book)}\n\n${buildWriteContext(book, lineId)}`
}

// ── proposal：走向卡片（W2/G4 简版——导演直出；两段式候选筛由 M4 子代理接入） ──

export async function genDirections(
  book: Book,
  lineId: string,
  hint?: string
): Promise<DirectionCard[]> {
  const ctx = base(book, lineId)
  const cards = await callJson<{ cards: DirectionCard[] }>({
    slot: DIRECTOR_SLOT,
    system: directorPersona(),
    user: `${ctx}

## 任务
现在请为下一章提出 4 个走向选项。要求：
1. 四张卡片类型各不相同：steady（稳妥推进）/ twist（冒险转折）/ depth（人物深化）/ wild（野路子）。若剧情强需求可增减至 1-5 张，但类型尽量不重复。
2. 每张卡片：title（短语）、preview（剧情预告 1-2 句，具体有画面）、structure（结构化标注：回收哪个伏笔/引入什么新元素/推动哪条人物线）、arc（弧线标注，如「开启 3 章追杀弧」「本章闭合某个弧」，无弧线则写「单章」）。
3. 遵守反模式纪律：选项必有代价、无空选项。
4. 已到期的伏笔优先安排回收。${hint ? `\n5. 作者提到的方向倾向（作参考，不必拘泥）：${hint.slice(0, 200)}` : ''}`,
    jsonHint: `{"cards":[{"kind":"steady|twist|depth|wild","title":"...","preview":"...","structure":"...","arc":"..."}]}`,
    maxTokens: 3000
  })
  const valid = (cards.cards ?? []).filter(
    (c) => c && typeof c.title === 'string' && typeof c.preview === 'string'
  )
  if (!valid.length) throw new Error('模型未产出有效走向卡片')
  return valid.slice(0, 5).map((c) => ({
    kind: c.kind,
    title: c.title,
    preview: c.preview,
    structure: c.structure ?? '',
    arc: c.arc ?? '单章'
  }))
}

// ── outline：章级大纲（W3 第一级） ───────────────────────────────────────────

export async function genOutline(
  book: Book,
  lineId: string,
  direction: NonNullable<JobPayload['direction']>
): Promise<ChapterOutline> {
  const ctx = base(book, lineId)
  const choiceText =
    direction.source === 'card'
      ? `作者选择了第 ${(direction.cardIndex ?? 0) + 1} 张卡片`
      : '作者自由输入的走向'
  const outline = await callJson<ChapterOutline>({
    slot: DIRECTOR_SLOT,
    system: directorPersona(),
    user: `${ctx}

## 任务
${choiceText}：${direction.text}

请产出下一章的章级大纲：title（章节名）、synopsis（本章梗概，150-300 字，写清楚开篇钩子、中段推进、结尾悬念）、beats（3-6 个情节拍，每个一句话，按时间顺序）。`,
    jsonHint: `{"title":"...","synopsis":"...","beats":["...","..."]}`,
    maxTokens: 2500
  })
  if (!outline?.title || !Array.isArray(outline.beats)) throw new Error('模型未产出有效大纲')
  return {
    title: outline.title,
    synopsis: outline.synopsis ?? '',
    beats: outline.beats.filter(Boolean)
  }
}

// ── scene：场景级分镜（W3 第二级，可跳过） ───────────────────────────────────

export async function genScenes(
  book: Book,
  lineId: string,
  outline: ChapterOutline,
  direction: NonNullable<JobPayload['direction']>
): Promise<Scene[]> {
  const ctx = base(book, lineId)
  const res = await callJson<{ scenes: Array<Pick<Scene, 'summary'> & Partial<Scene>> }>({
    slot: DIRECTOR_SLOT,
    system: directorPersona(),
    user: `${ctx}

## 任务
走向：${direction.text}
章级大纲《${outline.title}》：${outline.synopsis}
拍点：${outline.beats.map((b, i) => `${i + 1}. ${b}`).join(' ')}

请产出本章的场景分镜（3-6 幕）：每幕 summary（这场发生什么，一段话）、viewpoint（视点人物，默认主角）、pace（节奏：慢/中/快）。分镜要可直接落笔。`,
    jsonHint: `{"scenes":[{"summary":"...","viewpoint":"...","pace":"慢|中|快"}]}`,
    maxTokens: 2500
  })
  const scenes = (res.scenes ?? [])
    .filter((s) => s && typeof s.summary === 'string')
    .map((s, i) => ({
      id: `s${i + 1}`,
      summary: s.summary,
      viewpoint: s.viewpoint || '',
      pace: s.pace || '中'
    }))
  if (!scenes.length) throw new Error('模型未产出有效分镜')
  return scenes
}

// ── draft：流式正文（写手槽） ────────────────────────────────────────────────

export interface DraftInput {
  book: Book
  lineId: string
  outline: ChapterOutline
  scenes: Scene[] | null
  direction: NonNullable<JobPayload['direction']>
}

export function draftPrompt(input: DraftInput): { system: string; user: string } {
  const { book, lineId, outline, scenes, direction } = input
  const ctx = base(book, lineId)
  const sceneBlock = scenes?.length
    ? `\n## 本章分镜（按顺序写）\n${scenes.map((s, i) => `${i + 1}. 【${s.viewpoint || '主视点'}·${s.pace}】${s.summary}`).join('\n')}`
    : ''
  return {
    system: `${directorPersona()}

## 正文写作特别纪律
- 这是网文长篇的一章，直接从故事写起，不写章名、不写「本章完」、不加任何说明。
- 文风要求见下方任务包。字数目标 ${book.targetWords} 字（±20%）。
- 正文零元语言、零说教，敏感情节直接写。
- 开头不得重复「上一章结尾」的内容。`,
    user: `${ctx}
${sceneBlock}

## 本章大纲
《${outline.title}》：${outline.synopsis}
拍点：${outline.beats.map((b, i) => `${i + 1}. ${b}`).join(' ')}
作者选定的走向：${direction.text}

现在，写本章正文。`
  }
}

export async function genDraft(
  input: DraftInput,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const { system, user } = draftPrompt(input)
  const res = await callRaw(
    {
      slot: WRITER_SLOT,
      system,
      user,
      maxTokens: Math.ceil((input.book.targetWords * 1.7) / 1) || 4096,
      jsonHint: '',
      signal,
      params: { responseFormat: 'text' }
    },
    onDelta
  )
  const text = res.text.trim()
  if (!text) throw new Error('模型返回空正文')
  return text
}

// ── selfcheck（W6：零成本 lint + 自动修一次） ────────────────────────────────

export function selfCheck(
  book: Book,
  _lineId: string,
  draft: string,
  prevTail?: string
): LintReport {
  return lintChapter(draft, {
    prevTail,
    targetWords: book.targetWords,
    bannedWords: book.negativeWords
  })
}

/** 自动修正重写（W6 第一道：lint 报告喂回写手重写一次） */
export async function autoFixDraft(
  input: DraftInput,
  draft: string,
  report: LintReport,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const { system, user } = draftPrompt(input)
  const issues = report.issues
    .map((i) => `- [${i.rule}] ${i.quote ? `「${i.quote}」` : ''}${i.advice}`)
    .join('\n')
  const res = await callRaw(
    {
      slot: WRITER_SLOT,
      system,
      user: `${user}

## 重写要求
上一稿存在以下问题，请重写本章修正所有问题，其余部分保持原有质量与走向：
${issues}

原稿：
${draft}`,
      maxTokens: Math.ceil((input.book.targetWords * 1.7) / 1) || 4096,
      jsonHint: '',
      signal,
      params: { responseFormat: 'text' }
    },
    onDelta
  )
  const text = res.text.trim()
  if (!text) throw new Error('自动修正返回空正文')
  return text
}

// ── finalize：纪要卡（W4：概要+设定变更清单） ────────────────────────────────

export async function genRecap(
  book: Book,
  lineId: string,
  chapter: Chapter
): Promise<ChapterRecap> {
  const ctx = base(book, lineId)
  const recap = await callJson<ChapterRecap>({
    slot: DIRECTOR_SLOT,
    system: directorPersona(),
    user: `${ctx}

## 任务
第${chapter.orderNo}章《${chapter.title}》已定稿入库，正文如下：
${chapter.content.slice(0, 12000)}

请产出本章纪要：
1. summary：本章内容摘要（100-200 字，供滚动记忆使用，只记读者可见的事实）。
2. stateChanges：本章结束时人物的活状态变化（只列有变化的人；location/body/mood/items/knows/goal 中只填变化的项）。
3. cardOps：本章是否引入/更新了值得入库的设定卡（新地点/势力/物品/规则等；没有则空数组）。
4. foreshadowOps：本章的伏笔操作（plant=埋新伏笔/plan=计划回收/resolve=已回收；没有则空数组）。
5. quickActions：2-3 个本章专属的修改建议按钮（给作者一键发出改章指令用）。label 是 4-8 字按钮文案（如「补反派视角」「伏笔埋深」），instruction 是完整的改章指令（作者点击后直接发给写手执行，要具体可执行）。建议要贴合本章情境——打斗章可想动作/视角，情感章可想对手戏/留白，埋伏笔的章可想收紧或加厚。没有值得建议的就空数组。`,
    jsonHint: `{"summary":"...","stateChanges":[{"characterId":"若不知道id则填名字","name":"...","patch":{"location":"...","mood":"..."}}],"cardOps":[{"op":"create|update","kind":"geography|faction|history|power|item|custom","title":"...","readerText":"读者已知","authorText":"作者真相"}],"foreshadowOps":[{"op":"plant|plan|resolve","title":"...","detail":"..."}],"quickActions":[{"label":"补反派视角","instruction":"补写一段反派视角的插叙..."}]}`,
    maxTokens: 2500
  })
  if (!recap?.summary) throw new Error('模型未产出有效纪要')
  return {
    summary: recap.summary,
    stateChanges: Array.isArray(recap.stateChanges) ? recap.stateChanges : [],
    cardOps: Array.isArray(recap.cardOps) ? recap.cardOps : [],
    foreshadowOps: Array.isArray(recap.foreshadowOps) ? recap.foreshadowOps : [],
    quickActions: Array.isArray(recap.quickActions) ? recap.quickActions : []
  }
}

/** 滚动记忆压缩（D2：细记层超阈值时把最老一段压进 memories，后台执行） */
export async function compactMemories(
  _book: Book,
  lineId: string,
  chapters: Array<{ orderNo: number; title: string; summary: string }>
): Promise<void> {
  if (chapters.length <= 12) return
  const { saveMemory, listMemories } = await import('../store.js')
  const mems = listMemories(lineId)
  const compactedTo = mems.length ? Math.max(...mems.map((m) => m.toOrder)) : 0
  const from = compactedTo + 1
  const to = chapters.length - 8
  if (to <= from) return
  const slice = chapters.filter((c) => c.orderNo >= from && c.orderNo <= to)
  if (!slice.length) return
  const res = await callJson<{ summary: string }>({
    slot: 'utility',
    system:
      '你是小说前情压缩器，把分章摘要压成连贯的前情梗概，保留：主线推进、伏笔状态、人物关系变化、时间地点跳转。不保留细节描写。',
    user: `第${from}-${to}章的分章摘要：\n${slice.map((c) => `第${c.orderNo}章《${c.title}》：${c.summary}`).join('\n')}\n\n产出压缩前情摘要（400-800字）。`,
    jsonHint: `{"summary":"..."}`,
    maxTokens: 2000
  })
  if (res.summary) saveMemory({ lineId, fromOrder: from, toOrder: to, content: res.summary })
}

// ── revise：改章（章末快捷钮/自由指令；M4） ──────────────────────────────────

export interface ReviseInput {
  book: Book
  lineId: string
  chapter: Chapter
  instruction: string
  /** 局部改：引述要改的那一段原文 */
  segment?: string
}

export async function genRevise(input: ReviseInput, onDelta: (t: string) => void): Promise<string> {
  const { book, lineId, chapter, instruction, segment } = input
  const ctx = base(book, lineId)
  const segBlock = segment
    ? `\n## 局部修改目标段\n只改下面这一段（可整段替换），其余部分原样保留输出：\n${segment}`
    : ''
  const res = await callRaw(
    {
      slot: WRITER_SLOT,
      system: directorPersona(),
      user: `${ctx}

## 任务
第${chapter.orderNo}章《${chapter.title}》当前正文：
${chapter.content}

## 作者的修改指令
${instruction}${segBlock}

现在输出修改后的本章完整正文（未被要求改动的部分保持原文，不要输出任何解释）。`,
      maxTokens: Math.max(Math.ceil(chapter.content.length * 2), 4096),
      jsonHint: '',
      params: { responseFormat: 'text' }
    },
    onDelta
  )
  const text = res.text.trim()
  if (!text) throw new Error('模型返回空正文')
  return text
}

// ── 子代理审读（M4：review 七维 / audit 漂移+空转+连续性 / diagnose 问答） ────

const REVIEWER_PERSONA = `你是独立的审稿编辑（与写手隔离视角），只读不写。纪律：
- 每条发现必须附原文引文（quote，20 字以内），无引文不收录。
- 好的维度也要给 good 评语，七维全评，不许空着。
- 不复述剧情，只给编辑判断。`

export async function genReview(
  book: Book,
  lineId: string,
  chapter: Chapter
): Promise<AgentReport> {
  const ctx = base(book, lineId)
  const report = await callJson<AgentReport>({
    slot: 'reviewer',
    system: REVIEWER_PERSONA,
    user: `${ctx}

## 任务
审读第${chapter.orderNo}章《${chapter.title}》正文：
${chapter.content.slice(0, 14000)}

按七个维度评审：张力 / 文风 / 节奏 / 逻辑 / 对话 / 感官 / 钩子（章末留人程度）。
每维一条 finding：level（good=达标/warn=可改进/bad=有问题）、quote（原文引文）、comment（具体判断，不复述剧情）。
verdict 是 100 字内总评。score 是 1-5 总分。suggestions 给 0-3 条可执行的修改建议。`,
    jsonHint: `{"verdict":"...","score":4,"findings":[{"dimension":"张力","level":"warn","quote":"...","comment":"..."}],"suggestions":["..."]}`,
    maxTokens: 3000
  })
  if (!report?.verdict) throw new Error('模型未产出有效审读报告')
  return normalizeReport(report, 'review')
}

export async function genAudit(
  book: Book,
  lineId: string,
  recent: Array<{ orderNo: number; title: string; summary: string }>,
  latestTwo: Chapter[]
): Promise<AgentReport> {
  const ctx = base(book, lineId)
  const report = await callJson<AgentReport>({
    slot: 'reviewer',
    system: REVIEWER_PERSONA,
    user: `${ctx}

## 任务
对本书最近章节做跨章审计（三个固定维度+自由补充）：
1. 文风漂移：最近文风是否偏离开书定的文风（对照上文文风设定），是否趋同平淡。
2. 剧情空转：最近几章是否有实质推进（人物目标/关系/信息量/伏笔任一前进才算），连续 2 章无推进要标 bad。
3. 连续性：时间线/地点/人物状态/已知信息是否有前后矛盾。

## 最近章节摘要
${recent.map((c) => `第${c.orderNo}章《${c.title}》：${c.summary}`).join('\n')}

## 最近两章全文
${latestTwo.map((c) => `第${c.orderNo}章《${c.title}》：\n${c.content.slice(0, 6000)}`).join('\n\n')}

findings 每维一条（dimension 用「文风漂移/剧情空转/连续性」），verdict 100 字内总结健康状况，score 1-5，suggestions 给可执行修正方向。`,
    jsonHint: `{"verdict":"...","score":4,"findings":[{"dimension":"文风漂移","level":"good","quote":"...","comment":"..."}],"suggestions":["..."]}`,
    maxTokens: 3000
  })
  if (!report?.verdict) throw new Error('模型未产出有效审计报告')
  return normalizeReport(report, 'audit')
}

export async function genDiagnose(
  book: Book,
  lineId: string,
  question: string
): Promise<AgentReport> {
  const ctx = base(book, lineId)
  const report = await callJson<AgentReport>({
    slot: 'director',
    system: `${directorPersona()}

当前是诊断模式：作者在向你提问（关于剧情、人物、伏笔、下一步走向、如果开新线会怎样等）。基于全书上下文如实回答，判断要落在具体章节数据上。answer写在 verdict 字段。`,
    user: `${ctx}

## 作者的问题
${question}

verdict 里给出你的回答（300 字内，直接了当，可分点）。findings 里列出支撑你判断的证据（dimension=依据类型如「伏笔」「人物状态」，quote 引章节摘要或原文，comment 说明）。suggestions 给 0-3 条可选的下一步动作。score 填 0。`,
    jsonHint: `{"verdict":"...","score":0,"findings":[{"dimension":"伏笔","level":"warn","quote":"...","comment":"..."}],"suggestions":["..."]}`,
    maxTokens: 3000
  })
  if (!report?.verdict) throw new Error('模型未产出有效诊断')
  return normalizeReport(report, 'diagnose')
}

// ── 自由对话（M5 智能体页：跟导演聊，不执行写操作） ─────────────────────────

export async function genChat(
  book: Book,
  lineId: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  question: string,
  onDelta?: (t: string) => void
): Promise<string> {
  const ctx = base(book, lineId)
  const msgs = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user' as const,
      content: `${ctx}

## 作者说
${question}`
    }
  ]
  const result = await callRaw(
    {
      slot: 'director',
      system: `${directorPersona()}

当前是自由交流模式：作者在跟你聊天——问剧情、讨论走向、要建议、闲聊都行。纪律：
- 口语化、直接了当，通常 50-300 字，不用敬语开场（「好的」「当然可以」都省了）
- 观点要落在本书的具体人物/伏笔/章节上，不空谈写作理论
- 你不能在这里执行写作动作；作者想让干什么（写下一章/改章/开新线/审读）时，简短回应他的意图并告诉他点界面上的对应操作`,
      // user 仅为满足签名；实际请求体由 params.messages 整体覆盖（见 callRaw）
      user: ctx,
      jsonHint: '',
      params: { messages: msgs, responseFormat: 'text' },
      maxTokens: 2000
    },
    onDelta
  )
  return result.text
}

function normalizeReport(raw: AgentReport, kind: AgentReport['kind']): AgentReport {
  return {
    kind,
    verdict: raw.verdict,
    score: typeof raw.score === 'number' ? raw.score : 0,
    findings: Array.isArray(raw.findings)
      ? raw.findings
          .filter((f) => f?.dimension)
          .map((f) => ({
            dimension: f.dimension,
            level: f.level === 'bad' || f.level === 'warn' ? f.level : 'good',
            quote: f.quote ?? '',
            comment: f.comment ?? ''
          }))
      : [],
    suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.filter(Boolean) : []
  }
}
