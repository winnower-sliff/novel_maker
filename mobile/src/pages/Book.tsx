import { useBackHandler } from '@mobile/lib/backHandler'
import AgentChat from '@mobile/pages/AgentChat'
import Read from '@mobile/pages/Read'
import Write from '@mobile/pages/Write'
import CharsSub from '@mobile/pages/subs/CharsSub'
import OutlineSub from '@mobile/pages/subs/OutlineSub'
import PremiseSub from '@mobile/pages/subs/PremiseSub'
import WorldSub from '@mobile/pages/subs/WorldSub'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'

type BookTab = 'read' | 'write' | 'agent'

/** 写作 tab 内的二级子页（按创作流程顺序，门禁逐级解锁） */
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

/** 书内壳：一级 tab（阅读/写作/智能体）+ 写作内 5 子页顶栏切换。
 *  projectId=null 为创建模式：仅「基本设定」，projectCreate 后经 onCreated 交还调用方。
 *  门禁：前一步完成才能点亮下一步（完成=设定存档/世界观>0/人物>0/大纲>0）；写作子页恒开。
 *  子页位置记忆在 localStorage，无记录落第一个未完成页。 */
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
  const [tab, setTab] = useState<BookTab>('write')
  const [sub, setSub] = useState<SubPage>('premise')

  // Book 内子视图（编辑器/阅读页/AiBar）各自注册返回键；都没注册（栈里只剩 Book）时，返回键回书架
  useBackHandler(onClose)

  // —— 门禁数据（创建模式不查）——
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
  const gatesReady =
    !enabled || (projects.length > 0 && [wb, chars, outlines].every((l) => Array.isArray(l)))
  const planDone = !!projectId && projects.some((p: Project) => p.id === projectId && !!p.wizardPlan)
  const done: Record<SubPage, boolean> = {
    premise: planDone,
    world: wb.length > 0,
    chars: chars.length > 0,
    outline: outlines.length > 0,
    sub: true
  }
  const unlocked: Record<SubPage, boolean> = {
    premise: true,
    world: done.premise,
    chars: done.premise && done.world,
    outline: done.premise && done.world && done.chars,
    sub: true
  }

  // 位置记忆：进书一次性初始化（记住上次子页；无记录/已锁定则落第一个未完成页）
  const initRef = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅进书初始化一次，门禁后续变化不重置位置
  useEffect(() => {
    if (!projectId || !gatesReady) return
    if (initRef.current === projectId) return
    initRef.current = projectId
    const saved = localStorage.getItem(subStorageKey(projectId)) as SubPage | null
    if (saved && unlocked[saved]) {
      setSub(saved)
      return
    }
    setSub(SUBS.find((s) => !done[s.key])?.key ?? 'sub')
  }, [projectId, gatesReady])

  // 位置持久化
  useEffect(() => {
    if (projectId) localStorage.setItem(subStorageKey(projectId), sub)
  }, [projectId, sub])

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
          {SUBS.map((s) => {
            const ok = unlocked[s.key]
            return (
              <button
                type="button"
                key={s.key}
                disabled={!ok}
                onClick={() => setSub(s.key)}
                className={`flex-1 cursor-pointer py-2 text-xs disabled:cursor-default ${
                  sub === s.key
                    ? 'border-b-2 border-amber-500/80 font-medium text-amber-400'
                    : ok
                      ? 'text-zinc-400'
                      : 'text-zinc-700'
                }`}
              >
                {ok ? s.label : `🔒${s.label}`}
              </button>
            )
          })}
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-hidden">
        {tab === 'read' && <Read projectId={projectId} />}
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
