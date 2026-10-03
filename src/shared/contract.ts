import { z } from 'zod'
import { PROVIDER_IDS } from './providers'
import type {
  AgentDonePayload,
  AgentSession,
  AgentSessionBrief,
  AgentToolCall,
  BatchSnapshot,
  BuiltContext,
  Chapter,
  ChapterBrief,
  ChapterSummary,
  Character,
  CharacterAppearance,
  ChatMessage,
  ChatResult,
  ContentBlock,
  EmbeddingStatus,
  Foreshadow,
  ModelProbeResult,
  ModelRouting,
  OutlineItem,
  Project,
  ProjectGraph,
  RunRecordPayload,
  RuntimeSnapshot,
  SearchHit,
  ServerStatus,
  SettingsView,
  SkillFile,
  SkillMeta,
  SubagentEvent,
  ToolDef,
  UsageRecord,
  UsageStats,
  VolumeSummary,
  WorldbuildEntry
} from './types'

/**
 * API 契约（单一事实源）：
 * - invokeContract：渲染端 → 主进程的全部请求通道。args 为 zod tuple schema
 *   （内嵌 HTTP 边界据此做运行时校验），ret 为返回类型标记（运行时为 null）。
 * - ipcOnlyContract：仅桌面 IPC 可用的敏感通道（服务器自身配置、本机导出对话框）。
 * - eventContract：主进程 → 渲染端的事件通道与 payload 元组类型。
 * - 输入类型（*Input / ChatParams 等）从 schema 推导，types.ts 再导出兼容旧路径。
 * 三端（handlers / preload / web-bridge）全部从本文件派生签名：主进程改签名，
 * 渲染端立即编译报错；渲染端乱传参，HTTP 边界立即 400。
 */

// ── 基础枚举（类型与运行时值都从这里出） ─────────────────────────────────────

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

export const PIPELINE_ACTIONS = [
  'outline',
  'volumeIdea',
  'rulesRefine',
  'outlineAlign',
  'chapter',
  'summary',
  'polish',
  'check',
  'review',
  'expand',
  'volumeSummary',
  'stateSync',
  'character',
  'characterRoster',
  'worldbuild',
  'canonSync',
  'premiseDraft'
] as const
export type PipelineAction = (typeof PIPELINE_ACTIONS)[number]

export const OUTLINE_STATUSES = ['draft', 'approved', 'written', 'polished'] as const
export type OutlineStatus = (typeof OUTLINE_STATUSES)[number]

// ── 输入 schema ──────────────────────────────────────────────────────────────

export const ProviderIdSchema = z.enum(PROVIDER_IDS)

export const ChatMessageSchema: z.ZodType<ChatMessage> = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([
    z.string(),
    z.array(z.custom<ContentBlock>((v) => typeof v === 'object' && v !== null))
  ])
})

export const ChatParamsSchema = z.object({
  model: z.string(),
  system: z.string().optional(),
  messages: z.array(ChatMessageSchema),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  purpose: z.enum(PURPOSES).optional(),
  cacheSystem: z.boolean().optional(),
  tools: z.custom<ToolDef[]>((v) => Array.isArray(v)).optional()
})

export const ProjectInputSchema = z.object({
  title: z.string(),
  genre: z.string().optional(),
  styleGuide: z.string().optional(),
  targetWords: z.number().optional(),
  wizardPlan: z.string().optional()
})

export const CharacterInputSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  role: z.string().optional(),
  tags: z.string().optional(),
  card: z.string().optional(),
  state: z.string().optional()
})

export const WorldbuildInputSchema = z.object({
  projectId: z.string(),
  category: z.string(),
  title: z.string(),
  tags: z.string().optional(),
  keys: z.string().optional(),
  content: z.string().optional()
})

export const OutlineInputSchema = z.object({
  projectId: z.string(),
  volume: z.number(),
  chapterNo: z.number(),
  title: z.string().optional(),
  synopsis: z.string().optional(),
  scenes: z.array(z.string()).optional(),
  role: z.string().optional(),
  suspense: z.string().optional(),
  twist: z.number().optional(),
  hook: z.string().optional(),
  foreshadowOps: z.string().optional(),
  status: z.enum(OUTLINE_STATUSES).optional()
})

