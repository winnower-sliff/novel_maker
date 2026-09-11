export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export const PURPOSES = ['playground', 'outline', 'chapter', 'summary', 'polish', 'check'] as const
export type Purpose = (typeof PURPOSES)[number]

export interface ChatParams {
  model: string
  system?: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  purpose?: Purpose
  cacheSystem?: boolean
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

export type ModelRouting = Partial<Record<Purpose, string>>

export interface SettingsView {
  hasApiKey: boolean
  apiKeyMasked: string
  baseUrl: string
  defaultModel: string
  customModels: string
  modelRouting: ModelRouting
  quota5hPrompts: number
  promptCache: boolean
}

export interface SettingsPatch {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  customModels?: string
  modelRouting?: ModelRouting
  quota5hPrompts?: number
  promptCache?: boolean
}

export interface ModelProbeResult {
  source: 'endpoint' | 'builtin'
  models: string[]
}

export interface WindowStats {
  windowStart: number
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface GroupStats {
  key: string
  requests: number
  inputTokens: number
  outputTokens: number
}

export interface UsageStats {
  window5h: WindowStats
  totals: Omit<WindowStats, 'windowStart'>
  byDay: GroupStats[]
  byModel: GroupStats[]
  byPurpose: GroupStats[]
}
