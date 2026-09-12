import { useMemo, useSyncExternalStore } from 'react'
import type { WorldbuildGenParams } from '@shared/types'
import { runPipeline } from './ipc'
import { pushToast } from './toastStore'

export type WbGenStatus = 'retrieving' | 'running' | 'done' | 'error'

export interface WbGenTask {
  id: number
  projectId: string
  categories: string[]
  title: string
  brief: string
  count?: number
  output: string
  status: WbGenStatus
  entryIds: string[]
  error: string | null
  seen: boolean
}

export type WbGenParams = WorldbuildGenParams

export interface WbNavBadge {
  tone: 'running' | 'done' | 'error' | 'mixed'
  pulse: boolean
}

let tasks: WbGenTask[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}

const DELTA_THROTTLE_MS = 100
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let lastEmitAt = 0

function emitNow(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  lastEmitAt = Date.now()
  emit()
}

function emitThrottled(): void {
  if (pendingTimer) return
  const wait = Math.max(0, DELTA_THROTTLE_MS - (Date.now() - lastEmitAt))
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    lastEmitAt = Date.now()
    emit()
  }, wait)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function patch(id: number, p: Partial<WbGenTask>, throttled = false): void {
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...p } : t))
  if (throttled) emitThrottled()
  else emitNow()
}

function isLive(s: WbGenStatus): boolean {
  return s === 'running' || s === 'retrieving'
}

export function startGen(params: WbGenParams): void {
  const key = params.categories.join(',')
  const dup = tasks.some(
    (t) =>
      isLive(t.status) &&
      t.projectId === params.projectId &&
      t.categories.join(',') === key &&
      t.title === params.title
  )
  if (dup) return
  const id = nextId++
  tasks = [
    ...tasks,
    {
      id,
      projectId: params.projectId,
      categories: params.categories,
      title: params.title,
      brief: params.brief,
      count: params.count,
      output: '',
      status: 'retrieving',
      entryIds: [],
      error: null,
      seen: false
    }
  ]
  emitNow()
  runPipeline(
    'worldbuild',
    params,
    (text) => {
      const cur = tasks.find((t) => t.id === id)
      if (cur && isLive(cur.status)) {
        patch(id, { status: 'running', output: (cur.output + text).slice(-8000) }, true)
      }
    },
    () => patch(id, { status: 'running' })
  )
    .then((payload) => {
      const d = payload.data as { entryIds?: string[]; error?: string } | undefined
      if (d?.error) {
        patch(id, { status: 'error', error: `生成完成但保存失败：${d.error}` })
        pushToast('error', `「${params.title || params.brief.slice(0, 12)}」保存失败`)
        return
      }
      patch(id, { status: 'done', entryIds: d?.entryIds ?? [] })
      const n = d?.entryIds?.length ?? 0
      pushToast('success', `已生成并保存 ${n} 个条目`)
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      patch(id, { status: 'error', error: msg })
      pushToast('error', `生成失败：${msg}`)
    })
}

export function retryTask(id: number): void {
  const t = tasks.find((x) => x.id === id)
  if (!t || isLive(t.status)) return
  tasks = tasks.filter((x) => x.id !== id)
  emitNow()
  startGen({
    projectId: t.projectId,
    categories: t.categories,
    title: t.title,
    brief: t.brief,
    count: t.count
  })
}

export function dismissTask(id: number): void {
  tasks = tasks.filter((t) => t.id !== id)
  emitNow()
}

export function markSeen(): void {
  let changed = false
  const next: WbGenTask[] = []
  for (const t of tasks) {
    if (isLive(t.status) || t.status === 'error') {
      if (t.status === 'error' && !t.seen) {
        next.push({ ...t, seen: true })
        changed = true
      } else {
        next.push(t)
      }
    } else if (t.seen) {
      changed = true
    } else {
      next.push({ ...t, seen: true })
      changed = true
    }
  }
  if (changed) {
    tasks = next
    emitNow()
  }
}

export function useWbGenTasks(projectId: string): WbGenTask[] {
  const all = useSyncExternalStore(subscribe, () => tasks)
  return useMemo(() => all.filter((t) => t.projectId === projectId), [all, projectId])
}

const BADGE_RUNNING: WbNavBadge = { tone: 'running', pulse: true }
const BADGE_DONE: WbNavBadge = { tone: 'done', pulse: false }
const BADGE_ERROR: WbNavBadge = { tone: 'error', pulse: false }
const BADGE_MIXED: WbNavBadge = { tone: 'mixed', pulse: false }

function aggregateBadge(): WbNavBadge | null {
  if (tasks.some((t) => isLive(t.status))) return BADGE_RUNNING
  const relevant = tasks.filter((t) => !t.seen)
  const done = relevant.some((t) => t.status === 'done')
  const error = relevant.some((t) => t.status === 'error')
  if (done && error) return BADGE_MIXED
  if (done) return BADGE_DONE
  if (error) return BADGE_ERROR
  return null
}

export function useWbGenNavBadge(): WbNavBadge | null {
  return useSyncExternalStore(subscribe, aggregateBadge)
}
