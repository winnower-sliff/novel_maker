import type {
  ArgsOf,
  ArgsOfApi,
  InvokeChannels,
  IpcOnlyChannels,
  RetOf,
  RetOfApi
} from '../../shared/contract'
import type { EventSink } from '../eventSink'

/**
 * 所有 handler 的第一个参数是传输上下文：Electron 里包装 WebContents，
 * HTTP 里推送到 SSE。第二个参数是契约元组（ArgsOf<C>），由调用方解构。
 */
export interface HandlerContext {
  sink: EventSink
}

export type Handler = (ctx: HandlerContext, args: never[]) => unknown

export type HandlerTable = {
  [C in InvokeChannels]: (ctx: HandlerContext, args: ArgsOf<C>) => RetOf<C> | Promise<RetOf<C>>
}

export type IpcOnlyHandlerTable = {
  [C in IpcOnlyChannels]: (
    ctx: HandlerContext,
    args: ArgsOfApi<C>
  ) => RetOfApi<C> | Promise<RetOfApi<C>>
}

export type PartialHandlerTable = Partial<HandlerTable>
