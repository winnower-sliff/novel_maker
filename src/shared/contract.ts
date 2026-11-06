import { z } from 'zod'
import { MODEL_SLOTS, PROVIDER_IDS } from './providers.js'
import type {
  Book,
  Card,
  Chapter,
  ChapterVersion,
  Character,
  ChatMessage,
  ChatMessageRow,
  ContentBlock,
  Foreshadow,
  Job,
  LlmErrorHint,
  ModelProbeResult,
  SampleFileInfo,
  SampleInfo,
  SampleSearchHit,
  SampleSectionView,
  SampleText,
  ServerStatus,
  SettingsView,
  StatusCard,
  StoryLine,
  ToolDef,
  UsageRecord,
  UsageStats
} from './types.js'

/**
 * v2 API 契约（单一事实源）。
 * 传输只有一种：手机 APK → HTTP（/api/invoke/:channel，token 鉴权）+ SSE（/api/events）。
 * - invokeContract：请求通道。args 为 zod tuple schema（HTTP 边界运行时校验），ret 为返回类型标记。
 * - eventContract：服务器 → APP 的事件通道与 payload 元组类型。
 * 服务端 handlers 与 APK TypeScript 客户端全部从本文件派生签名：
 * 改签名两端立即编译报错；乱传参 HTTP 边界立即 400。
 */

// ── 输入 schema ──────────────────────────────────────────────────────────────

const ProviderIdSchema = z.enum(PROVIDER_IDS)
const ModelSlotSchema = z.enum(MODEL_SLOTS)

export const ChatMessageSchema: z.ZodType<ChatMessage> = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([
    z.string(),
    z.array(z.custom<ContentBlock>((v) => typeof v === 'object' && v !== null))
  ])
})

export const ChatParamsSchema = z.object({
  /** 按槽位路由解析 provider+model（director 为默认槽）；显式 provider/model 优先 */
  slot: ModelSlotSchema.optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  system: z.string().optional(),
  messages: z.array(ChatMessageSchema),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  tools: z.custom<ToolDef[]>((v) => Array.isArray(v)).optional(),
  /** 结构化输出（GLM/DeepSeek/OpenAI 兼容端点通用） */
  responseFormat: z.enum(['text', 'json_object']).optional(),
  /** 测试直连：跳过路由，直接用 provider+model+apiKey（API Key 明文仅本参数一次，不落库） */
  apiKeyOverride: z.string().optional()
})
export type ChatParams = z.output<typeof ChatParamsSchema>

const ProviderProfileSchema = z.object({
  baseUrl: z.string(),
  defaultModel: z.string(),
  customModels: z.string()
})

export const SettingsPatchSchema = z.object({
  provider: ProviderIdSchema.optional(),
  profiles: z.partialRecord(ProviderIdSchema, ProviderProfileSchema.partial()).optional(),
  /** 明文 API Key 只写不读（保存后回读掩码）；空串清除 */
  apiKeys: z.partialRecord(ProviderIdSchema, z.string()).optional(),
  routing: z
    .partialRecord(ModelSlotSchema, z.object({ provider: ProviderIdSchema, model: z.string() }))
    .optional()
})
export type SettingsPatch = z.output<typeof SettingsPatchSchema>

export const ModelProbeOptionsSchema = z.object({
  provider: ProviderIdSchema.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional()
})
export type ModelProbeOptions = z.output<typeof ModelProbeOptionsSchema>

// ── 领域输入 schema（M2） ─────────────────────────────────────────────────────

export const BookCreateSchema = z.object({
  title: z.string().min(1),
  genre: z.string().optional(),
  targetWords: z.number().int().positive().optional()
})
export type BookCreate = z.output<typeof BookCreateSchema>

export const BookPatchSchema = z.object({
  title: z.string().optional(),
  intro: z.string().optional(),
  genre: z.string().optional(),
  styleName: z.string().optional(),
  styleSample: z.string().optional(),
  styleNotes: z.string().optional(),
  targetWords: z.number().int().positive().optional(),
  redlines: z.array(z.string()).optional(),
  positiveWords: z.array(z.string()).optional(),
  negativeWords: z.array(z.string()).optional(),
  archived: z.boolean().optional()
})