export const ForeshadowInputSchema = z.object({
  projectId: z.string(),
  content: z.string(),
  plantedChapter: z.string().optional(),
  status: z.string().optional(),
  resolvedChapter: z.string().optional(),
  plannedResolve: z.string().optional(),
  priority: z.string().optional()
})

export const SettingsPatchSchema = z.object({
  provider: ProviderIdSchema.optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  customModels: z.string().optional(),
  modelRouting: z.custom<ModelRouting>((v) => typeof v === 'object' && v !== null).optional(),
  quota5hPrompts: z.number().optional(),
  promptCache: z.boolean().optional(),
  currentProjectId: z.string().optional()
})

export const ServerConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().optional(),
  password: z.string().nullable().optional()
})

export const ModelProbeOptionsSchema = z.object({
  provider: ProviderIdSchema.optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional()
})

export const WorldbuildGenParamsSchema = z.object({
  projectId: z.string(),
  categories: z.array(z.string()),
  title: z.string(),
  brief: z.string(),
  count: z.number().optional(),
  tags: z.array(z.string()).optional(),
  allowUpdate: z.boolean().optional()
})

export const CharacterGenParamsSchema = z.object({
  projectId: z.string(),
  brief: z.string(),
  name: z.string().optional(),
  allowUpdate: z.boolean().optional(),
  // false = 仅解析预览不落库（人物班底挑选模式），缺省 true 保持自动落库
  save: z.boolean().optional()
})

export const OutlineGenParamsSchema = z.object({
  projectId: z.string(),
  idea: z.string(),
  volume: z.number(),
  startNo: z.number(),
  count: z.number(),
  allowUpdate: z.boolean().optional(),
  // 节奏与硬性要求（每行一条，原样透传给 prompt，逐章严格执行）
  rules: z.string().optional()
})

export const SaveChapterInputSchema = z.object({
  outlineId: z.string(),
  projectId: z.string(),
  content: z.string(),
  status: z.string().optional()
})

export const WorldbuildCommitChunkOptsSchema = z.object({
  allowNewType: z.boolean(),
  taskEntryIds: z.array(z.string()),
  allowUpdate: z.boolean().optional()
})

export const WorldbuildTypePosSchema = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  first: z.boolean().optional(),
  last: z.boolean().optional()
})

export const AgentRunParamsSchema = z.object({
  projectId: z.string(),
  messages: z.array(ChatMessageSchema),
  model: z.string().optional()
})

export const WorldbuildPreviewEntrySchema = z.object({
  category: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  content: z.string(),
  isNewType: z.boolean()
})

export const ExportOptionsSchema = z.object({
  projectId: z.string(),
  format: z.enum(['txt', 'md', 'docx']),
  scope: z.enum(['all', 'single']),
  outlineId: z.string().optional()
})

export const PremiseDraftParamsSchema = z.object({ projectId: z.string() })

/** pipeline:run 的 params：按 action 在 handler 内用 PIPELINE_PARAM_SCHEMAS 校验 */
export const PIPELINE_PARAM_SCHEMAS = {
  premiseDraft: z.object({ projectId: z.string() }),
  outline: OutlineGenParamsSchema,
  volumeIdea: z.object({
    projectId: z.string(),
    volume: z.number(),
    idea: z.string(),
    rules: z.string().optional()
  }),
  rulesRefine: z.object({
    projectId: z.string(),
    volume: z.number(),
    rules: z.string()
  }),
  outlineAlign: z.object({ projectId: z.string() }),
  chapter: z.object({
    outlineId: z.string(),
    wordTarget: z.number().optional(),
    candidates: z.number().optional()
  }),
  summary: z.object({
    outlineId: z.string(),
    finalize: z.boolean().optional()
  }),
  polish: z.object({
    outlineId: z.string(),
    focus: z.string().optional(),
    save: z.boolean().optional()
  }),
  check: z.object({ outlineId: z.string() }),
  review: z.object({ outlineId: z.string() }),
  expand: z.object({ outlineId: z.string(), targetWords: z.number() }),
  volumeSummary: z.object({ projectId: z.string(), volume: z.number() }),
  stateSync: z.object({ outlineId: z.string() }),
  character: CharacterGenParamsSchema,
  characterRoster: z.object({
    projectId: z.string(),
    count: z.number().optional(),
    note: z.string().optional()
  }),
  worldbuild: WorldbuildGenParamsSchema,
  canonSync: z.object({ projectId: z.string(), volume: z.number() })
} satisfies Record<PipelineAction, z.ZodTypeAny>

