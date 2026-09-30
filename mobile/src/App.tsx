import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import Book from '@mobile/pages/Book'
import Connect from '@mobile/pages/Connect'
import More from '@mobile/pages/More'
import Shelf from '@mobile/pages/Shelf'
import { useConnStore } from '@mobile/lib/conn'

type Page = 'shelf' | 'more'

const PAGES: Array<{ key: Page; label: string; icon: string }> = [
  { key: 'shelf', label: '书架', icon: '📚' },
  { key: 'more', label: '更多', icon: '⋯' }
]

export default function App() {
  const conn = useConnStore((s) => s.conn)
  const [page, setPage] = useState<Page>('shelf')
  const [bookId, setBookId] = useState<string | null>(null)
  const { data: projects } = useQuery({
    queryKey: ['novel', 'projects'],
    queryFn: () => window.api.novel.projects(),
    enabled: !!conn
  })
  const book = projects?.find((p) => p.id === bookId) ?? null

  if (!conn) return <Connect />

  if (bookId && book) {
    return (
      <Book projectId={bookId} title={book.title} onClose={() => setBookId(null)} />
    )
  }

  return (
    <div className="flex h-full flex-col">
      <main className="min-h-0 flex-1 overflow-y-auto">
        {page === 'shelf' && <Shelf onOpen={setBookId} />}
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