export const CardKindSchema = z.enum(['geography', 'faction', 'history', 'power', 'item', 'custom'])

export const CardInputSchema = z.object({
  id: z.string().optional(),
  lineId: z.string(),
  kind: CardKindSchema.optional(),
  title: z.string().min(1),
  readerText: z.string().optional(),
  authorText: z.string().optional(),
  revealPlan: z.string().optional(),
  /** 结构化数据（对象数组渲染成表格，供 AI 表格化 CRUD） */
  data: z.record(z.string(), z.unknown()).optional(),
  pinned: z.boolean().optional(),
  tags: z.array(z.string()).optional()
})

export const CharacterInputSchema = z.object({
  id: z.string().optional(),
  lineId: z.string(),
  name: z.string().min(1),
  role: z.string().optional(),
  card: z.record(z.string(), z.unknown()).optional(),
  /** 七要素沿用字符串；额外键放任意 JSON（嵌套对象/表格，设定页递归渲染） */
  state: z
    .looseObject({
      location: z.string().optional(),
      body: z.string().optional(),
      mood: z.string().optional(),
      items: z.string().optional(),
      knows: z.string().optional(),
      goal: z.string().optional()
    })
    .optional(),
  relations: z.array(z.object({ to: z.string(), label: z.string() })).optional(),
  pinned: z.boolean().optional(),
  tags: z.array(z.string()).optional()
})

export const ForeshadowInputSchema = z.object({
  id: z.string().optional(),
  lineId: z.string(),
  title: z.string().min(1),
  detail: z.string().optional(),
  plantedChapterId: z.string().optional(),
  plannedChapterId: z.string().optional(),
  resolvedChapterId: z.string().optional(),
  status: z.enum(['open', 'planned', 'resolved']).optional(),
  priority: z.number().int().optional()
})

export const DirectionChoiceSchema = z.object({
  source: z.enum(['card', 'free']),
  cardIndex: z.number().int().optional(),
  text: z.string().min(1)
})

export const SampleImportSchema = z.object({
  fileName: z.string().min(1),
  name: z.string().min(1).optional()
})

// ── invoke 契约 ──────────────────────────────────────────────────────────────

const ret = <T>(): T => null as unknown as T

