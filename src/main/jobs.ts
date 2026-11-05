import type {
  Book,
  ChapterOutline,
  DirectionCard,
  Job,
  JobPayload,
  Scene
} from '../shared/types.js'
import { emitJob, emitJobDelta } from './broadcast.js'
import {
  autoFixDraft,
  compactMemories,
  genDirections,
  genDraft,
  genOutline,
  genRecap,
  genScenes,
  selfCheck
} from './director/steps.js'
import { stripHtmlComments } from './lint.js'
import {
  activeLine,
  effectiveChapters,
  failStuckJobs,
  getBook,
  getCharacter,
  getJob,
  insertChapter,
  insertJob,
  listCharacters,
  listJobs,
  patchCharacterStates,
  previousChapter,
  saveCard,
  saveCharacter,
  saveForeshadow,
  updateChapterSummary,
  updateJob
} from './store.js'

/**
 * 任务流水线（W10/W12/W14）：
 * - 全局串行：同一时刻至多一个生成任务在跑，新任务排队自动衔接
 * - 每步落库（jobs.step+payload），waiting_user 等作者操作
 * - 看门狗：running 超 10 分钟标 failed
 * - 写章五步：proposal→outline→scene→draft→selfcheck/finalize
 */

// ── 串行队列 ─────────────────────────────────────────────────────────────────

let activeJobId: string | null = null

function busy(): boolean {
  if (!activeJobId) return false
  const j = getJob(activeJobId)
  if (!j || j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') {
    activeJobId = null
    return false
  }
  return true
}

async function pump(): Promise<void> {
  if (busy()) return
  const next = listJobs(undefined, 10).find((j) => j.state === 'queued')
  if (!next) return
  activeJobId = next.id
  // queued 任务从 proposal 起跑
  if (next.kind === 'write' && next.step === '') {
    await runProposal(next)
  }
}

/** 步骤执行包装：异常落库+广播+释放队列 */
async function guarded(jobId: string, fn: () => Promise<Job | null>): Promise<Job> {
  try {
    const result = await fn()
    const final = result ?? (getJob(jobId) as Job)
    emitJob(final)
    return final
  } catch (err) {
    const failed = updateJob(jobId, {
      state: 'failed',
      error: String((err as Error)?.message ?? err)
    })
    if (failed) emitJob(failed)
    return failed as Job
  } finally {
    activeJobId = null
    // 自动衔接队列里的下一个（W14）
    void pump().catch(() => {})
  }
}

function requireJob(jobId: string): Job {
  const job = getJob(jobId)
  if (!job) throw new Error(`任务 ${jobId} 不存在`)
  return job
}

function requireWriteJob(jobId: string, step?: string): Job {
  const job = requireJob(jobId)
  if (job.kind !== 'write') throw new Error('非写作任务')
  if (job.state === 'done' || job.state === 'cancelled') throw new Error('任务已结束')
  if (step && job.step !== step)
    throw new Error(`当前步骤是 ${job.step || '初始'}，不能执行 ${step} 操作`)
  return job
}

// ── 各步执行 ─────────────────────────────────────────────────────────────────

async function runProposal(job: Job): Promise<Job | null> {
  const book = getBook(job.bookId)
  if (!book) throw new Error('书不存在')
  activeJobId = job.id
  updateJob(job.id, { state: 'running', step: 'proposal', watchdogAt: Date.now(), error: '' })
  const cards: DirectionCard[] = await genDirections(book, job.lineId)
  return updateJob(job.id, {
    state: 'waiting_user',
    step: 'outline',
    payload: { cards },
    watchdogAt: 0
  })
}

// ── 公开 API（handlers 调用） ────────────────────────────────────────────────

