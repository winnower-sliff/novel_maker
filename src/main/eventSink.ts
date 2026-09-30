import type { EventChannels, EventContract } from '../shared/contract'

/**
 * 传输无关的事件出口：Electron 下包装 WebContents，HTTP 下推送到 SSE。
 * 业务逻辑只依赖本接口，不再直接引用 electron。
 * 事件通道与 payload 形状由 shared/contract.ts 的 EventContract 约束。
 */
export interface EventSink {
  send<C extends EventChannels>(channel: C, ...args: EventContract[C]): void
  isClosed(): boolean
}
