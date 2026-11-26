import type { ChatParams } from '../shared/contract.js'
import type { ChatMessage, ChatResult, ToolDef, UsageInfo } from '../shared/types.js'
import { LlmError, normalizeBase } from './llm.js'

/** OpenAI 兼容消息（tool 角色 + tool_calls 展开；assistant 的思考链以 reasoning_content 回传） */
type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAiToolCall[]
      reasoning_content?: string
    }
  | { role: 'tool'; tool_call_id: string; content: string }

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export function openaiHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return headers
}

/** baseUrl 已带版本段（/v1 等）则直接拼路径，否则补 /v1（兼容 LM Studio 惯例与根域写法） */
function openaiPath(baseUrl: string, suffix: string): string {
  const base = normalizeBase(baseUrl)
  return /\/v\d+$/.test(base) ? `${base}${suffix}` : `${base}/v1${suffix}`
}

export function openaiChatUrl(baseUrl: string): string {
  return openaiPath(baseUrl, '/chat/completions')
}

export function openaiModelsUrl(baseUrl: string): string {
  return openaiPath(baseUrl, '/models')
}

function toOpenaiTools(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }))
}

function toolResultContent(content: string | undefined): string {
  return content ?? ''
}

/** Anthropic 消息（string 或 blocks）→ OpenAI 消息；tool_result 展开为 role:tool，且紧跟 assistant tool_calls */
function toOpenaiMessages(system: string | undefined, messages: ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  // 思考模式带工具的续轮，assistant 的 reasoning_content 必须原样回传（DeepSeek 文档要求，缺了 400）；
  // 没带思考链的消息（思考关闭、或历史里没存）就不带这个字段
  const reasoning = (m: ChatMessage): { reasoning_content?: string } =>
    m.reasoning ? { reasoning_content: m.reasoning } : {}
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(
        m.role === 'assistant'
          ? { role: 'assistant', content: m.content, ...reasoning(m) }
          : { role: m.role, content: m.content }
      )
      continue
    }
    if (m.role === 'assistant') {
      let text = ''
      const toolCalls: OpenAiToolCall[] = []
      for (const b of m.content) {
        if (b.type === 'text') {
          text += b.text
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
          })
        }
      }
      out.push(
        toolCalls.length
          ? { role: 'assistant', content: text || null, tool_calls: toolCalls, ...reasoning(m) }
          : { role: 'assistant', content: text, ...reasoning(m) }
      )
    } else {
      let text = ''
      const toolResults: Array<{ id: string; content: string }> = []
      for (const b of m.content) {
        if (b.type === 'text') {
          text += b.text
        } else if (b.type === 'tool_result') {
          toolResults.push({ id: b.tool_use_id, content: toolResultContent(b.content) })
        }
      }
      for (const tr of toolResults)
        out.push({ role: 'tool', tool_call_id: tr.id, content: tr.content })
      if (text || toolResults.length === 0) out.push({ role: 'user', content: text })
    }
  }
  return out
}

/**
 * `<think>…</think>` 流式剥离：qwen3 等本地模型经 OpenAI 端点会把思考内容混在 content 里。
 * 跨 chunk 的半截标签用 pending 缓冲判定，避免把正文误当标签前缀截断。
 */
class ThinkStripper {
  private inThink = false
  private pending = ''

  /** 喂入增量，返回可安全转发给用户的文本（剥除思考段）；思考段经 onThink 吐出（流式思考 UI 用） */
  feed(chunk: string, onThink?: (s: string) => void): string {
    this.pending += chunk
    let safe = ''
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>'
      const idx = this.pending.indexOf(tag)
      if (idx >= 0) {
        if (this.inThink) onThink?.(this.pending.slice(0, idx))
        else safe += this.pending.slice(0, idx)
        this.pending = this.pending.slice(idx + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // 尾部可能是不完整标签前缀：暂缓输出，等下一个 chunk 判定
      const hold = tagPrefixLen(this.pending, tag)
      if (!this.inThink) safe += this.pending.slice(0, this.pending.length - hold)
      else if (onThink) {
        const think = this.pending.slice(0, this.pending.length - hold)
        if (think) onThink(think)
      }
      this.pending = this.pending.slice(this.pending.length - hold)
      break
    }
    return safe
  }

  /** 流结束：非思考态的残留（如未闭合的半截标签）按原文放出，思考态残留丢弃 */
  flush(): string {
    const rest = this.pending
    this.pending = ''
    return this.inThink ? '' : rest
  }
}

/** s 的尾部与 tag 前缀重合的最大长度（如 s='ab</t' vs '</think>' → 3） */
function tagPrefixLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1)
  for (let len = max; len > 0; len--) {
    if (s.endsWith(tag.slice(0, len))) return len
  }
  return 0
}