export async function startWrite(bookId: string): Promise<Job> {
  const book = getBook(bookId)
  if (!book) throw new Error('书不存在')
  const line = activeLine(book)
  if (!line) throw new Error('书没有激活线')
  if (busy()) {
    return insertJob({ bookId, lineId: line.id, kind: 'write' })
  }
  const job = insertJob({ bookId, lineId: line.id, kind: 'write' })
  activeJobId = job.id
  return guarded(job.id, () => runProposal(job))
}

export async function chooseDirection(
  jobId: string,
  direction: { source: 'card' | 'free'; cardIndex?: number; text: string }
): Promise<Job> {
  const job = requireWriteJob(jobId, 'outline')
  activeJobId = jobId
  return guarded(jobId, async () => {
    updateJob(jobId, { state: 'running', watchdogAt: Date.now(), payload: { direction } })
    const book = getBook(job.bookId)
    if (!book) throw new Error('书不存在')
    const outline: ChapterOutline = await genOutline(book, job.lineId, direction)
    return updateJob(jobId, {
      state: 'waiting_user',
      step: 'scene',
      watchdogAt: 0,
      payload: { outline }
    })
  })
}

export async function confirmOutline(jobId: string, edits?: Partial<ChapterOutline>): Promise<Job> {
  const job = requireWriteJob(jobId, 'scene')
  const direction = job.payload.direction
  const outline = { ...(job.payload.outline as ChapterOutline), ...edits }
  if (!direction || !outline) throw new Error('任务数据不完整')
  activeJobId = jobId
  return guarded(jobId, async () => {
    updateJob(jobId, {
      state: 'running',
      step: 'scene',
      watchdogAt: Date.now(),
      payload: { outline }
    })
    const book = getBook(job.bookId)
    if (!book) throw new Error('书不存在')
    const scenes: Scene[] = await genScenes(book, job.lineId, outline, direction)
    return updateJob(jobId, {
      state: 'waiting_user',
      step: 'draft',
      watchdogAt: 0,
      payload: { scenes }
    })
  })
}

/** scenes=null 表示用户跳过分镜（W3 逃生门），直接开写 */
export async function confirmScenes(jobId: string, scenes: Scene[] | null): Promise<Job> {
  const job = requireWriteJob(jobId, 'draft')
  const direction = job.payload.direction
  const outline = job.payload.outline
  if (!direction || !outline) throw new Error('任务数据不完整')
  const finalScenes = scenes ?? job.payload.scenes ?? null
  activeJobId = jobId
  return guarded(jobId, async () => {
    updateJob(jobId, {
      state: 'running',
      step: 'draft',
      watchdogAt: Date.now(),
      payload: { scenes: finalScenes }
    })
    const book = getBook(job.bookId)
    if (!book) throw new Error('书不存在')
    const draft = await genDraft(
      { book, lineId: job.lineId, outline, scenes: finalScenes, direction },
      (t) => emitJobDelta(jobId, t)
    )
    return await selfcheckPhase(job, book, draft)
  })
}

/** 自检→自动修一次→再检（W6）；不过则 waiting_user 给作者选择 */
async function selfcheckPhase(
  job: Job,
  book: NonNullable<ReturnType<typeof getBook>>,
  draft: string
): Promise<Job | null> {
  const prev = previousChapter(job.lineId)
  const report = selfCheck(book, job.lineId, draft, prev?.content?.slice(-400))
  if (report.pass) {
    return await finalize(job.id, draft)
  }
  if (job.payload.autoFixed) {
    return updateJob(job.id, {
      state: 'waiting_user',
      step: 'selfcheck',
      payload: { draftText: draft, lint: report },
      watchdogAt: 0
    })
  }
  // 自动修一次
  const outline = job.payload.outline as ChapterOutline
  const direction = job.payload.direction as NonNullable<JobPayload['direction']>
  const scenes = job.payload.scenes ?? null
  const fixed = await autoFixDraft(
    { book, lineId: job.lineId, outline, scenes, direction },
    draft,
    report,
    (t) => emitJobDelta(job.id, t)
  )
  const report2 = selfCheck(book, job.lineId, fixed, prev?.content?.slice(-400))
  if (report2.pass) {
    return await finalize(job.id, fixed)
  }
  return updateJob(job.id, {
    state: 'waiting_user',
    step: 'selfcheck',
    payload: { draftText: fixed, lint: report2, autoFixed: true },
    watchdogAt: 0
  })
}

