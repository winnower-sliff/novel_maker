import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { ModelRouting, ProviderProfile, SettingsPatch, SettingsView } from '../shared/types'
import { PROVIDER_IDS, isProviderId, providerPreset, type ProviderId } from '../shared/providers'

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

function readStored(): StoredSettings {
  const file = settingsFile()
  if (!existsSync(file)) {
    return {
      provider: 'glm',
      profiles: {},
      apiKeys: {},
      quota5hPrompts: 0,
      currentProjectId: ''
    }
  }
  let raw: (Partial<StoredSettings> & LegacySettings) | null = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StoredSettings> & LegacySettings
  } catch {
    raw = null
  }
  if (!raw) {
    return {
      provider: 'glm',
      profiles: {},
      apiKeys: {},
      quota5hPrompts: 0,
      currentProjectId: ''
    }
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
    currentProjectId: raw.currentProjectId ?? ''
  }
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
  return {
    provider: stored.provider,
    apiKey: stored.provider === 'ollama' ? key || 'ollama' : key,
    baseUrl: profile.baseUrl.trim() || preset.baseUrl,
    needsKey: preset.needsKey,
    supportsCache: preset.supportsCache,
    promptCache: preset.supportsCache && profile.promptCache
  }
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
        promptCache: patch.promptCache !== undefined ? patch.promptCache : prev.promptCache
      }
    },
    apiKeys: { ...stored.apiKeys },
    quota5hPrompts:
      patch.quota5hPrompts !== undefined
        ? Math.max(0, Math.floor(patch.quota5hPrompts) || 0)
        : stored.quota5hPrompts,
    currentProjectId: patch.currentProjectId ?? stored.currentProjectId
  }
  if (patch.apiKey !== undefined) {
    const trimmed = patch.apiKey.trim()
    if (trimmed) next.apiKeys[provider] = encodeKey(trimmed)
    else delete next.apiKeys[provider]
  }
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf-8')
  return loadSettingsView()
}
