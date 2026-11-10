import type { ChatMessage, Job, JobPayload } from '../shared/types.js'
import { interceptorDefs, runAgentLoop } from './agent/loop.js'
import { toolDefs } from './agent/tools.js'
import { emitJob, emitJobActivity, emitJobDelta, emitMessageAppend } from './broadcast.js'
import { isQuotaError } from './director/callJson.js'
import {
  applyRevisePlan,
  compactMemories,
  genAudit,
  genChapterPlan,
  genDiagnose,
  genReview,
  genRevisePlan,
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
  getJob,
  getLine,
  insertJob,
  listJobs,
  listMessages,
  previousChapter,
  replaceChapterContent,
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
  pushMessage({
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
  pushMessage({
    bookId,
    role: 'user',
    content,
    meta: jobId ? { kind, jobId } : { kind }
  })
}

/** 落库+广播：聊天流新行实时推给前端（message:append），运行中也能上墙 */
function pushMessage(input: Parameters<typeof appendMessage>[0]): void {
  const row = appendMessage(input)
  if (row) emitMessageAppend(row)
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
    write: runAgentWriteJob,
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
    const raw = String((err as Error)?.message ?? err)
    const quota = isQuotaError(err)
    const failed = updateJob(jobId, {
      state: 'failed',
      error: quota
        ? `额度不足：模型账户余额/额度已耗尽（${raw}）。请到对应平台充值后，回来点「重试」。`
        : raw
    })
    if (failed) {
      note(jobId, 'failed', quota ? failed.error : `卡住了：${failed.error}`)
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

/** 导演白话流式（chat 气泡）：delta 带累计长度 total，前端失配即全量补拉（服务端唯一真相源）；
 * reset() 供 agent 每轮开始清空（新一轮 total 从 0 重计，旧流让位给已落库消息卡） */
type Saver = ((t: string) => void) & { reset: () => void }
function chatSaver(jobId: string): Saver {
  let acc = ''
  let lastSave = 0
  const fn = (t: string) => {
    acc += t
    emitJobDelta(jobId, 'text', t, acc.length)
    const now = Date.now()
    if (now - lastSave > 3000) {
      lastSave = now
      updateJob(jobId, { payload: { answer: acc } })
    }
  }
  fn.reset = () => {
    acc = ''
    updateJob(jobId, { payload: { answer: '' } })
  }
  return fn
}

/** 思考链流式（思考卡内实时刷新）：与 chatSaver 同款节流落盘 payload.thinkingText */
function thinkSaver(jobId: string): Saver {
  let acc = ''
  let lastSave = 0
  const fn = (t: string) => {
    acc += t
    emitJobDelta(jobId, 'thinking', t, acc.length)
    const now = Date.now()
    if (now - lastSave > 3000) {
      lastSave = now
      updateJob(jobId, { payload: { thinkingText: acc } })
    }
  }
  fn.reset = () => {
    acc = ''
    updateJob(jobId, { payload: { thinkingText: '' } })
  }
  return fn
}

/** agent say 落库工厂：工具卡同时实时广播（job:activity） */
function agentSay(
  jobId: string,
  bookId: string
): (content: string, meta?: Record<string, unknown>) => void {
  return (content, meta) => {
    pushMessage({ bookId, role: 'assistant', content, meta: { jobId, ...meta } })
    if (meta?.kind === 'tool') {
      emitJobActivity(jobId, {
        tool: String(meta.tool ?? ''),
        summary: String(meta.summary ?? ''),
        ok: meta.ok !== false
      })
    }
  }
}

// ── 各步执行 ─────────────────────────────────────────────────────────────────

/** 写章直通入口（走向卡已废除，用户决策：聊天驱动，agent 自主定走向）。 */
async function runAgentWriteJob(job: Job): Promise<Job | null> {
  const book = getBook(job.bookId)
  if (book?.planMode) return runPlanJob(job)
  const direction = job.payload.direction ?? {
    source: 'free' as const,
    text: job.payload.directionHint ?? ''
  }
  return runAgentChapterJob(job, direction)
}

// ── 计划模式（书级开关：先出计划书，作者过目后才动笔；等待期可聊） ────────────

async function runPlanJob(job: Job): Promise<Job | null> {
  const book = getBook(job.bookId)
  if (!book) throw new Error('书不存在')
  updateJob(job.id, { state: 'running', step: 'plan', watchdogAt: Date.now(), error: '' })
  const plan = await genChapterPlan(book, job.lineId, job.payload.directionHint ?? '')
  updateJob(job.id, { state: 'waiting_user', step: 'plan', payload: { plan }, watchdogAt: 0 })
  note(job.id, 'plan', '本章计划已出，等你过目')
  return getJob(job.id)
}

/** 作者点「按计划执行」：计划+补充作为走向，进 agent 全流程。 */
export async function approvePlan(jobId: string, feedback?: string): Promise<Job> {
  const job = requireJob(jobId)
  if (job.kind !== 'write' || job.state !== 'waiting_user' || job.step !== 'plan') {
    throw new Error('当前不在计划确认环节')
  }
  const plan = job.payload.plan ?? ''
  userMsg(job.bookId, '按计划写')
  const direction = {
    source: 'free' as const,
    text: `${plan}${feedback ? `；作者补充：${feedback}` : ''}`
  }
  return (await runAgentChapterJob(job, direction)) ?? job
}

// ── 公开 API（handlers 调用） ────────────────────────────────────────────────

export async function startWrite(bookId: string, hint?: string): Promise<Job> {
  const book = getBook(bookId)
  if (!book) throw new Error('书不存在')
  const line = activeLine(book)
  if (!line) throw new Error('书没有激活线')
  if (busy()) {
    return insertJob({
      bookId,
      lineId: line.id,
      kind: 'write',
      payload: hint ? { directionHint: hint.slice(0, 300) } : undefined
    })
  }
  const job = insertJob({
    bookId,
    lineId: line.id,
    kind: 'write',
    payload: hint ? { directionHint: hint.slice(0, 300) } : undefined
  })
  userMsg(
    bookId,
    hint
      ? `写第 ${effectiveChapters(line.id).length + 1} 章（倾向：${hint.slice(0, 80)}）`
      : `写第 ${effectiveChapters(line.id).length + 1} 章`
  )
  activeJobId = job.id
  return guarded(job.id, () => runAgentWriteJob(job))
}

/**
 * M6+ agent 自主段：写章全流程（查资料→拟大纲→写正文→自检→入书→沉淀）。
 * 走向卡已废除（用户决策：聊天驱动）——direction 来自聊天意图/作者倾向，agent 自主定具体走向。
 */
async function runAgentChapterJob(
  job: Job,
  direction: NonNullable<JobPayload['direction']>
): Promise<Job | null> {
  const book = getBook(job.bookId)
  if (!book) throw new Error('书不存在')
  updateJob(job.id, { state: 'running', step: 'agent', watchdogAt: Date.now(), error: '' })
  const chapterNo = effectiveChapters(job.lineId).length + 1
  const task = direction.text
    ? `写第 ${chapterNo} 章。作者给出的倾向：${direction.text}。据此定具体走向，按写章任务纪律自主完成全流程。`
    : `写第 ${chapterNo} 章。作者没有给倾向：综合现状卡、伏笔与前文自主定走向，按写章任务纪律自主完成全流程。`
  const result = await runAgentLoop({
    jobId: job.id,
    bookId: job.bookId,
    task,
    history: [],
    mode: 'chapter',
    tools: [...toolDefs(), ...interceptorDefs('chapter')],
    onDelta: chatSaver(job.id),
    say: agentSay(job.id, job.bookId),
    onTurn: () => updateJob(job.id, { watchdogAt: Date.now() }),
    onChapterCommitted: (chapter, extra) => {
      note(job.id, 'chapter', `《${chapter.title}》已入书`)
      updateJob(job.id, {
        chapterId: chapter.id,
        payload: {
          draftText: chapter.content,
          draftWordCount: chapter.wordCount,
          recap: {
            summary: extra.summary,
            stateChanges: [],
            cardOps: [],
            foreshadowOps: [],
            quickActions: extra.quickActions
          }
        }
      })
      const b2 = getBook(job.bookId)
      if (b2) {
        void compactMemories(b2, job.lineId, effectiveChapters(job.lineId)).catch(() => {})
        const n = effectiveChapters(job.lineId).length
        if (n > 0 && n % 8 === 0) maybeQueueAudit(job.bookId, job.lineId)
      }
    }
  })
  return updateJob(job.id, {
    state: 'done',
    step: '',
    payload: { answer: result.text },
    watchdogAt: 0
  })
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
    // 走向卡已废除：一律从 agent 段重跑（倾向从 payload.direction/directionHint 带上；计划模式重出计划）
    return await runAgentWriteJob(job)
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
  const plan = await genRevisePlan({
    book,
    lineId: job.lineId,
    chapter,
    instruction: revise.instruction,
    segment: revise.segment
  })
  const applied = applyRevisePlan(chapter.content, plan)
  if ('noHit' in applied)
    throw new Error('改稿未命中原文：find 引文在原文中找不到，请重新圈定原文逐字片段')
  // 改章自检只报告不入闸：字数类指令（加长/缩短）天然会偏 targetWords，不参与字数检查；
  // 结果附在 payload.lint 供 UI 展示，问题大由作者再发指令
  const prev = previousChapter(job.lineId)
  const report = selfCheck(
    { ...book, targetWords: 0 },
    job.lineId,
    applied.next,
    prev?.content?.slice(-400)
  )
  const clean = stripHtmlComments(applied.next)
  replaceChapterContent(revise.chapterId, clean)
  note(job.id, 'revised', `《${chapter.title}》已按指令改好`)
  return updateJob(job.id, {
    state: 'done',
    step: 'finalize',
    payload: {
      draftText: clean,
      draftWordCount: clean.replace(/\s/g, '').length,
      lint: report,
      reviseMode:
        applied.mode === 'rewrite' ? '整章重写' : `局部修改 ${applied.applied}/${applied.total} 处`
    },
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
  updateJob(job.id, { state: 'running', step: 'agent', watchdogAt: Date.now(), error: '' })
  // 对话历史投影：只带文本 chat 消息（user+assistant），工具卡/动作不回灌
  const history: ChatMessage[] = listMessages(job.bookId, { limit: 40 })
    .filter((m) => m.meta?.kind === 'chat' && m.content !== question)
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }))
  // 计划模式：同书有等待确认的计划时，让导演看得到计划（等待期可聊）
  const waitingPlan = listJobs(job.bookId, 50).find(
    (j) => j.id !== job.id && j.kind === 'write' && j.state === 'waiting_user' && j.step === 'plan'
  )
  const planBlock = waitingPlan?.payload.plan
    ? `\n\n〔本章计划（等作者过目中，作者聊的内容可能与此相关）〕\n${waitingPlan.payload.plan}`
    : ''
  // 轮开始清空流式缓冲（新一轮从 0 计流，落库消息卡接管旧内容）
  const cs = chatSaver(job.id)
  const ts = thinkSaver(job.id)
  const result = await runAgentLoop({
    jobId: job.id,
    bookId: job.bookId,
    task: question + planBlock,
    history,
    mode: 'free',
    tools: [...toolDefs(), ...interceptorDefs('free')],
    onDelta: cs,
    onThinking: ts,
    // chat 白话链路开思考（思考折叠区 UI）；写章/改章链路保持默认 disabled
    thinking: 'enabled',
    say: agentSay(job.id, job.bookId),
    onTurn: () => {
      updateJob(job.id, { watchdogAt: Date.now() })
      cs.reset()
      ts.reset()
    },
    // 意图动作（对话驱动开章/审读/审计）：避免 loop→jobs 循环依赖，经 actions 注入
    actions: {
      startChapter: (hint) => {
        void startWrite(job.bookId, hint).catch(() => {})
        return hint ? `写章任务已排队（方向倾向已带上：${hint.slice(0, 60)}）` : '写章任务已排队'
      },
      review: async (chapterId) => {
        const line = activeLine(getBook(job.bookId) ?? book)
        const ch =
          (chapterId ? getChapter(chapterId) : undefined) ?? previousChapter(line?.id ?? job.lineId)
        if (!ch) return '没有可审读的章节'
        const b = getBook(job.bookId) ?? book
        const report = await genReview(b, ch.lineId, ch)
        return `《${ch.title}》审读报告（${report.score} 分）：${report.verdict}\n维度发现：${report.findings
          .map((f) => `[${f.dimension}/${f.level}] ${f.comment}`)
          .join('；')}\n建议：${report.suggestions.join('；')}`
      },
      audit: async () => {
        const b = getBook(job.bookId) ?? book
        const chapters = effectiveChapters(job.lineId)
        if (chapters.length < 2) return '章节太少（不足 2 章），无从审计'
        const recent = chapters.slice(-10).map((c) => ({
          orderNo: c.orderNo,
          title: c.title,
          summary: c.summary
        }))
        const report = await genAudit(b, job.lineId, recent, chapters.slice(-2))
        return `全书审计报告（${report.score} 分）：${report.verdict}\n${report.findings
          .map((f) => `[${f.dimension}/${f.level}] ${f.comment}`)
          .join('；')}\n建议：${report.suggestions.join('；')}`
      }
    }
  })
  // loop 未落白话时（直接 finish）补一条，保证对话流有回音
  if (
    result.text &&
    !listMessages(job.bookId, { limit: 3 }).some((m) => m.content === result.text)
  ) {
    pushMessage({
      bookId: job.bookId,
      role: 'assistant',
      content: result.text,
      meta: { kind: 'chat', jobId: job.id }
    })
  }
  return updateJob(job.id, {
    state: 'done',
    step: '',
    payload: { answer: result.text },
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
