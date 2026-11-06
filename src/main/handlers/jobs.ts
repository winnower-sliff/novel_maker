import {
  approvePlan,
  cancelJob,
  getJobById,
  listJobsFor,
  retryJob,
  startAudit,
  startChat,
  startDiagnose,
  startReview,
  startRevise,
  startWrite
} from '../jobs.js'
import type { HandlerTable } from './types.js'

/** 写作任务（M6 全面 agent 化）：走向卡确认后 agent 自主段一路到入书；全部操作落 jobs 表，进度经 job:update/job:delta 事件推送 */

type Domain = Pick<
  HandlerTable,
  | 'job:startWrite'
  | 'job:approvePlan'
  | 'job:startRevise'
  | 'job:startReview'
  | 'job:startAudit'
  | 'job:startChat'
  | 'job:startDiagnose'
  | 'job:retry'
  | 'job:cancel'
  | 'job:get'
  | 'job:list'
>

export const jobHandlers: Domain = {
  'job:startWrite': (_ctx, [bookId]) => startWrite(bookId),
  'job:approvePlan': (_ctx, [jobId, feedback]) => approvePlan(jobId, feedback),
  'job:startRevise': (_ctx, [chapterId, instruction, segment]) =>
    startRevise(chapterId, instruction, segment),
  'job:startReview': (_ctx, [chapterId]) => startReview(chapterId),
  'job:startAudit': (_ctx, [bookId]) => startAudit(bookId),
  'job:startChat': (_ctx, [bookId, text]) => startChat(bookId, text),
  'job:startDiagnose': (_ctx, [bookId, question]) => startDiagnose(bookId, question),
  'job:retry': (_ctx, [jobId]) => retryJob(jobId),
  'job:cancel': (_ctx, [jobId]) => cancelJob(jobId),
  'job:get': (_ctx, [jobId]) => getJobById(jobId),
  'job:list': (_ctx, [bookId]) => listJobsFor(bookId)
}
