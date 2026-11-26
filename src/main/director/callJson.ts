import type { ChatParams } from '../../shared/contract.js'
import type { ModelSlot } from '../../shared/providers.js'
import type { ChatMessage, ChatResult } from '../../shared/types.js'
import { resolveAuth } from '../config.js'
import { chatStream, LlmError, pickRatelimitHeaders } from '../llm.js'
import { appendUsage } from '../usage.js'

/**
 * LLM 调用封装（G9 技术性失败重试 + JSON 提取 + 记账）。
 * - 网络/5xx：指数退避重试 2 次；429：读 retry-after（≤60s）重试 1 次
 * - JSON 解析失败：把错误喂回模型重试 1 次（原消息保留，纠错说明追加在后面）
 * - 每次调用 appendUsage（purpose=slot）
 */

export class StepError extends Error {
  readonly category: 'network' | 'server' | 'bad_output' | 'aborted' | 'quota'
  constructor(message: string, category: StepError['category'] = 'server') {
    super(message)
    this.name = 'StepError'
    this.category = category
  }
}

/** 欠费/额度耗尽特征（HTTP 402 + 主流平台文案） */
const QUOTA_RE =
  /HTTP 402|insufficient[_ ]?(?:balance|quota|credits?)|balance is (?:low|insufficient|not enough)|quota.*exceed|exceeded.*quota|arrear|欠费|余额不足|额度不足|账户已欠费/i

export function isQuotaError(err: unknown): boolean {
  if ((err as StepError)?.category === 'quota') return true
  return QUOTA_RE.test(String((err as Error | undefined)?.message ?? err))
}

/** 用户取消/任务被终止（AbortSignal 中止）。这类错误不是故障：不重试、不记 failed */
export function isAbortError(err: unknown): boolean {
  if ((err as StepError)?.category === 'aborted') return true
  if ((err as Error | undefined)?.name === 'AbortError') return true
  return /aborted/i.test(String((err as Error | undefined)?.message ?? err))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    if (signal?.aborted) finish()
    else signal?.addEventListener('abort', finish, { once: true })
  })
}

function shouldRetry(err: unknown): { retry: boolean; waitMs: number } {
  if (isAbortError(err)) return { retry: false, waitMs: 0 }
  const msg = String((err as Error | undefined)?.message ?? err)
  // 状态码优先取结构化字段：错误文案可能已被网关的 JSON 错误体替换，不再含「HTTP 429」
  const status =
    err instanceof LlmError ? err.status : Number(msg.match(/HTTP (\d{3})/)?.[1] ?? Number.NaN)
  if (status === 429) {
    const header = err instanceof LlmError ? err.retryAfterMs : undefined
    if (header !== undefined) return { retry: true, waitMs: Math.min(Math.max(header, 500), 60000) }
    const ra = msg.match(/retry[- ]after[^\d]*(\d+)/i)
    return { retry: true, waitMs: Math.min((ra ? Number(ra[1]) : 5) * 1000, 60000) }
  }
  if (status && status >= 500) return { retry: true, waitMs: 3000 }
  if (
    /网络请求失败|fetch failed|ECONN|ETIMEDOUT|socket|terminated|other side closed|输出中断|没有收到新数据/i.test(
      msg
    )
  )
    return { retry: true, waitMs: 2000 }
  return { retry: false, waitMs: 0 }
}

