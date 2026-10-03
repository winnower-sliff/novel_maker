import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  ChatParams,
  ChatResult,
  PipelineAction,
  RunMeta,
  RunRecordPayload,
  RuntimeRunRecord,
  WorldbuildGenParams
} from '../../shared/types'
import { runAgent } from '../agent'
import { LONG_CHAPTER_THRESHOLD, runChapterCandidates, runLongChapter } from '../chapterRunner'
import { enqueueEmbedding } from '../embedding'
import type { EventSink } from '../eventSink'
import { lintChapterReport, stripHtmlComments } from '../lint'
import { chatStream, LlmError, pickRatelimitHeaders } from '../llm'
import {
  buildWorldbuildIndex,
  buildWorldbuildRetrieveRequest,
  resolveWorldbuildRetrieval,
  type WorldbuildRetrieval
} from '../pipeline'
import { resolveRequestAuth } from '../settings'
import * as store from '../store'
import { appendUsage } from '../usage'

const activeRequests = new Map<string, AbortController>()
const activeAgentRuns = new Map<string, AbortController>()

/** 批量编排（主进程）等待单次生成完成的回调：error 为 null 表示成功 */
export type SettleCb = (error: string | null, payload?: unknown) => void

// 运行注册表：requestId → 结果快照。SSE/窗口断连期间 done/error 事件丢失时，
// 渲染端经 llm:poll 补拉，避免 UI 永远卡「生成中」。完成后保留 10 分钟。
type RunRecord = RunRecordPayload

const runRecords = new Map<string, RunRecord>()
const RECORD_TTL_MS = 10 * 60 * 1000

function recordRunning(requestId: string, kind: RunRecord['kind'], meta?: RunMeta): void {
  runRecords.set(requestId, { status: 'running', kind, meta })
}

function recordDone(requestId: string, payload: unknown): void {
  const prev = runRecords.get(requestId)
  if (prev)
    runRecords.set(requestId, {
      ...prev,
      status: 'done',
      finishedAt: Date.now(),
      donePayload: payload
    })
}

function recordError(requestId: string, message: string): void {
  const prev = runRecords.get(requestId)
  if (prev)
    runRecords.set(requestId, { ...prev, status: 'error', finishedAt: Date.now(), error: message })
}

export function pollRuns(requestIds: string[]): Record<string, RunRecord> {
  const now = Date.now()
  for (const [rid, rec] of runRecords) {
    if (rec.status !== 'running' && rec.finishedAt && now - rec.finishedAt > RECORD_TTL_MS) {
      runRecords.delete(rid)
    }
  }
  const out: Record<string, RunRecord> = {}
  for (const rid of requestIds) {
    const rec = runRecords.get(rid)
    if (rec) out[rid] = rec
  }
  return out
}

/** 全部在途/近期完成记录（runtime:snapshot 用，渲染端中央同步器拉取兜底） */
export function listRuns(): RuntimeRunRecord[] {
  void pollRuns([])
  return [...runRecords.entries()].map(([id, rec]) => ({ id, ...rec }))
}

export { LONG_CHAPTER_THRESHOLD }

export function abortLlmRequest(requestId: string): void {
  activeRequests.get(requestId)?.abort()
}

export function abortAgentRun(requestId: string): void {
  activeAgentRuns.get(requestId)?.abort()
}

export function startAgentRun(
  sink: EventSink,
  params: { projectId: string; messages: ChatMessage[]; model?: string }
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeAgentRuns.set(requestId, controller)
  recordRunning(requestId, 'agent')

  void (async () => {
    let payload: Awaited<ReturnType<typeof runAgent>>
    try {
      const auth = await resolveRequestAuth('agent')
      payload = await runAgent({
        sink,
        requestId,
        projectId: params.projectId,
        messages: params.messages,
        model: params.model?.trim() || auth.model,
        signal: controller.signal
      })
    } catch (err) {
      const message = controller.signal.aborted
        ? '已停止'
        : ((err as Error)?.message ?? String(err))
      recordError(requestId, message)
      if (!sink.isClosed()) {
        sink.send('agent:error', requestId, message)
      }
      return
    } finally {
      activeAgentRuns.delete(requestId)
    }
    recordDone(requestId, payload)
    if (!sink.isClosed()) sink.send('agent:done', requestId, payload)
  })()

  return requestId
}

const CONTINUE_PROMPT =
  '输出因长度限制被中断。请从中断处继续输出剩余条目：直接续写正文，不要重复已输出的任何内容，不要开场白或解释，保持完全相同的输出格式，直到全部条目输出完毕。'

