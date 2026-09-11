import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ChatParams, ModelProbeResult, SettingsPatch, SettingsView, UsageRecord } from '../shared/types'
import { chatStream, LlmError, pickRatelimitHeaders, probeModels } from './llm'
import { getApiKey, getBaseUrl, loadSettingsView, saveSettings } from './settings'
import { appendUsage, listUsage } from './usage'

const activeRequests = new Map<string, AbortController>()

export function registerIpc(): void {
  ipcMain.handle('settings:get', (): Promise<SettingsView> => loadSettingsView())

  ipcMain.handle('settings:save', (_e, patch: SettingsPatch): Promise<SettingsView> =>
    saveSettings(patch)
  )

  ipcMain.handle('models:probe', async (_e, apiKeyOverride?: string): Promise<ModelProbeResult> => {
    const apiKey = apiKeyOverride?.trim() || (await getApiKey())
    if (!apiKey) throw new Error('未配置 API Key')
    return probeModels({ apiKey, baseUrl: await getBaseUrl() })
  })

  ipcMain.handle('llm:chat', async (e: IpcMainInvokeEvent, params: ChatParams): Promise<string> => {
    const apiKey = await getApiKey()
    if (!apiKey) throw new Error('未配置 API Key，请先在设置中填写')
    const baseUrl = await getBaseUrl()

    const requestId = randomUUID()
    const controller = new AbortController()
    activeRequests.set(requestId, controller)
    const win = e.sender

    chatStream(
      params,
      { apiKey, baseUrl },
      (text) => {
        if (!win.isDestroyed()) win.send('llm:delta', requestId, text)
      },
      controller.signal
    )
      .then((result) => {
        const record: UsageRecord = {
          ts: Date.now(),
          model: result.model,
          purpose: params.purpose ?? 'playground',
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
          durationMs: result.durationMs,
          ratelimit: pickRatelimitHeaders(result.headers)
        }
        appendUsage(record)
        if (!win.isDestroyed()) {
          win.send('llm:done', requestId, {
            usage: result.usage,
            model: result.model,
            stopReason: result.stopReason,
            durationMs: result.durationMs,
            headers: result.headers
          })
        }
      })
      .catch((err: unknown) => {
        if (!win.isDestroyed()) {
          const message =
            err instanceof LlmError
              ? `[${err.status ?? '网络'}] ${err.message}`
              : ((err as Error)?.message ?? String(err))
          win.send('llm:error', requestId, message)
        }
      })
      .finally(() => {
        activeRequests.delete(requestId)
      })

    return requestId
  })

  ipcMain.handle('llm:abort', (_e, requestId: string): void => {
    activeRequests.get(requestId)?.abort()
  })

  ipcMain.handle('usage:list', (_e, limit?: number): UsageRecord[] => listUsage(limit ?? 200))
}
