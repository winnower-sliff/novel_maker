import type {
  AgentReport,
  Chapter,
  ChapterOutline,
  ChatMessageRow,
  DirectionCard,
  Job,
  JobPayload,
  Scene
} from '../shared/types.js'
import { emitJob, emitJobDelta } from './broadcast.js'
import { buildStatusCard } from './director/context.js'
import {
  autoFixDraft,
  compactMemories,
  genAudit,
  genChat,
  genDiagnose,
  genDirections,
  genDraft,
  genOutline,
  genRecap,
  genReview,
  genRevise,
  genScenes,
  selfCheck
} from './director/steps.js'
import { stripHtmlComments } from './lint.js'
import {
  activeLine,
  appendMessage,
  effectiveChapters,
  failStuckJobs,
  getBook,
  getChapter,
  getCharacter,
  getJob,
  getLine,
  insertChapter,
  insertJob,
  listCharacters,
  listJobs,
  listMessages,
  patchCharacterStates,
  previousChapter,
  replaceChapterContent,
  saveCard,
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

// ── 对话流节点消息（M5 智能体页：写作循环各阶段以消息形式进入对话流） ────────

/** 落一条导演侧节点消息：meta 指向 job+step，正文数据前端从 job payload 取 */
function note(jobId: string, step: string, content = ''): void {
  const job = getJob(jobId)
  if (!job) return
  appendMessage({
    bookId: job.bookId,
    role: 'assistant',
    content,
    meta: { kind: 'job', jobId, step }
  })
}

/** 落一条作者消息（动作/聊天发言），content 即作者可见文本 */
function userMsg(
  bookId: string,
  content: string,
  jobId?: string,
  kind: 'action' | 'chat' = 'action'
): void {
  appendMessage({
    bookId,
    role: 'user',
    content,
    meta: jobId ? { kind, jobId } : { kind }
  })
}

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
  const runners: Partial<Record<string, (j: Job) => Promise<Job | null>>> = {
    write: next.step === '' ? runProposal : undefined,
    revise: runReviseJob,
    review: runReviewJob,
    audit: runAuditJob,
    diagnose: runDiagnoseJob,
    chat: runChatJob
  }
  const run = runners[next.kind]
  if (!run) return
  await guarded(next.id, () => run(next))
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
    if (failed) {
      note(jobId, 'failed', `卡住了：${failed.error}`)
      emitJob(failed)
    }
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

/** 流式正文节流落库（W13 中断恢复：断网/杀 APP 重连后，已生成部分从 payload.draftText 恢复显示） */
function streamingSaver(jobId: string): (t: string) => void {
  let acc = ''
  let lastSave = 0
  return (t: string) => {
    emitJobDelta(jobId, t)
    acc += t
    const now = Date.now()
    if (now - lastSave > 3000) {
      lastSave = now
      updateJob(jobId, { payload: { draftText: acc } })
    }
  }
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
  note(job.id, 'cards', '本章走向备选已出，等你选一个方向')
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
  userMsg(bookId, `写第 ${effectiveChapters(line.id).length + 1} 章`)
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
    userMsg(
      job.bookId,
      direction.source === 'card' ? `选走向：${direction.text}` : `自定义走向：${direction.text}`,
      jobId
    )
    updateJob(jobId, { state: 'running', watchdogAt: Date.now(), payload: { direction } })
    const book = getBook(job.bookId)
    if (!book) throw new Error('书不存在')
    const outline: ChapterOutline = await genOutline(book, job.lineId, direction)
    note(jobId, 'outline', `《${outline.title}》章级大纲已出，确认或修改`)
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
  const edited = Boolean(edits && Object.keys(edits).length > 0)
  activeJobId = jobId
  return guarded(jobId, async () => {
    userMsg(job.bookId, edited ? '确认大纲（有修改）' : '确认大纲', jobId)
    updateJob(jobId, {
      state: 'running',
      step: 'scene',
      watchdogAt: Date.now(),
      payload: { outline }
    })
    const book = getBook(job.bookId)
    if (!book) throw new Error('书不存在')
    const scenes: Scene[] = await genScenes(book, job.lineId, outline, direction)
    note(jobId, 'scenes', '本章分镜已出，逐幕确认或直接开写')
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
    userMsg(job.bookId, scenes ? '按分镜开写正文' : '跳过分镜，直接开写', jobId)
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
      streamingSaver(jobId)
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
    note(job.id, 'selfcheck', '自动修了一轮仍有问题，你来定夺')
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
    streamingSaver(job.id)
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
  userMsg(job.bookId, '接受瑕疵，直接入书', jobId)
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
  note(jobId, 'chapter', `《${chapter.title}》已入书`)

  // 滚动记忆压缩（D2，后台静默）
  void compactMemories(book, job.lineId, effectiveChapters(job.lineId)).catch(() => {})
  // 每 8 章自动排一次跨章审计（M4 文风漂移/剧情空转守望）
  const chaptersNow = effectiveChapters(job.lineId)
  if (chaptersNow.length > 0 && chaptersNow.length % 8 === 0) {
    maybeQueueAudit(job.bookId, job.lineId)
  }
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
  const job = requireJob(jobId)
  if (
    job.kind !== 'write' &&
    job.kind !== 'revise' &&
    job.kind !== 'review' &&
    job.kind !== 'audit' &&
    job.kind !== 'diagnose' &&
    job.kind !== 'chat'
  )
    throw new Error('该任务不支持重试')
  if (job.state !== 'failed' && job.state !== 'cancelled')
    throw new Error('只有失败/取消的任务可重试')
  if (busy() && activeJobId !== jobId) throw new Error('有任务在执行中')
  const book = getBook(job.bookId)
  if (!book) throw new Error('书不存在')
  // 子代理类任务：从头重跑（参数在 payload）
  if (job.kind !== 'write') {
    const runners: Record<string, (j: Job) => Promise<Job | null>> = {
      revise: runReviseJob,
      review: runReviewJob,
      audit: runAuditJob,
      diagnose: runDiagnoseJob,
      chat: runChatJob
    }
    const run = runners[job.kind]
    if (!run) throw new Error('该任务不支持重试')
    activeJobId = jobId
    return guarded(jobId, async () => {
      updateJob(jobId, { state: 'running', watchdogAt: Date.now(), error: '' })
      return await run(job)
    })
  }
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
          streamingSaver(jobId)
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
          streamingSaver(jobId)
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

// ── 改章 revise（M4 章末快捷钮/自由指令；W9 版本可回看） ─────────────────────

export async function startRevise(
  chapterId: string,
  instruction: string,
  segment?: string
): Promise<Job> {
  const chapter = getChapter(chapterId)
  if (!chapter) throw new Error('章节不存在')
  if (!instruction.trim()) throw new Error('修改指令不能为空')
  const line = getLine(chapter.lineId)
  if (!line) throw new Error('章节所属线不存在')
  const job = insertJob({
    bookId: line.bookId,
    lineId: chapter.lineId,
    kind: 'revise',
    payload: {
      revise: { chapterId, instruction: instruction.trim(), segment: segment?.trim() || undefined }
    }
  })
  userMsg(
    line.bookId,
    segment
      ? `选段改《${chapter.title}》：${instruction.trim()}`
      : `改《${chapter.title}》：${instruction.trim()}`,
    job.id
  )
  return enqueueOrRun(job, () => runReviseJob(job))
}

async function runReviseJob(job: Job): Promise<Job | null> {
  const revise = job.payload.revise
  if (!revise) throw new Error('改章任务缺少参数')
  const chapter = getChapter(revise.chapterId)
  const book = getBook(job.bookId)
  if (!chapter || !book) throw new Error('章节或书不存在')
  activeJobId = job.id
  updateJob(job.id, {
    state: 'running',
    step: 'draft',
    watchdogAt: Date.now(),
    error: '',
    chapterId: revise.chapterId
  })
  const draft = await genRevise(
    { book, lineId: job.lineId, chapter, instruction: revise.instruction, segment: revise.segment },
    streamingSaver(job.id)
  )
  // 改章自检只报告不入闸：字数类指令（加长/缩短）天然会偏 targetWords，不参与字数检查；
  // 结果附在 payload.lint 供 UI 展示，问题大由作者再发指令（旧版本在 chapter_versions 可回退）
  const prev = previousChapter(job.lineId)
  const report = selfCheck(
    { ...book, targetWords: 0 },
    job.lineId,
    draft,
    prev?.content?.slice(-400)
  )
  const clean = stripHtmlComments(draft)
  replaceChapterContent(revise.chapterId, clean, `改章：${revise.instruction.slice(0, 80)}`)
  note(job.id, 'revised', `《${chapter.title}》已按指令改好`)
  return updateJob(job.id, {
    state: 'done',
    step: 'finalize',
    payload: { draftText: clean, draftWordCount: clean.replace(/\s/g, '').length, lint: report },
    watchdogAt: 0
  })
}

// ── 子代理审读（M4 四角色中的三个 LLM 隔离视角 + diagnose 吸收分支推演） ─────

export async function startReview(chapterId: string): Promise<Job> {
  const chapter = getChapter(chapterId)
  if (!chapter) throw new Error('章节不存在')
  const line = getLine(chapter.lineId)
  if (!line) throw new Error('章节所属线不存在')
  const job = insertJob({
    bookId: line.bookId,
    lineId: chapter.lineId,
    kind: 'review',
    payload: { reviewChapterId: chapterId }
  })
  userMsg(line.bookId, `审读《${chapter.title}》`, job.id)
  return enqueueOrRun(job, () => runReviewJob(job))
}

async function runReviewJob(job: Job): Promise<Job | null> {
  const chapterId = job.payload.reviewChapterId
  const chapter = chapterId ? getChapter(chapterId) : null
  const book = getBook(job.bookId)
  if (!chapter || !book) throw new Error('章节或书不存在')
  activeJobId = job.id
  updateJob(job.id, {
    state: 'running',
    step: 'report',
    watchdogAt: Date.now(),
    error: '',
    chapterId: chapter.id
  })
  const report = await genReview(book, job.lineId, chapter)
  note(job.id, 'report', `《${chapter.title}》审读报告已出`)
  return updateJob(job.id, { state: 'done', step: 'report', payload: { report }, watchdogAt: 0 })
}

export async function startAudit(bookId: string): Promise<Job> {
  const book = getBook(bookId)
  if (!book) throw new Error('书不存在')
  const line = activeLine(book)
  if (!line) throw new Error('书没有激活线')
  const job = insertJob({ bookId, lineId: line.id, kind: 'audit' })
  userMsg(bookId, '跑一次全书审计')
  return enqueueOrRun(job, () => runAuditJob(job))
}

async function runAuditJob(job: Job): Promise<Job | null> {
  const book = getBook(job.bookId)
  if (!book) throw new Error('书不存在')
  activeJobId = job.id
  updateJob(job.id, { state: 'running', step: 'report', watchdogAt: Date.now(), error: '' })
  const chapters = effectiveChapters(job.lineId)
  if (chapters.length < 2) throw new Error('章节太少，无从审计')
  const recent = chapters.slice(-10).map((c) => ({
    orderNo: c.orderNo,
    title: c.title,
    summary: c.summary
  }))
  const latestTwo = chapters.slice(-2)
  const report = await genAudit(book, job.lineId, recent, latestTwo)
  note(job.id, 'report', '全书审计报告已出')
  return updateJob(job.id, { state: 'done', step: 'report', payload: { report }, watchdogAt: 0 })
}

export async function startDiagnose(bookId: string, question: string): Promise<Job> {
  const book = getBook(bookId)
  if (!book) throw new Error('书不存在')
  if (!question.trim()) throw new Error('问题不能为空')
  const line = activeLine(book)
  if (!line) throw new Error('书没有激活线')
  const job = insertJob({ bookId, lineId: line.id, kind: 'diagnose', payload: { question } })
  userMsg(bookId, question.trim(), job.id)
  return enqueueOrRun(job, () => runDiagnoseJob(job))
}

async function runDiagnoseJob(job: Job): Promise<Job | null> {
  const book = getBook(job.bookId)
  const question = job.payload.question
  if (!book || !question) throw new Error('诊断任务缺少参数')
  activeJobId = job.id
  updateJob(job.id, { state: 'running', step: 'report', watchdogAt: Date.now(), error: '' })
  const report = await genDiagnose(book, job.lineId, question)
  note(job.id, 'report', '导演诊断已出')
  return updateJob(job.id, { state: 'done', step: 'report', payload: { report }, watchdogAt: 0 })
}

// ── 自由对话（M5 智能体页：跟导演聊剧情/问问题/出主意；进串行队列不抢写作） ──

export async function startChat(bookId: string, text: string): Promise<Job> {
  const book = getBook(bookId)
  if (!book) throw new Error('书不存在')
  const line = activeLine(book)
  if (!line) throw new Error('书没有激活线')
  const t = text.trim()
  if (!t) throw new Error('消息不能为空')
  const job = insertJob({ bookId, lineId: line.id, kind: 'chat', payload: { question: t } })
  userMsg(bookId, t, job.id, 'chat')
  return enqueueOrRun(job, () => runChatJob(job))
}

async function runChatJob(job: Job): Promise<Job | null> {
  const book = getBook(job.bookId)
  const question = job.payload.question
  if (!book || !question) throw new Error('对话任务缺少参数')
  activeJobId = job.id
  updateJob(job.id, { state: 'running', step: 'draft', watchdogAt: Date.now(), error: '' })
  const history = listMessages(job.bookId, { limit: 40 })
    .filter((m): m is ChatMessageRow => m.meta?.kind === 'chat' && m.content !== question)
    .slice(-12)
  const answer = await genChat(book, job.lineId, history, question, streamingSaver(job.id))
  appendMessage({
    bookId: job.bookId,
    role: 'assistant',
    content: answer,
    meta: { kind: 'chat', jobId: job.id }
  })
  return updateJob(job.id, {
    state: 'done',
    step: '',
    payload: { answer, draftText: undefined },
    watchdogAt: 0
  })
}

/** 空闲立即跑（guarded），忙则排队（pump 自动衔接） */
function enqueueOrRun(job: Job, run: () => Promise<Job | null>): Promise<Job> {
  if (busy()) return Promise.resolve(job)
  return guarded(job.id, run)
}

/** 每 8 章自动排一次跨章审计（M4；去重：同书已有在途/待跑 audit 不重复排） */
function maybeQueueAudit(bookId: string, lineId: string): void {
  const existing = listJobs(bookId, 50).some(
    (j) =>
      j.kind === 'audit' &&
      j.lineId === lineId &&
      j.state !== 'done' &&
      j.state !== 'failed' &&
      j.state !== 'cancelled'
  )
  if (existing) return
  insertJob({ bookId, lineId, kind: 'audit' })
  void pump().catch(() => {})
}

/** 取消（W11：主动取消=作废整章；二次确认由 UI 承担） */
export function cancelJob(jobId: string): Job {
  const job = requireJob(jobId)
  if (job.state === 'done') throw new Error('任务已完成，无法取消')
  const cancelled = updateJob(jobId, { state: 'cancelled', watchdogAt: 0 })
  if (cancelled) emitJob(cancelled)
  note(jobId, 'cancelled', '已按你的要求取消')
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
