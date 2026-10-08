import type { ChatMessage, ChatParams, ChatResult, ToolDef, UsageInfo } from '../shared/types'
import { LlmError, normalizeBase } from './llm'

/** OpenAI 兼容消息（tool 角色 + tool_calls 展开） */
type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
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
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
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
          ? { role: 'assistant', content: text || null, tool_calls: toolCalls }
          : { role: 'assistant', content: text }
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

  /** 喂入增量，返回可安全转发给用户的文本（剥除思考段） */
  feed(chunk: string): string {
    this.pending += chunk
    let safe = ''
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>'
      const idx = this.pending.indexOf(tag)
      if (idx >= 0) {
        if (!this.inThink) safe += this.pending.slice(0, idx)
        this.pending = this.pending.slice(idx + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // 尾部可能是不完整标签前缀：暂缓输出，等下一个 chunk 判定
      const hold = tagPrefixLen(this.pending, tag)
      if (!this.inThink) safe += this.pending.slice(0, this.pending.length - hold)
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
    } catch {
      /* 重试失败则用原响应报错 */
    }
  }
  return res
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
  onDelta: (text: string) => void,
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

  const res = await fetchSse(url, openaiHeaders(auth.apiKey), body, signal)

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      msg = parseErrorBody(await res.text()) ?? msg
    } catch {
      /* ignore non-json error body */
    }
    throw new LlmError(msg, res.status)
  }

  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })

  const usage = emptyUsage()
  let text = ''
  let model = params.model
  let stopReason: string | null = null
  const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
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
    }
    const choices = ev.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    if (!choice) return
    const delta = choice.delta as
      | {
          content?: string | null
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      | undefined
    if (typeof delta?.content === 'string' && delta.content) {
      const safe = stripper.feed(delta.content)
      if (safe) {
        text += safe
        onDelta(safe)
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

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    for (;;) {
      const idx = buf.indexOf('\n')
      if (idx < 0) break
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      handleChunk(payload)
    }
  }

  const tail = stripper.flush()
  if (tail) {
    text += tail
    onDelta(tail)
  }
  for (const acc of toolAcc.values()) {
    let input: Record<string, unknown> = {}
    if (acc.json.trim()) {
      try {
        input = JSON.parse(acc.json) as Record<string, unknown>
      } catch {
        input = { _raw: acc.json }
      }
    }
    toolUses.push({ id: acc.id, name: acc.name, input })
  }

  return { text, usage, model, stopReason, durationMs: Date.now() - started, headers, toolUses }
}