function emptyUsage(): UsageInfo {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

/** 流式响应中连续这么久没有收到新数据就视为卡死。思考型模型首字可能很慢，所以给到 2 分钟 */
const STREAM_IDLE_TIMEOUT_MS = 120_000

/**
 * 读一个流分片：读途中连接被掐断 → 包成 LlmError（走网络重试）；取消引起的中止原样上抛。
 * 长时间没有新数据（网关挂起但不断开）同样转成可重试错误，不必干等任务看门狗。
 */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // 取消 reader 以释放底层连接，否则这条挂起的连接会一直占着
        void reader.cancel().catch(() => {})
        reject(new LlmError(`模型响应超时（${STREAM_IDLE_TIMEOUT_MS / 1000} 秒没有收到新数据）`))
      }, STREAM_IDLE_TIMEOUT_MS)
    })
    return await Promise.race([reader.read(), idle])
  } catch (err) {
    if (signal?.aborted || (err as Error).name === 'AbortError') throw err
    if (err instanceof LlmError) throw err
    throw new LlmError(`网络请求失败: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

async function fetchSse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  } catch (err) {
    // 取消引起的中止原样上抛，别包成网络错误（调用方靠它识别「用户取消」）
    if ((err as Error).name === 'AbortError') throw err
    throw new LlmError(`网络请求失败: ${(err as Error).message}`)
  }
  // 老版本网关不认 stream_options 字段直接 400：去掉该字段重试一次
  if (res.status === 400 && body.stream_options !== undefined) {
    try {
      const retry = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, stream_options: undefined }),
        signal
      })
      if (retry.ok || retry.status !== 400) return retry
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      /* 重试失败则用原响应报错 */
    }
  }
  return res
}

/** retry-after 响应头：秒数或 HTTP 日期 → 毫秒（没有/无法识别则 undefined） */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const secs = Number(value)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

function parseErrorBody(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as {
      error?: string | { message?: string; type?: string; code?: string | number }
    }
    if (typeof j.error === 'string') return j.error
    if (j.error?.message)
      return j.error.type || j.error.code
        ? `${j.error.type ?? j.error.code}: ${j.error.message}`
        : j.error.message
  } catch {
    /* non-json */
  }
  return null
}

export async function chatStreamOpenai(
  params: ChatParams,
  auth: { apiKey: string; baseUrl: string },
  cbs: { onDelta: (text: string) => void; onThinking?: (text: string) => void },
  signal?: AbortSignal
): Promise<ChatResult> {
  const started = Date.now()
  const url = openaiChatUrl(auth.baseUrl)
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    messages: toOpenaiMessages(params.system, params.messages),
    stream: true,
    // 流式拿 usage 的通行做法；不支持的网关由 fetchSse 兜底重试
    stream_options: { include_usage: true }
  }
  if (params.tools?.length) {
    body.tools = toOpenaiTools(params.tools)
    body.tool_choice = 'auto'
  }
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.responseFormat) body.response_format = { type: params.responseFormat }
  // 默认显式关思考：混合推理模型（DeepSeek V4/GLM）思考默认开且计入 max_tokens，
  // 会吃掉大半输出预算导致正文只剩几百字（坑 14 同款教训）；仅 chat 白话链路显式开
  body.thinking = { type: params.thinking === 'enabled' ? 'enabled' : 'disabled' }

  const res = await fetchSse(url, openaiHeaders(auth.apiKey), body, signal)

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      msg = parseErrorBody(await res.text()) ?? msg
    } catch {
      /* ignore non-json error body */
    }
    throw new LlmError(msg, res.status, retryAfterMs(res.headers.get('retry-after')))
  }

  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })

  const usage = emptyUsage()
  let text = ''
  let thinking = ''
  let model = params.model ?? ''
  let stopReason: string | null = null
  const toolUses: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    inputError?: 'truncated' | 'invalid'
  }> = []
  const toolAcc = new Map<number, { id: string; name: string; json: string }>()
  const stripper = new ThinkStripper()

  const handleChunk = (payload: string): void => {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof ev.model === 'string' && ev.model) model = ev.model
    const u = ev.usage as Record<string, number> | undefined
    if (u) {
      usage.inputTokens = u.prompt_tokens ?? 0
      usage.outputTokens = u.completion_tokens ?? 0
      // 命中前缀缓存的输入 token：DeepSeek 顶层字段 / OpenAI prompt_tokens_details
      const details = u.prompt_tokens_details as Record<string, number> | undefined
      usage.cacheReadTokens = u.prompt_cache_hit_tokens ?? details?.cached_tokens ?? 0
    }
    const choices = ev.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    if (!choice) return
    const delta = choice.delta as
      | {
          content?: string | null
          /** 兼容网关思考流：GLM/DeepSeek 系把推理放独立字段，正文在 content */
          reasoning_content?: string | null
          reasoning?: string | null
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      | undefined
    const rc = delta?.reasoning_content ?? delta?.reasoning
    if (typeof rc === 'string' && rc) {
      thinking += rc
      cbs.onThinking?.(rc)
    }
    if (typeof delta?.content === 'string' && delta.content) {
      const safe = stripper.feed(delta.content, (s) => {
        thinking += s
        cbs.onThinking?.(s)
      })
      if (safe) {
        text += safe
        cbs.onDelta(safe)
      }
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        let acc = toolAcc.get(idx)
        if (!acc) {
          acc = { id: tc.id ?? `call_${idx}_${Date.now().toString(36)}`, name: '', json: '' }
          toolAcc.set(idx, acc)
        }
        if (tc.id) acc.id = tc.id
        if (tc.function?.name) acc.name = tc.function.name
        if (typeof tc.function?.arguments === 'string') acc.json += tc.function.arguments
      }
    }
    const finish = choice.finish_reason as string | null | undefined
    if (finish) {
      stopReason =
        finish === 'tool_calls'
          ? 'tool_use'
          : finish === 'length'
            ? 'max_tokens'
            : finish === 'stop'
              ? 'end_turn'
              : finish
    }
  }

  const reader = res.body?.getReader()
  if (!reader) throw new LlmError('响应无内容流')

  const decoder = new TextDecoder()
  let buf = ''
  let sawDone = false

  for (;;) {
    const { done, value } = await readChunk(reader, signal)
    if (done) break
    buf += decoder.decode(value, { stream: true })
    for (;;) {
      const idx = buf.indexOf('\n')
      if (idx < 0) break
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') {
        sawDone = true
        continue
      }
      handleChunk(payload)
    }
  }

  // 既没收到 finish_reason 也没收到 [DONE]：连接被中途掐断（网关超时/代理断流），
  // 半截内容不能当完整结果交给下游（会被当成写完的正文入库）
  if (!stopReason && !sawDone) {
    throw new LlmError(`模型输出中断（已收到 ${text.length} 字，未收到结束标记）`)
  }
  if (!stopReason) stopReason = 'end_turn'

  const tail = stripper.flush()
  if (tail) {
    text += tail
    cbs.onDelta(tail)
  }
  for (const acc of toolAcc.values()) {
    let input: Record<string, unknown> = {}
    let parseFailed = false
    if (acc.json.trim()) {
      try {
        input = JSON.parse(acc.json) as Record<string, unknown>
      } catch {
        parseFailed = true
      }
    }
    if (parseFailed)
      console.warn(
        `[llm] tool ${acc.name} 参数 JSON 解析失败（${acc.json.length} 字符），已丢弃片段防污染历史`
      )
    toolUses.push({
      id: acc.id,
      name: acc.name,
      input,
      ...(parseFailed
        ? {
            inputError: stopReason === 'max_tokens' ? ('truncated' as const) : ('invalid' as const)
          }
        : {})
    })
  }

  return {
    text,
    thinking,
    usage,
    model,
    stopReason,
    durationMs: Date.now() - started,
    headers,
    toolUses
  }
}