/** 从模型输出提取 JSON 对象（剥代码围栏/前后杂文，平衡花括号扫描） */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const start = c.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < c.length; i++) {
      const ch = c[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(c.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  throw new StepError('模型输出中未找到合法 JSON', 'bad_output')
}

export interface CallOptions {
  slot: ModelSlot
  system: string
  user: string
  maxTokens?: number
  temperature?: number
  /** 期望的 JSON 形状说明（喂给模型的 schema 提示） */
  jsonHint: string
  signal?: AbortSignal
  /** 思考链流式回调（网关 reasoning 字段/<think> 标签剥出） */
  onThinking?: (text: string) => void
  /** 思考模式（默认 disabled：混合推理模型思考 token 计入 max_tokens 会吃正文预算） */
  thinking?: 'enabled' | 'disabled'
  /** 流式输出中途失败、即将从头重试：调用方应清掉已累计的增量（上一轮是半截废稿） */
  onRestart?: () => void
}

/** 单次流式原始调用（含网络级重试+记账） */
export async function callRaw(
  opts: CallOptions & { params?: Partial<ChatParams> },
  onDelta?: (text: string) => void
): Promise<ChatResult> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal?.aborted) throw new StepError('任务已取消', 'aborted')
    if (attempt > 0) {
      const { waitMs } = shouldRetry(lastErr)
      if (!waitMs) break
      await sleep(waitMs, opts.signal)
      opts.onRestart?.()
    }
    const auth = resolveAuth(opts.slot)
    try {
      const result = await chatStream(
        {
          slot: opts.slot,
          provider: auth.provider,
          model: auth.model,
          system: opts.system,
          messages: [{ role: 'user', content: opts.user }],
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          thinking: opts.thinking,
          responseFormat: 'json_object',
          ...opts.params
        },
        { apiKey: auth.apiKey, baseUrl: auth.baseUrl },
        { onDelta: (t) => onDelta?.(t), onThinking: (t) => opts.onThinking?.(t) },
        opts.signal
      )
      appendUsage({
        ts: Date.now(),
        model: result.model,
        purpose: opts.slot,
        ...result.usage,
        durationMs: result.durationMs,
        ratelimit: pickRatelimitHeaders(result.headers)
      })
      return result
    } catch (err) {
      lastErr = err
      if (isAbortError(err) || opts.signal?.aborted) throw new StepError('任务已取消', 'aborted')
      if (!shouldRetry(err).retry) break
    }
  }
  if (isQuotaError(lastErr)) {
    throw new StepError(`额度不足：${String((lastErr as Error)?.message ?? lastErr)}`, 'quota')
  }
  throw new StepError(`模型调用失败：${String((lastErr as Error)?.message ?? lastErr)}`, 'network')
}

/**
 * 结构化 JSON 调用：解析失败把错误喂回模型重试一次。
 * 重试不丢上下文：原 user 消息原样保留，后面追加「上次的输出 + 纠错说明」。
 * 不能用纠错说明整段替换原消息——模型看不到原材料，只能凭空编。
 */
export async function callJson<T>(opts: CallOptions): Promise<T> {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `${opts.user}\n\n（只输出一个 JSON 对象，不要输出其他内容。形状：${opts.jsonHint}）`
    }
  ]
  let lastErr: unknown = null
  for (let round = 0; round < 2; round++) {
    const res = await callRaw({ ...opts, params: { messages } })
    try {
      return extractJson(res.text) as T
    } catch (err) {
      lastErr = err
      if (res.text.trim()) messages.push({ role: 'assistant', content: res.text })
      messages.push({ role: 'user', content: retryNote(err, res, opts.jsonHint) })
    }
  }
  throw new StepError(
    `模型两次未产出合法 JSON：${String((lastErr as Error)?.message ?? lastErr)}`,
    'bad_output'
  )
}

/** 纠错说明：指出哪里不合规，并带上上次输出开头供模型对照（原材料仍在前面的原消息里） */
function retryNote(err: unknown, res: ChatResult, jsonHint: string): string {
  const why =
    res.stopReason === 'max_tokens'
      ? '你上次的输出在长度上限处被截断，JSON 不完整。请精简内容，保证这次能完整输出整个 JSON 对象'
      : `你上次的输出不是合法 JSON（${(err as Error).message}）。常见原因：JSON 前后夹了别的文字、字符串里的英文双引号没转义（改用中文引号）、括号没配对`
  const head = res.text.trim() ? `\n\n你上次输出的开头（供对照）：${res.text.slice(0, 200)}` : ''
  return `${why}。\n任务不变，按上面原有的材料重新输出：只输出一个完整的 JSON 对象，不要代码围栏，不要解释。形状：${jsonHint}${head}`
}