/** 接受瑕疵（W6 选项之一）：带病入书 */
export async function acceptFlaws(jobId: string): Promise<Job> {
  const job = requireWriteJob(jobId, 'selfcheck')
  if (!job.payload.draftText) throw new Error('没有可入书的草稿')
  activeJobId = jobId
  return guarded(jobId, () => finalize(jobId, job.payload.draftText as string))
}

/** 入书+纪要（W4：自检过后写完即入书；变更清单落库） */
async function finalize(jobId: string, draftOverride?: string): Promise<Job | null> {
  const job = getJob(jobId)
  if (!job) throw new Error('任务不存在')
  const draft = stripHtmlComments(draftOverride ?? (job.payload.draftText as string))
  if (!draft) throw new Error('草稿为空')
  const book = getBook(job.bookId)
  if (!book) throw new Error('书不存在')
  updateJob(jobId, { state: 'running', step: 'finalize', watchdogAt: Date.now() })

  const outline = job.payload.outline as ChapterOutline
  const prev = previousChapter(job.lineId)
  const chapter = insertChapter({
    lineId: job.lineId,
    parentChapterId: prev?.id ?? '',
    title: outline.title,
    content: draft,
    summary: '',
    meta: {
      direction: job.payload.direction,
      outline,
      scenes: job.payload.scenes ?? null
    }
  })

  // 纪要（概要+设定变更），失败不阻断入书（章已在库）
  let recap: JobPayload['recap']
  try {
    recap = await genRecap(book, job.lineId, { ...chapter, content: draft })
    applyRecap(job, chapter.id, recap)
    // 摘要写回章节（滚动记忆细记层）
    updateChapterSummary(chapter.id, recap.summary)
  } catch (err) {
    console.warn('[jobs] 纪要生成失败（不影响入书）:', (err as Error)?.message)
  }

  const done = updateJob(jobId, {
    state: 'done',
    step: 'finalize',
    chapterId: chapter.id,
    payload: {
      recap: recap ?? undefined,
      draftText: draft,
      draftWordCount: draft.replace(/\s/g, '').length
    },
    watchdogAt: 0
  })

  // 滚动记忆压缩（D2，后台静默）
  void compactMemories(book, job.lineId, effectiveChapters(job.lineId)).catch(() => {})
  return done
}

/** 应用纪要的设定变更（B5 agent 全权维护；B8 活状态；伏笔台账） */
function applyRecap(job: Job, chapterId: string, recap: NonNullable<JobPayload['recap']>): void {
  const statePatches: Array<{ id: string; patch: Record<string, string> }> = []
  for (const sc of recap.stateChanges) {
    let charId = sc.characterId && getCharacter(sc.characterId) ? sc.characterId : null
    if (!charId) {
      const hit = listCharactersByName(job.lineId, sc.name)
      if (hit) charId = hit.id
    }
    if (charId) statePatches.push({ id: charId, patch: sc.patch as Record<string, string> })
  }
  if (statePatches.length) patchCharacterStates(statePatches)

  for (const op of recap.cardOps) {
    if (op.op === 'create' && op.title) {
      saveCard({
        lineId: job.lineId,
        kind: op.kind ?? 'custom',
        title: op.title,
        readerText: op.readerText ?? '',
        authorText: op.authorText ?? ''
      })
    }
    // update/delete 留给 M4 子代理盘点（M2 先 create）
  }

  for (const op of recap.foreshadowOps) {
    saveForeshadow({
      lineId: job.lineId,
      title: op.title,
      detail: op.detail,
      plantedChapterId: op.op === 'plant' ? chapterId : '',
      resolvedChapterId: op.op === 'resolve' ? chapterId : '',
      plannedChapterId: op.op === 'plan' ? chapterId : '',
      status: op.op === 'resolve' ? 'resolved' : op.op === 'plan' ? 'planned' : 'open'
    })
  }
}

