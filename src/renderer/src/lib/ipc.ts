import type { ChatParams, PipelineAction } from '@shared/types'
import type { Api, DonePayload } from '../../../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

export type { DonePayload } from '../../../preload/index'

export function runPipeline(
  action: PipelineAction,
  params: unknown,
  onDelta?: (text: string) => void,
  onReady?: () => void
): Promise<DonePayload> {
  return new Promise((resolve, reject) => {
    const offs: Array<() => void> = []
    const cleanup = (): void => offs.forEach((off) => off())
    void window.api.pipeline
      .run(action, params)
      .then((id) => {
        onReady?.()
        offs.push(
          window.api.llm.onDelta((rid, text) => {
            if (rid === id) onDelta?.(text)
          }),
          window.api.llm.onDone((rid, payload) => {
            if (rid === id) {
              cleanup()
              resolve(payload)
            }
          }),
          window.api.llm.onError((rid, message) => {
            if (rid === id) {
              cleanup()
              reject(new Error(message))
            }
          })
        )
      })
      .catch((err: unknown) => {
        cleanup()
        reject(err as Error)
      })
  })
}

export function chatStream(
  params: ChatParams,
  onDelta?: (text: string) => void
): { done: Promise<DonePayload>; abort: () => void } {
  let requestId: string | null = null
  const done = new Promise<DonePayload>((resolve, reject) => {
    const offs: Array<() => void> = []
    const cleanup = (): void => offs.forEach((off) => off())
    void window.api.llm
      .chat(params)
      .then((id) => {
        requestId = id
        offs.push(
          window.api.llm.onDelta((rid, text) => {
            if (rid === id) onDelta?.(text)
          }),
          window.api.llm.onDone((rid, payload) => {
            if (rid === id) {
              cleanup()
              resolve(payload)
            }
          }),
          window.api.llm.onError((rid, message) => {
            if (rid === id) {
              cleanup()
              reject(new Error(message))
            }
          })
        )
      })
      .catch((err: unknown) => {
        cleanup()
        reject(err as Error)
      })
  })
  return {
    done,
    abort: (): void => {
      if (requestId) void window.api.llm.abort(requestId)
    }
  }
}
