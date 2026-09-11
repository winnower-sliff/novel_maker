export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatParams {
  model: string
  system?: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  purpose?: string
}

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface ChatResult {
  text: string
  usage: UsageInfo
  model: string
  stopReason: string | null
  durationMs: number
  headers: Record<string, string>
}

export interface UsageRecord {
  ts: number
  model: string
  purpose: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  durationMs: number
  ratelimit?: Record<string, string>
}

export interface SettingsView {
  hasApiKey: boolean
  apiKeyMasked: string
  baseUrl: string
  defaultModel: string
  customModels: string
}

export interface SettingsPatch {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  customModels?: string
}

export interface ModelProbeResult {
  source: 'endpoint' | 'builtin'
  models: string[]
}
