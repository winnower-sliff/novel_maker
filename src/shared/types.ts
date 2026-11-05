import type { ModelSlot, ProviderId } from './providers.js'

/**
 * v2 共享类型（M1 最小集）：LLM 消息/工具、模型配置、服务器状态、用量记账。
 * 输入类型与枚举在 contract.ts（zod 单一事实源），这里只放纯数据形状。
 */

// ── LLM 消息（协议中立内部形态；OpenAI 转换在 main/llmOpenai.ts） ──────────

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
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
  toolUses: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    /** 参数 JSON 解析失败标记（input 已清空，调用方不得执行）：truncated=输出被长度上限截断，invalid=JSON 不完整或非法 */
    inputError?: 'truncated' | 'invalid'
  }>
}

// ── 模型配置 ─────────────────────────────────────────────────────────────────

/** 槽位路由：undefined 回退 director 槽 */
export type ModelRouting = Partial<Record<ModelSlot, { provider: ProviderId; model: string }>>

export interface ProviderProfile {
  baseUrl: string
  defaultModel: string
  /** 逗号/换行分隔的自定义模型清单（手机端输入方便） */
  customModels: string
}

export interface SettingsView {
  provider: ProviderId
  profiles: Record<ProviderId, ProviderProfile>
  configuredProviders: ProviderId[]
  /** 当前 provider 的 API Key 掩码（形如 sk-***abcd），未配置为 null */
  apiKeyMasked: string | null
  routing: ModelRouting
}

// ── 服务器状态 ───────────────────────────────────────────────────────────────

export interface ServerStatus {
  running: boolean
  port: number
  /** 局域网/Tailscale 可达地址（含端口），无则 null */
  url: string | null
  lanReachable: boolean
  hasPassword: boolean
  clients: number
  /** 服务器版本（package.json version） */
  version: string
  /** 进程运行秒数 */
  uptimeS: number
  error: string | null
}

// ── 模型探测 / 用量 ─────────────────────────────────────────────────────────

export interface ModelProbeResult {
  source: 'endpoint' | 'builtin'
  models: string[]
}

export interface UsageRecord {
  ts: number
  model: string
  /** 记账分类：槽位名（director/writer/reviewer/utility）或 'chat' */
  purpose: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  durationMs: number
  ratelimit?: Record<string, string>
}

export interface WindowStats {
  windowStart: number
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface GroupStats extends Omit<WindowStats, 'windowStart'> {
  key: string
}

export interface UsageStats {
  window5h: WindowStats
  totals: Omit<WindowStats, 'windowStart'>
  byDay: GroupStats[]
  byModel: GroupStats[]
  byPurpose: GroupStats[]
}

// ── 错误提示 ─────────────────────────────────────────────────────────────────

export type LlmErrorCategory =
  | 'network'
  | 'auth'
  | 'quota'
  | 'rate_limited'
  | 'model_not_found'
  | 'context_too_long'
  | 'server_error'
  | 'content_filter'
  | 'aborted'
  | 'unknown'

export interface LlmErrorHint {
  category: LlmErrorCategory
  /** 面向用户的可操作提示文案 */
  friendly: string
  /** 服务商原始报错（排查用，UI 折叠展示） */
  raw: string
}
