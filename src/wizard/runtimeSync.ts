// 中央同步器：根治「UI 状态依赖事件推送到达」类 bug（SSE 在手机 WebView 上不可靠：
// 熄屏冻结/切后台断连/重连时序）。原则=「推为加速、拉为兜底」——
// 事件到达照常更新，但任何丢失的事件都会在触发时机（回前台/SSE 重连/10s 定期）
// 被 runtime:snapshot 拉取纠正。组件只读 store，不关心事件是否到达。

import type { RuntimeSnapshot } from '@shared/types'
import type { DonePayload } from '../preload/index'
import { qk } from '../renderer/src/lib/queries'
import { queryClient } from '../renderer/src/lib/queryClient'
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

let ready = false
let lastTickAt = 0
/** 上次快照中各 run/batch 的状态：检测迁移用（首次不通知，避免历史完成重复打扰） */
const lastRunStatus = new Map<string, string>()
const lastBatchRunning = new Map<string, boolean>()

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
  }

  // —— 单章完成迁移通知 ——
  for (const r of snap.runs) {
    const prev = lastRunStatus.get(r.id)
    if (prev === 'running' && r.status !== 'running' && r.meta?.outlineId) {
      const missed = r.finishedAt !== undefined && r.finishedAt < lastTickAt
      if (r.status === 'done') fire('章节生成完成', '正文已就绪', 'success', missed)
      else fire('章节生成失败', r.error ?? '未知错误', 'error', missed)
    }
    lastRunStatus.set(r.id, r.status)
  }
}

function isActive(snap: RuntimeSnapshot): boolean {
  return (
    snap.runs.some((r) => r.status === 'running') ||
    snap.batches.some((b) => b.running) ||
    pollPending()
  )
}

function tick(force = false): void {
  const api = (window as { api?: typeof window.api } | undefined)?.api
  if (!api?.runtime) return
  if (!force) {
    const st = useWriteRunStore.getState()
    const localActive =
      (st.batch?.running ?? false) || (st.run !== null && !st.run.finished) || pollPending()
    if (!localActive) return
  }
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

  // 定时器常开：无活跃任务时 tick(false) 只做本地检查，开销接近零；
  // 有任务时自动进入 10s 兜底轮询，无需任务启动方显式登记
  setInterval(() => tick(false), POLL_MS)
  // 启动即拉一次：刷新/重开页面后恢复在途任务显示
  tick(true)
}
