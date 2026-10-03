// 中央同步器：根治「UI 状态依赖事件推送到达」类 bug（SSE 在手机 WebView 上不可靠：
// 熄屏冻结/切后台断连/重连时序）。原则=「推为加速、拉为兜底」——
// 事件到达照常更新，但任何丢失的事件都会在触发时机（回前台/SSE 重连/活跃 10s、空闲 60s 定期）
// 被 runtime:snapshot 拉取纠正。组件只读 store，不关心事件是否到达。

import type { CanonSyncResult, RuntimeSnapshot } from '@shared/types'
import type { DonePayload } from '../preload/index'
import { qk } from '../renderer/src/lib/queries'
import { queryClient } from '../renderer/src/lib/queryClient'
import { ingestCanonSync } from './canonStore'
import { notify } from './notify'
import { pollPending } from './pipeline'
import { pushToast } from './toastStore'
import {
  applyRunDone,
  applyRunError,
  beginChapterRun,
  useWriteRunStore,
  type WriteBatchState,
  type WriteBusy
} from './writeRunStore'

const POLL_MS = 10_000
/** 空闲期降频拉取：本地看似无任务，也可能存在「另一端启动/响应丢失未落 store」的任务 */
const IDLE_POLL_MS = 60_000

let ready = false
let lastTickAt = 0
let lastPullAt = 0
/** 上次快照中各 run/batch 的状态：检测迁移用（首次不通知，避免历史完成重复打扰） */
const lastRunStatus = new Map<string, string>()
const lastBatchRunning = new Map<string, boolean>()
/** 刷新后已提示过「后台大纲生成中」的 run：防每个 tick 重复 toast */
const outlineHinted = new Set<string>()
/**
 * 刷新后在途 orphan run（本页 promise 链已断，pendingRuns 无记录）：
 * 登记后 tick(false) 的 localActive 才包含它们，迁移检测（running→settle 补通知）才能持续工作
 */
const watchedRuns = new Set<string>()

function fire(title: string, body: string, tone: 'success' | 'error', missed: boolean): void {
  pushToast(tone, `${title}：${body}`)
  // 页面可见时 toast 足够；后台错过（回前台补发）或页面不在前台时发系统通知
  if (document.visibilityState !== 'visible' || missed) notify(title, body)
}

