import type { DonePayload, RunRecordPayload } from '../shared/contract.js'
import type { EventSink } from './eventSink.js'

/**
 * 流式请求注册表：rid → 状态/结果/中止器。
 * SSE 推送 + llm:poll 补拉（客户端断线重连后凭 requestId 恢复）。
 * 记录 TTL 10 分钟，定期清理。
 */

const TTL_MS = 10 * 60 * 1000

interface RunEntry {
  requestId: string
  status: 'running' | 'done' | 'error' | 'aborted'
  createdAt: number
  abort: AbortController
  payload?: DonePayload
  error?: string
}

const runs = new Map<string, RunEntry>()

let cleanupTimer: NodeJS.Timeout | null = null

function ensureCleanup(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [rid, entry] of runs) {
      if (entry.status !== 'running' && now - entry.createdAt > TTL_MS) runs.delete(rid)
    }
  }, 60_000)
  cleanupTimer.unref()
}

export function newRun(): RunEntry {
  ensureCleanup()
  let requestId = ''
  do {
    requestId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  } while (runs.has(requestId))
  const entry: RunEntry = {
    requestId,
    status: 'running',
    createdAt: Date.now(),
    abort: new AbortController()
  }
  runs.set(requestId, entry)
  return entry
}

export function getRun(requestId: string): RunRecordPayload | null {
  const entry = runs.get(requestId)
  if (!entry) return null
  const base: RunRecordPayload = { status: entry.status, requestId: entry.requestId }
  if (entry.payload) return { ...base, ...entry.payload }
  if (entry.error) return { ...base, error: entry.error }
  return base
}

export function abortRun(requestId: string): boolean {
  const entry = runs.get(requestId)
  if (entry?.status !== 'running') return false
  entry.abort.abort()
  return true
}

export function pollRuns(requestIds: string[]): Record<string, RunRecordPayload> {
  const out: Record<string, RunRecordPayload> = {}
  for (const rid of requestIds) {
    const payload = getRun(rid)
    if (payload) out[rid] = payload
  }
  return out
}

/** 流式执行入口：立即返回 requestId，执行在后台跑；delta/done/error 推 sink 并落注册表 */
export function startStreaming(
  sink: EventSink,
  exec: (
    requestId: string,
    onDelta: (t: string) => void,
    signal: AbortSignal
  ) => Promise<DonePayload>
): string {
  const entry = newRun()
  const { requestId } = entry
  void (async () => {
    try {
      const payload = await exec(
        requestId,
        (text) => {
          sink.send('llm:delta', requestId, text)
        },
        entry.abort.signal
      )
      entry.status = 'done'
      entry.payload = payload
      sink.send('llm:done', requestId, payload)
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      if (entry.abort.signal.aborted) {
        entry.status = 'aborted'
        const payload: DonePayload = {
          text: '',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: '',
          stopReason: 'aborted',
          durationMs: 0
        }
        entry.payload = payload
        sink.send('llm:done', requestId, payload)
      } else {
        entry.status = 'error'
        entry.error = message
        sink.send('llm:error', requestId, message)
      }
    }
  })()
  return requestId
}
