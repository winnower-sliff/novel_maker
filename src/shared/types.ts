import type { OutlineStatus, Purpose } from './contract'
import type { ProviderId } from './providers'

// 输入类型与枚举已收敛到 contract.ts（zod 单一事实源），这里统一再导出兼容旧路径
export type {
  CharacterGenParams,
  CharacterInput,
  ChatParams,
  ForeshadowInput,
  ModelProbeOptions,
  OutlineGenParams,
  OutlineInput,
  OutlineStatus,
  PipelineAction,
  PremiseDraftParams,
  ProjectInput,
  Purpose,
  ServerConfigPatch,
  SettingsPatch,
  WorldbuildGenParams,
  WorldbuildInput
} from './contract'
export { OUTLINE_STATUSES, PIPELINE_ACTIONS, PURPOSES } from './contract'

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

/** 运行元数据：runtime:snapshot 恢复进度/补发通知用 */
export interface RunMeta {
  projectId?: string
  outlineId?: string
  action?: string
  /** canonSync 等按卷跑的任务带卷号（迁移通知/预览挂起需要） */
  volume?: number
}

/** 运行注册表条目（llm:poll/runtime:snapshot 补拉用）：断连期间 done/error 事件丢失时的结果快照 */
export interface RunRecordPayload {
  status: 'running' | 'done' | 'error'
  kind: 'llm' | 'agent'
  finishedAt?: number
  donePayload?: unknown
  error?: string
  meta?: RunMeta
  /** running 期间的流式文本尾部（后台/重挂页面经 snapshot 恢复进度显示用，done 后不再更新） */
  textTail?: string
}

/** 带 requestId 的运行记录（runtime:snapshot 返回） */
export interface RuntimeRunRecord extends RunRecordPayload {
  id: string
}

/** 中央同步器拉取的全量运行态快照 */
export interface RuntimeSnapshot {
  runs: RuntimeRunRecord[]
  batches: BatchSnapshot[]
}

/** 批量自动写作进度快照（主进程编排，write:batch 事件/write:batchStatus 拉取） */
export interface BatchSnapshot {
  projectId: string
  running: boolean
  paused: boolean
  done: number
  total: number
  currentNo: number
  log: string[]
  resumeIds: string[] | null
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
  wizardPlan: string
  createdAt: number
  updatedAt: number
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

/** 人物关联展示：按人物 id 索引的出场章节统计（主进程扫描已写正文） */
export interface CharacterAppearance {
  chapters: number[]
  count: number
}

export interface WorldbuildEntry {
  id: string
  projectId: string
  category: string
  title: string
  tags: string
  keys: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface OutlineItem {
  id: string
  projectId: string
  volume: number
  chapterNo: number
  title: string
  synopsis: string
  scenes: string[]
  role: string
  suspense: string
  twist: number
  hook: string
  foreshadowOps: string
  status: OutlineStatus
  createdAt: number
  updatedAt: number
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

/** outlineAlign 产出的大纲修订项（对照已写剧情修正后续章节纲要） */
export interface AlignRevision {
  outlineId: string
  volume: number
  chapterNo: number
  title: string
  synopsis: string
  scenes?: string[]
  hook?: string
  reason?: string
}

export interface LedgerEntry {
  name: string
  value: string
}

export interface ChapterSummary {
  id: string
  chapterId: string
  summary: string
  events: string[]
  timeline: string
  characterStates: Array<{ name: string; state: string }>
  ledger: LedgerEntry[]
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

export interface WorldbuildPreviewEntry {
  category: string
  title: string
  tags: string[]
  content: string
  isNewType: boolean
}

/** canonSync：对已有世界观条目的修订建议（id 为原条目，确认后按 id 覆盖落库） */
export interface CanonWorldUpdate {
  id: string
  title: string
  category: string
  tags: string[]
  content: string
}

/** canonSync 管线 done payload.data：人物已自动落库，世界观进预览确认 */
export interface CanonSyncResult {
  savedCharacters: {
    characterId?: string
    name: string
    revised: Array<{ id: string; name: string }>
  }
  worldNew: WorldbuildPreviewEntry[]
  worldUpdates: CanonWorldUpdate[]
}

export type ExportFormat = 'txt' | 'md' | 'docx'

export interface PremiseDraftCharacter {
  name: string
  brief: string
}

export interface PremiseDraftResult {
  worldbuildBrief: string
  worldbuildCategories: string[]
  worldbuildCount: number
  characters: PremiseDraftCharacter[]
  outlineIdea: string
  outlineCount: number
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

export type SubagentEvent =
  | { type: 'start'; parentId: string; task: string; role: string }
  | { type: 'delta'; parentId: string; text: string }
  | { type: 'toolCall'; parentId: string; call: AgentToolCall }
  | { type: 'toolResult'; parentId: string; id: string; ok: boolean; result: string }
  | { type: 'done'; parentId: string; text: string; turns: number }
  | { type: 'error'; parentId: string; message: string }

export interface AgentDonePayload {
  text: string
  turns: number
  requests: number
  changed: boolean
  denied: boolean
  hitLimit: boolean
  subagents: number
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
