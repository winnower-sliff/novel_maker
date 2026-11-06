import type { ChatParams } from '../../shared/contract.js'
import type { ModelSlot } from '../../shared/providers.js'
import type { ChatResult } from '../../shared/types.js'
import { resolveAuth } from '../config.js'
import { chatStream } from '../llm.js'
import { appendUsage } from '../usage.js'

/**
 * LLM 调用封装（G9 技术性失败重试 + JSON 提取 + 记账）。
 * - 网络/5xx：指数退避重试 2 次；429：读 retry-after（≤60s）重试 1 次
 * - JSON 解析失败：把错误喂回模型重试 1 次
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function shouldRetry(err: unknown): { retry: boolean; waitMs: number } {
  const msg = String((err as Error | undefined)?.message ?? err)
  if (/aborted/i.test(msg)) return { retry: false, waitMs: 0 }
  const m = msg.match(/HTTP (\d{3})/)
  const status = m ? Number(m[1]) : null
  if (status === 429) {
    const ra = msg.match(/retry[- ]after[^\d]*(\d+)/i)
    return { retry: true, waitMs: Math.min((ra ? Number(ra[1]) : 5) * 1000, 60000) }
  }
  if (status && status >= 500) return { retry: true, waitMs: 3000 }
  if (/网络请求失败|fetch failed|ECONN|ETIMEDOUT|socket/i.test(msg))
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
}

/** 单次流式原始调用（含网络级重试+记账） */
export async function callRaw(
  opts: CallOptions & { params?: Partial<ChatParams> },
  onDelta?: (text: string) => void
): Promise<ChatResult> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const { waitMs } = shouldRetry(lastErr)
      if (!waitMs) break
      await sleep(waitMs)
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
        durationMs: result.durationMs
      })
      return result
    } catch (err) {
      lastErr = err
      if (!shouldRetry(err).retry) break
    }
  }
  if (isQuotaError(lastErr)) {
    throw new StepError(`额度不足：${String((lastErr as Error)?.message ?? lastErr)}`, 'quota')
  }
  throw new StepError(`模型调用失败：${String((lastErr as Error)?.message ?? lastErr)}`, 'network')
}

/** 结构化 JSON 调用：解析失败把错误喂回模型重试一次 */
export async function callJson<T>(opts: CallOptions): Promise<T> {
  let user = `${opts.user}\n\n（只输出一个 JSON 对象，不要输出其他内容。形状：${opts.jsonHint}）`
  let lastErr: unknown = null
  for (let round = 0; round < 2; round++) {
    const res = await callRaw({ ...opts, user })
    try {
      return extractJson(res.text) as T
    } catch (err) {
      lastErr = err
      user = `你上次的输出不是合法 JSON（${(err as Error).message}）。重新输出，只输出一个 JSON 对象。形状：${opts.jsonHint}\n\n上次输出开头：${res.text.slice(0, 200)}`
    }
  }
  throw new StepError(
    `模型两次未产出合法 JSON：${String((lastErr as Error)?.message ?? lastErr)}`,
    'bad_output'
  )
}
