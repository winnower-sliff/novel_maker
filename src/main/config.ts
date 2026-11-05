import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SettingsPatch } from '../shared/contract.js'
import {
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
    provider: 'glm',
    profiles: {},
    apiKeys: {},
    routing: {}
  }
}

function load(): StoredConfig {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf-8')) as Partial<StoredConfig>
    const d = defaults()
    const rawPort = raw.server?.port
    const port = typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0 ? rawPort : d.server.port
    return {
      server: { port },
      provider: isProviderId(raw.provider) ? raw.provider : d.provider,
      profiles: raw.profiles ?? {},
      apiKeys: raw.apiKeys ?? {},
      routing: raw.routing ?? {}
    }
  } catch {
    return defaults()
  }
}

let current: StoredConfig | null = null

function config(): StoredConfig {
  if (!current) current = load()
  return current
}

function persist(): void {
  ensureDataDir()
  writeFileSync(file(), JSON.stringify(config(), null, 2), 'utf-8')
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
