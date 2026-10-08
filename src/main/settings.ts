import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import {
  effectiveProtocol,
  isProviderId,
  PROVIDER_IDS,
  type Protocol,
  type ProviderId,
  providerPreset
} from '../shared/providers'
import type {
  ModelRouting,
  ProviderProfile,
  Purpose,
  PurposeRoute,
  ServerConfig,
  SettingsPatch,
  SettingsView
} from '../shared/types'
import { clearSessions } from './serverSessions'

interface KeyPair {
  apiKeyEnc?: string
  apiKeyPlain?: string
}

interface StoredSettings {
  provider: ProviderId
  profiles: Partial<Record<ProviderId, ProviderProfile>>
  apiKeys: Partial<Record<ProviderId, KeyPair>>
  quota5hPrompts: number
  currentProjectId: string
  server: ServerConfig
}

interface LegacySettings {
  apiKeyEnc?: string
  apiKeyPlain?: string
  baseUrl?: string
  defaultModel?: string
  customModels?: string
  modelRouting?: ModelRouting
  promptCache?: boolean
  quota5hPrompts?: number
  currentProjectId?: string
}

export interface LlmAuth {
  provider: ProviderId
  apiKey: string
  baseUrl: string
  needsKey: boolean
  supportsCache: boolean
  promptCache: boolean
  /** 生效的上下文窗口（tokens）：profile 覆盖 > provider 预设；均缺省为 undefined（调用方回退保守默认） */
  contextWindow?: number
  /** 生效端点协议：custom 看 profile 覆盖，其余用预设 */
  protocol: Protocol
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function defaultProfile(id: ProviderId): ProviderProfile {
  const preset = providerPreset(id)
  return {
    baseUrl: preset.baseUrl,
    defaultModel: preset.defaultModel,
    customModels: '',
    modelRouting: {},
    promptCache: preset.supportsCache
  }
}

function uniqProviders(ids: ProviderId[]): ProviderId[] {
  return [...new Set(ids)]
}

const DEFAULT_SERVER_PORT = 3910

export function defaultServerConfig(): ServerConfig {
  return { enabled: true, port: DEFAULT_SERVER_PORT, passwordHash: '', passwordSalt: '' }
}

function normalizeServer(raw?: Partial<ServerConfig>): ServerConfig {
  const d = defaultServerConfig()
  const port = Number(raw?.port)
  return {
    enabled: raw?.enabled !== undefined ? !!raw.enabled : d.enabled,
    port: Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.floor(port) : d.port,
    passwordHash: typeof raw?.passwordHash === 'string' ? raw.passwordHash : '',
    passwordSalt: typeof raw?.passwordSalt === 'string' ? raw.passwordSalt : ''
  }
}

function emptyStored(): StoredSettings {
  return {
    provider: 'glm',
    profiles: {},
    apiKeys: {},
    quota5hPrompts: 0,
    currentProjectId: '',
    server: defaultServerConfig()
  }
}

function readStored(): StoredSettings {
  const file = settingsFile()
  if (!existsSync(file)) {
    return emptyStored()
  }
  let raw: (Partial<StoredSettings> & LegacySettings) | null = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StoredSettings> & LegacySettings
  } catch {
    raw = null
  }
  if (!raw) {
    return emptyStored()
  }

  const provider = isProviderId(raw.provider) ? raw.provider : 'glm'
  const profiles: Partial<Record<ProviderId, ProviderProfile>> = { ...(raw.profiles ?? {}) }

  if (!raw.profiles) {
    const glm = defaultProfile('glm')
    profiles.glm = {
      baseUrl: raw.baseUrl?.trim() || glm.baseUrl,
      defaultModel: raw.defaultModel?.trim() || glm.defaultModel,
      customModels: raw.customModels ?? '',
      modelRouting: raw.modelRouting ?? {},
      promptCache: raw.promptCache ?? glm.promptCache
    }
  }

  const apiKeys: Partial<Record<ProviderId, KeyPair>> = { ...(raw.apiKeys ?? {}) }
  if (!raw.apiKeys && (raw.apiKeyEnc || raw.apiKeyPlain)) {
    apiKeys.glm = { apiKeyEnc: raw.apiKeyEnc, apiKeyPlain: raw.apiKeyPlain }
  }