// ── 输入类型（types.ts 从这里再导出以兼容旧 import 路径） ───────────────────

export type ChatParams = z.output<typeof ChatParamsSchema>
export type ProjectInput = z.output<typeof ProjectInputSchema>
export type CharacterInput = z.output<typeof CharacterInputSchema>
export type WorldbuildInput = z.output<typeof WorldbuildInputSchema>
export type OutlineInput = z.output<typeof OutlineInputSchema>
export type ForeshadowInput = z.output<typeof ForeshadowInputSchema>
export type SettingsPatch = z.output<typeof SettingsPatchSchema>
export type ServerConfigPatch = z.output<typeof ServerConfigPatchSchema>
export type ModelProbeOptions = z.output<typeof ModelProbeOptionsSchema>
export type WorldbuildGenParams = z.output<typeof WorldbuildGenParamsSchema>
export type CharacterGenParams = z.output<typeof CharacterGenParamsSchema>
export type OutlineGenParams = z.output<typeof OutlineGenParamsSchema>
export type PremiseDraftParams = z.output<typeof PremiseDraftParamsSchema>
export type SaveChapterInput = z.output<typeof SaveChapterInputSchema>
export type WorldbuildCommitChunkOpts = z.output<typeof WorldbuildCommitChunkOptsSchema>
export type WorldbuildTypePos = z.output<typeof WorldbuildTypePosSchema>
export type AgentRunParams = z.output<typeof AgentRunParamsSchema>
export type WorldbuildPreviewEntryInput = z.output<typeof WorldbuildPreviewEntrySchema>
export type ExportOptions = z.output<typeof ExportOptionsSchema>

// ── 事件 payload 类型 ────────────────────────────────────────────────────────

export type DonePayload = Pick<
  ChatResult,
  'usage' | 'model' | 'stopReason' | 'durationMs' | 'headers'
> & {
  action?: PipelineAction
  data?: unknown
}

export interface WorldbuildRetrievalBrief {
  types: string[]
  tags: string[]
  count: number
  titles: string[]
}

export interface AgentToolCallEvent extends Omit<AgentToolCall, 'state'> {
  state: AgentToolCall['state']
}

export interface AgentToolResultEvent {
  id: string
  ok: boolean
  result: string
  denied?: boolean
}

// ── invoke 契约 ──────────────────────────────────────────────────────────────

const ret = <T>(): T => null as unknown as T

