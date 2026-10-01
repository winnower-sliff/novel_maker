import { splitHeadingHashtags } from '@shared/tags'
import type { WorldbuildGenParams } from '@shared/types'
import { useMemo } from 'react'
import { create } from 'zustand'
import { qk } from '../renderer/src/lib/queries'
import { queryClient } from '../renderer/src/lib/queryClient'
import { runPipeline } from './pipeline'
import { pushToast } from './toastStore'

export type WbGenStatus = 'retrieving' | 'running'

export interface WbGenTask {
  id: number
  projectId: string
  categories: string[]
  title: string
  brief: string
  count?: number
  tags: string[]
  output: string
  status: WbGenStatus
  committedCount: number
  entryIds: string[]
  revisedIds: string[]
  createdTypes: string[]
  allowNewType: boolean
  allowUpdate: boolean
}

export interface WbLiveSection {
  taskId: number
  category: string | null
  title: string
  tags: string[]
  content: string
  active: boolean
}

export type WbGenParams = WorldbuildGenParams

export interface WbNavBadge {
  tone: 'running' | 'done'
  pulse: boolean
}

const SECTION_HEADING = /^#{1,3}\s*(?:\[([^\]]*)\]\s*)?(.+?)\s*$/

interface RawSection {
  category: string | null
  title: string
  tags: string[]
  content: string
  raw: string
}

function splitSections(output: string): RawSection[] {
  const sections: RawSection[] = []
  let current: (Omit<RawSection, 'raw'> & { rawHeading: string }) | null = null
  for (const line of output.split(/\r?\n/)) {
    const m = SECTION_HEADING.exec(line)
    if (m && (m[1] || current)) {
      if (current) {
        sections.push({
          category: current.category,
          title: current.title,
          tags: current.tags,
          content: current.content,
          raw: `${current.rawHeading}\n${current.content}`
        })
      }
      const { title, tags } = splitHeadingHashtags(m[2])
      current = { category: m[1]?.trim() || null, title, tags, content: '', rawHeading: line }
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line
    }
  }
  if (current) {
    sections.push({
      category: current.category,
      title: current.title,
      tags: current.tags,
      content: current.content,
      raw: `${current.rawHeading}\n${current.content}`
    })
  }
  return sections
}

interface WbStoreState {
  tasks: WbGenTask[]
  savedSeq: number
  newIdsVersion: number
  revisedIdsVersion: number
}

const useWbStore = create<WbStoreState>(() => ({
  tasks: [],
  savedSeq: 0,
  newIdsVersion: 0,
  revisedIdsVersion: 0
}))

let nextId = 1
const newEntryIds = new Map<string, string>()
const revisedEntryIds = new Map<string, string>()
const commitChains = new Map<number, Promise<unknown>>()

interface ScanState {
  scanned: number
  lineBuf: string
}
const scanStates = new Map<number, ScanState>()
const HEADING_LIKE_RE = /^#{1,3}\s/

const DELTA_THROTTLE_MS = 100
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let lastEmitAt = 0

function emitNow(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  lastEmitAt = Date.now()
  useWbStore.setState((s) => s)
}

function emitThrottled(): void {
  if (pendingTimer) return
  const wait = Math.max(0, DELTA_THROTTLE_MS - (Date.now() - lastEmitAt))
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    lastEmitAt = Date.now()
    emitNow()
  }, wait)
}

function patch(id: number, p: Partial<WbGenTask>, throttled = false): void {
  useWbStore.setState((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...p } : t))
  }))
  if (throttled) emitThrottled()
  else emitNow()
}

function bumpVersions(): void {
  useWbStore.setState((s) => ({
    savedSeq: s.savedSeq + 1,
    newIdsVersion: s.newIdsVersion + 1,
    revisedIdsVersion: s.revisedIdsVersion + 1
  }))
}

function removeTask(id: number): void {
  useWbStore.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
  commitChains.delete(id)
  scanStates.delete(id)
  emitNow()
}