  return {
    provider,
    profiles,
    apiKeys,
    quota5hPrompts: Math.max(0, Math.floor(raw.quota5hPrompts ?? 0) || 0),
    currentProjectId: raw.currentProjectId ?? '',
    server: normalizeServer(raw.server)
  }
}

function writeStored(stored: StoredSettings): void {
  writeFileSync(settingsFile(), JSON.stringify(stored, null, 2), 'utf-8')
}

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return { salt, hash }
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  if (!salt || !hash) return false
  const calculated = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return calculated.length === expected.length && timingSafeEqual(calculated, expected)
}

export function loadServerConfig(): ServerConfig {
  return readStored().server
}

export function saveServerConfig(patch: {
  enabled?: boolean
  port?: number
  password?: string | null
}): ServerConfig {
  const stored = readStored()
  const server: ServerConfig = { ...stored.server }
  if (patch.enabled !== undefined) server.enabled = !!patch.enabled
  if (patch.port !== undefined && Number.isFinite(patch.port)) {
    server.port = Math.min(65535, Math.max(1, Math.floor(patch.port)))
  }
  if (patch.password !== undefined) {
    // 密码变更（含清除）→ 旧 token 全作废，各端需重新登录
    clearSessions()
    if (patch.password) {
      const { salt, hash } = hashPassword(patch.password)
      server.passwordSalt = salt
      server.passwordHash = hash
    } else {
      server.passwordSalt = ''
      server.passwordHash = ''
    }
  }
  writeStored({ ...stored, server })
  return server
}

function decodeKey(pair?: KeyPair): string {
  if (pair?.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(pair.apiKeyEnc, 'base64'))
    } catch {
      return ''
    }
  }
  return pair?.apiKeyPlain ?? ''
}

function encodeKey(key: string): KeyPair {
  if (!key) return {}
  if (safeStorage.isEncryptionAvailable()) {
    return { apiKeyEnc: safeStorage.encryptString(key).toString('base64'), apiKeyPlain: undefined }
  }
  return { apiKeyPlain: key, apiKeyEnc: undefined }
}