export const invokeContract = {
  'settings:get': { args: z.tuple([]), ret: ret<SettingsView>() },
  'settings:save': { args: z.tuple([SettingsPatchSchema]), ret: ret<SettingsView>() },

  'server:status': { args: z.tuple([]), ret: ret<ServerStatus>() },

  'models:probe': {
    args: z.tuple([ModelProbeOptionsSchema.optional()]),
    ret: ret<ModelProbeResult>()
  },

  'llm:chat': { args: z.tuple([ChatParamsSchema]), ret: ret<string>() },
  'llm:abort': { args: z.tuple([z.string()]), ret: ret<void>() },
  'llm:poll': {
    args: z.tuple([z.object({ requestIds: z.array(z.string()) })]),
    ret: ret<Record<string, RunRecordPayload>>()
  },

  'runtime:snapshot': { args: z.tuple([]), ret: ret<RuntimeSnapshot>() },

  'write:batchStart': {
    args: z.tuple([
      z.object({
        projectId: z.string(),
        ids: z.array(z.string()).optional(),
        resume: z.boolean().optional(),
        wordTarget: z.number().optional(),
        candidates: z.number().optional(),
        pauseEach: z.boolean().optional(),
        regenVolumeSummary: z.boolean().optional()
      })
    ]),
    ret: ret<BatchSnapshot>()
  },
  'write:batchStop': {
    args: z.tuple([z.object({ projectId: z.string() })]),
    ret: ret<BatchSnapshot | null>()
  },
  'write:batchStatus': {
    args: z.tuple([z.object({ projectId: z.string() })]),
    ret: ret<BatchSnapshot | null>()
  },

  'agent:run': { args: z.tuple([AgentRunParamsSchema]), ret: ret<string>() },
  'agent:abort': { args: z.tuple([z.string()]), ret: ret<void>() },
  'agent:resolve': {
    args: z.tuple([z.string(), z.string(), z.boolean(), z.boolean().optional()]),
    ret: ret<boolean>()
  },
  'agent:sessions': { args: z.tuple([z.string().optional()]), ret: ret<AgentSessionBrief[]>() },
  'agent:sessionLoad': { args: z.tuple([z.string()]), ret: ret<AgentSession | null>() },
  'agent:sessionSave': {
    args: z.tuple([z.custom<AgentSession>((v) => typeof v === 'object' && v !== null)]),
    ret: ret<void>()
  },
  'agent:sessionDelete': { args: z.tuple([z.string()]), ret: ret<void>() },

  'usage:list': { args: z.tuple([z.number().optional()]), ret: ret<UsageRecord[]>() },
  'usage:stats': { args: z.tuple([]), ret: ret<UsageStats>() },

  'pipeline:run': {
    args: z.tuple([z.enum(PIPELINE_ACTIONS), z.unknown()]),
    ret: ret<string>()
  },

  'novel:projects': { args: z.tuple([]), ret: ret<Project[]>() },
  'novel:projectCreate': { args: z.tuple([ProjectInputSchema]), ret: ret<Project>() },
  'novel:projectUpdate': {
    args: z.tuple([z.string(), ProjectInputSchema.partial()]),
    ret: ret<void>()
  },
  'novel:projectDelete': { args: z.tuple([z.string()]), ret: ret<void>() },
  'novel:characters': { args: z.tuple([z.string()]), ret: ret<Character[]>() },
  'novel:characterSave': {
    args: z.tuple([CharacterInputSchema.extend({ id: z.string().optional() })]),
    ret: ret<Character>()
  },
  'novel:characterDelete': { args: z.tuple([z.string()]), ret: ret<void>() },
  'novel:characterAppearances': {
    args: z.tuple([z.string()]),
    ret: ret<Record<string, CharacterAppearance>>()
  },
  'novel:worldbuild': { args: z.tuple([z.string()]), ret: ret<WorldbuildEntry[]>() },
  'novel:worldbuildSave': {
    args: z.tuple([WorldbuildInputSchema.extend({ id: z.string().optional() })]),
    ret: ret<WorldbuildEntry>()
  },
  'novel:worldbuildDelete': { args: z.tuple([z.string()]), ret: ret<void>() },
  'novel:worldbuildDeleteBatch': {
    args: z.tuple([z.string(), z.array(z.string())]),
    ret: ret<number>()
  },
  'novel:worldbuildCommitChunk': {
    args: z.tuple([z.string(), z.string(), z.array(z.string()), WorldbuildCommitChunkOptsSchema]),
    ret: ret<{
      entryIds: string[]
      createdTypes: string[]
      updatedIds: string[]
      revisedIds: string[]
    }>()
  },
  'novel:worldbuildRelink': {
    args: z.tuple([z.string(), z.array(z.string())]),
    ret: ret<number>()
  },
  'novel:worldbuildRetrieve': {
    args: z.tuple([WorldbuildGenParamsSchema]),
    ret: ret<WorldbuildRetrievalBrief | null>()
  },
  'novel:worldbuildSaveBatch': {
    args: z.tuple([z.string(), z.array(WorldbuildPreviewEntrySchema)]),
    ret: ret<{ entryIds: string[]; createdTypes: string[] }>()
  },
  'novel:worldbuildTypes': { args: z.tuple([z.string()]), ret: ret<string[]>() },
  'novel:worldbuildTypeCreate': { args: z.tuple([z.string(), z.string()]), ret: ret<string[]>() },
  'novel:worldbuildTypeDelete': { args: z.tuple([z.string(), z.string()]), ret: ret<string[]>() },
  'novel:worldbuildTypeReorder': {
    args: z.tuple([z.string(), z.string(), WorldbuildTypePosSchema]),
    ret: ret<string[]>()
  },
  'novel:outlines': { args: z.tuple([z.string()]), ret: ret<OutlineItem[]>() },
  'novel:outlineSave': {
    args: z.tuple([OutlineInputSchema.extend({ id: z.string().optional() })]),
    ret: ret<OutlineItem>()
  },
  'novel:outlineDelete': { args: z.tuple([z.string()]), ret: ret<void>() },
  'novel:chapterBriefs': { args: z.tuple([z.string()]), ret: ret<ChapterBrief[]>() },
  'novel:chapter': { args: z.tuple([z.string()]), ret: ret<Chapter | null>() },
  'novel:saveChapter': { args: z.tuple([SaveChapterInputSchema]), ret: ret<Chapter>() },
  'novel:contextPreview': { args: z.tuple([z.string()]), ret: ret<BuiltContext>() },
  'novel:foreshadows': { args: z.tuple([z.string()]), ret: ret<Foreshadow[]>() },
  'novel:foreshadowSave': {
    args: z.tuple([ForeshadowInputSchema.extend({ id: z.string().optional() })]),
    ret: ret<Foreshadow>()
  },
  'novel:foreshadowDelete': { args: z.tuple([z.string()]), ret: ret<void>() },
  'novel:summary': { args: z.tuple([z.string()]), ret: ret<ChapterSummary | null>() },
  'novel:volumeSummary': {
    args: z.tuple([z.string(), z.number()]),
    ret: ret<VolumeSummary | null>()
  },
  'novel:volumeSummaries': { args: z.tuple([z.string()]), ret: ret<VolumeSummary[]>() },

  'lint:run': { args: z.tuple([z.string(), z.string().optional()]), ret: ret<unknown>() },

  'embedding:status': { args: z.tuple([z.string().optional()]), ret: ret<EmbeddingStatus>() },
  'embedding:setEnabled': { args: z.tuple([z.boolean()]), ret: ret<void>() },
  'embedding:rebuild': { args: z.tuple([z.string().optional()]), ret: ret<{ count: number }>() },

  'search:project': {
    args: z.tuple([z.string(), z.string(), z.number().optional()]),
    ret: ret<SearchHit[]>()
  },

  'graph:project': { args: z.tuple([z.string()]), ret: ret<ProjectGraph>() },

  'skills:list': { args: z.tuple([]), ret: ret<SkillMeta[]>() },
  'skills:get': { args: z.tuple([z.string()]), ret: ret<SkillFile | null>() },
  'skills:save': { args: z.tuple([z.string(), z.string()]), ret: ret<void>() },
  'skills:delete': { args: z.tuple([z.string()]), ret: ret<void>() }
}

