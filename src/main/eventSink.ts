/**
 * 传输无关的事件出口：Electron 下包装 WebContents，HTTP 下推送到 SSE。
 * 业务逻辑只依赖本接口，不再直接引用 electron。
 */
export interface EventSink {
  send(channel: string, requestId: string, ...args: unknown[]): void
  isClosed(): boolean
}
