import { randomUUID } from 'node:crypto'
import { makeSessionTitle } from '../../shared/agentTranscript'
import { classifyLlmError } from '../../shared/llmError'
import { createOutlineScanMachine, feedOutlineScan } from '../../shared/outlineScan'
import type { ProviderId } from '../../shared/providers'
import type {
  AgentTranscriptInput,
  ChatMessage,
  ChatParams,
  ChatResult,
  LlmErrorHint,
  PipelineAction,
  RunMeta,
  RunRecordPayload,
  RuntimeRunRecord,
  WorldbuildGenParams
} from '../../shared/types'
import {
  cancelAgentConfirms,
  getAgentPendingConfirm,
  getAgentToolResultStatuses,
  runAgent
} from '../agent'
import {
  appendEvent,
  createSession,
  getSession,
  lastSeqOf,
  rebuildMessages,
  updateTitle
} from '../agentTranscript'
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

/** 错误事件附带的分类提示；用户主动中止（message='已停止'）不产生提示 */
function buildErrorHint(err: unknown, message: string): LlmErrorHint | undefined {
  if (message === '已停止') return undefined
  if (err instanceof LlmError) return classifyLlmError(err.message, err.status)
  return classifyLlmError(message)
}

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
  return [...runRecords.entries()].map(([id, rec]) => {
    if (rec.kind === 'agent' && rec.status === 'running') {
      const pendingConfirm = getAgentPendingConfirm(id)
      const toolStatuses = getAgentToolResultStatuses(id)
      if (pendingConfirm || toolStatuses.length > 0)
        return {
          id,
          ...rec,
          ...(pendingConfirm && { pendingConfirm }),
          ...(toolStatuses.length > 0 && { toolStatuses })
        }
    }
    return { id, ...rec }
  })
}

export { LONG_CHAPTER_THRESHOLD }

export function abortLlmRequest(requestId: string): void {
  activeRequests.get(requestId)?.abort()
}

export function abortAgentRun(requestId: string): void {
  activeAgentRuns.get(requestId)?.abort()
}

/** 每会话每时刻最多一个在途 run：sessionId → requestId */
const activeSessionRuns = new Map<string, string>()

/** 停止某会话的在途 run（删会话/会话内停止按钮用）；无在途返回 false */
export function abortSessionRun(sessionId: string): boolean {
  const rid = activeSessionRuns.get(sessionId)
  if (!rid) return false
  abortAgentRun(rid)
  cancelAgentConfirms(rid)
  return true
}

