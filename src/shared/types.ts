import type { ProviderId } from './providers'

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

export const PURPOSES = [
  'playground',
  'outline',
  'chapter',
  'summary',
  'polish',
  'check',
  'review',
  'expand',
  'agent'
] as const
export type Purpose = (typeof PURPOSES)[number]

export interface PurposeRoute {
  provider?: ProviderId
  model: string
}

export type ModelRouting = Partial<Record<Purpose, string | PurposeRoute>>

export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ChatParams {
  model: string
  system?: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  purpose?: Purpose
  cacheSystem?: boolean
  tools?: ToolDef[]
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
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
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

export interface ProviderProfile {
  baseUrl: string
  defaultModel: string
  customModels: string
  modelRouting: ModelRouting
  promptCache: boolean
}

export interface SettingsView {
  provider: ProviderId
  profiles: Record<ProviderId, ProviderProfile>
  configuredProviders: ProviderId[]
  hasApiKey: boolean
  apiKeyMasked: string
  baseUrl: string
  defaultModel: string
  customModels: string
  modelRouting: ModelRouting
  quota5hPrompts: number
  promptCache: boolean
  currentProjectId: string
}

export interface SettingsPatch {
  provider?: ProviderId
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  customModels?: string
  modelRouting?: ModelRouting
  quota5hPrompts?: number
  promptCache?: boolean
  currentProjectId?: string
}

export interface ServerConfig {
  enabled: boolean
  port: number
  passwordHash: string
  passwordSalt: string
}

export interface ServerStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string | null
  lanReachable: boolean
  hasPassword: boolean
  clients: number
  error: string | null
}

export interface ServerConfigPatch {
  enabled?: boolean
  port?: number
  password?: string | null
}

export interface ModelProbeOptions {
  provider?: ProviderId
  apiKey?: string
  baseUrl?: string
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

export interface Project {
  id: string
  title: string
  genre: string
  styleGuide: string
  targetWords: number
  status: string
  createdAt: number
  updatedAt: number
}

export interface ProjectInput {
  title: string
  genre?: string
  styleGuide?: string
  targetWords?: number
}

export interface Character {
  id: string
  projectId: string
  name: string
  role: string
  tags: string
  card: string
  state: string
  createdAt: number
  updatedAt: number
}

export interface CharacterInput {
  projectId: string
  name: string
  role?: string
  tags?: string
  card?: string
  state?: string
}

export interface WorldbuildEntry {
  id: string
  projectId: string
  category: string
  title: string
  tags: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface WorldbuildInput {
  projectId: string
  category: string
  title: string
  tags?: string
  content?: string
}

export type OutlineStatus = 'draft' | 'approved' | 'written' | 'polished'

export interface OutlineItem {
  id: string
  projectId: string
  volume: number
  chapterNo: number
  title: string
  synopsis: string
  role: string
  suspense: string
  twist: number
  hook: string
  foreshadowOps: string
  status: OutlineStatus
  createdAt: number
  updatedAt: number
}

export interface OutlineInput {
  projectId: string
  volume: number
  chapterNo: number
  title?: string
  synopsis?: string
  role?: string
  suspense?: string
  twist?: number
  hook?: string
  foreshadowOps?: string
  status?: OutlineStatus
}

export interface SkillMeta {
  name: string
  description: string
  filename: string
}

export interface SkillFile extends SkillMeta {
  raw: string
}

export interface Chapter {
  id: string
  outlineId: string
  projectId: string
  version: number
  content: string
  wordCount: number
  status: string
  createdAt: number
  updatedAt: number
}

export interface ChapterBrief extends OutlineItem {
  hasDraft: boolean
  wordCount: number
  chapterStatus: string
}

export interface ChapterSummary {
  id: string
  chapterId: string
  summary: string
  events: string[]
  timeline: string
  characterStates: Array<{ name: string; state: string }>
  foreshadowsPlanted: Array<{ content: string; quote?: string }>
  foreshadowsResolved: string[]
  createdAt: number
}

export interface VolumeSummary {
  projectId: string
  volume: number
  summary: string
  updatedAt: number
}

export interface Foreshadow {
  id: string
  projectId: string
  content: string
  plantedChapter: string
  status: string
  resolvedChapter: string
  plannedResolve: string
  priority: string
  createdAt: number
  updatedAt: number
}

export interface ForeshadowInput {
  projectId: string
  content: string
  plantedChapter?: string
  status?: string
  resolvedChapter?: string
  plannedResolve?: string
  priority?: string
}

export interface ContextPart {
  name: string
  detail: string
  tokens: number
}

export interface BuiltContext {
  system: string
  user: string
  parts: ContextPart[]
  totalTokens: number
}

export type PipelineAction =
  | 'outline'
  | 'chapter'
  | 'summary'
  | 'polish'
  | 'check'
  | 'review'
  | 'expand'
  | 'volumeSummary'
  | 'stateSync'
  | 'character'
  | 'worldbuild'

export interface WorldbuildGenParams {
  projectId: string
  categories: string[]
  title: string
  brief: string
  count?: number
  tags?: string[]
  allowUpdate?: boolean
}

export interface WorldbuildPreviewEntry {
  category: string
  title: string
  tags: string[]
  content: string
  isNewType: boolean
}

export type ExportFormat = 'txt' | 'md' | 'docx'

export interface CharacterGenParams {
  projectId: string
  brief: string
  name?: string
  allowUpdate?: boolean
}

export interface OutlineGenParams {
  projectId: string
  idea: string
  volume: number
  startNo: number
  count: number
  allowUpdate?: boolean
}

export interface ReviewScore {
  dim: string
  score: number
  quote: string
  comment: string
}

export interface ReviewResult {
  verdict: 'rewrite' | 'polish' | 'pass'
  scores: ReviewScore[]
  summary: string
  parsed: boolean
}

export type GraphNodeKind = 'character' | 'worldbuild' | 'outline' | 'foreshadow'

export interface ProjectGraphNode {
  id: string
  rawId: string
  kind: GraphNodeKind
  label: string
  degree: number
  tags?: string[]
}

export interface ProjectGraphEdge {
  source: string
  target: string
  rel?: string
}

export interface ProjectGraph {
  nodes: ProjectGraphNode[]
  edges: ProjectGraphEdge[]
  danglingLinks: string[]
}

export interface SearchHit {
  kind: 'worldbuild' | 'character' | 'chapter'
  id: string
  title: string
  snippet: string
  score: number
}

export interface EmbeddingStatus {
  available: boolean
  enabled: boolean
  reason: string
  model: string
  count: number
  downloading: boolean
  progress: number
}

export type AgentToolState = 'running' | 'confirming' | 'ok' | 'error' | 'denied'

export interface AgentToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  state: AgentToolState
  result?: string
  dangerReason?: string
}

export type AgentTurn =
  | { role: 'user'; text: string; ts: number }
  | { role: 'assistant'; text: string; toolCalls: AgentToolCall[]; ts: number }

export interface AgentSession {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  turns: AgentTurn[]
}

export interface AgentSessionBrief {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface AgentDonePayload {
  text: string
  turns: number
  requests: number
  changed: boolean
  denied: boolean
  hitLimit: boolean
  usage: UsageInfo
  model: string
  durationMs: number
}

export interface AgentToolDefView {
  name: string
  label: string
  danger: boolean
  read: boolean
}
