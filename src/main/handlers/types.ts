import type { ArgsOf, InvokeChannels, RetOf } from '../../shared/contract.js'
import type { EventSink } from '../eventSink.js'

/**
 * handler 表类型：全部从契约派生。
 * 调用方（server.ts）必须 handler(ctx, args) 整体传元组，不能 spread（v1 坑 23 实锤）。
 */

export interface HandlerCtx {
  sink: EventSink
}

export type HandlerTable = {
  [C in InvokeChannels]: (ctx: HandlerCtx, args: ArgsOf<C>) => RetOf<C> | Promise<RetOf<C>>
}
