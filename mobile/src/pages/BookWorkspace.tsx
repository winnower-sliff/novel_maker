import { useQueryClient } from '@tanstack/react-query'
import { qk, useBook } from '../lib/queries'
import { useUiStore } from '../lib/uiStore'
import Cards from './Cards'
import Lines from './Lines'
import Read from './Read'
import Write from './Write'

const SUBS = [
  { key: 'write', label: '写作' },
  { key: 'read', label: '阅读' },
  { key: 'cards', label: '设定' },
  { key: 'lines', label: '线' }
] as const

export default function BookWorkspace() {
  const openBookId = useUiStore((s) => s.openBookId)
  const bookSub = useUiStore((s) => s.bookSub)
  const setBookSub = useUiStore((s) => s.setBookSub)
  const closeBook = useUiStore((s) => s.closeBook)
  const { data } = useBook(openBookId ?? '')
  const queryClient = useQueryClient()

  const book = data?.book
  const activeLine = data?.lines.find((l) => l.id === book?.activeLineId)

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-[#fbf6ec]">
      <header className="pt-safe flex items-center gap-2 border-b border-orange-100 px-4 pb-3">
        <button
          type="button"
          className="-ml-1 rounded-full p-2 text-stone-500 hover:bg-orange-100 hover:text-stone-800"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: qk.books })
            closeBook()
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{book?.title ?? '…'}</div>
          {activeLine && activeLine.name !== '主线' && (
            <div className="truncate text-xs text-orange-600">{activeLine.name}</div>
          )}
        </div>
        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs text-stone-500">
          {data?.chapters.length ?? 0} 章
        </span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
        {bookSub === 'write' && <Write />}
        {bookSub === 'read' && <Read />}
        {bookSub === 'cards' && <Cards />}
        {bookSub === 'lines' && <Lines />}
      </main>

      <nav className="pb-safe grid grid-cols-4 border-t border-orange-100">
        {SUBS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={
              'flex flex-col items-center gap-0.5 py-2 text-xs ' +
              (bookSub === s.key ? 'text-orange-600' : 'text-stone-500')
            }
            onClick={() => setBookSub(s.key)}
          >
            {s.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
