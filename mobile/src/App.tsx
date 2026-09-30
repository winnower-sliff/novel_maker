import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import AgentChat from '@mobile/pages/AgentChat'
import Codex from '@mobile/pages/Codex'
import Connect from '@mobile/pages/Connect'
import Home from '@mobile/pages/Home'
import More from '@mobile/pages/More'
import Write from '@mobile/pages/Write'
import { useConnStore } from '@mobile/lib/conn'

type Page = 'home' | 'write' | 'agent' | 'codex' | 'more'

const PAGES: Array<{ key: Page; label: string; icon: string }> = [
  { key: 'home', label: '书架', icon: '📚' },
  { key: 'write', label: '写作', icon: '✍️' },
  { key: 'agent', label: '智能体', icon: '🤖' },
  { key: 'codex', label: '设定', icon: '📖' },
  { key: 'more', label: '更多', icon: '⋯' }
]

export default function App() {
  const conn = useConnStore((s) => s.conn)
  const [page, setPage] = useState<Page>('home')
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => window.api.settings.get(),
    enabled: !!conn
  })
  const projectId = settings?.currentProjectId ?? ''

  if (!conn) return <Connect />

  return (
    <div className="flex h-full flex-col">
      <main className="min-h-0 flex-1 overflow-y-auto">
        {page === 'home' && <Home currentProjectId={projectId} />}
        {page === 'write' && <Write projectId={projectId} />}
        {page === 'agent' && <AgentChat projectId={projectId} />}
        {page === 'codex' && <Codex projectId={projectId} />}
        {page === 'more' && <More />}
      </main>
      <nav className="flex border-t border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)]">
        {PAGES.map((p) => (
          <button
            type="button"
            key={p.key}
            onClick={() => setPage(p.key)}
            className={`flex flex-1 cursor-pointer flex-col items-center gap-0.5 py-2 text-[11px] ${
              page === p.key ? 'text-amber-400' : 'text-zinc-500'
            }`}
          >
            <span className="text-lg leading-none">{p.icon}</span>
            {p.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
