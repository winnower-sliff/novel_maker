import type { BuiltContext, ChatParams } from '../shared/types'
import { appendWritingRules, CHAPTER_RULE_TAGS } from './agent/instructions'
import { buildChapterContext } from './context'
import type { EventSink } from './eventSink'
import { type LintReport, lintChapterReport } from './lint'
import { chatStream, pickRatelimitHeaders } from './llm'
import { buildChapterRequest, extractJsonArray, skillBody } from './pipeline'
import { resolveRequestAuth } from './settings'
import * as store from './store'
import { appendUsage } from './usage'

/**
 * 长章编排器（AgentWrite 方法，THUDM/LongWriter 验证）：
 * 先让模型把本章拆成「段落计划（要点+字数）」，再逐段顺序写作，
 * 每轮注入 指令+计划+已写文本，突破单次长输出的质量衰减。
 */

export const LONG_CHAPTER_THRESHOLD = 3500
const _MAX_SEGMENT_WORDS = 900
const MIN_SEGMENT_WORDS = 200

export interface SegmentPlan {
  point: string
  words: number
}

export function parseSegmentPlan(text: string, wordTarget: number): SegmentPlan[] {
  const arr = extractJsonArray(text)
  const plan: SegmentPlan[] = []
  if (arr) {
    for (const item of arr) {
      const r = item as Record<string, unknown>
      const point = String(r.point ?? r.要点 ?? '').trim()
      const words = Math.round(Number(r.words ?? r.字数))
      if (!point) continue
      plan.push({
        point: point.slice(0, 300),
        words: Number.isFinite(words) ? Math.min(2000, Math.max(MIN_SEGMENT_WORDS, words)) : 600
      })
    }
  }
  if (plan.length === 0) {
    return [{ point: '（计划解析失败，按单段完成本章全部内容）', words: wordTarget }]
  }
  return plan
}

function buildPlanRequest(ctx: BuiltContext, wordTarget: number): ChatParams {
  const system = appendWritingRules(
    [skillBody('segment-planner'), ctx.system].filter(Boolean).join('\n\n'),
    ['chapter', 'plot']
  )
  const user = `请为本章制定分段写作计划，目标 ${wordTarget} 字。\n\n${ctx.user}\n\n输出 JSON 数组：[{"point":"…","words":600}]`
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2048,
    temperature: 0.3,
    purpose: 'outline'
  }
}

function buildSegmentRequest(
  ctx: BuiltContext,
  plan: SegmentPlan[],
  written: string,
  index: number,
  total: number
): ChatParams {
  const system = appendWritingRules(
    [skillBody('chapter-writer'), ctx.system].filter(Boolean).join('\n\n'),
    CHAPTER_RULE_TAGS
  )
  const planLines = plan.map((s, i) => `第 ${i + 1} 段（${s.words} 字）：${s.point}`).join('\n')
  const user = [
    `本章写作指令：${ctx.user}`,
    '',
    `段落计划（共 ${total} 段，已定稿）：`,
    planLines,
    '',
    written
      ? `已写文本（续写时保持人称、时态、语气与节奏一致）：\n${written.slice(-2400)}`
      : '（尚未开始，你写的是本章第一段）',
    '',
    `现在请写「第 ${index + 1} 段」，要点：${plan[index].point}，目标 ${plan[index].words} 字。`,
    '只输出这一段的正文；不要重复已写文本；不要输出小标题或段落编号；' +
      (index < total - 1
        ? '这是持续创作中的一段，不要写收尾总结、修辞性结尾或下章预告。'
        : '这是最后一段，按大纲要求收尾并留好结尾钩子。')
  ].join('\n')
  return {
    model: '',
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: Math.min(16384, Math.max(2048, plan[index].words * 3)),
    temperature: 0.8,
    purpose: 'chapter'
  }
}

function overlapLen(prev: string, next: string, window = 200): number {
  const max = Math.min(window, prev.length, next.length)
  for (let n = max; n > 0; n--) {
    if (prev.endsWith(next.slice(0, n))) return n
  }
  return 0
}

export interface LongChapterResult {
  text: string
  plan: SegmentPlan[]
  requests: number
}

