import { providerPreset } from '@shared/providers'
import { useQuery } from '@tanstack/react-query'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import { CreationWizard } from './components/CreationWizard'
import { Toaster } from './components/Toaster'
import { markAgentSeen, useAgentNavBadge } from './lib/agentUiStore'
import { fmtTokens } from './lib/format'
import type { Navigate, Page } from './lib/nav'
import { qk, queries } from './lib/queries'
import { queryClient } from './lib/queryClient'
import { useWbGenNavBadge } from './lib/wbGenStore'
import Agent from './pages/Agent'
import Characters from './pages/Characters'
import Foreshadows from './pages/Foreshadows'
import GraphPage from './pages/GraphPage'
import Outline from './pages/Outline'
import Playground from './pages/Playground'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import Skills from './pages/Skills'
import Usage from './pages/Usage'
import Worldbuild from './pages/Worldbuild'
import Writing from './pages/Writing'

interface NavItem {
  id: Page
  label: string
  icon: ReactElement
}

const CREATIVE_PAGES: ReadonlySet<Page> = new Set([
  'agent',
  'graph',
  'writing',
  'outline',
  'characters',
  'worldbuild',
  'foreshadows'
])

const GROUP_CREATIVE: NavItem[] = [
  {
    id: 'agent',
    label: '智能体',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <rect x="4" y="7" width="16" height="12" rx="3" />
        <path d="M12 7V4M8 4h8" strokeLinecap="round" />
        <circle cx="9" cy="13" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="15" cy="13" r="1.4" fill="currentColor" stroke="none" />
      </svg>
    )
  },
  {
    id: 'graph',
    label: '图谱',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <circle cx="6" cy="6" r="2.4" />
        <circle cx="18" cy="7" r="2.4" />
        <circle cx="12" cy="17" r="2.4" />
        <path d="M8.2 7 15.7 7M7 8.3l4 6.6M16.9 9.2l-3.6 5.6" strokeLinecap="round" />
      </svg>
    )
  },
  {
    id: 'worldbuild',
    label: '世界观',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z" />
      </svg>
    )
  },
  {
    id: 'characters',
    label: '人物',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <circle cx="9" cy="8" r="3.5" />
        <path
          d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5M16 4.6a3.5 3.5 0 0 1 0 6.8M17.5 15.4c1.8.7 3 2.2 3 4.6"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  {
    id: 'outline',
    label: '大纲',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" strokeLinecap="round" />
      </svg>
    )
  },
  {
    id: 'writing',
    label: '写作台',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <path d="m16.5 3.5 4 4L8 20l-5 1 1-5L16.5 3.5Z" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    id: 'foreshadows',
    label: '伏笔',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <path
          d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"
          strokeLinecap="round"
        />
        <circle cx="12" cy="12" r="3" />
      </svg>
    )
  }
]

const GROUP_SYSTEM: NavItem[] = [
  {
    id: 'playground',
    label: '试写',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <path d="M4 6h16M4 12h10M4 18h7" strokeLinecap="round" />
      </svg>
    )
  },
  {
    id: 'skills',
    label: '技能',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    id: 'usage',
    label: '用量',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeLinecap="round" />
      </svg>
    )
  },
  {
    id: 'settings',
    label: '设置',
    icon: (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="h-4 w-4"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
      </svg>
    )
  }
]

const WB_BADGE_DOT: Record<string, string> = {
  running: 'bg-amber-500 animate-pulse',
  done: 'bg-emerald-500',
  error: 'bg-red-500',
  mixed: 'bg-amber-400'
}

const AGENT_BADGE_DOT: Record<string, string> = {
  running: 'bg-amber-500 animate-pulse',
  confirming: 'bg-red-500 animate-pulse',
  done: 'bg-emerald-500',
  error: 'bg-red-500'
}

