import type { ChatParams } from '../shared/contract.js'
import { isProviderId, type ProviderId, providerPreset } from '../shared/providers.js'
import type { ChatResult, ModelProbeResult } from '../shared/types.js'
import { chatStreamOpenai, openaiHeaders, openaiModelsUrl } from './llmOpenai.js'

export class LlmError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

export function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** 唯一 LLM 入口：统一 OpenAI 兼容流式 */
export async function chatStream(
  params: ChatParams,
  auth: { apiKey: string; baseUrl: string },
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<ChatResult> {
  return chatStreamOpenai(params, auth, onDelta, signal)
}

async function listModelIds(
  url: string,
  headers: Record<string, string>
): Promise<string[] | null> {
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    if (!Array.isArray(body.data)) return null
    const ids = body.data.map((m) => m.id).filter((id): id is string => typeof id === 'string')
    return ids.length ? ids : null
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
  if (!base) return builtin()
  const ids = await listModelIds(openaiModelsUrl(base), openaiHeaders(auth.apiKey))
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

/** provider 名转显示名（错误提示用） */
export function providerLabel(provider: string): string {
  return isProviderId(provider) ? providerPreset(provider).label : provider
}