export const invokeContract = {
  'app:info': {
    args: z.tuple([]),
    ret: ret<{ version: string; dataDir: string; uptimeS: number; platform: string }>()
  },
  'settings:get': { args: z.tuple([]), ret: ret<SettingsView>() },
  'settings:save': { args: z.tuple([SettingsPatchSchema]), ret: ret<SettingsView>() },
  'server:status': { args: z.tuple([]), ret: ret<ServerStatus>() },
  'models:probe': {
    args: z.tuple([ModelProbeOptionsSchema.optional()]),
    ret: ret<ModelProbeResult>()
  },
  /** 流式对话：返回 requestId，delta/done/error 经 SSE 推送，llm:poll 补拉 */
  'llm:chat': { args: z.tuple([ChatParamsSchema]), ret: ret<string>() },
  'llm:abort': { args: z.tuple([z.string()]), ret: ret<boolean>() },
  'llm:poll': {
    args: z.tuple([z.object({ requestIds: z.array(z.string()) })]),
    ret: ret<Record<string, RunRecordPayload>>()
  },
  'usage:list': { args: z.tuple([z.number().optional()]), ret: ret<UsageRecord[]>() },
  'usage:stats': { args: z.tuple([]), ret: ret<UsageStats>() },

  // ── 书架 / 分叉树（D1-D6） ────────────────────────────────────────────────
  'book:create': { args: z.tuple([BookCreateSchema]), ret: ret<Book>() },
  'book:list': { args: z.tuple([]), ret: ret<Book[]>() },
  'book:get': {
    args: z.tuple([z.string()]),
    ret: ret<{
      book: Book
      lines: StoryLine[]
      chapters: Array<
        Pick<Chapter, 'id' | 'lineId' | 'orderNo' | 'title' | 'wordCount' | 'updatedAt'>
      >
    }>()
  },
  'book:update': { args: z.tuple([z.string(), BookPatchSchema]), ret: ret<Book>() },
  'book:delete': { args: z.tuple([z.string(), z.boolean()]), ret: ret<boolean>() },
  'book:statusCard': { args: z.tuple([z.string()]), ret: ret<StatusCard | null>() },
  'line:fork': {
    args: z.tuple([z.string(), z.string(), z.string().optional(), z.string().optional()]),
    ret: ret<StoryLine>()
  },
  'line:activate': { args: z.tuple([z.string(), z.string()]), ret: ret<boolean>() },
  'line:delete': { args: z.tuple([z.string(), z.boolean()]), ret: ret<boolean>() },
  'chapter:get': { args: z.tuple([z.string()]), ret: ret<Chapter | null>() },
  'chapter:versions': { args: z.tuple([z.string()]), ret: ret<ChapterVersion[]>() },
  'card:list': {
    args: z.tuple([z.string(), CardKindSchema.optional(), z.string().optional()]),
    ret: ret<Card[]>()
  },
  'card:save': { args: z.tuple([CardInputSchema]), ret: ret<Card | null>() },
  'card:delete': { args: z.tuple([z.string()]), ret: ret<boolean>() },
  'character:list': { args: z.tuple([z.string(), z.string().optional()]), ret: ret<Character[]>() },
  'character:save': { args: z.tuple([CharacterInputSchema]), ret: ret<Character | null>() },
  'character:delete': { args: z.tuple([z.string()]), ret: ret<boolean>() },
  'foreshadow:list': {
    args: z.tuple([z.string(), z.enum(['open', 'planned', 'resolved']).optional()]),
    ret: ret<Foreshadow[]>()
  },
  'foreshadow:save': { args: z.tuple([ForeshadowInputSchema]), ret: ret<Foreshadow | null>() },
  'message:list': {
    args: z.tuple([z.string(), z.string().optional()]),
    ret: ret<ChatMessageRow[]>()
  },

  // ── 写作任务流水线（W10/W12） ─────────────────────────────────────────────
  'job:startWrite': { args: z.tuple([z.string()]), ret: ret<Job>() },
  'job:startRevise': {
    args: z.tuple([z.string(), z.string(), z.string().optional()]),
    ret: ret<Job>()
  },
  'job:startReview': { args: z.tuple([z.string()]), ret: ret<Job>() },
  'job:startAudit': { args: z.tuple([z.string()]), ret: ret<Job>() },
  'job:startDiagnose': { args: z.tuple([z.string(), z.string()]), ret: ret<Job>() },
  'job:startChat': { args: z.tuple([z.string(), z.string()]), ret: ret<Job>() },
  'job:chooseDirection': { args: z.tuple([z.string(), DirectionChoiceSchema]), ret: ret<Job>() },
  'job:retry': { args: z.tuple([z.string()]), ret: ret<Job>() },
  'job:cancel': { args: z.tuple([z.string()]), ret: ret<Job>() },
  'job:get': { args: z.tuple([z.string()]), ret: ret<Job | null>() },
  'job:list': { args: z.tuple([z.string().optional()]), ret: ret<Job[]>() },

  // ── 开书引导（B1-B4） ─────────────────────────────────────────────────────
  'onboard:start': {
    args: z.tuple([z.string()]),
    ret: ret<{ reply: string; options: string[]; stage: string; draft?: unknown; done?: boolean }>()
  },
  'onboard:answer': {
    args: z.tuple([z.string(), z.string()]),
    ret: ret<{ reply: string; options: string[]; stage: string; draft?: unknown; done?: boolean }>()
  },

  // ── 范文库（完整书入库，agent 节选翻阅） ────────────────────────────────────
  'sample:listDir': { args: z.tuple([]), ret: ret<SampleFileInfo[]>() },
  'sample:import': { args: z.tuple([SampleImportSchema]), ret: ret<SampleInfo>() },
  'sample:list': { args: z.tuple([]), ret: ret<SampleInfo[]>() },
  'sample:attach': {
    args: z.tuple([z.string(), z.array(z.string())]),
    ret: ret<Book>()
  },
  'sample:delete': { args: z.tuple([z.string()]), ret: ret<boolean>() },
  // 阅读层：目录/正文窗口/关键词命中
  'sample:sections': { args: z.tuple([z.string()]), ret: ret<SampleSectionView[]>() },
  'sample:readText': {
    args: z.tuple([z.string(), z.number(), z.number()]),
    ret: ret<SampleText>()
  },
  'sample:search': {
    args: z.tuple([z.string(), z.string()]),
    ret: ret<SampleSearchHit[]>()
  }
}

