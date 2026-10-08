import { effectiveProtocol, providerPreset } from '../../shared/providers'
import { probeModels } from '../llm'
import { getServerStatus } from '../serverState'
import { getApiKeyFor, loadSettingsView, saveSettings } from '../settings'
import type { PartialHandlerTable } from './context'

export const settingsHandlers = {
  'settings:get': () => loadSettingsView(),
  'settings:save': (_ctx, [patch]) => saveSettings(patch),

  'server:status': () => getServerStatus(),

  'models:probe': async (_ctx, [opts]) => {
    const view = await loadSettingsView()
    const provider = opts?.provider ?? view.provider
    const providerView = view.profiles[provider]
    const apiKey = opts?.apiKey?.trim() || (await getApiKeyFor(provider))
    const baseUrl = opts?.baseUrl?.trim() || providerView.baseUrl
    if (!apiKey && providerPreset(provider).needsKey) throw new Error('未配置 API Key')
    const protocol = opts?.protocol ?? effectiveProtocol(provider, providerView.protocol)
    return probeModels({ provider, apiKey, baseUrl, protocol })
  }
} satisfies PartialHandlerTable
