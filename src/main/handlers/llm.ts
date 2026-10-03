import type { PartialHandlerTable } from './context'
import { abortLlmRequest, pollRuns, startStream } from './stream'

export const llmHandlers = {
  'llm:chat': (ctx, [params]) => startStream(ctx.sink, params),

  'llm:abort': (_ctx, [requestId]) => {
    abortLlmRequest(requestId)
  },

  'llm:poll': (_ctx, [p]) => pollRuns(p.requestIds)
} satisfies PartialHandlerTable
