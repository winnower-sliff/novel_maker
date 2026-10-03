import type { ChatParams, PipelineAction, RunRecordPayload } from '@shared/types'
import type { Api, DonePayload } from '../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

export type { DonePayload } from '../preload/index'

// 流式兜底：长时间收不到任何 delta/done/error 视为连接中断（SSE 断连且重连失败等）
const IDLE_TIMEOUT_MS = 300_000

// 断连兜底：pollPending 由中央同步器（runtimeSync.ts）按触发时机统一调用，
// 把在途请求向主进程查询，已完成/已失败的合成结果喂给等待方
// （Promise 二次 settle 天然幂等），避免手机熄屏/切后台后 UI 永远卡「生成中」。
const pendingRuns = new Map<
  string,
  { resolve: (p: DonePayload) => void; reject: (e: Error) => void }
>()

/** 查询在途 pipeline run 并合成结果；返回是否仍有在途（供同步器判断是否继续轮询） */
export function pollPending(): boolean {
  if (pendingRuns.size === 0) return false
  const requestIds = [...pendingRuns.keys()]
  let live = false
  void window.api.llm
    .poll({ requestIds })
    .then((recs: Record<string, RunRecordPayload>) => {
      for (const [rid, rec] of Object.entries(recs)) {
        const run = pendingRuns.get(rid)
        if (!run) continue
        if (rec.status === 'done') {
          pendingRuns.delete(rid)
          run.resolve(rec.donePayload as DonePayload)
        } else if (rec.status === 'error') {
          pendingRuns.delete(rid)
          run.reject(new Error(rec.error ?? '生成失败'))
        }
      }
      live = pendingRuns.size > 0
    })
    .catch(() => {})
  return live || pendingRuns.size > 0
}

type StreamHooks = {
  onDelta?: (text: string) => void
  onReady?: () => void
}

export function subscribeStream(
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
      if (requestId) pendingRuns.delete(requestId)
      offs.forEach((off) => {
        off()
      })
    }
    const armWatchdog = (): void => {
      stopWatchdog()
      watchdog = setTimeout(() => {
        // 看门狗到期先向主进程查询该 run：仍 running 就续期等待（SSE 断连 ≠ 请求死亡，
        // 重连后 delta/done 自然恢复），确认 done/error/记录不存在才 settle。
        // 期间 rid 保留在 pendingRuns 里，pollPending（中央同步器）持续兜底补拉。
        const id = requestId
        if (!id) return
        void window.api.llm
          .poll({ requestIds: [id] })
          .then((recs) => {
            const rec = recs[id]
            if (!rec) {
              cleanup()
              reject(new Error('连接长时间无响应，已中断。请检查网络后重试'))
            } else if (rec.status === 'done') {
              cleanup()
              resolve(rec.donePayload as DonePayload)
            } else if (rec.status === 'error') {
              cleanup()
              reject(new Error(rec.error ?? '生成失败'))
            } else {
              armWatchdog()
            }
          })
          .catch(() => {
            // poll 本身失败（服务器不可达）：不判死，续期等待恢复
            armWatchdog()
          })
      }, IDLE_TIMEOUT_MS)
    }
    void open()
      .then((id) => {
        requestId = id
        pendingRuns.set(id, { resolve, reject })
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
