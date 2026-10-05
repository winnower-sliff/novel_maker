import { useBackHandler } from '@mobile/lib/backHandler'
import AgentConfirmBanner from '@mobile/components/AgentConfirmBanner'
import AgentChat from '@mobile/pages/AgentChat'
import Read from '@mobile/pages/Read'
import Write from '@mobile/pages/Write'
import CharsSub from '@mobile/pages/subs/CharsSub'
import OutlineSub from '@mobile/pages/subs/OutlineSub'
import PremiseSub from '@mobile/pages/subs/PremiseSub'
import WorldSub from '@mobile/pages/subs/WorldSub'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { ChapterBrief, Project } from '@shared/types'
import { useAnyAgentRunning } from '@wizard/agentRunStore'
import { prefetchBook, putBriefs, getCachedBriefs } from '@mobile/lib/readerCache'
import { useSettingsStore } from '@mobile/lib/settingsStore'
import { useReaderChromeStore } from '@mobile/lib/readerChromeStore'
import type { ReactNode } from 'react'

type BookTab = 'read' | 'write' | 'agent'

/** 写作 tab 内的二级子页（按创作流程顺序排列） */
export type SubPage = 'premise' | 'world' | 'chars' | 'outline' | 'sub'

const SUBS: Array<{ key: SubPage; label: string }> = [
  { key: 'premise', label: '基本设定' },
  { key: 'world', label: '世界观' },
  { key: 'chars', label: '人物设定' },
  { key: 'outline', label: '卷章大纲' },
  { key: 'sub', label: '写作' }
]

const TABS: Array<{ key: BookTab; label: string }> = [
  { key: 'read', label: '阅读' },
  { key: 'write', label: '写作' },
  { key: 'agent', label: '智能体' }
]

const SUB_KEYS: readonly string[] = SUBS.map((s) => s.key)
const isSubPage = (v: unknown): v is SubPage => typeof v === 'string' && SUB_KEYS.includes(v)
const isBookTab = (v: unknown): v is BookTab =>
  v === 'read' || v === 'write' || v === 'agent'

/** 进书第一帧同步读 store（App 对 settings 水合做 ready 门控，此处必是恢复后的值） */
function loadTab(pid: string): BookTab {
  const saved = useSettingsStore.getState().bookUi[pid]?.tab
  return isBookTab(saved) ? saved : 'write'
}

function loadSub(pid: string): SubPage {
  const saved = useSettingsStore.getState().bookUi[pid]?.sub
  return isSubPage(saved) ? saved : 'premise'
}

/** 书内壳：一级 tab（阅读/写作/智能体）+ 写作内 5 子页顶栏切换。
 *  projectId=null 为创建模式：仅「基本设定」，projectCreate 后经 onCreated 交还调用方。
 *  子页不设硬门禁（桌面端也没有），仅弱引导：第一个未完成子页标「下一步」。
 *  位置记忆无条件恢复：进书第一帧同步读 localStorage（换书时渲染期重派生），无纠偏无等待。 */
