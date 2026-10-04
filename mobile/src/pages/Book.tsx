import { useBackHandler } from '@mobile/lib/backHandler'
import AgentChat from '@mobile/pages/AgentChat'
import Read from '@mobile/pages/Read'
import Write from '@mobile/pages/Write'
import CharsSub from '@mobile/pages/subs/CharsSub'
import OutlineSub from '@mobile/pages/subs/OutlineSub'
import PremiseSub from '@mobile/pages/subs/PremiseSub'
import WorldSub from '@mobile/pages/subs/WorldSub'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'

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

const subStorageKey = (pid: string): string => `nm-book-sub:${pid}`
const tabStorageKey = (pid: string): string => `nm-book-tab:${pid}`

const SUB_KEYS: readonly string[] = SUBS.map((s) => s.key)
const isSubPage = (v: string | null): v is SubPage => v !== null && SUB_KEYS.includes(v)
const isBookTab = (v: string | null): v is BookTab => v === 'read' || v === 'write' || v === 'agent'

function loadTab(pid: string): BookTab {
  const saved = localStorage.getItem(tabStorageKey(pid))
  return isBookTab(saved) ? saved : 'write'
}

function loadSub(pid: string): SubPage {
  const saved = localStorage.getItem(subStorageKey(pid))
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
  const [sub, setSub] = useState<SubPage>(() => loadSub(projectId ?? 'new'))

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
    localStorage.setItem(tabStorageKey(projectId), tab)
    localStorage.setItem(subStorageKey(projectId), sub)
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
        <div className="w-14" />
      </div>
      <div className="flex border-b border-zinc-800 bg-zinc-950/95">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 cursor-pointer py-2.5 text-sm ${
              tab === t.key
                ? 'border-b-2 border-amber-500 font-medium text-amber-400'
                : 'text-zinc-500'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
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
    </div>
  )
}