/** 标题清洗：剥掉首行外的内容、包裹符号与收尾标点，超长截断 */
function cleanTitle(raw: string): string | null {
  const line = raw.trim().split('\n')[0].trim()
  const stripped = line
    .replace(/^[「『"‘'《【[(（]+/, '')
    .replace(/[」』"”'》\]）)…。.！!？?]+$/, '')
  const t = stripped.trim()
  if (!t) return null
  return t.length > 16 ? t.slice(0, 16) : t
}

/** 会话自动起名：小请求生成 ≤12 字动宾式短标题；任何失败静默返回 null（回退启发式标题） */
export async function genSessionTitle(
  userText: string,
  assistantText: string
): Promise<string | null> {
  const u = userText.trim().slice(0, 500)
  if (!u) return null
  try {
    const auth = await resolveRequestAuth('agent')
    if (!auth.apiKey && auth.needsKey) return null
    const a = assistantText.trim().slice(0, 800)
    const result = await chatStream(
      {
        model: auth.model,
        system:
          '为写作助手会话生成标题：输出一个不超过12字的中文动宾式短语，概括本会话的核心任务目标。不要书名号、引号、句号或任何前后缀说明，只输出标题本身',
        messages: [
          {
            role: 'user',
            content: `用户请求：${u}${a ? `\n\n助手处理结果（节选）：${a}` : ''}`
          }
        ],
        maxTokens: 200,
        purpose: 'agent'
      },
      { apiKey: auth.apiKey, baseUrl: auth.baseUrl, protocol: auth.protocol },
      () => {}
    )
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
    return cleanTitle(result.text)
  } catch {
    return null
  }
}

export interface AgentRunHandle {
  requestId: string
  sessionId: string
}

export function startAgentRun(
  sink: EventSink,
  params: {
    projectId: string
    /** 新路径：传 text（可不带 sessionId，服务端建会话）；旧客户端过渡：只传 messages */
    sessionId?: string
    text?: string
    messages?: ChatMessage[]
    model?: string
  }
): string | AgentRunHandle {
  // 旧客户端过渡路径：messages 直跑、不落 transcript（旧端 persistRun/sessionSave 自管）
  if (params.text === undefined) {
    if (!params.messages) throw new Error('缺少 text 或 messages 参数')
    return startLegacyAgentRun(sink, params.projectId, params.messages, params.model)
  }

  const text = params.text
  if (params.sessionId) {
    if (activeSessionRuns.has(params.sessionId))
      throw new Error('该会话已有进行中的任务，请先停止或等待完成')
    if (!getSession(params.sessionId)) throw new Error('会话不存在或已删除')
  }
  const sessionId =
    params.sessionId ?? createSession(params.projectId, makeSessionTitleText(text)).id
  const isFirstTurn = lastSeqOf(sessionId) === 0

  const requestId = randomUUID()
  const controller = new AbortController()
  activeAgentRuns.set(requestId, controller)
  activeSessionRuns.set(sessionId, requestId)

  /** 落库即广播：多端/多 tab 都从 agent:transcript 感知该会话的权威事件（含 seq） */
  const persist = (ev: AgentTranscriptInput): void => {
    const stored = appendEvent(sessionId, ev)
    if (stored && !sink.isClosed()) {
      sink.send('agent:transcript', requestId, sessionId, stored)
    }
  }
  persist({ kind: 'user', text })
  const messages = rebuildMessages(sessionId)
  recordRunning(requestId, 'agent', { projectId: params.projectId, sessionId })

  void (async () => {
    let payload: Awaited<ReturnType<typeof runAgent>>
    try {
      const auth = await resolveRequestAuth('agent')
      payload = await runAgent({
        sink,
        requestId,
        projectId: params.projectId,
        messages,
        model: params.model?.trim() || auth.model,
        signal: controller.signal,
        persist
      })
    } catch (err) {
      const message = controller.signal.aborted
        ? '已停止'
        : ((err as Error)?.message ?? String(err))
      recordError(requestId, message)
      persist({ kind: 'run_error', message })
      if (!sink.isClosed()) {
        sink.send('agent:error', requestId, message, buildErrorHint(err, message))
      }
      return
    } finally {
      activeAgentRuns.delete(requestId)
      if (activeSessionRuns.get(sessionId) === requestId) activeSessionRuns.delete(sessionId)
    }
    recordDone(requestId, payload)
    persist({ kind: 'done', summary: payload })
    if (!sink.isClosed()) sink.send('agent:done', requestId, payload)
    // 首轮收尾后自动起名（失败静默，保留启发式标题）
    if (isFirstTurn) {
      void genSessionTitle(text, payload.text).then((t) => {
        if (t) updateTitle(sessionId, t)
      })
    }
  })()

  return { requestId, sessionId }
}

/** 启发式标题：首条用户消息前 20 字 */
function makeSessionTitleText(text: string): string {
  return makeSessionTitle([{ role: 'user', text, ts: Date.now() }])
}

/** 旧客户端过渡：messages 直跑（transcript 由客户端 sessionSave 自管），返回 rid 字符串 */
function startLegacyAgentRun(
  sink: EventSink,
  projectId: string,
  messages: ChatMessage[],
  model?: string
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeAgentRuns.set(requestId, controller)
  recordRunning(requestId, 'agent', { projectId })

  void (async () => {
    let payload: Awaited<ReturnType<typeof runAgent>>
    try {
      const auth = await resolveRequestAuth('agent')
      payload = await runAgent({
        sink,
        requestId,
        projectId,
        messages,
        model: model?.trim() || auth.model,
        signal: controller.signal
      })
    } catch (err) {
      const message = controller.signal.aborted
        ? '已停止'
        : ((err as Error)?.message ?? String(err))
      recordError(requestId, message)
      if (!sink.isClosed()) {
        sink.send('agent:error', requestId, message, buildErrorHint(err, message))
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

// multiRound 单批失败自动重试的退避间隔；重试耗尽但已生成部分内容时，
// 降级为「保存已生成部分」而非全盘失败（afterDone 会 salvage 解析落库）
const MULTI_RETRY_DELAYS_MS = [2000, 5000]

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
    /** 传入目标章数即启用结构化进度：send() 对已确认文本增量解析章数（仅 outline 用） */
    progressTotal?: number
    /** 临时指定本次生成的 provider（写作页「引擎」切换用），优先级高于 modelRouting */
    provider?: ProviderId
  }
): string {
  const requestId = randomUUID()
  const controller = new AbortController()
  activeRequests.set(requestId, controller)
  recordRunning(requestId, 'llm', { ...opts?.meta, action: opts?.action ?? opts?.meta?.action })

  // 大纲进度扫描器：跨 chunk 状态机，只吃 send() 的已确认文本
  const progressTotal =
    typeof opts?.progressTotal === 'number' && opts.progressTotal > 0 ? opts.progressTotal : 0
  const scan = progressTotal > 0 ? createOutlineScanMachine() : null
  if (scan) {
    const rec = runRecords.get(requestId)
    if (rec) rec.progress = { count: 0, total: progressTotal, lastTitles: [] }
  }

  void (async () => {
    try {
      const auth = await resolveRequestAuth(rawParams.purpose, opts?.provider ?? rawParams.provider)
      if (!auth.apiKey && auth.needsKey) throw new Error('未配置 API Key，请先在设置中填写')
      const params: ChatParams = { ...rawParams }
      if (!params.model) params.model = auth.model
      if (auth.fallbackReason && !sink.isClosed()) {
        sink.send('llm:notice', requestId, auth.fallbackReason)
      }
      if (auth.promptCache && params.system) params.cacheSystem = true

      const send = (text: string): void => {
        if (!sink.isClosed()) sink.send('llm:delta', requestId, text)
        // 同步写注册表尾部：页面切走/刷新后经 runtime:snapshot 恢复进度显示
        const rec = runRecords.get(requestId)
        if (rec) rec.textTail = ((rec.textTail ?? '') + text).slice(-2000)
        // 结构化进度增量推进：仅已确认文本进入此处，重试丢弃的半截输出不会虚增计数
        if (scan && rec) {
          feedOutlineScan(scan, text)
          rec.progress = { count: scan.count, total: progressTotal, lastTitles: [...scan.titles] }
        }
      }

      let fullText = ''
      let result: ChatResult | null = null
      let totalMs = 0
      let round = 0
      const maxRounds = opts?.continueOnMaxTokens ?? 0
      const multi = opts?.multiRound
      // multiRound 分批场景下，历史 assistant 消息只放本段增量（避免累计全文重叠导致 input O(n²) 膨胀）
      let lastAssistantLen = 0
      // multiRound 重试耗尽后的降级标记：已有部分成果时 break 进正常 afterDone 流程（salvage 落库）
      let degraded = false

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

        let roundResult: ChatResult | null = null
        for (let attempt = 0; ; attempt++) {
          try {
            roundResult = await chatStream(
              params,
              { apiKey: auth.apiKey, baseUrl: auth.baseUrl, protocol: auth.protocol },
              onDelta,
              controller.signal
            )
            break
          } catch (err) {
            // 失败批次的半截输出（未 flush 部分）不进正文，同段整体重试
            pending = ''
            if (controller.signal.aborted) throw err
            if (!multi || fullText.length === 0) throw err
            if (attempt >= MULTI_RETRY_DELAYS_MS.length) {
              degraded = true
              break
            }
            const waitS = Math.round(MULTI_RETRY_DELAYS_MS[attempt] / 1000)
            if (!sink.isClosed()) {
              sink.send(
                'llm:notice',
                requestId,
                `本段生成失败（${(err as Error)?.message ?? '网络错误'}），${waitS}s 后自动重试…`
              )
            }
            await new Promise((r) => setTimeout(r, MULTI_RETRY_DELAYS_MS[attempt]))
          }
        }
        if (degraded) {
          if (!sink.isClosed()) {
            sink.send(
              'llm:notice',
              requestId,
              `连续多段生成失败，已保存已生成的约 ${fullText.length} 字内容，其余部分可稍后重新生成`
            )
          }
          break
        }
        result = roundResult as ChatResult
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
            { role: 'assistant', content: fullText.slice(lastAssistantLen) },
            { role: 'user', content: next }
          ]
          lastAssistantLen = fullText.length
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
      const message = controller.signal.aborted
        ? '已停止'
        : err instanceof LlmError
          ? `[${err.status ?? '网络'}] ${err.message}`
          : ((err as Error)?.message ?? String(err))
      recordError(requestId, message)
      opts?.onSettled?.(message)
      if (!sink.isClosed()) {
        sink.send('llm:error', requestId, message, buildErrorHint(err, message))
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
  onSettled?: SettleCb,
  provider?: ProviderId
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
        signal: controller.signal,
        provider
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
        sink.send('llm:error', requestId, message, buildErrorHint(err, message))
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
  onSettled?: SettleCb,
  provider?: ProviderId
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
        signal: controller.signal,
        provider
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
        sink.send('llm:error', requestId, message, buildErrorHint(err, message))
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
      { apiKey: auth.apiKey, baseUrl: auth.baseUrl, protocol: auth.protocol },
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
