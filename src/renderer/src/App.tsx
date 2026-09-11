import { useState, type ReactElement } from 'react'
import Playground from './pages/Playground'
import Settings from './pages/Settings'
import Usage from './pages/Usage'

type Page = 'playground' | 'usage' | 'settings'

const NAV: Array<{ id: Page; label: string; icon: ReactElement }> = [
  {
    id: 'playground',
    label: '试写',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
        <path d="M4 6h16M4 12h10M4 18h7" strokeLinecap="round" />
      </svg>
    )
  },
  {
    id: 'usage',
    label: '用量',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeLinecap="round" />
      </svg>
    )
  },
  {
    id: 'settings',
    label: '设置',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
      </svg>
    )
  }
]

export default function App() {
  const [page, setPage] = useState<Page>('playground')

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/80">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="h-7 w-7 text-amber-500"
          >
            <path d="M12 6.5C10.5 5 8.5 4.5 4.5 4.5v13c4 0 6 .5 7.5 2 1.5-1.5 3.5-2 7.5-2v-13c-4 0-6 .5-7.5 2Z" />
            <path d="M12 6.5v13" />
          </svg>
          <div>
            <div className="text-sm font-semibold text-zinc-100">Novel Maker</div>
            <div className="text-[10px] text-zinc-500">GLM 长篇创作</div>
          </div>
        </div>
        <nav className="mt-2 flex-1 space-y-1 px-2">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={`flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                page === item.id
                  ? 'bg-zinc-800 font-medium text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 text-[10px] text-zinc-600">v0.1.0 · M1</div>
      </aside>
      <main className="flex-1 overflow-hidden">
        {page === 'playground' && <Playground />}
        {page === 'usage' && <Usage />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  )
}