function scanForHeadings(id: number, output: string): void {
  let st = scanStates.get(id)
  if (!st) {
    st = { scanned: 0, lineBuf: '' }
    scanStates.set(id, st)
  }
  if (st.scanned > output.length) {
    st.scanned = 0
    st.lineBuf = ''
  }
  const chunk = st.lineBuf + output.slice(st.scanned)
  st.scanned = output.length
  const lines = chunk.split('\n')
  st.lineBuf = lines.pop() ?? ''
  let sawHeading = false
  for (const line of lines) {
    if (HEADING_LIKE_RE.test(line)) sawHeading = true
  }
  if (!sawHeading) return
  const cur = useWbStore.getState().tasks.find((t) => t.id === id)
  if (!cur) return
  void commitReadySections(id, splitSections(cur.output).length - 1)
}

async function commitReadySections(id: number, completeCount: number): Promise<void> {
  const task = useWbStore.getState().tasks.find((t) => t.id === id)
  if (!task || completeCount <= task.committedCount) return
  const from = task.committedCount
  const sections = splitSections(task.output)
  if (completeCount > sections.length) completeCount = sections.length
  if (completeCount <= from) return
  const rawChunk = sections
    .slice(from, completeCount)
    .map((s) => s.raw)
    .join('\n\n')
  const prev = commitChains.get(id) ?? Promise.resolve()
  const p = prev.then(() =>
    window.api.novel.worldbuildCommitChunk(task.projectId, rawChunk, task.categories, {
      allowNewType: task.allowNewType,
      taskEntryIds: task.entryIds,
      allowUpdate: task.allowUpdate
    })
  )
  commitChains.set(id, p)
  try {
    const r = await p
    const cur = useWbStore.getState().tasks.find((t) => t.id === id)
    if (!cur) return
    const revisedSet = new Set(r.revisedIds)
    for (const eid of r.entryIds) {
      if (!revisedSet.has(eid)) newEntryIds.set(eid, cur.projectId)
    }
    for (const eid of r.revisedIds) revisedEntryIds.set(eid, cur.projectId)
    bumpVersions()
    void queryClient.invalidateQueries({ queryKey: qk.worldbuild(cur.projectId) })
    patch(
      id,
      {
        committedCount: Math.max(cur.committedCount, completeCount),
        entryIds: [...cur.entryIds, ...r.entryIds],
        revisedIds: [...cur.revisedIds, ...r.revisedIds],
        createdTypes: [...cur.createdTypes, ...r.createdTypes],
        allowNewType: cur.allowNewType && r.createdTypes.length === 0
      },
      true
    )
    emitNow()
  } catch (err) {
    const cur = useWbStore.getState().tasks.find((t) => t.id === id)
    if (!cur) return
    patch(id, { committedCount: Math.max(cur.committedCount, completeCount) }, true)
    pushToast(
      'error',
      `条目入库失败，已跳过该批：${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export function startGen(params: WbGenParams): void {
  const key = params.categories.join(',')
  const dup = useWbStore
    .getState()
    .tasks.some(
      (t) =>
        t.projectId === params.projectId &&
        t.categories.join(',') === key &&
        t.title === params.title
    )
  if (dup) return
  const id = nextId++
  useWbStore.setState((s) => ({
    tasks: [
      ...s.tasks,
      {
        id,
        projectId: params.projectId,
        categories: params.categories,
        title: params.title,
        brief: params.brief,
        count: params.count,
        tags: params.tags ?? [],
        output: '',
        status: 'retrieving',
        committedCount: 0,
        entryIds: [],
        revisedIds: [],
        createdTypes: [],
        allowNewType: true,
        allowUpdate: params.allowUpdate === true
      }
    ]
  }))
  emitNow()
  const briefPreview = params.brief.trim().slice(0, 30)
  pushToast(
    'success',
    `已开始生成：${briefPreview}${params.brief.trim().length > 30 ? '…' : ''}（可在条目列表查看进度）`
  )
  runPipeline(
    'worldbuild',
    params,
    (text) => {
      const cur = useWbStore.getState().tasks.find((t) => t.id === id)
      if (cur) {
        const output = cur.output + text
        patch(id, { status: 'running', output }, true)
        scanForHeadings(id, output)
      }
    },
    () => patch(id, { status: 'running' })
  )
    .then(async (payload) => {
      const task = useWbStore.getState().tasks.find((t) => t.id === id)
      if (!task) return
      const sections = splitSections(task.output)
      const truncated = payload.stopReason === 'max_tokens'
      const finalCount = truncated ? Math.max(0, sections.length - 1) : sections.length
      await commitReadySections(id, finalCount)
      const done = useWbStore.getState().tasks.find((t) => t.id === id)
      if (!done) return
      if (done.entryIds.length > 0) {
        try {
          await window.api.novel.worldbuildRelink(done.projectId, done.entryIds)
        } catch {
          /* 补链失败不阻塞收尾 */
        }
        const typeNote =
          done.createdTypes.length > 0 ? `，新建类型：${done.createdTypes.join('、')}` : ''
        const truncNote = truncated ? '（输出被截断，已丢弃最后 1 个不完整条目）' : ''
        const reviseNote =
          done.revisedIds.length > 0 ? `，修订已有条目 ${done.revisedIds.length} 个（橙点）` : ''
        pushToast(
          'success',
          `已生成入库 ${done.entryIds.length - done.revisedIds.length} 个条目${reviseNote}${typeNote}${truncNote}`
        )
      } else {
        pushToast('error', '未解析到有效条目，可重试或调整需求')
      }
      removeTask(id)
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      pushToast('error', `生成失败：${msg}（已入库的条目会保留）`)
      removeTask(id)
    })
}

export function markEntrySeen(ids: string | string[]): void {
  const list = Array.isArray(ids) ? ids : [ids]
  let changed = false
  for (const id of list) {
    if (newEntryIds.delete(id)) changed = true
    if (revisedEntryIds.delete(id)) changed = true
  }
  if (changed) {
    useWbStore.setState((s) => ({
      newIdsVersion: s.newIdsVersion + 1,
      revisedIdsVersion: s.revisedIdsVersion + 1
    }))
    emitNow()
  }
}

export function useWbGenTasks(projectId: string): WbGenTask[] {
  const all = useWbStore((s) => s.tasks)
  return useMemo(() => all.filter((t) => t.projectId === projectId), [all, projectId])
}

export function useWbLiveEntries(projectId: string): WbLiveSection[] {
  const all = useWbStore((s) => s.tasks)
  return useMemo(() => {
    const out: WbLiveSection[] = []
    for (const t of all) {
      if (t.projectId !== projectId) continue
      const sections = splitSections(t.output)
      sections.forEach((s, i) => {
        if (i < t.committedCount) return
        out.push({
          taskId: t.id,
          category: s.category,
          title: s.title,
          tags: s.tags,
          content: s.content,
          active: t.status === 'running' && i === sections.length - 1
        })
      })
    }
    return out
  }, [all, projectId])
}

export function useNewEntryIds(projectId: string): string[] {
  const version = useWbStore((s) => s.newIdsVersion)
  // biome-ignore lint/correctness/useExhaustiveDependencies: dep 仅作重触发信号，加入会破坏语义
  return useMemo(
    () => [...newEntryIds.entries()].filter(([, pid]) => pid === projectId).map(([id]) => id),
    [version, projectId]
  )
}

export function useRevisedEntryIds(projectId: string): string[] {
  const version = useWbStore((s) => s.revisedIdsVersion)
  // biome-ignore lint/correctness/useExhaustiveDependencies: dep 仅作重触发信号，加入会破坏语义
  return useMemo(
    () => [...revisedEntryIds.entries()].filter(([, pid]) => pid === projectId).map(([id]) => id),
    [version, projectId]
  )
}

export function useWbSavedSeq(): number {
  return useWbStore((s) => s.savedSeq)
}

const BADGE_RUNNING: WbNavBadge = { tone: 'running', pulse: true }
const BADGE_DONE: WbNavBadge = { tone: 'done', pulse: false }

export function useWbGenNavBadge(): WbNavBadge | null {
  return useWbStore((s) => {
    if (s.tasks.length > 0) return BADGE_RUNNING
    if (newEntryIds.size > 0 || revisedEntryIds.size > 0) return BADGE_DONE
    return null
  })
}