export type InvokeChannels = keyof typeof invokeContract & string
export type ArgsOf<C extends InvokeChannels> = z.output<(typeof invokeContract)[C]['args']>
export type RetOf<C extends InvokeChannels> = (typeof invokeContract)[C]['ret']

/** 仅桌面 IPC 可用：服务器自身配置与本机导出对话框，不暴露给局域网 HTTP。 */
export const ipcOnlyContract = {
  'exporter:run': {
    args: z.tuple([ExportOptionsSchema]),
    ret: ret<{ path: string; words: number }>()
  },
  'server:config': { args: z.tuple([ServerConfigPatchSchema]), ret: ret<ServerStatus>() }
}

export type IpcOnlyChannels = keyof typeof ipcOnlyContract & string

export type ApiChannel = InvokeChannels | IpcOnlyChannels

export type ArgsOfApi<C extends ApiChannel> = C extends InvokeChannels
  ? ArgsOf<C>
  : C extends IpcOnlyChannels
    ? z.output<(typeof ipcOnlyContract)[C]['args']>
    : never
export type RetOfApi<C extends ApiChannel> = C extends InvokeChannels
  ? RetOf<C>
  : C extends IpcOnlyChannels
    ? (typeof ipcOnlyContract)[C]['ret']
    : never

// ── 事件契约 ─────────────────────────────────────────────────────────────────

