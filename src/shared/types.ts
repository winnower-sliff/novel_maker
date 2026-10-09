import type { AgentToolResultEvent, OutlineStatus, Purpose } from './contract'
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
  /** 覆盖该 provider 预设的上下文窗口（tokens），供智能体主动压缩预估；缺省用预设值 */
  contextWindow?: number
  /** 仅 custom 生效：覆盖预设协议；其余 provider 固定用预设协议 */
  protocol?: 'anthropic' | 'openai'
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
  /** agent run 所属会话（客户端按会话对账认领 rid 用） */
  sessionId?: string
}

/** agent run 在途待应答的确认（runtime:snapshot 恢复用；串行 await，同一时刻最多一个） */
export interface PendingConfirmInfo {
  confirmId: string
  toolName: string
  input?: unknown
  dangerReason?: string
}

/** 大纲生成实时进度（主进程增量解析已确认流文本维护，runtime:snapshot 轮询恢复） */
export interface OutlineRunProgress {
  /** 已配平解析出的章数 */
  count: number
  /** 本次生成目标章数 */
  total: number
  /** 最近解析的章节标题（≤3 个） */
  lastTitles: string[]
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
  /** outline run 的结构化进度（1s 轮询驱动真进度条，跨 chunk 增量解析） */
  progress?: OutlineRunProgress
  /** agent run 的待应答确认（仅 running 时由 listRuns 实时附加） */
  pendingConfirm?: PendingConfirmInfo
  /** agent run 已完成工具的轻量状态表（仅 running 时附加，渲染端对账校正刷新窗口丢失的卡） */
  toolStatuses?: AgentToolResultStatus[]
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
  /** 用户主动停止（区别于自然完成）：停止后不再执行后续阶段，UI 据此区分「已完成」 */
  stopped: boolean
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
  styleSample: string
  targetWords: number
  status: string
  wizardPlan: string
  agentInstructions: string
  createdAt: number
  updatedAt: number
}

export interface Character {
  id: string
  projectId: string
  name: string
  role: string
  tags: string
  /** 合并视图：由 character_sections 拼装（存储事实源是分节表，card 列恒空） */
  card: string
  /** 人物关联：`[[世界观条目|关系短语]]` 语法，展示/图谱用 */
  relation: string
  state: string
  createdAt: number
  updatedAt: number
}

/**
 * 实体卡分节（人物/世界观通用）：title 为字段名（如「基本信息」「概述」），
 * content 为该字段 markdown 正文；归属实体由 entityId + 使用场景区分
 */
export interface EntitySection {
  id: string
  /** 归属实体 id（人物或世界观条目） */
  entityId: string
  title: string
  content: string
  sortKey: number
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
  /** 合并视图：由 worldbuild_sections 拼装（存储事实源是分节表，content 列恒空） */
  content: string
  /** 人物/剧情关联：该条目与人物卡人物或剧情线的绑定关系，空串为未填 */
  relation: string
  createdAt: number
  updatedAt: number
}

export interface OutlineItem {
  id: string
  projectId: string
  volume: number
  chapterNo: number
  /** 排序事实：章号由该值的位置派生（缓存），插删移动只改此值 */
  sortKey: number
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
  /** 章节引用 uid：有效时展示层解析为当前章号，文本字段仅作悬空/无引用时的回退 */
  plantedOutlineId: string
  plannedResolveOutlineId: string
  resolvedOutlineId: string
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
  relation?: string
  isNewType: boolean
}

