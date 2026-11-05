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

// ── 领域模型：分叉树（DECISIONS.md D1-D6 / B6-B8 / W9 / W12） ────────────────

export interface Book {
  id: string
  title: string
  intro: string
  genre: string
  /** 文风卡（B3）：名称+参考样本+风格要点 */
  styleName: string
  styleSample: string
  styleNotes: string
  /** 章节目标字数（B4，agent 微调 ±20%） */
  targetWords: number
  /** 剧情红线（B2）：走向/正文/新线永远避开 */
  redlines: string[]
  activeLineId: string
  archived: boolean
  createdAt: number
  updatedAt: number
}

export interface StoryLine {
  id: string
  bookId: string
  /** 主线为空串 */
  parentLineId: string
  /** 分叉点的章（主线为空串；跨线引用） */
  forkChapterId: string
  /** agent 自动起（如「复仇线」）；主线固定「主线」 */
  name: string
  note: string
  createdAt: number
}

export interface ChapterMeta {
  /** 用户选定的走向（卡片或自由输入） */
  direction?: { source: 'card' | 'free'; cardIndex?: number; text: string }
  outline?: ChapterOutline
  scenes?: Scene[] | null
  [key: string]: unknown
}

export interface Chapter {
  id: string
  lineId: string
  /** 前一章（本线内链式；分叉线首章指向父线分叉点） */
  parentChapterId: string
  orderNo: number
  title: string
  content: string
  wordCount: number
  /** 本章摘要（滚动记忆的细记层） */
  summary: string
  meta: ChapterMeta
  createdAt: number
  updatedAt: number
}

export interface ChapterVersion {
  id: string
  chapterId: string
  content: string
  reason: string
  wordCount: number
  createdAt: number
}

export type CardKind = 'geography' | 'faction' | 'history' | 'power' | 'item' | 'custom'

export interface Card {
  id: string
  bookId: string
  lineId: string
  kind: CardKind
  title: string
  /** 读者已知层：写作措辞不得超出此层（B6） */
  readerText: string
  /** 作者真相层：含未揭示设定与计划揭示章 */
  authorText: string
  revealPlan: string
  /** 钉选=每次写作必进上下文（B7） */
  pinned: boolean
  tags: string[]
  createdAt: number
  updatedAt: number
}

/** 人物活状态（B8 七要素，agent 每章收尾自动更新） */
export interface CharacterState {
  location?: string
  body?: string
  mood?: string
  items?: string
  knows?: string
  goal?: string
}

export interface CharacterRelation {
  to: string
  label: string
}

export interface Character {
  id: string
  bookId: string
  lineId: string
  name: string
  role: string
  /** 人物卡自由结构（背景/外貌/性格/口癖等） */
  card: Record<string, unknown>
  state: CharacterState
  relations: CharacterRelation[]
  pinned: boolean
  tags: string[]
  createdAt: number
  updatedAt: number
}

export type ForeshadowStatus = 'open' | 'planned' | 'resolved'

export interface Foreshadow {
  id: string
  bookId: string
  lineId: string
  title: string
  detail: string
  plantedChapterId: string
  plannedChapterId: string
  resolvedChapterId: string
  status: ForeshadowStatus
  priority: number
  createdAt: number
  updatedAt: number
}

/** 滚动分层记忆的远端压缩层（D2）：最近章细记在 chapters.summary */
export interface MemoryBlock {
  id: string
  lineId: string
  fromOrder: number
  toOrder: number
  content: string
  createdAt: number
}

export interface ChatMessageRow {
  id: string
  bookId: string
  chapterId: string
  role: 'user' | 'assistant'
  content: string
  meta: Record<string, unknown>
  createdAt: number
}

// ── 任务流水线（W10/W12/W14） ────────────────────────────────────────────────

export type JobKind = 'write' | 'onboard' | 'rewrite'
export type JobState = 'queued' | 'running' | 'waiting_user' | 'done' | 'failed' | 'cancelled'
/** 写章五步：提案→章级大纲→分镜→正文→自检收尾（W3/W6） */
export type JobStep = 'proposal' | 'outline' | 'scene' | 'draft' | 'selfcheck' | 'finalize'

/** 走向卡片（W2）：默认 4 张类型不同，按需 1-5 张 */
export interface DirectionCard {
  kind: 'steady' | 'twist' | 'depth' | 'wild'
  /** 卡片标题（短语） */
  title: string
  /** 剧情预告（1-2 句） */
  preview: string
  /** 结构化标注：回收哪个伏笔/引入什么新元素等 */
  structure: string
  /** 弧线标注（如「开启 3 章追杀弧」） */
  arc: string
}

export interface ChapterOutline {
  title: string
  synopsis: string
  beats: string[]
}

export interface Scene {
  id: string
  summary: string
  viewpoint: string
  pace: string
}

/** 本章纪要卡（W4）：概要+设定变更清单（可撤销） */
export interface ChapterRecap {
  summary: string
  stateChanges: Array<{ characterId: string; name: string; patch: CharacterState }>
  cardOps: Array<{
    op: 'create' | 'update' | 'delete'
    cardId?: string
    kind?: CardKind
    title?: string
    readerText?: string
    authorText?: string
  }>
  foreshadowOps: Array<{
    op: 'plant' | 'plan' | 'resolve'
    title: string
    detail: string
    foreshadowId?: string
    atOrder?: number
  }>
}

export interface JobPayload {
  /** proposal 产物 */
  cards?: DirectionCard[]
  /** 用户选择（卡片序号或自由输入） */
  direction?: { source: 'card' | 'free'; cardIndex?: number; text: string }
  /** outline 产物 */
  outline?: ChapterOutline
  /** scene 产物（null=用户跳过分镜直接开写） */
  scenes?: Scene[] | null
  /** draft/selfcheck 产物 */
  draftText?: string
  draftWordCount?: number
  /** 自检报告（两轮：初检/自动修后复检） */
  lint?: LintReport
  autoFixed?: boolean
  /** finalize 产物（纪要卡） */
  recap?: ChapterRecap
  /** 流式正文关联的 requestId（SSE 补拉用） */
  draftRequestId?: string
}

export interface Job {
  id: string
  bookId: string
  lineId: string
  kind: JobKind
  state: JobState
  step: JobStep | ''
  payload: JobPayload
  error: string
  chapterId: string
  watchdogAt: number
  createdAt: number
  updatedAt: number
}

// ── 自检（W6，零成本硬闸） ───────────────────────────────────────────────────

export interface LintIssue {
  rule: string
  level: 'major' | 'minor'
  quote: string
  advice: string
}

export interface LintReport {
  issues: LintIssue[]
  score: number
  pass: boolean
  wordCount: number
  targetWords: number | null
}

// ── 现状卡（W1，纯数据组装零模型成本） ──────────────────────────────────────

export interface StatusCard {
  bookTitle: string
  lineName: string
  chapterCount: number
  lastChapter: { orderNo: number; title: string; summary: string; updatedAt: number } | null
  /** 未闭合伏笔（open/planned，按优先级+计划章排序） */
  openForeshadows: Array<{
    title: string
    detail: string
    status: ForeshadowStatus
    plannedOrder: number | null
  }>
  /** 主要人物现状（pinned 优先，最多 6 人） */
  characters: Array<{ name: string; role: string; state: CharacterState }>
  /** 断更天数>7 时为 true（前端据此展示全量前情简报入口） */
  staleDays: number | null
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
