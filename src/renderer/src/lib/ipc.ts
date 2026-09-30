import type { ChatParams, PipelineAction } from '@shared/types'
import type { Api, DonePayload } from '../../../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

export type { DonePayload } from '../../../preload/index'

// 流式兜底：长时间收不到任何 delta/done/error 视为连接中断（SSE 断连且重连失败等）
const IDLE_TIMEOUT_MS = 300_000

type StreamHooks = {
  onDelta?: (text: string) => void
  onReady?: () => void
}

function subscribeStream(
  open: () => Promise<string>,
  hooks: StreamHooks
): { done: Promise<DonePayload>; abort: () => void } {
  let requestId: string | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null
  const done = new Promise<DonePayload>((resolve, reject) => {
    const offs: Array<() => void> = []
    const stopWatchdog = (): void => {
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }
    }
    const cleanup = (): void => {
      stopWatchdog()
      offs.forEach((off) => {
        off()
      })
    }
    const armWatchdog = (): void => {
      stopWatchdog()
      watchdog = setTimeout(() => {
        cleanup()
        reject(new Error('连接长时间无响应，已中断。请检查网络后重试'))
      }, IDLE_TIMEOUT_MS)
    }
    void open()
      .then((id) => {
        requestId = id
        hooks.onReady?.()
        armWatchdog()
        offs.push(
          window.api.llm.onDelta((rid, text) => {
            if (rid === id) {
              armWatchdog()
              hooks.onDelta?.(text)
            }
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

export function runPipeline(
  action: PipelineAction,
  params: unknown,
  onDelta?: (text: string) => void,
  onReady?: () => void
): Promise<DonePayload> {
  return startPipeline(action, params, onDelta, onReady).done
}

export function startPipeline(
  action: PipelineAction,
  params: unknown,
  onDelta?: (text: string) => void,
  onReady?: () => void
): { done: Promise<DonePayload>; abort: () => void } {
  return subscribeStream(() => window.api.pipeline.run(action, params), {
    onDelta,
    onReady
  })
}

export function chatStream(
  params: ChatParams,
  onDelta?: (text: string) => void
): { done: Promise<DonePayload>; abort: () => void } {
  return subscribeStream(() => window.api.llm.chat(params), onDelta ? { onDelta } : {})
}