export default function App() {
  const [page, setPage] = useState<Page>('projects')
  const [writingFocus, setWritingFocus] = useState<string | null>(null)
  const [graphFocus, setGraphFocus] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const wbBadge = useWbGenNavBadge()
  const agentBadge = useAgentNavBadge()

  const statsQ = useQuery({ ...queries.usageStats(), refetchInterval: 30_000 })
  const settingsQ = useQuery(queries.settings())
  const projectsQ = useQuery(queries.projects())

  const stats = statsQ.data ?? null
  const cfg = settingsQ.data ?? null
  const projectsList = projectsQ.data ?? []
  const currentProject = cfg?.currentProjectId
    ? (projectsList.find((p) => p.id === cfg.currentProjectId) ?? null)
    : null

  // 事件驱动的跨页失效：LLM 流完成 → 小说数据域 + 额度；agent 完成 → 全量失效
  useEffect(() => {
    const offDone = window.api.llm.onDone((_rid, p) => {
      void queryClient.invalidateQueries({ queryKey: qk.novel })
      void queryClient.invalidateQueries({ queryKey: qk.usageStats })
      void queryClient.invalidateQueries({ queryKey: qk.usageList(200) })
      if (p.action === 'chapter' || p.action === 'summary') {
        void queryClient.invalidateQueries({
          queryKey: qk.chapterBriefs(cfg?.currentProjectId ?? '')
        })
      }
    })
    const offError = window.api.llm.onError(() => {
      void queryClient.invalidateQueries({ queryKey: qk.usageStats })
    })
    const offAgentDone = window.api.agent.onDone(() => {
      void queryClient.invalidateQueries()
    })
    return () => {
      offDone()
      offError()
      offAgentDone()
    }
  }, [cfg?.currentProjectId])

  const switchProject = useCallback((id: string) => {
    void window.api.settings.save({ currentProjectId: id }).then(() => {
      void queryClient.invalidateQueries({ queryKey: qk.settings })
      void queryClient.invalidateQueries({ queryKey: qk.projects })
    })
  }, [])

  const navigate = useCallback<Navigate>(
    (target, focusOutlineId, graphNodeId) => {
      setNavOpen(false)
      const blocked = cfg !== null && !cfg.currentProjectId && CREATIVE_PAGES.has(target)
      const finalTarget = blocked ? 'projects' : target
      setPage(finalTarget)
      setWritingFocus(finalTarget === 'writing' ? (focusOutlineId ?? null) : null)
      setGraphFocus(finalTarget === 'graph' ? (graphNodeId ?? null) : null)
    },
    [cfg]
  )

  const clearGraphFocus = useCallback((): void => setGraphFocus(null), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: dep 仅作重触发信号，加入会破坏语义
  useEffect(() => {
    if (page === 'agent') markAgentSeen()
  }, [page, agentBadge])

  const quotaPct =
    cfg && cfg.quota5hPrompts > 0
      ? Math.min(100, ((stats?.window5h.requests ?? 0) / cfg.quota5hPrompts) * 100)
      : null

  const renderNav = (items: NavItem[]) =>
    items.map((item) => (
      <button
        type="button"
        key={item.id}
        onClick={() => navigate(item.id)}
        className={`flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
          page === item.id
            ? 'bg-zinc-800 font-medium text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
        }`}
      >
        {item.icon}
        {item.label}
        {item.id === 'worldbuild' && wbBadge && (
          <span className={`ml-auto h-2 w-2 shrink-0 rounded-full ${WB_BADGE_DOT[wbBadge.tone]}`} />
        )}
        {item.id === 'agent' && page !== item.id && agentBadge && (
          <span
            className={`ml-auto h-2 w-2 shrink-0 rounded-full ${AGENT_BADGE_DOT[agentBadge.tone]}`}
          />
        )}
      </button>
    ))

  return (
    <div className="flex h-full flex-col">
      <Toaster />
      <CreationWizard onNavigate={navigate} />
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/95 px-3 pt-[env(safe-area-inset-top)] md:hidden">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="打开导航"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-5 w-5"
          >
            <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
          </svg>
        </button>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="h-5 w-5 shrink-0 text-amber-500"
        >
          <path d="M12 6.5C10.5 5 8.5 4.5 4.5 4.5v13c4 0 6 .5 7.5 2 1.5-1.5 3.5-2 7.5-2v-13c-4 0-6 .5-7.5 2Z" />
          <path d="M12 6.5v13" />
        </svg>
        <span className="truncate text-sm font-medium text-zinc-100">
          {currentProject ? currentProject.title : 'Novel Maker'}
        </span>
        <button
          type="button"
          onClick={() => navigate('projects')}
          className="ml-auto shrink-0 cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          项目
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        {navOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            aria-hidden="true"
            onClick={() => setNavOpen(false)}
          />
        )}
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900 transition-transform duration-200 md:static md:z-auto md:w-52 md:translate-x-0 ${
            navOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center gap-2.5 px-4 py-4">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="h-7 w-7 text-amber-500"
            >
              <path d="M12 6.5C10.5 5 8.5 4.5 4.5 4.5v13c4 0 6 .5 7.5 2 1.5-1.5 3.5-2 7.5-2v-13c-4 0-6 .5-7.5 2Z" />
              <path d="M12 6.5v13" />
            </svg>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-zinc-100">Novel Maker</div>
              <div className="text-[10px] text-zinc-500">
                {cfg ? `${providerPreset(cfg.provider).label} 长篇创作` : '长篇创作'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              aria-label="关闭导航"
              className="ml-auto flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 md:hidden"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="h-4 w-4"
              >
                <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="relative mx-3">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="w-full cursor-pointer rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-left transition-colors hover:border-zinc-700"
            >
              <div className="text-[10px] text-zinc-500">当前项目</div>
              <div className="flex items-center gap-1">
                <span className="truncate text-xs font-medium text-zinc-200">
                  {currentProject ? currentProject.title : '选择或新建项目'}
                </span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className={`ml-auto h-3 w-3 shrink-0 text-zinc-500 transition-transform ${menuOpen ? 'rotate-180' : ''}`}
                >
                  <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </button>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  aria-hidden="true"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
                  <div className="max-h-64 overflow-y-auto p-1">
                    {projectsList.length === 0 && (
                      <div className="px-2.5 py-2 text-xs text-zinc-600">还没有项目</div>
                    )}
                    {projectsList.map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        onClick={() => {
                          setMenuOpen(false)
                          if (p.id !== currentProject?.id) switchProject(p.id)
                          navigate('projects')
                        }}
                        className={`flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors ${
                          p.id === currentProject?.id
                            ? 'bg-zinc-800 font-medium text-zinc-100'
                            : 'text-zinc-300 hover:bg-zinc-800/60'
                        }`}
                      >
                        <span className="truncate">{p.title}</span>
                        {p.genre && (
                          <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                            {p.genre}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-zinc-800 p-1">
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false)
                        navigate('projects')
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
                    >
                      ＋ 新建项目…
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <nav className="mt-3 flex-1 space-y-4 overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
            <div className="space-y-1">
              <div className="px-3 pb-1 text-[10px] font-medium tracking-wider text-zinc-600">
                创作
              </div>
              {renderNav(GROUP_CREATIVE)}
            </div>
            <div className="space-y-1">
              <div className="px-3 pb-1 text-[10px] font-medium tracking-wider text-zinc-600">
                系统
              </div>
              {renderNav(GROUP_SYSTEM)}
            </div>
          </nav>
          <div className="px-4 py-3 text-[10px] text-zinc-600">v0.2.0 · M3</div>
        </aside>
        <main className="flex-1 overflow-hidden">
          {page === 'projects' && (
            <Projects
              currentProjectId={cfg?.currentProjectId ?? ''}
              onSwitch={switchProject}
              onNavigate={navigate}
            />
          )}
          <div className={page === 'agent' ? 'h-full' : 'hidden'}>
            <Agent projectId={currentProject?.id ?? ''} />
          </div>
          {page === 'graph' && (
            <GraphPage
              projectId={currentProject?.id ?? ''}
              onNavigate={navigate}
              focusNodeId={graphFocus}
              onFocusConsumed={clearGraphFocus}
            />
          )}
          {page === 'writing' && (
            <Writing
              projectId={currentProject?.id ?? ''}
              onNavigate={navigate}
              focusOutlineId={writingFocus}
              onFocusConsumed={() => setWritingFocus(null)}
            />
          )}
          {page === 'outline' && (
            <Outline projectId={currentProject?.id ?? ''} onNavigate={navigate} />
          )}
          {page === 'characters' && (
            <Characters projectId={currentProject?.id ?? ''} onNavigate={navigate} />
          )}
          {page === 'worldbuild' && (
            <Worldbuild projectId={currentProject?.id ?? ''} onNavigate={navigate} />
          )}
          {page === 'foreshadows' && (
            <Foreshadows projectId={currentProject?.id ?? ''} onNavigate={navigate} />
          )}
          {page === 'playground' && <Playground />}
          {page === 'skills' && <Skills />}
          {page === 'usage' && <Usage />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
      <footer className="hidden h-8 shrink-0 border-t border-zinc-800 bg-zinc-900/80 md:block">
        <button
          type="button"
          className="flex h-full w-full cursor-pointer items-center gap-4 overflow-x-auto px-4 text-left text-[11px] text-zinc-500 hover:text-zinc-300"
          onClick={() => setPage('usage')}
        >
          <span>
            默认模型 <span className="font-mono text-zinc-300">{cfg?.defaultModel ?? '—'}</span>
          </span>
          <span>
            5h 窗口 <span className="font-mono text-zinc-300">{stats?.window5h.requests ?? 0}</span>{' '}
            次请求
            {cfg && cfg.quota5hPrompts > 0 && (
              <span className="font-mono"> / {cfg.quota5hPrompts}</span>
            )}
          </span>
          <span>
            入{' '}
            <span className="font-mono text-zinc-300">
              {fmtTokens(stats?.window5h.inputTokens ?? 0)}
            </span>
          </span>
          <span>
            出{' '}
            <span className="font-mono text-zinc-300">
              {fmtTokens(stats?.window5h.outputTokens ?? 0)}
            </span>
          </span>
          {quotaPct !== null && (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="h-1.5 w-28 overflow-hidden rounded-full bg-zinc-800">
                <span
                  className={`block h-full rounded-full ${
                    quotaPct >= 90
                      ? 'bg-red-500'
                      : quotaPct >= 70
                        ? 'bg-amber-500'
                        : 'bg-emerald-600'
                  }`}
                  style={{ width: `${quotaPct}%` }}
                />
              </span>
              {quotaPct.toFixed(0)}%
            </span>
          )}
          <span className={quotaPct !== null ? '' : 'ml-auto'}>
            缓存{cfg?.promptCache === false ? '关' : '开'}
          </span>
        </button>
      </footer>
    </div>
  )
}