export async function runLongChapter(opts: {
  sink: EventSink
  requestId: string
  projectId: string
  outlineId: string
  wordTarget: number
  signal: AbortSignal
}): Promise<LongChapterResult> {
  const { sink, requestId, signal } = opts
  const send = (text: string): void => {
    if (!sink.isClosed()) sink.send('llm:delta', requestId, text)
  }

  const ctx = await buildChapterContext(opts.projectId, opts.outlineId, opts.wordTarget)

  const planAuth = await resolveRequestAuth('outline')
  const planRes = await chatStream(
    {
      ...buildPlanRequest(ctx, opts.wordTarget),
      model: planAuth.model,
      cacheSystem: planAuth.promptCache && true
    },
    { apiKey: planAuth.apiKey, baseUrl: planAuth.baseUrl },
    () => {},
    signal
  )
  appendUsage({
    ts: Date.now(),
    model: planRes.model,
    purpose: 'outline',
    inputTokens: planRes.usage.inputTokens,
    outputTokens: planRes.usage.outputTokens,
    cacheReadTokens: planRes.usage.cacheReadTokens,
    cacheCreationTokens: planRes.usage.cacheCreationTokens,
    durationMs: planRes.durationMs,
    ratelimit: pickRatelimitHeaders(planRes.headers)
  })
  const plan = parseSegmentPlan(planRes.text, opts.wordTarget)

  const auth = await resolveRequestAuth('chapter')
  let written = ''
  let requests = 1
  for (let i = 0; i < plan.length; i++) {
    if (signal.aborted) break
    let pending = ''
    let deduped = false
    const flush = (): void => {
      if (!pending) return
      if (!deduped) {
        deduped = true
        pending = pending.slice(overlapLen(written, pending))
      }
      written += pending
      send(pending)
      pending = ''
    }
    const onDelta = (text: string): void => {
      if (deduped) {
        written += text
        send(text)
        return
      }
      pending += text
      if (pending.length >= 200 || pending.includes('\n')) flush()
    }
    const res = await chatStream(
      {
        ...buildSegmentRequest(ctx, plan, written, i, plan.length),
        model: auth.model,
        cacheSystem: auth.promptCache && true
      },
      { apiKey: auth.apiKey, baseUrl: auth.baseUrl },
      onDelta,
      signal
    )
    flush()
    requests++
    appendUsage({
      ts: Date.now(),
      model: res.model,
      purpose: 'chapter',
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheReadTokens: res.usage.cacheReadTokens,
      cacheCreationTokens: res.usage.cacheCreationTokens,
      durationMs: res.durationMs,
      ratelimit: pickRatelimitHeaders(res.headers)
    })
  }

  return { text: written, plan, requests }
}

export function resolveChapterForLong(outlineId: string): { outlineId: string; projectId: string } {
  const outline = store.getOutline(outlineId)
  if (!outline) throw new Error('章节不存在')
  return { outlineId: outline.id, projectId: outline.projectId }
}

export interface CandidateResult {
  text: string
  score: number
  wordCount: number
  lint: LintReport
}

/**
 * 多候选选优：同一章生成 N 个候选（温度递变制造多样性），
 * 程序判据打分（硬闸 lint 分 + 字数贴合度），挑最优；候选全部返回供用户切换。
 */
export async function runChapterCandidates(opts: {
  sink: EventSink
  requestId: string
  projectId: string
  outlineId: string
  wordTarget: number
  candidates: number
  signal: AbortSignal
}): Promise<{ candidates: CandidateResult[]; winnerIndex: number }> {
  const { sink, requestId, signal } = opts
  const notice = (text: string): void => {
    if (!sink.isClosed()) sink.send('llm:notice', requestId, text)
  }
  const built = await buildChapterRequest(opts.projectId, opts.outlineId, opts.wordTarget)
  const auth = await resolveRequestAuth('chapter')
  const n = Math.min(3, Math.max(2, opts.candidates))
  const out: CandidateResult[] = []
  for (let i = 0; i < n; i++) {
    if (signal.aborted) break
    notice(`候选 ${i + 1}/${n} 生成中…`)
    const temperature = Math.min(1, 0.8 + i * 0.12)
    const res = await chatStream(
      {
        ...built.params,
        model: auth.model,
        temperature,
        cacheSystem: auth.promptCache && !!built.params.system
      },
      { apiKey: auth.apiKey, baseUrl: auth.baseUrl },
      () => {},
      signal
    )
    appendUsage({
      ts: Date.now(),
      model: res.model,
      purpose: 'chapter',
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheReadTokens: res.usage.cacheReadTokens,
      cacheCreationTokens: res.usage.cacheCreationTokens,
      durationMs: res.durationMs,
      ratelimit: pickRatelimitHeaders(res.headers)
    })
    const text = res.text.trim()
    const lint = lintChapterReport(opts.outlineId, text)
    const deviation = opts.wordTarget > 0 ? Math.abs(lint.wordCount / opts.wordTarget - 1) : 0
    const score = Math.max(0, lint.score - Math.round(Math.min(30, deviation * 40)))
    out.push({ text, score, wordCount: lint.wordCount, lint })
  }
  let winnerIndex = 0
  out.forEach((c, i) => {
    if (c.score > out[winnerIndex].score) winnerIndex = i
  })
  return { candidates: out, winnerIndex }
}