export type InvokeChannels = keyof typeof invokeContract & string
export type ArgsOf<C extends InvokeChannels> = z.output<(typeof invokeContract)[C]['args']>
export type RetOf<C extends InvokeChannels> = (typeof invokeContract)[C]['ret']

// ── 事件契约 ─────────────────────────────────────────────────────────────────

export interface DonePayload {
  text: string
  usage: { inputTokens: number; outputTokens: number }
  model: string
  stopReason: string | null
  durationMs: number
}

export interface RunRecordPayload {
  status: 'running' | 'done' | 'error' | 'aborted'
  requestId: string
  /** done */
  text?: string
  usage?: { inputTokens: number; outputTokens: number }
  model?: string
  stopReason?: string | null
  durationMs?: number
  /** error */
  error?: string
  hint?: LlmErrorHint | null
}

export interface EventContract {
  'llm:delta': [requestId: string, text: string]
  'llm:done': [requestId: string, payload: DonePayload]
  'llm:error': [requestId: string, message: string, hint?: LlmErrorHint]
  'llm:notice': [requestId: string, message: string]
  /** 任务状态变化（含 waiting_user 提醒、done/failed 终态） */
  'job:update': [jobId: string, job: Job]
  /** agent 工具卡实时推送（每次工具调用一条） */
  'job:activity': [jobId: string, act: { tool: string; summary: string; ok: boolean }]
  /** 生成进度（正文/改章字数——正文不进聊天流，聚合条只报进度） */
  'job:progress': [jobId: string, p: { phase: 'draft' | 'revise'; chars: number }]
  /** 导演白话流式增量（chat 气泡）；total=累计长度，失配即全量补拉 */
  'job:delta': [jobId: string, text: string, total: number]
  /** 聊天流新消息落库（agent 运行中实时推，前端精确追加不整页重拉） */
  'message:append': [msg: ChatMessageRow]
}

export const EVENT_CHANNELS = [
  'llm:delta',
  'llm:done',
  'llm:error',
  'llm:notice',
  'job:update',
  'job:activity',
  'job:progress',
  'job:delta',
  'message:append'
] as const satisfies readonly (keyof EventContract)[]

export type EventChannels = keyof EventContract & string

// ── Api 形状（APK 客户端） ──────────────────────────────────────────────────

export type InvokeFn<C extends InvokeChannels> = (...args: ArgsOf<C>) => Promise<RetOf<C>>

export type SubscribeFn<C extends EventChannels> = (
  cb: (...args: EventContract[C]) => void
) => () => void

