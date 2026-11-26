import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SettingsPatch } from '../shared/contract.js'
import {
  isModelSlot,
  isProviderId,
  type ModelSlot,
  PROVIDER_IDS,
  type ProviderId,
  providerPreset
} from '../shared/providers.js'
import type { ModelRouting, ProviderProfile, SettingsView } from '../shared/types.js'
import { dataDir, ensureDataDir } from './paths.js'

/**
 * 配置存储（settings.json）：服务器端口、模型 provider/profile、
 * API Key（明文存数据目录——单用户 PC 场景，目录继承用户 Profile ACL；无 Electron safeStorage）。
 * v2 无鉴权：Tailscale 网络本身即信任边界（2026-11 用户决策），无密码/token。
 * 更新语义：可选字段未传保留原值，显式空串清除。
 */

export interface ServerConfig {
  port: number
}

interface StoredConfig {
  server: ServerConfig
  provider: ProviderId
  profiles: Partial<Record<ProviderId, ProviderProfile>>
  apiKeys: Partial<Record<ProviderId, string>>
  routing: ModelRouting
}

const DEFAULT_PORT = 3910

function file(): string {
  return join(dataDir(), 'settings.json')
}

function defaults(): StoredConfig {
  return {
    server: { port: DEFAULT_PORT },
    provider: 'deepseek',
    profiles: {},
    apiKeys: {},
    routing: {}
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 只留「键是现有 provider、值形状合格」的条目并返回被剔除的键；raw 不是对象时视为空段 */
function pickProviders(
  raw: unknown,
  okValue: (v: unknown) => boolean
): { kept: Record<string, unknown>; dropped: string[] } {
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  if (isPlainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (isProviderId(key) && okValue(value)) kept[key] = value
      else dropped.push(key)
    }
  }
  return { kept, dropped }
}

/**
 * 清洗已移除 provider 的残留：provider 不在可选范围则回落到默认；profiles / apiKeys 里不属于现有
 * provider 的键剔除；routing 里指向不存在 provider 的槽删除。只在内存里清洗——不改名、不落盘，
 * 下次保存设置时才自然写回。routing 槽不清的话 resolveAuth 会拿它去取预设，直接 TypeError。
 */
function sanitize(raw: unknown, fallback: ProviderId): Omit<StoredConfig, 'server'> {
  const r = isPlainObject(raw) ? raw : {}
  const notes: string[] = []

  const provider = isProviderId(r.provider) ? r.provider : fallback
  if (typeof r.provider === 'string' && !isProviderId(r.provider)) {
    notes.push(`当前服务「${r.provider}」不在可选范围，改为「${provider}」`)
  }

  const profiles = pickProviders(r.profiles, isPlainObject)
  const apiKeys = pickProviders(r.apiKeys, (v) => typeof v === 'string')
  const stale = [
    ...(profiles.dropped.length ? [`profiles 的 ${profiles.dropped.join('、')} 段`] : []),
    ...(apiKeys.dropped.length ? [`apiKeys 的 ${apiKeys.dropped.join('、')} 段`] : [])
  ]
  if (stale.length) notes.push(`已忽略 ${stale.join('、')}`)

  const routing: ModelRouting = {}
  if (isPlainObject(r.routing)) {
    for (const [slot, value] of Object.entries(r.routing)) {
      if (!isModelSlot(slot) || !isPlainObject(value)) continue
      const target = value.provider
      if (!isProviderId(target)) {
        const name = typeof target === 'string' ? target : '（未填写）'
        notes.push(`模型槽「${slot}」指向的「${name}」不在可选范围，已清除这一条，该槽改用默认模型`)
        continue
      }
      routing[slot] = {
        provider: target,
        model: typeof value.model === 'string' ? value.model : ''
      }
    }
  }

  if (notes.length) {
    console.warn(
      `[config] settings.json 含已移除模型服务的残留，已在内存中清洗（不改名、不落盘，下次保存设置时才写回）：${notes.join('；')}`
    )
  }
  return {
    provider,
    profiles: profiles.kept as Partial<Record<ProviderId, ProviderProfile>>,
    apiKeys: apiKeys.kept as Partial<Record<ProviderId, string>>,
    routing
  }
}

function load(): StoredConfig {
  const f = file()
  if (!existsSync(f)) return defaults()
  let raw: Partial<StoredConfig>
  try {
    raw = JSON.parse(readFileSync(f, 'utf-8')) as Partial<StoredConfig>
  } catch {
    // 文件损坏：改名保留（里面有作者的 API Key，不能让下次保存拿默认值把它覆盖掉）
    const now = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    const kept = `${f}.corrupt-${stamp}`
    try {
      renameSync(f, kept)
      console.error(
        `[config] settings.json 无法解析，已改名保留为 ${basename(kept)}；本次使用默认设置`
      )
    } catch {
      console.error(
        '[config] settings.json 无法解析，且改名失败；本次使用默认设置（不要保存设置，否则原文件会被覆盖）'
      )
    }
    return defaults()
  }
  try {
    const d = defaults()
    const rawPort = raw.server?.port
    const port =
      typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0
        ? rawPort
        : d.server.port
    return { server: { port }, ...sanitize(raw, d.provider) }
  } catch {
    return defaults()
  }
}

let current: StoredConfig | null = null

function config(): StoredConfig {
  if (!current) current = load()
  return current
}

/** 原子写：先写临时文件再改名覆盖，写到一半断电/崩溃不会留下半个 settings.json */
function persist(): void {
  ensureDataDir()
  const target = file()
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(config(), null, 2), 'utf-8')
  renameSync(tmp, target)
}