export interface EventContract {
  'llm:delta': [requestId: string, text: string]
  'llm:done': [requestId: string, payload: DonePayload]
  'llm:error': [requestId: string, message: string]
  'llm:notice': [requestId: string, message: string]
  'agent:delta': [requestId: string, text: string]
  'agent:toolCall': [requestId: string, call: AgentToolCallEvent]
  'agent:toolResult': [requestId: string, result: AgentToolResultEvent]
  'agent:done': [requestId: string, payload: AgentDonePayload]
  'agent:error': [requestId: string, message: string]
  'agent:subEvent': [requestId: string, event: SubagentEvent]
  'write:batch': [projectId: string, snapshot: BatchSnapshot]
}

export const EVENT_CHANNELS = [
  'llm:delta',
  'llm:done',
  'llm:error',
  'llm:notice',
  'agent:delta',
  'agent:toolCall',
  'agent:toolResult',
  'agent:done',
  'agent:error',
  'agent:subEvent',
  'write:batch'
] as const satisfies readonly (keyof EventContract)[]

export type EventChannels = keyof EventContract & string

// ── Api 形状（preload 与 web-bridge 共同实现，buildApi 统一构造） ────────────

export type InvokeFn<C extends ApiChannel> = (...args: ArgsOfApi<C>) => Promise<RetOfApi<C>>

export type SubscribeFn<C extends EventChannels> = (
  cb: (...args: EventContract[C]) => void
) => () => void

export interface Api {
  settings: {
    get: InvokeFn<'settings:get'>
    save: InvokeFn<'settings:save'>
  }
  server: {
    status: InvokeFn<'server:status'>
    config: InvokeFn<'server:config'>
  }
  models: {
    probe: InvokeFn<'models:probe'>
  }
  llm: {
    chat: InvokeFn<'llm:chat'>
    abort: InvokeFn<'llm:abort'>
    poll: InvokeFn<'llm:poll'>
    onDelta: SubscribeFn<'llm:delta'>
    onDone: SubscribeFn<'llm:done'>
    onError: SubscribeFn<'llm:error'>
    onNotice: SubscribeFn<'llm:notice'>
  }
  runtime: {
    snapshot: InvokeFn<'runtime:snapshot'>
  }
  usage: {
    list: InvokeFn<'usage:list'>
    stats: InvokeFn<'usage:stats'>
  }
  write: {
    batchStart: InvokeFn<'write:batchStart'>
    batchStop: InvokeFn<'write:batchStop'>
    batchStatus: InvokeFn<'write:batchStatus'>
    onBatch: SubscribeFn<'write:batch'>
  }
  novel: {
    projects: InvokeFn<'novel:projects'>
    projectCreate: InvokeFn<'novel:projectCreate'>
    projectUpdate: InvokeFn<'novel:projectUpdate'>
    projectDelete: InvokeFn<'novel:projectDelete'>
    characters: InvokeFn<'novel:characters'>
    characterSave: InvokeFn<'novel:characterSave'>
    characterDelete: InvokeFn<'novel:characterDelete'>
    characterAppearances: InvokeFn<'novel:characterAppearances'>
    worldbuild: InvokeFn<'novel:worldbuild'>
    worldbuildSave: InvokeFn<'novel:worldbuildSave'>
    worldbuildDelete: InvokeFn<'novel:worldbuildDelete'>
    worldbuildDeleteBatch: InvokeFn<'novel:worldbuildDeleteBatch'>
    worldbuildCommitChunk: InvokeFn<'novel:worldbuildCommitChunk'>
    worldbuildRelink: InvokeFn<'novel:worldbuildRelink'>
    worldbuildRetrieve: InvokeFn<'novel:worldbuildRetrieve'>
    worldbuildSaveBatch: InvokeFn<'novel:worldbuildSaveBatch'>
    worldbuildTypes: InvokeFn<'novel:worldbuildTypes'>
    worldbuildTypeCreate: InvokeFn<'novel:worldbuildTypeCreate'>
    worldbuildTypeDelete: InvokeFn<'novel:worldbuildTypeDelete'>
    worldbuildTypeReorder: InvokeFn<'novel:worldbuildTypeReorder'>
    outlines: InvokeFn<'novel:outlines'>
    outlineSave: InvokeFn<'novel:outlineSave'>
    outlineDelete: InvokeFn<'novel:outlineDelete'>
    chapterBriefs: InvokeFn<'novel:chapterBriefs'>
    chapter: InvokeFn<'novel:chapter'>
    saveChapter: InvokeFn<'novel:saveChapter'>
    contextPreview: InvokeFn<'novel:contextPreview'>
    foreshadows: InvokeFn<'novel:foreshadows'>
    foreshadowSave: InvokeFn<'novel:foreshadowSave'>
    foreshadowDelete: InvokeFn<'novel:foreshadowDelete'>
    summary: InvokeFn<'novel:summary'>
    volumeSummary: InvokeFn<'novel:volumeSummary'>
    volumeSummaries: InvokeFn<'novel:volumeSummaries'>
  }
  embedding: {
    status: InvokeFn<'embedding:status'>
    setEnabled: InvokeFn<'embedding:setEnabled'>
    rebuild: InvokeFn<'embedding:rebuild'>
  }
  search: {
    project: InvokeFn<'search:project'>
  }
  lint: {
    run: InvokeFn<'lint:run'>
  }
  pipeline: {
    run: InvokeFn<'pipeline:run'>
  }
  agent: {
    run: InvokeFn<'agent:run'>
    abort: InvokeFn<'agent:abort'>
    resolve: InvokeFn<'agent:resolve'>
    sessions: InvokeFn<'agent:sessions'>
    sessionLoad: InvokeFn<'agent:sessionLoad'>
    sessionSave: InvokeFn<'agent:sessionSave'>
    sessionDelete: InvokeFn<'agent:sessionDelete'>
    onDelta: SubscribeFn<'agent:delta'>
    onToolCall: SubscribeFn<'agent:toolCall'>
    onToolResult: SubscribeFn<'agent:toolResult'>
    onDone: SubscribeFn<'agent:done'>
    onError: SubscribeFn<'agent:error'>
    onSubEvent: SubscribeFn<'agent:subEvent'>
  }
  exporter: {
    run: InvokeFn<'exporter:run'>
  }
  graph: {
    project: InvokeFn<'graph:project'>
  }
  skills: {
    list: InvokeFn<'skills:list'>
    get: InvokeFn<'skills:get'>
    save: InvokeFn<'skills:save'>
    delete: InvokeFn<'skills:delete'>
  }
}

