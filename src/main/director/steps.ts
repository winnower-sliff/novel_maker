import type {
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
import { bookBasics, directorPersona, redlineBlock, styleBlock } from './prompts.js'

/**
 * 导演循环各步（W2/W3/W6）：
 * proposal 走向卡片 → outline 章级大纲 → scene 分镜 → draft 正文 → selfcheck/finalize。
 * 每步一次 LLM 调用（结构化 JSON / 流式正文），产物落 JobPayload。
 */

const WRITER_SLOT = 'writer' as const
const DIRECTOR_SLOT = 'director' as const

function base(book: Book, lineId: string): string {
  return `${bookBasics(book)}${redlineBlock(book)}${styleBlock(book)}\n\n${buildWriteContext(book, lineId)}`
}

// ── proposal：走向卡片（W2/G4 简版——导演直出；两段式候选筛由 M4 子代理接入） ──

export async function genDirections(book: Book, lineId: string): Promise<DirectionCard[]> {
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
4. 已到期的伏笔优先安排回收。`,
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
  return lintChapter(draft, { prevTail, targetWords: book.targetWords })
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
4. foreshadowOps：本章的伏笔操作（plant=埋新伏笔/plan=计划回收/resolve=已回收；没有则空数组）。`,
    jsonHint: `{"summary":"...","stateChanges":[{"characterId":"若不知道id则填名字","name":"...","patch":{"location":"...","mood":"..."}}],"cardOps":[{"op":"create|update","kind":"geography|faction|history|power|item|custom","title":"...","readerText":"读者已知","authorText":"作者真相"}],"foreshadowOps":[{"op":"plant|plan|resolve","title":"...","detail":"..."}]}`,
    maxTokens: 2500
  })
  if (!recap?.summary) throw new Error('模型未产出有效纪要')
  return {
    summary: recap.summary,
    stateChanges: Array.isArray(recap.stateChanges) ? recap.stateChanges : [],
    cardOps: Array.isArray(recap.cardOps) ? recap.cardOps : [],
    foreshadowOps: Array.isArray(recap.foreshadowOps) ? recap.foreshadowOps : []
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