export interface Api {
  app: {
    info: InvokeFn<'app:info'>
  }
  settings: {
    get: InvokeFn<'settings:get'>
    save: InvokeFn<'settings:save'>
  }
  server: {
    status: InvokeFn<'server:status'>
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
  usage: {
    list: InvokeFn<'usage:list'>
    stats: InvokeFn<'usage:stats'>
  }
  book: {
    create: InvokeFn<'book:create'>
    list: InvokeFn<'book:list'>
    get: InvokeFn<'book:get'>
    update: InvokeFn<'book:update'>
    delete: InvokeFn<'book:delete'>
    statusCard: InvokeFn<'book:statusCard'>
  }
  line: {
    fork: InvokeFn<'line:fork'>
    activate: InvokeFn<'line:activate'>
    delete: InvokeFn<'line:delete'>
  }
  chapter: {
    get: InvokeFn<'chapter:get'>
    versions: InvokeFn<'chapter:versions'>
  }
  card: {
    list: InvokeFn<'card:list'>
    save: InvokeFn<'card:save'>
    delete: InvokeFn<'card:delete'>
  }
  character: {
    list: InvokeFn<'character:list'>
    save: InvokeFn<'character:save'>
    delete: InvokeFn<'character:delete'>
  }
  foreshadow: {
    list: InvokeFn<'foreshadow:list'>
    save: InvokeFn<'foreshadow:save'>
  }
  message: {
    list: InvokeFn<'message:list'>
    onAppend: SubscribeFn<'message:append'>
  }
  job: {
    startWrite: InvokeFn<'job:startWrite'>
    startRevise: InvokeFn<'job:startRevise'>
    startReview: InvokeFn<'job:startReview'>
    startAudit: InvokeFn<'job:startAudit'>
    startDiagnose: InvokeFn<'job:startDiagnose'>
    startChat: InvokeFn<'job:startChat'>
    chooseDirection: InvokeFn<'job:chooseDirection'>
    retry: InvokeFn<'job:retry'>
    cancel: InvokeFn<'job:cancel'>
    get: InvokeFn<'job:get'>
    list: InvokeFn<'job:list'>
    onUpdate: SubscribeFn<'job:update'>
    onActivity: SubscribeFn<'job:activity'>
    onProgress: SubscribeFn<'job:progress'>
    onDelta: SubscribeFn<'job:delta'>
  }
  onboard: {
    start: InvokeFn<'onboard:start'>
    answer: InvokeFn<'onboard:answer'>
  }
  sample: {
    listDir: InvokeFn<'sample:listDir'>
    import: InvokeFn<'sample:import'>
    list: InvokeFn<'sample:list'>
    /** 整组设置某书的绑定范文（传空数组=全部解绑），旧 sample:detach 已并入 */
    attach: InvokeFn<'sample:attach'>
    delete: InvokeFn<'sample:delete'>
    /** 阅读层目录（自动懒解析结构节） */
    sections: InvokeFn<'sample:sections'>
    /** 按全文偏移取正文窗口 */
    readText: InvokeFn<'sample:readText'>
    /** 关键词全文命中（标签优先，正文位置次之） */
    search: InvokeFn<'sample:search'>
  }
}

// 覆盖率断言：Api 里声明的每个 invoke 方法都必须对应契约中的通道，缺一个编译报错
type MethodChannels<N> = N extends keyof Api
  ? { [M in keyof Api[N]]: Api[N][M] extends InvokeFn<infer C> ? C : never }[keyof Api[N]]
  : never
type DeclaredChannels = MethodChannels<keyof Api>
type _MissingChannels = Exclude<InvokeChannels, DeclaredChannels>
type _CoverageOk = [_MissingChannels] extends [never] ? true : never
const _coverageCheck: _CoverageOk = true
void _coverageCheck

// ── 客户端统一构造器（APK 的 HTTP transport 用） ────────────────────────────

export interface ApiTransport {
  invoke: (channel: string, args: unknown[]) => unknown
  subscribe: (channel: string, cb: (...args: never[]) => void) => () => void
}

function eventMethodName(event: string): string {
  return `on${event[0]?.toUpperCase()}${event.slice(1)}`
}

export function buildApi(transport: ApiTransport): Api {
  const root: Record<string, Record<string, unknown>> = {}
  const put = (channel: string, fn: unknown): void => {
    const idx = channel.indexOf(':')
    const ns = channel.slice(0, idx)
    if (!root[ns]) root[ns] = {}
    root[ns]![channel.slice(idx + 1)] = fn
  }
  for (const channel of Object.keys(invokeContract)) {
    put(channel, (...args: unknown[]) => transport.invoke(channel, args))
  }
  for (const channel of EVENT_CHANNELS) {
    const idx = channel.indexOf(':')
    const ns = channel.slice(0, idx)
    if (!root[ns]) root[ns] = {}
    root[ns]![eventMethodName(channel.slice(idx + 1))] = (cb: (...args: never[]) => void) =>
      transport.subscribe(channel, cb)
  }
  return root as unknown as Api
}