/** canonSync：对已有世界观条目的修订建议（id 为原条目，确认后按 id 覆盖落库） */
export interface CanonWorldUpdate {
  id: string
  title: string
  category: string
  tags: string[]
  content: string
  /** 人物/剧情关联修订：未传保留原条目 relation */
  relation?: string
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

export type AgentSegment = { kind: 'text'; text: string } | { kind: 'tool'; callId: string }

export type AgentTurn =
  | { role: 'user'; text: string; ts: number }
  | {
      role: 'assistant'
      text: string
      toolCalls: AgentToolCall[]
      segments?: AgentSegment[]
      ts: number
    }

/** agents.md 分节视图：tag=null 表示无标签（每次任务都注入） */
export interface RuleSectionView {
  title: string
  tag: string | null
  /** 节正文（不含 ## 标题行） */
  body: string
}

export interface AgentInstructionsView {
  globalText: string
  projectText: string
  globalPath: string
  /** agents.md 文件头（## 分节之前的内容，恒注入） */
  globalPreamble: string
  /** agents.md 解析出的分节列表（供结构化编辑器） */
  globalSections: RuleSectionView[]
}

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

/** 智能体持久化队列项（agent_queue 表）：task=排队任务按序执行，inject=运行中插入指令 */
export interface AgentQueueItem {
  id: string
  sessionId: string
  projectId: string
  kind: 'task' | 'inject'
  text: string
  model: string
  provider: string
  /** 仅 task 有意义：同会话内顺序，小者先执行 */
  position: number
  createdAt: number
}

export type SubagentEvent =
  | { type: 'start'; parentId: string; task: string; role: string }
  | { type: 'delta'; parentId: string; text: string }
  | { type: 'toolCall'; parentId: string; call: AgentToolCall }
  | { type: 'toolResult'; parentId: string; id: string; ok: boolean; result: string }
  | { type: 'done'; parentId: string; text: string; turns: number }
  | { type: 'error'; parentId: string; message: string }

/** LLM 服务商错误分类（llm:error / agent:error 事件随附，供前端展示可操作的友好提示） */
export type LlmErrorCategory =
  | 'insufficient_balance'
  | 'auth'
  | 'rate_limit'
  | 'model_not_found'
  | 'context_too_long'
  | 'network'
  | 'server_error'
  | 'content_filter'
  | 'unknown'

export interface LlmErrorHint {
  category: LlmErrorCategory
  /** 面向用户的可操作提示文案 */
  friendly: string
  /** 服务商原始报错（排查用，UI 折叠展示） */
  raw: string
}

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
  /** 全部工具结果流水（run 收尾一次性下发，供渲染端校正刷新窗口丢失的工具卡终态） */
  toolResults?: AgentToolResultEvent[]
  /** 自动续跑次数：检测到任务中途停摆（压缩后停顿/征询语）时主进程自动注入「继续」的次数 */
  autoContinues?: number
  /** 上下文超限触发的程序化自动压缩次数 */
  autoCompacts?: number
  /** 本 run 内发生过上下文压缩时携带最后一次压缩摘要（渲染端据此在压缩点渲染折叠条） */
  compact?: { summary: string }
}

/** 工具结果轻量状态表（runtime:snapshot 周期对账用，不带 result 全文避免大 payload 反复传输） */
export interface AgentToolResultStatus {
  id: string
  ok: boolean
  denied?: boolean
}

/** done 事件随附的 run 收尾摘要（transcript 落库用，不含工具流水全量） */
export type AgentDoneSummary = AgentDonePayload

/**
 * 会话 transcript 事件（服务端事实源，按 seq 单调递增落库）：
 * delta 不落库（只走 SSE 实时流），assistant 文本在每轮 chatStream 结束后按轮合并落。
 */
export type AgentTranscriptEvent =
  | { seq: number; ts: number; kind: 'user'; text: string }
  | { seq: number; ts: number; kind: 'assistant'; text: string }
  | { seq: number; ts: number; kind: 'tool_call'; call: AgentToolCall }
  | {
      seq: number
      ts: number
      kind: 'tool_result'
      id: string
      ok: boolean
      result: string
      denied?: boolean
    }
  | { seq: number; ts: number; kind: 'run_error'; message: string }
  | { seq: number; ts: number; kind: 'done'; summary: AgentDoneSummary }

/** 落库前形态（seq/ts 由服务端分配） */
export type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
export type AgentTranscriptInput = DistributiveOmit<AgentTranscriptEvent, 'seq' | 'ts'>

/** agent:sessionEvents 返回：增量事件 + 当前水位 */
export interface AgentTranscriptResult {
  sessionId: string
  events: AgentTranscriptEvent[]
  lastSeq: number
}

export interface AgentToolDefView {
  name: string
  label: string
  danger: boolean
  read: boolean
}
