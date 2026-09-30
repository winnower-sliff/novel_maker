import type { PartialHandlerTable } from './context'
import { abortLlmRequest, startStream } from './stream'

export const llmHandlers = {
  'llm:chat': (ctx, [params]) => startStream(ctx.sink, params),

  'llm:abort': (_ctx, [requestId]) => {
    abortLlmRequest(requestId)
  }
} satisfies PartialHandlerTable