// 覆盖率断言：Api 里声明的每个 invoke 方法都必须对应契约中的通道，缺一个编译报错
type MethodChannels<N> = N extends keyof Api
  ? { [M in keyof Api[N]]: Api[N][M] extends InvokeFn<infer C> ? C : never }[keyof Api[N]]
  : never
type DeclaredChannels = MethodChannels<keyof Api>
type _MissingChannels = Exclude<ApiChannel, DeclaredChannels>
type _CoverageOk = [_MissingChannels] extends [never] ? true : never
const _coverageCheck: _CoverageOk = true
void _coverageCheck

// ── 统一构造器：preload（IPC）与 web-bridge（HTTP+SSE）共用 ─────────────────

export interface ApiTransport {
  invoke: (channel: string, args: unknown[]) => unknown
  subscribe: (channel: string, cb: (...args: never[]) => void) => () => void
}

function eventMethodName(event: string): string {
  return `on${event[0].toUpperCase()}${event.slice(1)}`
}

export function buildApi(transport: ApiTransport): Api {
  const root: Record<string, Record<string, unknown>> = {}
  const put = (channel: string, fn: unknown): void => {
    const idx = channel.indexOf(':')
    const ns = channel.slice(0, idx)
    if (!root[ns]) root[ns] = {}
    root[ns][channel.slice(idx + 1)] = fn
  }
  for (const channel of Object.keys(invokeContract)) {
    put(channel, (...args: unknown[]) => transport.invoke(channel, args))
  }
  for (const channel of Object.keys(ipcOnlyContract)) {
    put(channel, (...args: unknown[]) => transport.invoke(channel, args))
  }
  for (const channel of EVENT_CHANNELS) {
    const idx = channel.indexOf(':')
    const ns = channel.slice(0, idx)
    if (!root[ns]) root[ns] = {}
    root[ns][eventMethodName(channel.slice(idx + 1))] = (cb: (...args: never[]) => void) =>
      transport.subscribe(channel, cb)
  }
  return root as unknown as Api
}
