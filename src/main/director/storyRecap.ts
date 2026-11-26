import type { Chapter, MemoryBlock } from '../../shared/types.js'
import { dbEpoch } from '../db.js'
import * as store from '../store.js'
import { callJson } from './callJson.js'

/**
 * 前情梗概（长期记忆·合并式）：每条线一行 `running` 梗概，新章入书后把新章纪要并进去、原地更新，
 * 取代旧的「逐章单块压缩 + 保头截尾」。固定四段：主线脉络 / 伏笔状态（已埋、已回收）/ 人物关系 / 时间地点。
 * - 全部后台执行（fire-and-forget）：失败只记日志，绝不让写章任务失败。
 * - 同一条线同一时刻只跑一个合并循环；循环每一步重读库，合并期间新入书的章下一步自然带上。
 * - 旧的逐章压缩块（kind=legacy）不再新增，只在首次构建时当参考材料。
 * - 「第 N 章」一律指本线有效章序列里的位置；梗概覆盖到哪用章节 id 定位（分叉线里章序号从 1 重排，不能用序号当锚）。
 */

/** 一批最多并多少章的纪要（补建长书时分批，免得一次喂太多压不好） */
const BATCH_CHAPTERS = 30
/** 梗概提示词里的目标长度（字，不计空白） */
const RECAP_SOFT_LIMIT = 1500
/** 落库硬上限（字，不计空白）：超过先让模型压一次，仍超则硬截 */
const RECAP_HARD_LIMIT = 2200
/** 旧压缩块首次合并时最多带入多少字 */
const LEGACY_REF_LIMIT = 6000
/** 最新一章结尾原文带入多少字（核对当前时间、地点、在场人物用） */
const TAIL_CHARS = 400
/** 单章纪要每条最多带入多少字 */
const SUMMARY_LIMIT = 400
/** 连续合并的步数上限（防模型产出不推进时死循环；千章的书也够） */
const MAX_STEPS = 40
/** 合并失败后的冷却：期间不再触发（模型故障时不反复白烧） */
const FAIL_COOLDOWN_MS = 60_000

/** 桩按这行身份识别后台调用（scripts/smoke-m3-stub.mjs 的旁路路由，改这里要同步改桩） */
const RECAP_ROLE = '你是前情梗概维护员，只输出 JSON。'
const SUMMARY_ROLE = '你是章纪要维护员，只输出 JSON。'

const RECAP_JSON_HINT =
  '{"plot":"主线脉络","foreshadowsOpen":"已埋未回收的伏笔","foreshadowsResolved":"已回收的伏笔","relations":"人物关系","timePlace":"时间地点"}'

interface RecapJson {
  plot?: string
  foreshadowsOpen?: string
  foreshadowsResolved?: string
  relations?: string
  timePlace?: string
}

/** pos = 在本线有效章序列里的序号（从 1 起） */
type ChapterAt = Chapter & { pos: number }

interface RecapWork {
  lineId: string
  /** 现有梗概；null = 首次构建 */
  running: MemoryBlock | null
  /** 参考材料：旧的逐章压缩块，或锚点已失效的旧梗概 */
  reference: string
  /** 本次要并入的新章 */
  fresh: ChapterAt[]
  /** 已并入过、但正文改了，要按新纪要更正梗概的章 */
  revised: ChapterAt[]
  /** 这批章里正文改过、纪要要先按新正文重写的 */
  resummarize: ChapterAt[]
  chapters: ChapterAt[]
  /** 这一步做完后梗概覆盖到的章 */
  covers: { id: string; pos: number }
}

