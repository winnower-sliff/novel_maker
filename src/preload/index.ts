import { contextBridge, ipcRenderer } from 'electron'
import { type ApiTransport, buildApi } from '../shared/contract'

/**
 * contextBridge 暴露 window.api。
 * 全部通道签名由 shared/contract.ts 派生，本文件只负责 IPC 传输实现。
 */

const transport: ApiTransport = {
  invoke: (channel, args) => ipcRenderer.invoke(channel, ...args),
  subscribe: (channel, cb) => {
    const listener = (_e: unknown, ...args: unknown[]): void => cb(...(args as never[]))
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  }
}

const api = buildApi(transport)

contextBridge.exposeInMainWorld('api', api)

export type {
  AgentToolCallEvent,
  AgentToolResultEvent,
  Api,
  DonePayload,
  WorldbuildRetrievalBrief
} from '../shared/contract'