function longestOverlapLen(prev: string, next: string, window = 200): number {
  const max = Math.min(window, prev.length, next.length)
  for (let n = max; n > 0; n--) {
    if (prev.endsWith(next.slice(0, n))) return n
  }
  return 0
}

export function startStream(
  sink: EventSink,
  rawParams: ChatParams,
  opts?: {
    action?: PipelineAction
    afterDone?: (result: ChatResult) => unknown
    continueOnMaxTokens?: number
    /** 多段生成：每段结束后由 nextPrompt 决定下一段指令（返回 null 结束）。分批生成等编排场景用 */
    multiRound?: {
      maxRounds: number
      nextPrompt: (fullText: string, roundsDone: number, stopReason: string | null) => string | null
    }
    onSettled?: SettleCb
    meta?: RunMeta
  }
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  recordRunning(requestId, 'llm', { ...opts?.meta, action: opts?.action ?? opts?.meta?.action })

  void (async () => {
    try {
      const auth = await resolveRequestAuth(rawParams.purpose)
      if (!auth.apiKey && auth.needsKey) throw new Error('未配置 API Key，请先在设置中填写')
      const params: ChatParams = { ...rawParams }
      if (!params.model) params.model = auth.model
      if (auth.fallbackReason && !sink.isClosed()) {
        sink.send('llm:notice', requestId, auth.fallbackReason)
      }
      if (auth.promptCache && params.system) params.cacheSystem = true

      const send = (text: string): void => {
        if (!sink.isClosed()) sink.send('llm:delta', requestId, text)
      }

      let fullText = ''
      let result: ChatResult | null = null
      let totalMs = 0
      let round = 0
      const maxRounds = opts?.continueOnMaxTokens ?? 0
      const multi = opts?.multiRound

      for (;;) {
        let pending = ''
        let deduped = round === 0
        const flush = (): void => {
          if (!pending) return
          if (!deduped) {
            deduped = true
            pending = pending.slice(longestOverlapLen(fullText, pending))
          }
          fullText += pending
          send(pending)
          pending = ''
        }
        const onDelta = (text: string): void => {
          if (deduped) {
            fullText += text
            send(text)
            return
          }
          pending += text
          if (pending.length >= 200 || pending.includes('\n')) flush()
        }

        result = await chatStream(
          params,
          { apiKey: auth.apiKey, baseUrl: auth.baseUrl },
          onDelta,
          controller.signal
        )
        flush()
        totalMs += result.durationMs
        appendUsage({
          ts: Date.now(),
          model: result.model,
          purpose: params.purpose ?? 'playground',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
          durationMs: result.durationMs,
          ratelimit: pickRatelimitHeaders(result.headers)
        })

        if (controller.signal.aborted) break
        if (multi) {
          if (round >= multi.maxRounds) break
          const next = multi.nextPrompt(fullText, round + 1, result.stopReason)
          if (next === null) break
          round++
          params.messages = [
            ...params.messages,
            { role: 'assistant', content: fullText },
            { role: 'user', content: next }
          ]
          continue
        }
        if (result.stopReason !== 'max_tokens' || round >= maxRounds) break
        round++
        params.messages = [
          ...params.messages,
          { role: 'assistant', content: fullText },
          { role: 'user', content: CONTINUE_PROMPT }
        ]
      }

      const final = result as ChatResult
      let data: unknown
      let dataError: string | undefined
      try {
        data = opts?.afterDone?.({ ...final, text: fullText, durationMs: totalMs })
      } catch (err) {
        dataError = (err as Error)?.message ?? String(err)
      }

      const donePayload = {
        usage: final.usage,
        model: final.model,
        stopReason: final.stopReason,
        durationMs: totalMs,
        headers: final.headers,
        action: opts?.action,
        data: dataError ? { error: dataError } : data
      }
      recordDone(requestId, donePayload)
      opts?.onSettled?.(null, donePayload)
      if (!sink.isClosed()) sink.send('llm:done', requestId, donePayload)
    } catch (err) {
      const message =
        err instanceof LlmError
          ? `[${err.status ?? '网络'}] ${err.message}`
          : ((err as Error)?.message ?? String(err))
      recordError(requestId, message)
      opts?.onSettled?.(message)
      if (!sink.isClosed()) {
        sink.send('llm:error', requestId, message)
      }
    } finally {
      activeRequests.delete(requestId)
    }
  })()

  return requestId
}

