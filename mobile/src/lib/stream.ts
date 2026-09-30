import type { DonePayload } from '@shared/contract'
import type { ChatParams } from '@shared/types'

/** llm:chat 流式封装（与桌面 lib/ipc.ts chatStream 同构） */
export function chatStream(
  params: ChatParams,
  onDelta?: (text: string) => void
): { done: Promise<DonePayload>; abort: () => void } {
  let requestId: string | null = null
  const done = new Promise<DonePayload>((resolve, reject) => {
    const offs: Array<() => void> = []
    const cleanup = (): void =>
      offs.forEach((off) => {
        off()
      })
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
