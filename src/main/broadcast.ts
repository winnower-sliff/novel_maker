import type { Job } from '../shared/types.js'
import type { EventSink } from './eventSink.js'

/**
 * 全局事件广播：串行队列自动衔接/看门狗触发时无请求上下文，
 * 经此模块拿 server.ts 挂载的 webSink。
 */

let globalSink: EventSink | null = null

export function setGlobalSink(sink: EventSink): void {
  globalSink = sink
}

export function emitJob(job: Job): void {
  if (!globalSink || globalSink.isClosed()) return
  globalSink.send('job:update', job.id, job)
}

export function emitJobDelta(jobId: string, text: string): void {
  if (!globalSink || globalSink.isClosed()) return
  globalSink.send('job:delta', jobId, text)
}
