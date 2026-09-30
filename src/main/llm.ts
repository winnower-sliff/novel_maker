import { type ProviderId, providerPreset } from '../shared/providers'
import type { ChatParams, ChatResult, ModelProbeResult, UsageInfo } from '../shared/types'

const ANTHROPIC_VERSION = '2023-06-01'

export class LlmError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json'
  }
}

function emptyUsage(): UsageInfo {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

export async function chatStream(
  params: ChatParams,
  auth: { apiKey: string; baseUrl: string },
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<ChatResult> {
  const started = Date.now()
  const url = `${normalizeBase(auth.baseUrl)}/v1/messages`
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    messages: params.messages,
    stream: true,
    thinking: { type: 'disabled' }
  }
  if (params.tools?.length) {
    body.tools = params.tools
  }
  if (params.system) {
    body.system = params.cacheSystem
      ? [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }]
      : params.system
  }
  if (params.temperature !== undefined) body.temperature = params.temperature

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(auth.apiKey),
      body: JSON.stringify(body),
      signal
    })
  } catch (err) {
    throw new LlmError(`网络请求失败: ${(err as Error).message}`)
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = JSON.parse(await res.text()) as { error?: { type?: string; message?: string } }
      if (j.error?.message) msg = `${j.error.type ? `${j.error.type}: ` : ''}${j.error.message}`
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

  const reader = res.body?.getReader()
  if (!reader) throw new LlmError('响应无内容流')

  const decoder = new TextDecoder()
  let buf = ''

  const handleEvent = (payload: string): void => {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    if (ev.type === 'message_start') {
      const message = ev.message as { model?: string; usage?: Record<string, number> } | undefined
      if (message?.model) model = message.model
      const u = message?.usage
      if (u) {
        usage.inputTokens = u.input_tokens ?? 0
        usage.cacheReadTokens = u.cache_read_input_tokens ?? 0
        usage.cacheCreationTokens = u.cache_creation_input_tokens ?? 0
      }
    } else if (ev.type === 'content_block_start') {
      const block = ev.content_block as { type?: string; id?: string; name?: string } | undefined
      if (block?.type === 'tool_use' && block.id) {
        toolAcc.set(ev.index as number, { id: block.id, name: block.name ?? '', json: '' })
      }
    } else if (ev.type === 'content_block_delta') {
      const delta = ev.delta as { type?: string; text?: string; partial_json?: string } | undefined
      if (delta?.type === 'text_delta' && delta.text) {
        text += delta.text
        onDelta(delta.text)
      } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
        const acc = toolAcc.get(ev.index as number)
        if (acc) acc.json += delta.partial_json
      }
    } else if (ev.type === 'content_block_stop') {
      const acc = toolAcc.get(ev.index as number)
      if (acc) {
        let input: Record<string, unknown> = {}
        if (acc.json.trim()) {
          try {
            input = JSON.parse(acc.json) as Record<string, unknown>
          } catch {
            input = { _raw: acc.json }
          }
        }
        toolUses.push({ id: acc.id, name: acc.name, input })
        toolAcc.delete(ev.index as number)
      }
    } else if (ev.type === 'message_delta') {
      const u = ev.usage as Record<string, number> | undefined
      if (u?.output_tokens !== undefined && u.output_tokens !== null) {
        usage.outputTokens = u.output_tokens
      }
      const delta = ev.delta as { stop_reason?: string | null } | undefined
      if (delta?.stop_reason) stopReason = delta.stop_reason
    } else if (ev.type === 'error') {
      const error = ev.error as { message?: string } | undefined
      throw new LlmError(error?.message ?? '流式返回错误')
    }
  }

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
      handleEvent(payload)
    }
  }

  return { text, usage, model, stopReason, durationMs: Date.now() - started, headers, toolUses }
}

async function listModelIds(
  url: string,
  headers: Record<string, string>
): Promise<string[] | null> {
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return null
    const j = (await res.json()) as { data?: Array<{ id?: string }> }
    const ids = (j.data ?? []).map((m) => m.id).filter((id): id is string => !!id)
    return ids.length > 0 ? ids : null
  } catch {
    return null
  }
}

async function listOllamaTags(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`)
    if (!res.ok) return null
    const j = (await res.json()) as { models?: Array<{ model?: string; name?: string }> }
    const ids = (j.models ?? []).map((m) => m.model ?? m.name).filter((id): id is string => !!id)
    return ids.length > 0 ? ids : null
  } catch {
    return null
  }
}

export async function probeModels(auth: {
  provider: ProviderId
  apiKey: string
  baseUrl: string
}): Promise<ModelProbeResult> {
  const base = normalizeBase(auth.baseUrl)
  const builtin = (): ModelProbeResult => ({
    source: 'builtin',
    models: [...providerPreset(auth.provider).builtinModels]
  })

  if (auth.provider === 'ollama') {
    const viaOpenai = await listModelIds(`${base}/v1/models`, {})
    if (viaOpenai) return { source: 'endpoint', models: viaOpenai }
    const viaTags = await listOllamaTags(base)
    if (viaTags) return { source: 'endpoint', models: viaTags }
    return builtin()
  }

  if (auth.provider === 'deepseek') {
    const root = base.replace(/\/anthropic$/i, '')
    const ids = await listModelIds(`${root}/models`, {
      authorization: `Bearer ${auth.apiKey}`
    })
    if (ids) return { source: 'endpoint', models: ids }
    return builtin()
  }

  const ids = await listModelIds(`${base}/v1/models`, authHeaders(auth.apiKey))
  if (ids) return { source: 'endpoint', models: ids }
  return builtin()
}

export function pickRatelimitHeaders(headers: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (/ratelimit|rate-limit|remaining|retry|reset|limit-output/i.test(k)) {
      picked[k] = v
    }
  }
  return picked
}