export default function Book({
  projectId,
  title,
  onClose,
  onCreated
}: {
  projectId: string | null
  title: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [tab, setTab] = useState<BookTab>(() => loadTab(projectId ?? 'new'))
  // 智能体任意会话运行中 → 「智能体」tab 标运行圆点
  const agentBusy = useAnyAgentRunning()
  const [sub, setSub] = useState<SubPage>(() => loadSub(projectId ?? 'new'))
  // 阅读正文态聚焦模式：书名行/tab 行与阅读页上下栏三层联动同收同展
  const chromeActive = useReaderChromeStore((s) => s.active)
  const chromeVisible = useReaderChromeStore((s) => s.visible)
  const chromeCollapsed = chromeActive && !chromeVisible

  /** 壳层收展动画 wrapper（grid-rows 0fr/1fr，与 Read.tsx chromeWrap 同款） */
  const collapseWrap = (inner: ReactNode): ReactNode => (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out ${
        chromeCollapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
      }`}
    >
      <div className="min-h-0 overflow-hidden">{inner}</div>
    </div>
  )

  // 换书时组件不 remount（App 无 key），渲染期检测 pid 变化同步重读位置（官方 derive-state 模式）
  const [prevPid, setPrevPid] = useState<string | null>(projectId)
  if (projectId !== prevPid) {
    setPrevPid(projectId)
    if (projectId) {
      setTab(loadTab(projectId))
      setSub(loadSub(projectId))
    }
  }

  // Book 内子视图（编辑器/阅读页/AiBar）各自注册返回键；都没注册（栈里只剩 Book）时，返回键回书架
  useBackHandler(onClose)

  const qc = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  // 顶栏手动刷新：等价原下拉刷新（全量 novel），外加当前书智能体会话
  const refreshBook = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void Promise.all([
      qc.invalidateQueries({ queryKey: ['novel'] }),
      qc.invalidateQueries({ queryKey: ['agentSessions', projectId] })
    ])
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }

  // —— 弱引导数据（只用于标「下一步」，不阻塞进书与位置恢复；创建模式不查）——
  const enabled = !!projectId
  const { data: projects = [] } = useQuery({
    queryKey: ['novel', 'projects'],
    queryFn: () => window.api.novel.projects(),
    enabled
  })
  const { data: wb = [] } = useQuery({
    queryKey: ['novel', 'worldbuild', projectId ?? ''],
    queryFn: () => window.api.novel.worldbuild(projectId!),
    enabled
  })
  const { data: chars = [] } = useQuery({
    queryKey: ['novel', 'characters', projectId ?? ''],
    queryFn: () => window.api.novel.characters(projectId!),
    enabled
  })
  const { data: outlines = [] } = useQuery({
    queryKey: ['novel', 'outlines', projectId ?? ''],
    queryFn: () => window.api.novel.outlines(projectId!),
    enabled
  })
  // 目录（顺带缓存快照）：进书即整本预取正文，无论落在哪个 tab，不依赖「阅读」页挂载
  const { data: briefs = [] } = useQuery({
    queryKey: ['novel', 'chapterBriefs', projectId ?? ''],
    queryFn: async (): Promise<ChapterBrief[]> => {
      try {
        const fresh = await window.api.novel.chapterBriefs(projectId!)
        void putBriefs({ projectId: projectId!, title, briefs: fresh, cachedAt: Date.now() })
        return fresh
      } catch (err) {
        const cached = await getCachedBriefs(projectId!)
        if (cached) return cached.briefs
        throw err
      }
    },
    enabled
  })
  const written = useMemo(
    () =>
      briefs
        .filter((b) => b.hasDraft)
        .sort((a, b) => a.volume - b.volume || a.chapterNo - b.chapterNo),
    [briefs]
  )
  useEffect(() => {
    if (!projectId || written.length === 0) return
    void prefetchBook(projectId, written)
  }, [projectId, written])
  const planDone = !!projectId && projects.some((p: Project) => p.id === projectId && !!p.wizardPlan)
  // 基本设定视为已完成：走过 AI 起草（wizardPlan 存在），或项目本就有任何板块内容
  const done: Record<SubPage, boolean> = {
    premise: planDone || wb.length > 0 || chars.length > 0 || outlines.length > 0,
    world: wb.length > 0,
    chars: chars.length > 0,
    outline: outlines.length > 0,
    sub: true
  }
  const nextKey = SUBS.find((s) => !done[s.key])?.key

  // 位置持久化
  useEffect(() => {
    if (!projectId) return
    useSettingsStore.getState().setBookUi(projectId, { tab, sub })
  }, [projectId, tab, sub])

  if (!projectId)
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer px-2.5 py-1.5 text-xs text-zinc-400"
          >
            ← 书架
          </button>
          <div className="min-w-0 flex-1 py-1.5 text-center text-sm font-medium text-zinc-200">
            新建作品
          </div>
          <div className="w-14" />
        </div>
        <main className="min-h-0 flex-1 overflow-hidden">
          <PremiseSub projectId={null} onCreated={onCreated} />
        </main>
      </div>
    )

  return (
    <div className="flex h-full flex-col">
      {collapseWrap(
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2">
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer px-2.5 py-1.5 text-xs text-zinc-400"
        >
          ← 书架
        </button>
        <div className="min-w-0 flex-1 truncate py-1.5 text-center text-sm font-medium text-zinc-200">
          {title}
        </div>
        <div className="flex w-14 items-center justify-center">
          <button
            type="button"
            aria-label="刷新"
            onClick={refreshBook}
            className="cursor-pointer p-1.5 text-zinc-400 active:text-zinc-200"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
        </div>
      </div>
      )}
      {collapseWrap(
      <div className="flex border-b border-zinc-800 bg-zinc-950/95">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 py-2.5 text-sm ${
              tab === t.key
                ? 'border-b-2 border-amber-500 font-medium text-amber-400'
                : 'text-zinc-500'
            }`}
          >
            {t.label}
            {t.key === 'agent' && agentBusy && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-label="运行中" />
            )}
          </button>
        ))}
      </div>
      )}
      {tab === 'write' && (
        <div className="flex border-b border-zinc-800 bg-zinc-950/60">
          {SUBS.map((s) => (
            <button
              type="button"
              key={s.key}
              onClick={() => setSub(s.key)}
              className={`flex flex-1 cursor-pointer items-center justify-center gap-1 py-2 text-xs ${
                sub === s.key
                  ? 'border-b-2 border-amber-500/80 font-medium text-amber-400'
                  : 'text-zinc-400 active:text-zinc-200'
              }`}
            >
              {s.label}
              {s.key === nextKey && sub !== nextKey && (
                <span className="inline-block h-1 w-1 rounded-full bg-amber-400" aria-label="下一步" />
              )}
            </button>
          ))}
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-hidden">
        {tab === 'read' && <Read projectId={projectId} title={title} />}
        {tab === 'agent' && <AgentChat projectId={projectId} />}
        {tab === 'write' && (
          <>
            {sub === 'premise' && <PremiseSub projectId={projectId} onCreated={onCreated} />}
            {sub === 'world' && <WorldSub projectId={projectId} />}
            {sub === 'chars' && <CharsSub projectId={projectId} />}
            {sub === 'outline' && <OutlineSub projectId={projectId} />}
            {sub === 'sub' && <Write projectId={projectId} />}
          </>
        )}
      </main>
      <AgentConfirmBanner hidden={tab === 'agent'} />
    </div>
  )
}