// ── 服务器配置 ───────────────────────────────────────────────────────────────

export function loadServerConfig(): ServerConfig {
  return { ...config().server }
}

export function getPort(): number {
  return config().server.port
}

export function setPort(port: number): void {
  config().server.port = port
  persist()
}

// ── 模型配置 ─────────────────────────────────────────────────────────────────

export function defaultProfile(id: ProviderId): ProviderProfile {
  const preset = providerPreset(id)
  return { baseUrl: preset.baseUrl, defaultModel: preset.defaultModel, customModels: '' }
}

export function profile(id: ProviderId): ProviderProfile {
  const c = config()
  return { ...defaultProfile(id), ...c.profiles[id] }
}

export function apiKey(id: ProviderId): string {
  return config().apiKeys[id] ?? ''
}

export function maskKey(key: string): string | null {
  if (!key) return null
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}***${key.slice(-4)}`
}

export interface LlmAuth {
  provider: ProviderId
  apiKey: string
  baseUrl: string
  model: string
  /** 生效的上下文窗口（tokens）：provider 预设；缺省 undefined（调用方回退保守默认） */
  contextWindow?: number
  maxOutputTokens?: number
}

/** 按槽位解析鉴权与模型：routing[slot] → 未配置回退 director 槽 → 当前 provider 默认模型 */
export function resolveAuth(slot: ModelSlot = 'director'): LlmAuth {
  const c = config()
  const route = c.routing[slot] ?? c.routing.director
  const provider = route?.provider ?? c.provider
  const p = profile(provider)
  const model = route?.model || p.defaultModel || providerPreset(provider).defaultModel
  const preset = providerPreset(provider)
  return {
    provider,
    apiKey: apiKey(provider),
    baseUrl: p.baseUrl || preset.baseUrl,
    model,
    contextWindow: preset.contextWindow,
    maxOutputTokens: preset.maxOutputTokens
  }
}

export function saveSettings(patch: SettingsPatch): SettingsView {
  const c = config()
  if (patch.provider) c.provider = patch.provider
  if (patch.profiles) {
    for (const id of Object.keys(patch.profiles) as ProviderId[]) {
      const incoming = patch.profiles[id]
      if (!incoming) continue
      const base = { ...defaultProfile(id), ...c.profiles[id] }
      // 更新语义：undefined 保留，显式空串清除
      c.profiles[id] = {
        baseUrl: incoming.baseUrl !== undefined ? incoming.baseUrl : base.baseUrl,
        defaultModel:
          incoming.defaultModel !== undefined ? incoming.defaultModel : base.defaultModel,
        customModels:
          incoming.customModels !== undefined ? incoming.customModels : base.customModels
      }
    }
  }
  if (patch.apiKeys) {
    for (const id of Object.keys(patch.apiKeys) as ProviderId[]) {
      const v = patch.apiKeys[id]
      if (v === undefined) continue
      if (v === '') delete c.apiKeys[id]
      else c.apiKeys[id] = v
    }
  }
  if (patch.routing) {
    const routing: ModelRouting = { ...c.routing }
    for (const slot of Object.keys(patch.routing) as ModelSlot[]) {
      const r = patch.routing[slot]
      if (!r) continue
      if (!r.model) delete routing[slot]
      else routing[slot] = r
    }
    c.routing = routing
  }
  persist()
  return viewSettings()
}

export function viewSettings(): SettingsView {
  const c = config()
  const currentProvider = c.provider
  return {
    provider: currentProvider,
    profiles: Object.fromEntries(PROVIDER_IDS.map((id) => [id, profile(id)])) as Record<
      ProviderId,
      ProviderProfile
    >,
    configuredProviders: PROVIDER_IDS.filter((id) => {
      const p = profile(id)
      return !!apiKey(id) || (!providerPreset(id).needsKey && (!!p.baseUrl || id !== 'custom'))
    }),
    apiKeyMasked: maskKey(apiKey(currentProvider)),
    routing: c.routing
  }
}

export function initConfig(): void {
  ensureDataDir()
  if (!existsSync(file())) persist()
  current = null
}
