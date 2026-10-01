import { useQuery } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import Book, { type BookNavRequest } from '@mobile/pages/Book'
import Connect from '@mobile/pages/Connect'
import More from '@mobile/pages/More'
import Shelf from '@mobile/pages/Shelf'
import { MobileToaster, WizardHost } from '@mobile/components/WizardHost'
import { useConnStore } from '@mobile/lib/conn'
import type { Page as NavPage } from '@renderer/lib/nav'

type Page = 'shelf' | 'more'

const PAGES: Array<{ key: Page; label: string; icon: string }> = [
  { key: 'shelf', label: '书架', icon: '📚' },
  { key: 'more', label: '更多', icon: '⋯' }
]

export default function App() {
  const conn = useConnStore((s) => s.conn)
  const [page, setPage] = useState<Page>('shelf')
  const [bookId, setBookId] = useState<string | null>(null)
  const [bookNav, setBookNav] = useState<BookNavRequest | null>(null)
  const consumeBookNav = useCallback(() => setBookNav(null), [])

  // 向导 step4 导航映射：写作台→write tab；板块→codex tab 并展开对应 section
  const handleWizardNav = useCallback(
    (dest: NavPage) => {
      const map: Partial<Record<NavPage, { tab: BookNavRequest['tab']; section?: BookNavRequest['section'] }>> = {
        writing: { tab: 'write' },
        worldbuild: { tab: 'codex', section: 'world' },
        characters: { tab: 'codex', section: 'characters' },
        outline: { tab: 'codex', section: 'outline' },
        foreshadows: { tab: 'codex', section: 'foreshadow' }
      }
      const target = map[dest]
      if (!target) return
      setBookNav({ ...target, nonce: Date.now() })
    },
    []
  )
  const { data: projects } = useQuery({
    queryKey: ['novel', 'projects'],
    queryFn: () => window.api.novel.projects(),
    enabled: !!conn
  })
  const book = projects?.find((p) => p.id === bookId) ?? null

  if (!conn) return <Connect />

  return (
    <div className="flex h-full flex-col">
      {bookId && book ? (
        <Book
          projectId={bookId}
          title={book.title}
          onClose={() => setBookId(null)}
          navRequest={bookNav}
          onNavConsumed={consumeBookNav}
        />
      ) : (
        <>
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
        </>
      )}
      <WizardHost onNavigate={handleWizardNav} />
      <MobileToaster />
    </div>
  )
}