/** 长章模式（AgentWrite 计划→逐段写）：多请求编排，对外仍是单 requestId 流 */
export function startLongChapterStream(
  sink: EventSink,
  projectId: string,
  outlineId: string,
  wordTarget: number,
  onSettled?: SettleCb
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  recordRunning(requestId, 'llm', { projectId, outlineId, action: 'chapter' })

  void (async () => {
    try {
      const started = Date.now()
      const result = await runLongChapter({
        sink,
        requestId,
        projectId,
        outlineId,
        wordTarget,
        signal: controller.signal
      })
      const clean = stripHtmlComments(result.text)
      const chapter = store.saveChapter({
        outlineId,
        projectId,
        content: clean,
        status: 'draft'
      })
      enqueueEmbedding(projectId, 'summary', outlineId, clean.slice(0, 1200))
      const donePayload = {
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        model: '',
        stopReason: 'end_turn',
        durationMs: Date.now() - started,
        headers: {},
        action: 'chapter' as const,
        data: {
          chapterId: chapter.id,
          wordCount: chapter.wordCount,
          longMode: true,
          segments: result.plan.length,
          lint: lintChapterReport(outlineId, clean)
        }
      }
      recordDone(requestId, donePayload)
      onSettled?.(null, donePayload)
      if (!sink.isClosed()) sink.send('llm:done', requestId, donePayload)
    } catch (err) {
      const message = controller.signal.aborted
        ? '已停止'
        : err instanceof LlmError
          ? `[${err.status ?? '网络'}] ${err.message}`
          : ((err as Error)?.message ?? String(err))
      recordError(requestId, message)
      onSettled?.(message)
      if (!sink.isClosed()) {
        sink.send('llm:error', requestId, message)
      }
    } finally {
      activeRequests.delete(requestId)
    }
  })()

  return requestId
}

/** 多候选选优：生成 N 个候选、程序打分、返回全部候选并落库最优 */
export function startChapterCandidatesStream(
  sink: EventSink,
  projectId: string,
  outlineId: string,
  wordTarget: number,
  candidates: number,
  onSettled?: SettleCb
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  recordRunning(requestId, 'llm', { projectId, outlineId, action: 'chapter' })

  void (async () => {
    try {
      const started = Date.now()
      const result = await runChapterCandidates({
        sink,
        requestId,
        projectId,
        outlineId,
        wordTarget,
        candidates,
        signal: controller.signal
      })
      if (result.candidates.length === 0) throw new Error('候选生成失败')
      const winner = result.candidates[result.winnerIndex]
      const clean = stripHtmlComments(winner.text)
      const chapter = store.saveChapter({
        outlineId,
        projectId,
        content: clean,
        status: 'draft'
      })
      enqueueEmbedding(projectId, 'summary', outlineId, clean.slice(0, 1200))
      const donePayload = {
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        model: '',
        stopReason: 'end_turn',
        durationMs: Date.now() - started,
        headers: {},
        action: 'chapter' as const,
        data: {
          chapterId: chapter.id,
          wordCount: chapter.wordCount,
          candidateMode: true,
          winnerIndex: result.winnerIndex,
          candidates: result.candidates.map((c) => ({
            text: stripHtmlComments(c.text),
            score: c.score,
            wordCount: c.wordCount,
            issues: c.lint.issues.length,
            pass: c.lint.pass
          })),
          lint: winner.lint
        }
      }
      recordDone(requestId, donePayload)
      onSettled?.(null, donePayload)
      if (!sink.isClosed()) sink.send('llm:done', requestId, donePayload)
    } catch (err) {
      const message = controller.signal.aborted
        ? '已停止'
        : err instanceof LlmError
          ? `[${err.status ?? '网络'}] ${err.message}`
          : ((err as Error)?.message ?? String(err))
      recordError(requestId, message)
      onSettled?.(message)
      if (!sink.isClosed()) {
        sink.send('llm:error', requestId, message)
      }
    } finally {
      activeRequests.delete(requestId)
    }
  })()

  return requestId
}

export async function runWorldbuildRetrieval(
  p: WorldbuildGenParams
): Promise<WorldbuildRetrieval | undefined> {
  const req = buildWorldbuildRetrieveRequest(p)
  if (!req) return undefined
  try {
    const auth = await resolveRequestAuth(req.purpose)
    if (!auth.apiKey && auth.needsKey) return undefined
    const params: ChatParams = { ...req, model: req.model || auth.model }
    const result = await chatStream(
      params,
      { apiKey: auth.apiKey, baseUrl: auth.baseUrl },
      () => {}
    )
    appendUsage({
      ts: Date.now(),
      model: result.model,
      purpose: 'outline',
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
      durationMs: result.durationMs,
      ratelimit: pickRatelimitHeaders(result.headers)
    })
    return resolveWorldbuildRetrieval(p, buildWorldbuildIndex(p.projectId), result.text)
  } catch {
    return undefined
  }
}
