import { contextBridge, ipcRenderer } from 'electron'
import type {
  ChatParams,
  ChatResult,
  ModelProbeResult,
  SettingsPatch,
  SettingsView,
  UsageRecord,
  UsageStats
} from '../shared/types'

export type DonePayload = Pick<ChatResult, 'usage' | 'model' | 'stopReason' | 'durationMs' | 'headers'>

const api = {
  settings: {
    get: (): Promise<SettingsView> => ipcRenderer.invoke('settings:get'),
    save: (patch: SettingsPatch): Promise<SettingsView> => ipcRenderer.invoke('settings:save', patch)
  },
  models: {
    probe: (apiKeyOverride?: string): Promise<ModelProbeResult> =>
      ipcRenderer.invoke('models:probe', apiKeyOverride)
  },
  llm: {
    chat: (params: ChatParams): Promise<string> => ipcRenderer.invoke('llm:chat', params),
    abort: (requestId: string): Promise<void> => ipcRenderer.invoke('llm:abort', requestId),
    onDelta: (cb: (requestId: string, text: string) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, text: string): void => cb(requestId, text)
      ipcRenderer.on('llm:delta', listener)
      return () => ipcRenderer.off('llm:delta', listener)
    },
    onDone: (cb: (requestId: string, payload: DonePayload) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, payload: DonePayload): void =>
        cb(requestId, payload)
      ipcRenderer.on('llm:done', listener)
      return () => ipcRenderer.off('llm:done', listener)
    },
    onError: (cb: (requestId: string, message: string) => void): (() => void) => {
      const listener = (_e: unknown, requestId: string, message: string): void =>
        cb(requestId, message)
      ipcRenderer.on('llm:error', listener)
      return () => ipcRenderer.off('llm:error', listener)
    }
  },
  usage: {
    list: (limit?: number): Promise<UsageRecord[]> => ipcRenderer.invoke('usage:list', limit),
    stats: (): Promise<UsageStats> => ipcRenderer.invoke('usage:stats')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