function textLen(text: string): number {
  return text.replace(/\s/g, '').length
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（截断）`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 模型输出的四段拼成入库文本；五段全空视为无效产出 */
function renderRecap(raw: unknown): string | null {
  const r = (raw ?? {}) as Record<string, unknown>
  const plot = str(r.plot)
  const open = str(r.foreshadowsOpen)
  const resolved = str(r.foreshadowsResolved)
  const relations = str(r.relations)
  const timePlace = str(r.timePlace)
  if (!plot && !open && !resolved && !relations && !timePlace) return null
  return [
    '【主线脉络】',
    plot || '（暂无）',
    '【伏笔状态】',
    `已埋：${open || '（暂无）'}`,
    `已回收：${resolved || '（尚无）'}`,
    '【人物关系】',
    relations || '（暂无）',
    '【时间地点】',
    timePlace || '（暂无）'
  ].join('\n')
}

// ── 进程内调度（同线串行；改稿待重并的章先记在这里） ──────────────────────────

const active = new Set<string>()
const inflight = new Map<string, Promise<void>>()
const pendingRevisions = new Map<string, Set<string>>()
const failedAt = new Map<string, number>()

/** 新章入书后调用：把新章纪要并进本线的前情梗概（后台执行，失败只记日志） */
export function scheduleStoryRecap(lineId: string): void {
  if (active.has(lineId)) return // 在跑的循环每一步都重读库，这次的新内容下一步自然带上
  if (Date.now() - (failedAt.get(lineId) ?? 0) < FAIL_COOLDOWN_MS) return
  active.add(lineId)
  const p = run(lineId)
    .catch(() => {})
    .finally(() => {
      active.delete(lineId)
      inflight.delete(lineId)
    })
  inflight.set(lineId, p)
}

/** 改稿成功后调用：后台按新正文重写该章纪要，并把梗概里涉及本章的说法更正 */
export function noteRevisedChapter(chapterId: string): void {
  const chapter = store.getChapter(chapterId)
  if (!chapter) return
  const set = pendingRevisions.get(chapter.lineId) ?? new Set<string>()
  set.add(chapterId)
  pendingRevisions.set(chapter.lineId, set)
  scheduleStoryRecap(chapter.lineId)
}

/** 等在跑的合并全部结束（冒烟与收尾用） */
export function storyRecapSettled(): Promise<void> {
  return Promise.all([...inflight.values()]).then(() => undefined)
}

async function run(lineId: string): Promise<void> {
  try {
    for (let steps = 1; ; steps++) {
      if (!store.getLine(lineId)) return
      const work = takeWork(lineId)
      if (!work) return
      if (steps > MAX_STEPS) {
        console.warn(
          `[recap] 连续合并超过 ${MAX_STEPS} 步仍未追平，先停下（line=${lineId.slice(0, 8)}）`
        )
        return
      }
      const epoch = dbEpoch()
      await runStep(work, epoch)
      // 调模型期间恢复过备份（库被换掉）：后面的步骤都基于旧库，整轮作罢
      if (epoch !== dbEpoch()) return
    }
  } catch (err) {
    failedAt.set(lineId, Date.now())
    console.warn(
      `[recap] 前情梗概合并失败，${FAIL_COOLDOWN_MS / 1000} 秒后再试（line=${lineId.slice(0, 8)}）：${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

/** 算出这一步要并什么；没有要并的就返回 null（不调模型） */
function takeWork(lineId: string): RecapWork | null {
  const chapters: ChapterAt[] = store
    .effectiveChapters(lineId)
    .map((c, i) => ({ ...c, pos: i + 1 }))
  const running = store.getRunningMemory(lineId)
  // 锚点章不在本线有效章里（分叉点更早、章被删、恢复过备份）：这份梗概不再可信，整份重建，旧内容只当参考
  const anchorPos = running ? chapters.findIndex((c) => c.id === running.lastChapterId) : -1
  const trusted = running !== null && anchorPos >= 0
  const pending = pendingRevisions.get(lineId)
  // 章已经不在了的登记项顺手清掉
  if (pending) for (const id of pending) if (!chapters.some((c) => c.id === id)) pending.delete(id)
  const isPending = (c: ChapterAt): boolean => Boolean(pending?.has(c.id))

  const fresh = chapters.slice(anchorPos + 1, anchorPos + 1 + BATCH_CHAPTERS)
  // 已并入过 = 位置不晚于锚点章（anchorPos 是 0 起、pos 是 1 起）：最新一章被改稿是最常见的情形，不能漏
  const revised = trusted ? chapters.filter((c) => c.pos <= anchorPos + 1 && isPending(c)) : []
  const resummarize = fresh.filter(isPending)
  if (!fresh.length && !revised.length) return null
  // 没有旧梗概可依托时，这批章至少得有一条纪要可并，否则没有材料
  if (!trusted && !fresh.some((c) => c.summary.trim() || isPending(c))) return null

  const lastFresh = fresh.at(-1)
  const covers = lastFresh
    ? { id: lastFresh.id, pos: lastFresh.pos }
    : { id: running?.lastChapterId ?? '', pos: running?.toOrder ?? 0 }

  let reference = ''
  if (running && !trusted) reference = running.content
  else if (!running)
    reference = clip(
      store
        .listMemories(lineId, 'legacy')
        .map((m) => `第${m.fromOrder}-${m.toOrder}章：${m.content}`)
        .join('\n'),
      LEGACY_REF_LIMIT
    )

  return {
    lineId,
    running: trusted ? running : null,
    reference,
    fresh,
    revised,
    resummarize,
    chapters,
    covers
  }
}

async function runStep(work: RecapWork, epoch: number): Promise<void> {
  for (const c of [...work.revised, ...work.resummarize]) await summarizeChapter(c, epoch)
  const res = await callJson<RecapJson>(mergeCall(work))
  const text = renderRecap(res)
  if (!text) throw new Error('模型没有产出有效的梗概')
  const content = await fitRecap(text)
  // 调模型期间章可能被删、线被删、恢复过备份：这批章已不在本线里，结果作废，下一步重算
  if (epoch !== dbEpoch() || !stillInLine(work.lineId, work.covers.id)) return
  store.upsertRunningMemory({
    lineId: work.lineId,
    content,
    toOrder: work.covers.pos,
    lastChapterId: work.covers.id
  })
  const pending = pendingRevisions.get(work.lineId)
  for (const c of [...work.revised, ...work.resummarize]) pending?.delete(c.id)
  console.log(
    `[recap] 前情梗概已更新：覆盖到第 ${work.covers.pos} 章，${textLen(content)} 字（line=${work.lineId.slice(0, 8)}）`
  )
}

function stillInLine(lineId: string, chapterId: string): boolean {
  try {
    return store.effectiveChapters(lineId).some((c) => c.id === chapterId)
  } catch {
    return false
  }
}

/** 按正文重写一章纪要（改稿后用）。调用期间正文又变了就按最新正文重来；库被换过（恢复备份）就不写 */
async function summarizeChapter(at: ChapterAt, epoch: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = store.getChapter(at.id)
    if (!current) return
    const res = await callJson<{ summary?: string }>({
      slot: 'utility',
      system: SUMMARY_ROLE,
      user: `第${at.pos}章《${current.title}》正文：
${clip(current.content, 12000)}

写本章纪要（150-250 字）：按顺序写清关键事件、人物状态或关系的变化、新埋或回收的伏笔、结尾停在什么局面。只写这一章正文里确实发生的事。`,
      jsonHint: '{"summary":"本章纪要"}',
      maxTokens: 1000
    })
    const summary = str(res?.summary)
    if (!summary) throw new Error(`第${at.pos}章没有产出纪要`)
    const latest = store.getChapter(at.id)
    if (!latest || epoch !== dbEpoch()) return
    if (latest.content !== current.content) continue
    store.updateChapterSummary(at.id, summary)
    at.summary = summary
    return
  }
}

function mergeCall(work: RecapWork): {
  slot: 'utility'
  system: string
  user: string
  jsonHint: string
  maxTokens: number
} {
  const parts: string[] = ['把下面这批新章节的纪要并进「前情梗概」。']
  if (work.running) {
    parts.push(`〔现有前情梗概〕（已覆盖到第 ${work.running.toOrder} 章）\n${work.running.content}`)
  }
  if (work.reference) {
    parts.push(
      `〔旧的前情摘要〕（零散、可能过时，只作参考；与下面的章节纪要冲突时以纪要为准）\n${work.reference}`
    )
  }
  if (work.fresh.length) {
    parts.push(
      `〔要并入的新章纪要〕\n${work.fresh
        .map(
          (c) =>
            `第${c.pos}章《${c.title}》：${c.summary.trim() ? clip(c.summary.trim(), SUMMARY_LIMIT) : '（无纪要）'}`
        )
        .join('\n')}`
    )
  }
  if (work.revised.length) {
    parts.push(
      `〔已改稿的章〕以下章的正文已被作者改过，以这里的新纪要为准；梗概里涉及本章的说法要按新纪要更正，被推翻的旧说法删掉：\n${work.revised
        .map((c) => `第${c.pos}章《${c.title}》：${clip(c.summary.trim(), SUMMARY_LIMIT)}`)
        .join('\n')}`
    )
  }
  const latest = work.chapters.at(-1)
  if (latest && latest.id === work.covers.id && latest.content.trim()) {
    parts.push(
      `〔最新一章结尾原文〕第${latest.pos}章《${latest.title}》（只用来核对当前的时间、地点、在场人物）\n…${latest.content.trimEnd().slice(-TAIL_CHARS)}`
    )
  }
  parts.push(
    `输出合并后的完整前情梗概（不是只写新增部分），合计不超过 ${RECAP_SOFT_LIMIT} 字。没有新信息的段落沿用现有内容。`
  )
  return {
    slot: 'utility',
    system: `${RECAP_ROLE}
你维护一部小说的「前情梗概」：新章节并进来时更新它，供导演和写手随时查阅。这是长期记忆，准确性第一。

## 铁律
- 只依据给定材料。材料里没有的，不写、不推测、不补细节、不编人名地名数字。
- 新内容并进来时改写对应条目：被新章推翻的旧说法删掉或改成现状。不要只在末尾追加，不要重复。
- 人名、地名、称呼、数字照材料原样。
- 固定四段，每段用紧凑的条目写（谁做了什么、导致什么）：
  - plot 主线脉络：到目前为止的故事主线，按因果顺序。
  - foreshadowsOpen 已埋未回收的伏笔：每条写「伏笔—现状」；本章新埋的进这里，本章回收的挪到 foreshadowsResolved。
  - foreshadowsResolved 已回收的伏笔：每条写「伏笔—怎么回收的」。
  - relations 人物关系：主要人物两两之间的现状（同盟、敌对、亲属、债务等）。
  - timePlace 时间地点：最新一章结尾时的时间、地点、在场人物与局面。`,
    user: parts.join('\n\n'),
    jsonHint: RECAP_JSON_HINT,
    maxTokens: 4000
  }
}

/** 落库前卡长度：超了先让模型压一次，仍超则硬截并记日志 */
async function fitRecap(text: string): Promise<string> {
  if (textLen(text) <= RECAP_HARD_LIMIT) return text
  try {
    const res = await callJson<RecapJson>({
      slot: 'utility',
      system: RECAP_ROLE,
      user: `下面这份前情梗概太长了（${textLen(text)} 字）。压缩到 ${RECAP_SOFT_LIMIT} 字以内：保留全部关键事实（主线因果、未回收与已回收的伏笔、人物关系现状、当前时间地点），删掉细节和重复，四段结构不变，不要添加任何原文没有的内容。

〔前情梗概〕
${text}`,
      jsonHint: RECAP_JSON_HINT,
      maxTokens: 3000
    })
    const condensed = renderRecap(res)
    if (condensed && textLen(condensed) < textLen(text)) text = condensed
  } catch (err) {
    console.warn(`[recap] 超长梗概压缩失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (textLen(text) > RECAP_HARD_LIMIT) {
    console.warn(`[recap] 压缩后仍超长（${textLen(text)} 字），硬截到约 ${RECAP_HARD_LIMIT} 字`)
    text = clip(text, RECAP_HARD_LIMIT)
  }
  return text
}
