import { createRequire } from 'node:module'
import { providerPreset } from '../../shared/providers.js'
import { apiKey, profile, saveSettings, viewSettings } from '../config.js'
import { probeModels } from '../llm.js'
import { dataDir } from '../paths.js'
import { getServerStatus } from '../serverState.js'
import { computeStats, listUsage } from '../usage.js'
import { bookHandlers } from './books.js'
import { jobHandlers } from './jobs.js'
import { onboardHandlers } from './onboard.js'
import { sampleHandlers } from './samples.js'
import type { HandlerTable } from './types.js'

const require_ = createRequire(import.meta.url)
// src/main/handlers 与 dist/main/handlers 层级一致，../../../ 回项目根
const pkg = require_('../../../package.json') as { version: string }

const startedAt = Date.now()

// ── app / server ─────────────────────────────────────────────────────────────

const appHandlers: Pick<HandlerTable, 'app:info' | 'server:status'> = {
  'app:info': () => ({
    version: pkg.version,
    dataDir: dataDir(),
    uptimeS: Math.floor((Date.now() - startedAt) / 1000),
    platform: `${process.platform} node ${process.versions.node}`
  }),
  'server:status': () => getServerStatus()
}

// ── settings / models ────────────────────────────────────────────────────────

const settingsHandlers: Pick<HandlerTable, 'settings:get' | 'settings:save' | 'models:probe'> = {
  'settings:get': () => viewSettings(),
  'settings:save': (_ctx, [patch]) => saveSettings(patch),
  'models:probe': async (_ctx, [opts]) => {
    const provider = opts?.provider ?? viewSettings().provider
    const p = profile(provider)
    const key = opts?.apiKey || apiKey(provider)
    const baseUrl = opts?.baseUrl || p.baseUrl || providerPreset(provider).baseUrl
    return probeModels({ provider, apiKey: key, baseUrl })
  }
}

// ── usage ────────────────────────────────────────────────────────────────────

const usageHandlers: Pick<HandlerTable, 'usage:list' | 'usage:stats'> = {
  'usage:list': (_ctx, [limit]) => listUsage(limit),
  'usage:stats': () => computeStats()
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────

export const sharedHandlers: HandlerTable = {
  ...appHandlers,
  ...settingsHandlers,
  ...usageHandlers,
  ...bookHandlers,
  ...jobHandlers,
  ...onboardHandlers,
  ...sampleHandlers
}

export function appVersion(): string {
  return pkg.version
}
