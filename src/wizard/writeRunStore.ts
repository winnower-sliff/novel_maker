// 写作页运行态全局容器：批量自动写作与单章生成的进度/结果全部存放于此，
// 组件（桌面 Writing / 手机 Write）切走再回来不丢进度，生成在模块级闭包中继续。
// 事件桥在本模块首次使用时挂一次 llm 订阅，按 requestId 路由，不依赖任何组件存活。
import type { ChapterBrief, ContextPart, ReviewResult } from '@shared/types'
import { create } from 'zustand'
import { fmtTokens } from '../renderer/src/lib/format'
import type { DonePayload } from '../renderer/src/lib/ipc'
import { qk } from '../renderer/src/lib/queries'
import { queryClient } from '../renderer/src/lib/queryClient'

export interface LintIssue {
  rule: string
  level: 'major' | 'minor'
  quote: string
  advice: string
}

export interface LintReport {
  issues: LintIssue[]
  score: number
  pass: boolean
  wordCount: number
  targetWords: number | null
}

export interface CheckIssue {
  type: string
  quote: string
  issue: string
  fix: string
}

export type WriteBusy =
  | 'chapter'
  | 'summary'
  | 'polish'
  | 'expand'
  | 'check'
  | 'review'
  | 'stateSync'
  | null

export interface CandidateSetState {
  list: Array<{ text: string; score: number; wordCount: number; issues: number; pass: boolean }>
  winnerIndex: number
  selectedIndex: number
}

export interface CandidateDiff {
  kind: 'polish' | 'expand'
  text: string
}

export interface WriteBatchState {
  projectId: string
  running: boolean
  paused: boolean
  done: number
  total: number
  currentNo: number
  log: string[]
}

/** 单章流式生成（chapter/polish/expand）：事件桥按 requestId 写入，组件按章消费 */
export interface ChapterRun {
  projectId: string
  chapterId: string
  kind: 'chapter' | 'polish' | 'expand'
  requestId: string | null
  /** chapter 流：编辑器正文累积；候选模式下完成后被替换为最优候选文本 */
  editorText: string
  /** polish/expand 流：候选稿累积 */
  candidateText: string
  finished: boolean
  /** 组件已把结果回填编辑器/卡片 */
  consumed: boolean
}

interface WriteRunStore {
  batch: WriteBatchState | null
  resumeIds: string[] | null
  batchOpen: boolean
  busy: WriteBusy
  run: ChapterRun | null
  notice: string
  lastUsage: DonePayload | null
  candidate: CandidateDiff | null
  candidateSet: CandidateSetState | null
  lintReport: LintReport | null
  checkResult: { issues: CheckIssue[]; parsed: boolean } | null
  reviewResult: ReviewResult | null
  ctxPreview: ContextPart[] | null
}

export const useWriteRunStore = create<WriteRunStore>(() => ({
  batch: null,
  resumeIds: null,
  batchOpen: false,
  busy: null,
  run: null,
  notice: '',
  lastUsage: null,
  candidate: null,
  candidateSet: null,
  lintReport: null,
  checkResult: null,
  reviewResult: null,
  ctxPreview: null
}))

const S = useWriteRunStore

/** 自动写作推荐范围：起章=第一个没有正文的章，止章=最后一个有大纲的章；无未写章返回 null */
export function suggestBatchRange(briefs: ChapterBrief[]): { from: string; to: string } | null {
  const firstUnwritten = briefs.find((b) => !b.hasDraft)
  if (!firstUnwritten || briefs.length === 0) return null
  return { from: firstUnwritten.id, to: briefs[briefs.length - 1].id }
}

export function patchBatch(p: Partial<WriteBatchState>): void {
  S.setState((s) => (s.batch ? { batch: { ...s.batch, ...p } } : s))
}

export function appendBatchLog(line: string): void {
  S.setState((s) => (s.batch ? { batch: { ...s.batch, log: [...s.batch.log, line] } } : s))
}

/** 打开单章流：记录 requestId 前 run 已就位（事件到达时按 requestId 匹配） */
export function beginChapterRun(
  projectId: string,
  chapterId: string,
  kind: 'chapter' | 'polish' | 'expand'
): void {
  S.setState({
    run: {
      projectId,
      chapterId,
      kind,
      requestId: null,
      editorText: '',
      candidateText: '',
      finished: false,
      consumed: false
    }
  })
}

export function markRunConsumed(): void {
  S.setState((s) => (s.run ? { run: { ...s.run, consumed: true } } : s))
}

// —— 章节完成 payload 形状（与主进程 chapter/polish/expand afterDone 对齐）——

interface ChapterDoneData {
  chapterId?: string
  wordCount?: number
  contextParts?: ContextPart[]
  contextTokens?: number
  longMode?: boolean
  segments?: number
  lint?: LintReport
  error?: string
  candidateMode?: boolean
  winnerIndex?: number
  candidates?: Array<{
    text: string
    score: number
    wordCount: number
    issues: number
    pass: boolean
  }>
}

