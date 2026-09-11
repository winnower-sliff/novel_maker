import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { ModelRouting, SettingsPatch, SettingsView } from '../shared/types'

interface StoredSettings {
  apiKeyEnc?: string
  apiKeyPlain?: string
  baseUrl: string
  defaultModel: string
  customModels: string
  modelRouting: ModelRouting
  quota5hPrompts: number
  promptCache: boolean
}

const DEFAULTS: StoredSettings = {
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  defaultModel: 'glm-4.6',
  customModels: '',
  modelRouting: {},
  quota5hPrompts: 0,
  promptCache: true
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function readStored(): StoredSettings {
  const file = settingsFile()
  if (!existsSync(file)) return { ...DEFAULTS }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StoredSettings>
    return {
      ...DEFAULTS,
      ...raw,
      modelRouting: raw.modelRouting ?? {},
      apiKeyEnc: raw.apiKeyEnc,
      apiKeyPlain: raw.apiKeyPlain
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function decodeKey(stored: StoredSettings): string {
  if (stored.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.apiKeyEnc, 'base64'))
    } catch {
      return ''
    }
  }
  return stored.apiKeyPlain ?? ''
}

function encodeKey(key: string): Pick<StoredSettings, 'apiKeyEnc' | 'apiKeyPlain'> {
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

export async function getApiKey(): Promise<string> {
  return decodeKey(readStored())
}

export async function getBaseUrl(): Promise<string> {
  return readStored().baseUrl
}

export async function getPromptCacheEnabled(): Promise<boolean> {
  return readStored().promptCache
}

export async function loadSettingsView(): Promise<SettingsView> {
  const stored = readStored()
  const key = decodeKey(stored)
  return {
    hasApiKey: !!key,
    apiKeyMasked: mask(key),
    baseUrl: stored.baseUrl,
    defaultModel: stored.defaultModel,
    customModels: stored.customModels,
    modelRouting: stored.modelRouting,
    quota5hPrompts: stored.quota5hPrompts,
    promptCache: stored.promptCache
  }
}

export async function saveSettings(patch: SettingsPatch): Promise<SettingsView> {
  const stored = readStored()
  const next: StoredSettings = {
    baseUrl: patch.baseUrl?.trim() || stored.baseUrl,
    defaultModel: patch.defaultModel?.trim() || stored.defaultModel,
    customModels: patch.customModels ?? stored.customModels,
    modelRouting: patch.modelRouting ?? stored.modelRouting,
    quota5hPrompts:
      patch.quota5hPrompts !== undefined
        ? Math.max(0, Math.floor(patch.quota5hPrompts) || 0)
        : stored.quota5hPrompts,
    promptCache: patch.promptCache !== undefined ? patch.promptCache : stored.promptCache
  }
  if (patch.apiKey !== undefined) {
    const encoded = encodeKey(patch.apiKey.trim())
    next.apiKeyEnc = encoded.apiKeyEnc
    next.apiKeyPlain = encoded.apiKeyPlain
  } else {
    next.apiKeyEnc = stored.apiKeyEnc
    next.apiKeyPlain = stored.apiKeyPlain
  }
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf-8')
  return loadSettingsView()
}
