import type { EventChannels, EventContract } from '../shared/contract.js'

/**
 * 传输无关的事件出口：v2 只有 HTTP/SSE 一种出口（server.ts 内置 webSink）。
 * 事件通道与 payload 形状由 shared/contract.ts 的 EventContract 约束。
 */
export interface EventSink {
  send<C extends EventChannels>(channel: C, ...args: EventContract[C]): void
  isClosed(): boolean
}

export function consoleSink(prefix = '[event]'): EventSink {
  return {
    send: (channel, ...args) => console.log(prefix, channel, ...args),
    isClosed: () => false
  }
}
