import { useQueryClient } from '@tanstack/react-query'
import { qk, useBook, useJobFlow } from '../lib/queries'
import { useUiStore } from '../lib/uiStore'
import Cards from './Cards'
import Lines from './Lines'
import Read from './Read'
import Write from './Write'

const SUBS = [
  {
    key: 'write',
    label: '写作',
    icon: (
      <g>
        <path d="M12 20h9" strokeLinecap="round" />
        <path
          d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    )
  },
  {
    key: 'read',
    label: '阅读',
    icon: (
      <g>
        <path
          d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    )
  },
  {
    key: 'cards',
    label: '设定',
    icon: (
      <g>
        <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    )
  },
  {
    key: 'lines',
    label: '线',
    icon: (
      <g>
        <path d="M6 3v12" strokeLinecap="round" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" strokeLinecap="round" />
      </g>
    )
  }
] as const

export default function BookWorkspace() {
  const openBookId = useUiStore((s) => s.openBookId)
  const bookSub = useUiStore((s) => s.bookSub)
  const setBookSub = useUiStore((s) => s.setBookSub)
  const closeBook = useUiStore((s) => s.closeBook)
  const readerDark = useUiStore((s) => s.readerDark)
  const { data } = useBook(openBookId ?? '')
  const { data: jobFlow } = useJobFlow(openBookId ?? '')
  const queryClient = useQueryClient()

  const book = data?.book
  const activeLine = data?.lines.find((l) => l.id === book?.activeLineId)

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-[#fbf6ec]">
      <header className="pt-safe flex items-center gap-2 border-b border-orange-100 px-4 pb-3">
        <button
          type="button"
          aria-label="返回书架"
          className="-my-0.5 -ml-1.5 rounded-full p-2.5 text-stone-500 hover:bg-orange-100 hover:text-stone-800"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: qk.books })
            closeBook()
          }}
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
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

      {/* key=子页：切换时重建滚动容器，上一个子页的滚动位置不带过来 */}
      <main key={bookSub} className="min-h-0 flex-1 overflow-y-auto no-scrollbar">
        {bookSub === 'write' && <Write />}
        {bookSub === 'read' && <Read />}
        {bookSub === 'cards' && <Cards />}
        {bookSub === 'lines' && <Lines />}
      </main>

      {/* 阅读页夜间主题时底栏联动深色，避免暗室里一条亮带 */}
      <nav
        className={
          'pb-safe grid grid-cols-4 border-t ' +
          (bookSub === 'read' && readerDark
            ? 'border-stone-800 bg-[#141210] '
            : 'border-orange-100 bg-[#fbf6ec] ')
        }
      >
        {SUBS.map((s) => {
          const on = bookSub === s.key
          const dark = bookSub === 'read' && readerDark
          return (
            <button
              key={s.key}
              type="button"
              className={
                'relative flex flex-col items-center gap-0.5 py-2 text-[11px] ' +
                (dark ? 'active:bg-white/5 ' : 'active:bg-orange-50 ') +
                (on
                  ? dark
                    ? 'font-medium text-orange-400'
                    : 'font-medium text-orange-600'
                  : dark
                    ? 'text-stone-500'
                    : 'text-stone-400')
              }
              onClick={() => setBookSub(s.key)}
            >
              <span className="relative">
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={on ? 2.2 : 1.8}
                >
                  {s.icon}
                </svg>
                {/* 写作任务运行中：写作 tab 亮橙点，其他页也能看见导演在干活 */}
                {s.key === 'write' && jobFlow?.active && (
                  <span className="absolute -right-1.5 -top-0.5 h-2 w-2 rounded-full bg-orange-500" />
                )}
              </span>
              {s.label}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
