import { z } from 'zod'
import { MODEL_SLOTS, PROVIDER_IDS } from './providers.js'
import type {
  ChatMessage,
  ContentBlock,
  LlmErrorHint,
  ModelProbeResult,
  ServerStatus,
  SettingsView,
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
  profiles: z.record(ProviderIdSchema, ProviderProfileSchema.partial()).optional(),
  /** 明文 API Key 只写不读（保存后回读掩码）；空串清除 */
  apiKeys: z.record(ProviderIdSchema, z.string()).optional(),
  routing: z
    .record(ModelSlotSchema, z.object({ provider: ProviderIdSchema, model: z.string() }))
    .optional()
})
export type SettingsPatch = z.output<typeof SettingsPatchSchema>

export const ModelProbeOptionsSchema = z.object({
  provider: ProviderIdSchema.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional()
})
export type ModelProbeOptions = z.output<typeof ModelProbeOptionsSchema>

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
  'usage:stats': { args: z.tuple([]), ret: ret<UsageStats>() }
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
}

export const EVENT_CHANNELS = [
  'llm:delta',
  'llm:done',
  'llm:error',
  'llm:notice'
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
  return `on${event[0]!.toUpperCase()}${event.slice(1)}`
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