function mask(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

function profileFor(stored: StoredSettings, id: ProviderId): ProviderProfile {
  return stored.profiles[id] ?? defaultProfile(id)
}

export async function getApiKeyFor(id: ProviderId): Promise<string> {
  return decodeKey(readStored().apiKeys[id])
}

export async function getLlmAuth(): Promise<LlmAuth> {
  const stored = readStored()
  const preset = providerPreset(stored.provider)
  const profile = profileFor(stored, stored.provider)
  const key = decodeKey(stored.apiKeys[stored.provider])
  const protocol = effectiveProtocol(stored.provider, profile.protocol)
  return {
    provider: stored.provider,
    apiKey: stored.provider === 'ollama' ? key || 'ollama' : key,
    baseUrl: profile.baseUrl.trim() || preset.baseUrl,
    needsKey: preset.needsKey,
    supportsCache: preset.supportsCache,
    promptCache: preset.supportsCache && profile.promptCache && protocol !== 'openai',
    contextWindow: profile.contextWindow ?? preset.contextWindow,
    protocol
  }
}

/** 旧版路由值是纯模型名字符串，新版是 {provider?, model}；统一归一化 */
function normalizeRoute(value: string | PurposeRoute | undefined): PurposeRoute | null {
  if (!value) return null
  if (typeof value === 'string') {
    const model = value.trim()
    return model ? { model } : null
  }
  const model = value.model?.trim()
  if (!model) return null
  const provider = value.provider && isProviderId(value.provider) ? value.provider : undefined
  return { model, provider }
}

export interface RequestAuth extends LlmAuth {
  model: string
  fallbackReason: string
}

/**
 * 按用途解析鉴权与模型（跨 provider 路由）：
 * - 当前 provider 的 modelRouting[purpose] 可指定 {provider, model}，让记账类任务走本地 ollama 等免费通道
 * - 路由指向的 provider 未配置 Key（且需要 Key）时回退当前 provider 默认模型，并给出 fallbackReason
 */
export async function resolveRequestAuth(purpose?: Purpose): Promise<RequestAuth> {
  const stored = readStored()
  const base = await getLlmAuth()
  const profile = profileFor(stored, stored.provider)
  let model = profile.defaultModel.trim()
  let fallbackReason = ''
  const route = purpose ? normalizeRoute(profile.modelRouting[purpose]) : null
  if (route) {
    if (route.provider && route.provider !== stored.provider) {
      const targetPreset = providerPreset(route.provider)
      const targetProfile = profileFor(stored, route.provider)
      const targetKey = decodeKey(stored.apiKeys[route.provider])
      if (!targetKey && targetPreset.needsKey) {
        fallbackReason = `任务 ${purpose} 路由到 ${route.provider} 但未配置 API Key，已回退当前 provider`
      } else {
        const targetProtocol = effectiveProtocol(route.provider, targetProfile.protocol)
        return {
          provider: route.provider,
          apiKey: route.provider === 'ollama' ? targetKey || 'ollama' : targetKey,
          baseUrl: targetProfile.baseUrl.trim() || targetPreset.baseUrl,
          needsKey: targetPreset.needsKey,
          supportsCache: targetPreset.supportsCache,
          promptCache:
            targetPreset.supportsCache && targetProfile.promptCache && targetProtocol !== 'openai',
          contextWindow: targetProfile.contextWindow ?? targetPreset.contextWindow,
          protocol: targetProtocol,
          model: route.model,
          fallbackReason: ''
        }
      }
    } else {
      model = route.model
    }
  }
  return { ...base, model, fallbackReason }
}

export async function loadSettingsView(): Promise<SettingsView> {
  const stored = readStored()
  const provider = stored.provider
  const profile = profileFor(stored, provider)
  const key = decodeKey(stored.apiKeys[provider])
  const profiles = Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, profileFor(stored, id)])
  ) as Record<ProviderId, ProviderProfile>
  return {
    provider,
    profiles,
    configuredProviders: uniqProviders(
      PROVIDER_IDS.filter((id) => !!decodeKey(stored.apiKeys[id]))
    ),
    hasApiKey: !!key,
    apiKeyMasked: mask(key),
    baseUrl: profile.baseUrl,
    defaultModel: profile.defaultModel,
    customModels: profile.customModels,
    modelRouting: profile.modelRouting,
    quota5hPrompts: stored.quota5hPrompts,
    promptCache: providerPreset(provider).supportsCache && profile.promptCache,
    currentProjectId: stored.currentProjectId
  }
}

export async function saveSettings(patch: SettingsPatch): Promise<SettingsView> {
  const stored = readStored()
  const provider = isProviderId(patch.provider) ? patch.provider : stored.provider
  const prev = profileFor(stored, provider)
  const next: StoredSettings = {
    provider,
    profiles: {
      ...stored.profiles,
      [provider]: {
        baseUrl: patch.baseUrl?.trim() || prev.baseUrl,
        defaultModel: patch.defaultModel?.trim() || prev.defaultModel,
        customModels: patch.customModels ?? prev.customModels,
        modelRouting: patch.modelRouting ?? prev.modelRouting,
        promptCache: patch.promptCache !== undefined ? patch.promptCache : prev.promptCache,
        // 仅 custom 存协议覆盖；非 custom 一律清除，固定走预设
        protocol: provider === 'custom' ? (patch.protocol ?? prev.protocol) : undefined,
        contextWindow:
          patch.contextWindow !== undefined
            ? patch.contextWindow > 0
              ? Math.floor(patch.contextWindow)
              : undefined
            : prev.contextWindow
      }
    },
    apiKeys: { ...stored.apiKeys },
    quota5hPrompts:
      patch.quota5hPrompts !== undefined
        ? Math.max(0, Math.floor(patch.quota5hPrompts) || 0)
        : stored.quota5hPrompts,
    currentProjectId: patch.currentProjectId ?? stored.currentProjectId,
    server: stored.server
  }
  if (patch.apiKey !== undefined) {
    const trimmed = patch.apiKey.trim()
    if (trimmed) next.apiKeys[provider] = encodeKey(trimmed)
    else delete next.apiKeys[provider]
  }
  writeStored(next)
  return loadSettingsView()
}
