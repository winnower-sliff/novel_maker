import type { Job } from '../shared/types.js'
import type { EventSink } from './eventSink.js'

/**
 * 全局事件广播：串行队列自动衔接/看门狗触发时无请求上下文，
 * 经此模块拿 server.ts 挂载的 webSink。
 *
 * 事件面（M7 重构）：
 * - job:update   job 状态变化（含 payload）
 * - job:activity 工具卡实时推送（agent 每次工具调用）
 * - job:progress 生成进度（正文/改章字数——正文不进聊天流，只有进度）
 * - job:delta    导演白话流式（chat 气泡；total=累计长度，前端校验失配即全量补拉）
 */

let globalSink: EventSink | null = null

export function setGlobalSink(sink: EventSink): void {
  globalSink = sink
}

export function emitJob(job: Job): void {
  if (!globalSink || globalSink.isClosed()) return
  globalSink.send('job:update', job.id, job)
}

export interface JobActivity {
  tool: string
  summary: string
  ok: boolean
}

export function emitJobActivity(jobId: string, act: JobActivity): void {
  if (!globalSink || globalSink.isClosed()) return
  globalSink.send('job:activity', jobId, act)
}

export interface JobProgress {
  phase: 'draft' | 'revise'
  chars: number
}

export function emitJobProgress(jobId: string, p: JobProgress): void {
  if (!globalSink || globalSink.isClosed()) return
  globalSink.send('job:progress', jobId, p)
}

export function emitJobDelta(jobId: string, text: string, total: number): void {
  if (!globalSink || globalSink.isClosed()) return
  globalSink.send('job:delta', jobId, text, total)
}