function listCharactersByName(lineId: string, name: string): { id: string } | null {
  const hit = listCharacters(lineId).find((c) => c.name === name)
  return hit ?? null
}

/** 重试当前步骤（W6「再试」/中断恢复 W13） */
export async function retryJob(jobId: string): Promise<Job> {
  const job = requireWriteJob(jobId)
  if (busy() && activeJobId !== jobId) throw new Error('有任务在执行中')
  const book = getBook(job.bookId)
  if (!book) throw new Error('书不存在')
  activeJobId = jobId
  return guarded(jobId, async () => {
    updateJob(jobId, { state: 'running', watchdogAt: Date.now(), error: '' })
    switch (job.step) {
      case 'proposal':
      case '':
        return await runProposal(job)
      case 'outline': {
        const direction = job.payload.direction
        if (direction) {
          const outline = await genOutline(book, job.lineId, direction)
          return updateJob(jobId, {
            state: 'waiting_user',
            step: 'scene',
            watchdogAt: 0,
            payload: { outline }
          })
        }
        return await runProposal(job)
      }
      case 'scene': {
        const direction = job.payload.direction as NonNullable<JobPayload['direction']>
        const outline = job.payload.outline as ChapterOutline
        const scenes = await genScenes(book, job.lineId, outline, direction)
        return updateJob(jobId, {
          state: 'waiting_user',
          step: 'draft',
          watchdogAt: 0,
          payload: { scenes }
        })
      }
      case 'draft': {
        const direction = job.payload.direction as NonNullable<JobPayload['direction']>
        const outline = job.payload.outline as ChapterOutline
        const scenes = job.payload.scenes ?? null
        const draft = await genDraft(
          { book, lineId: job.lineId, outline, scenes, direction },
          (t) => emitJobDelta(jobId, t)
        )
        return await selfcheckPhase(job, book, draft)
      }
      case 'selfcheck': {
        // 再试=重新生成正文
        const direction = job.payload.direction as NonNullable<JobPayload['direction']>
        const outline = job.payload.outline as ChapterOutline
        const scenes = job.payload.scenes ?? null
        const draft = await genDraft(
          { book, lineId: job.lineId, outline, scenes, direction },
          (t) => emitJobDelta(jobId, t)
        )
        return await selfcheckPhase(
          { ...job, payload: { ...job.payload, autoFixed: false } },
          book,
          draft
        )
      }
      case 'finalize':
        return await finalize(jobId)
      default:
        throw new Error(`未知步骤 ${job.step}`)
    }
  })
}

/** 取消（W11：主动取消=作废整章；二次确认由 UI 承担） */
export function cancelJob(jobId: string): Job {
  const job = requireJob(jobId)
  if (job.state === 'done') throw new Error('任务已完成，无法取消')
  const cancelled = updateJob(jobId, { state: 'cancelled', watchdogAt: 0 })
  if (cancelled) emitJob(cancelled)
  if (activeJobId === jobId) activeJobId = null
  void pump().catch(() => {})
  return cancelled as Job
}

export function getJobById(jobId: string): Job | null {
  return getJob(jobId)
}

export function listJobsFor(bookId?: string): Job[] {
  return listJobs(bookId)
}

/** 启动时恢复：把重启前 running 的任务回滚到可重试状态（W13 简版：failed+可 retry） */
export function recoverJobsOnBoot(): void {
  failStuckJobs(0)
}

/** 看门狗 tick（index.ts 定时调用） */
export function watchdogTick(): void {
  failStuckJobs()
}

export function isBusy(): boolean {
  return busy()
}
