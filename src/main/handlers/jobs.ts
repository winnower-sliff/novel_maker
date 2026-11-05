import {
  acceptFlaws,
  cancelJob,
  chooseDirection,
  confirmOutline,
  confirmScenes,
  getJobById,
  listJobsFor,
  retryJob,
  startAudit,
  startDiagnose,
  startReview,
  startRevise,
  startWrite
} from '../jobs.js'
import type { HandlerTable } from './types.js'

/** 写作任务流水线（导演循环）：全部操作落 jobs 表，进度经 job:update/job:delta 事件推送 */

type Domain = Pick<
  HandlerTable,
  | 'job:startWrite'
  | 'job:startRevise'
  | 'job:startReview'
  | 'job:startAudit'
  | 'job:startDiagnose'
  | 'job:chooseDirection'
  | 'job:confirmOutline'
  | 'job:confirmScenes'
  | 'job:acceptFlaws'
  | 'job:retry'
  | 'job:cancel'
  | 'job:get'
  | 'job:list'
>

export const jobHandlers: Domain = {
  'job:startWrite': (_ctx, [bookId]) => startWrite(bookId),
  'job:startRevise': (_ctx, [chapterId, instruction, segment]) =>
    startRevise(chapterId, instruction, segment),
  'job:startReview': (_ctx, [chapterId]) => startReview(chapterId),
  'job:startAudit': (_ctx, [bookId]) => startAudit(bookId),
  'job:startDiagnose': (_ctx, [bookId, question]) => startDiagnose(bookId, question),
  'job:chooseDirection': (_ctx, [jobId, direction]) => chooseDirection(jobId, direction),
  'job:confirmOutline': (_ctx, [jobId, edits]) => confirmOutline(jobId, edits),
  'job:confirmScenes': (_ctx, [jobId, scenes]) => confirmScenes(jobId, scenes),
  'job:acceptFlaws': (_ctx, [jobId]) => acceptFlaws(jobId),
  'job:retry': (_ctx, [jobId]) => retryJob(jobId),
  'job:cancel': (_ctx, [jobId]) => cancelJob(jobId),
  'job:get': (_ctx, [jobId]) => getJobById(jobId),
  'job:list': (_ctx, [bookId]) => listJobsFor(bookId)
}
