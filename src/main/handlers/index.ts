/**
 * 业务 handler 汇总：全部通道签名由 shared/contract.ts 派生（HandlerTable），
 * 按域拆分在各子模块。sharedHandlers 同时供 Electron IPC 与内嵌 HTTP 调用；
 * ipcOnlyHandlers 仅桌面端注册。
 */

import { agentHandlers } from './agent'
import type { HandlerTable } from './context'
import { ipcOnlyHandlers } from './ipcOnly'
import { llmHandlers } from './llm'
import { novelHandlers } from './novel'
import { pipelineHandlers } from './pipeline'
import { settingsHandlers } from './settings'
import { toolHandlers } from './tools'

export const sharedHandlers: HandlerTable = {
  ...settingsHandlers,
  ...llmHandlers,
  ...agentHandlers,
  ...pipelineHandlers,
  ...novelHandlers,
  ...toolHandlers
}

export type { Handler, HandlerContext } from './context'
export { ipcOnlyHandlers }
