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
  currentProjectId: string
}

export interface SettingsPatch {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  customModels?: string
  modelRouting?: ModelRouting
  quota5hPrompts?: number
  promptCache?: boolean
  currentProjectId?: string
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
  createdAt: number
  updatedAt: number
}

export interface CharacterInput {
  projectId: string
  name: string
  role?: string
  tags?: string
  card?: string
}

export interface WorldbuildEntry {
  id: string
  projectId: string
  category: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface WorldbuildInput {
  projectId: string
  category: string
  title: string
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

export interface Foreshadow {
  id: string
  projectId: string
  content: string
  plantedChapter: string
  status: string
  resolvedChapter: string
  createdAt: number
  updatedAt: number
}

export interface ForeshadowInput {
  projectId: string
  content: string
  plantedChapter?: string
  status?: string
  resolvedChapter?: string
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
  | 'character'
  | 'worldbuild'

export type ExportFormat = 'txt' | 'md' | 'docx'

export interface OutlineGenParams {
  projectId: string
  idea: string
  volume: number
  startNo: number
  count: number
}