let bridgeReady = false

/** 挂全局 llm 事件桥（幂等）。在写作页组件挂载时调用即可，事件处理不依赖组件存活 */
export function ensureWriteRunBridge(): void {
  if (bridgeReady) return
  bridgeReady = true

  const handleRunDone = (id: string, payload: DonePayload): void => {
    const { run } = S.getState()
    if (!run || run.requestId !== id) return
    S.setState({ lastUsage: payload, busy: null, run: { ...run, finished: true } })
    if (payload.action === 'chapter') {
      const d = payload.data as ChapterDoneData
      const lint = d.lint ?? null
      S.setState({ lintReport: lint })
      if (d.candidateMode && d.candidates && d.candidates.length > 0) {
        const wi = d.winnerIndex ?? 0
        S.setState((s) => ({
          candidateSet: { list: d.candidates ?? [], winnerIndex: wi, selectedIndex: wi },
          run: s.run
            ? { ...s.run, editorText: (d.candidates ?? [])[wi]?.text ?? s.run.editorText }
            : s.run
        }))
      }
      S.setState({
        notice: d.error
          ? `生成完成但保存失败：${d.error}`
          : d.candidateMode
            ? `已生成 ${d.candidates?.length ?? 0} 个候选，最优第 ${(d.winnerIndex ?? 0) + 1} 个（已存入编辑器，可在对比卡中切换）`
            : `初稿完成：${d.wordCount ?? 0} 字 · 上下文约 ${fmtTokens(d.contextTokens ?? 0)} tokens${
                lint && !lint.pass ? ` · 硬闸 ${lint.issues.length} 项待处理` : ''
              }`,
        ctxPreview: d.contextParts ?? null
      })
      void queryClient.invalidateQueries({
        queryKey: qk.chapterBriefs(run.projectId)
      })
    } else if (payload.action === 'polish' || payload.action === 'expand') {
      S.setState((s) => ({
        candidate: {
          kind: payload.action as 'polish' | 'expand',
          text: s.run?.candidateText ?? ''
        },
        notice:
          payload.action === 'polish'
            ? '润色稿已生成：在下方 diff 视图逐块取舍后应用（不会直接覆盖原稿）'
            : '扩写稿已生成：在下方 diff 视图逐块取舍后应用（不会直接覆盖原稿）'
      }))
    }
  }

  const handleRunError = (id: string, message: string): void => {
    const { run } = S.getState()
    if (!run || run.requestId !== id) return
    S.setState({ busy: null, notice: `出错：${message}`, run: { ...run, finished: true } })
  }

  // 断连补拉：SSE 重连成功或页面回前台时查询在途单章 run 与批量的最新状态，
  // 主进程已完成/已失败的合成对应处理（与真实事件同一条路径，保证编辑器回填不丢）
  const pollRun = (): void => {
    const { run, batch } = S.getState()
    const rid = run?.requestId
    if (run && rid && !run.finished) {
      void window.api.llm
        .poll({ requestIds: [rid] })
        .then((recs) => {
          const rec = recs[rid]
          if (!rec || rec.status === 'running') return
          if (rec.status === 'done') handleRunDone(rid, rec.donePayload as DonePayload)
          else handleRunError(rid, rec.error ?? '生成失败')
        })
        .catch(() => {})
    }
    if (batch?.running) {
      void window.api.write
        .batchStatus({ projectId: batch.projectId })
        .then((snap) => {
          if (!snap) return
          S.setState({ batch: snap, resumeIds: snap.resumeIds })
        })
        .catch(() => {})
    }
  }
  window.addEventListener('nm-sse-state', ((e: CustomEvent<string>) => {
    if (e.detail === 'open') pollRun()
  }) as EventListener)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pollRun()
  })

  // 批量进度事件（主进程编排）：快照直接落 store；一轮跑完时失效章节列表
  window.api.write.onBatch((projectId, snap) => {
    const prev = S.getState().batch
    const wasRunning = prev?.running ?? false
    S.setState({ batch: snap, resumeIds: snap.resumeIds })
    if (wasRunning && !snap.running) {
      void queryClient.invalidateQueries({ queryKey: qk.chapterBriefs(projectId) })
    }
  })

  window.api.llm.onDelta((id, text) => {
    const { run } = S.getState()
    if (!run || run.requestId !== id || run.finished) return
    if (run.kind === 'chapter') {
      S.setState((s) => (s.run ? { run: { ...s.run, editorText: s.run.editorText + text } } : s))
    } else {
      S.setState((s) =>
        s.run ? { run: { ...s.run, candidateText: s.run.candidateText + text } } : s
      )
    }
  })

  window.api.llm.onDone((id, payload) => handleRunDone(id, payload))

  window.api.llm.onError((id, message) => handleRunError(id, message))

  window.api.llm.onNotice((_id, message) => {
    S.setState({ notice: message })
  })
}