function applySnapshot(snap: RuntimeSnapshot): void {
  const st = useWriteRunStore.getState()

  // —— 批量：当前项目的快照落 store + 完成迁移通知 ——
  const curPid = st.batch?.projectId
  for (const b of snap.batches) {
    if (curPid === b.projectId) {
      useWriteRunStore.setState({ batch: b as WriteBatchState, resumeIds: b.resumeIds })
    }
    const prev = lastBatchRunning.get(b.projectId)
    if (prev === true && !b.running) {
      // 上次快照还在跑、这次才发现结束 → 大概率是后台期间完成的，补发系统通知
      fire(
        '自动写作',
        b.paused ? `已暂停（${b.done}/${b.total}），可继续` : `已完成 ${b.done}/${b.total} 章`,
        'success',
        true
      )
      void queryClient.invalidateQueries({ queryKey: qk.chapterBriefs(b.projectId) })
    }
    lastBatchRunning.set(b.projectId, b.running)
  }

  // —— 单章 run：在途补拉（与真实事件同一条应用路径）+ 刷新恢复 ——
  const run = useWriteRunStore.getState().run
  if (run?.requestId && !run.finished) {
    const rec = snap.runs.find((r) => r.id === run.requestId)
    if (rec?.status === 'done') applyRunDone(rec.id, rec.donePayload as DonePayload)
    else if (rec?.status === 'error') applyRunError(rec.id, rec.error ?? '生成失败')
  } else if (!run) {
    // 刷新后 store 为空：主进程仍在跑的单章生成 → 恢复 busy 与进度显示
    const runningBatches = new Set(snap.batches.filter((b) => b.running).map((b) => b.projectId))
    const orphan = snap.runs.find((r) => {
      const m = r.meta
      return (
        r.status === 'running' &&
        !!m?.outlineId &&
        !!m.projectId &&
        (m.action === 'chapter' || m.action === 'polish' || m.action === 'expand') &&
        !runningBatches.has(m.projectId)
      )
    })
    if (orphan?.meta?.outlineId && orphan.meta.projectId && orphan.meta.action) {
      beginChapterRun(
        orphan.meta.projectId,
        orphan.meta.outlineId,
        orphan.meta.action as 'chapter' | 'polish' | 'expand'
      )
      useWriteRunStore.setState((s) =>
        s.run
          ? {
              run: { ...s.run, requestId: orphan.id, restored: true },
              busy: orphan.meta?.action as WriteBusy
            }
          : s
      )
      pushToast('success', '检测到后台生成任务，已恢复进度显示')
    }
    // 刷新后主进程仍在跑的大纲批量生成：提示即可（落库由主进程 afterDone 负责，不受刷新影响）
    const orphanOutline = snap.runs.find(
      (r) => r.status === 'running' && r.meta?.action === 'outline' && r.meta?.projectId
    )
    if (orphanOutline) {
      watchedRuns.add(orphanOutline.id)
      if (!outlineHinted.has(orphanOutline.id)) {
        outlineHinted.add(orphanOutline.id)
        pushToast('success', '检测到后台大纲生成任务，完成后会自动导入')
      }
    }
    // 刷新后仍在跑的设定同步（canonSync）：提示 + 登记持续轮询（完成时由迁移检测 ingest 预览）
    const orphanCanon = snap.runs.find(
      (r) => r.status === 'running' && r.meta?.action === 'canonSync' && r.meta?.projectId
    )
    if (orphanCanon) {
      watchedRuns.add(orphanCanon.id)
      if (!outlineHinted.has(orphanCanon.id)) {
        outlineHinted.add(orphanCanon.id)
        pushToast('success', '检测到后台设定同步任务，完成后会提示确认')
      }
    }
  }

  // —— run 完成迁移通知（章节类 + 大纲类）——
  for (const r of snap.runs) {
    const prev = lastRunStatus.get(r.id)
    if (prev === 'running' && r.status !== 'running') {
      watchedRuns.delete(r.id)
      const m = r.meta
      const missed = r.finishedAt !== undefined && r.finishedAt < lastTickAt
      if (m?.outlineId) {
        if (r.status === 'done') fire('章节生成完成', '正文已就绪', 'success', missed)
        else fire('章节生成失败', r.error ?? '未知错误', 'error', missed)
      } else if (m?.action === 'outline' && m.projectId) {
        // 大纲分批生成在后台完成/失败：补通知 + 失效大纲缓存（列表页自动刷新）
        if (r.status === 'done') fire('大纲生成完成', '新大纲已导入', 'success', missed)
        else fire('大纲生成失败', r.error ?? '未知错误', 'error', missed)
        void queryClient.invalidateQueries({ queryKey: qk.outlines(m.projectId) })
      } else if (m?.action === 'canonSync' && m.projectId && r.status === 'done') {
        // 设定同步在后台完成：结果 ingest（挂预览/纯人物 toast，防重与文案由 canonStore 统一处理）；失败按共识静默
        const d = (r.donePayload as DonePayload | undefined)?.data as CanonSyncResult | undefined
        if (d) ingestCanonSync(m.projectId, r.meta?.volume ?? 0, d)
      }
    }
    lastRunStatus.set(r.id, r.status)
  }
}

function isActive(snap: RuntimeSnapshot): boolean {
  return (
    snap.runs.some((r) => r.status === 'running') ||
    snap.batches.some((b) => b.running) ||
    watchedRuns.size > 0 ||
    pollPending()
  )
}

function tick(force = false): void {
  const api = (window as { api?: typeof window.api } | undefined)?.api
  if (!api?.runtime) return
  if (!force) {
    const st = useWriteRunStore.getState()
    const localActive =
      (st.batch?.running ?? false) ||
      (st.run !== null && !st.run.finished) ||
      watchedRuns.size > 0 ||
      pollPending()
    // 空闲期不完全跳过：降频兜底拉取，否则「本地无记录的进行中任务」永远无法被发现
    if (!localActive && Date.now() - lastPullAt < IDLE_POLL_MS) return
  }
  lastPullAt = Date.now()
  void api.runtime
    .snapshot()
    .then((snap) => {
      applySnapshot(snap)
      lastTickAt = Date.now()
      void isActive(snap) // 顺带触发 pollPending，保证在途 pipeline promise 补拉
    })
    .catch((e: unknown) => {
      console.warn('[runtimeSync] snapshot tick failed:', e)
    })
}

/** 挂中央同步器（幂等）。在两端 App 根组件挂载（连接就绪）后调用即可 */
export function ensureRuntimeSync(): void {
  if (ready || typeof window === 'undefined') return
  ready = true

  const onWake = (): void => tick(true)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onWake()
  })
  window.addEventListener('nm-sse-state', ((e: CustomEvent<string>) => {
    if (e.detail === 'open') onWake()
  }) as EventListener)

  // 定时器常开：活跃任务 10s 兜底轮询；空闲期降频 60s 拉一次（发现响应丢失/跨端启动的任务）
  setInterval(() => tick(false), POLL_MS)
  // 启动即拉一次：刷新/重开页面后恢复在途任务显示
  tick(true)
}
