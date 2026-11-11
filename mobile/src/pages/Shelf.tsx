import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Book } from '@shared/types'
import { useBooks, useShelfStatus } from '@mobile/lib/queries'
import { useUiStore } from '@mobile/lib/uiStore'

/** 书脊配色：按书 id 稳定取暖色系之一 */
const SPINE_COLORS = ['#ea580c', '#d97706', '#c2410c', '#b45309', '#9a3412', '#e11d48']

function spineColor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return SPINE_COLORS[h % SPINE_COLORS.length] ?? '#ea580c'
}

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return `${Math.floor(d / 30)} 个月前`
}

/** 书架：最近的书大卡续写 + 其余列表卡 + 长按 ⋯ 归档（归档不在书架显示，设置里可恢复） */
export default function Shelf() {
  const { data: books, isLoading } = useBooks()
  const openBook = useUiStore((s) => s.openBook)
  const startOnboard = useUiStore((s) => s.startOnboard)
  const setTab = useUiStore((s) => s.setTab)
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [menuFor, setMenuFor] = useState<Book | null>(null)

  const active = useMemo(
    () => (books ?? []).filter((b) => !b.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [books]
  )
  const { data: statuses } = useShelfStatus(active.map((b) => b.id))
  const statusById = useMemo(() => {
    const m = new Map<string, NonNullable<typeof statuses>[number]>()
    for (const s of statuses ?? []) m.set(s.bookId, s)
    return m
  }, [statuses])

  const createBook = useMutation({
    mutationFn: async (title: string) => window.api.book.create({ title, targetWords: 2000 }),
    onSuccess: (book) => {
      void qc.invalidateQueries({ queryKey: ['books'] })
      setCreating(false)
      startOnboard(book.id)
    },
    onError: () => setCreating(false)
  })

  const archive = async (b: Book) => {
    setMenuFor(null)
    await window.api.book.update(b.id, { archived: true })
    void qc.invalidateQueries({ queryKey: ['books'] })
    void qc.invalidateQueries({ queryKey: ['shelfStatus'] })
  }

  const recent = (() => {
    let id: string | null = null
    try {
      id = localStorage.getItem('nm-last-opened')
    } catch {
      // 忽略
    }
    return active.find((b) => b.id === id) ?? active[0]
  })()
  const rest = active.filter((b) => b !== recent)
  const archivedCount = (books ?? []).filter((b) => b.archived).length
  const metaOf = (b: Book): string => {
    const s = statusById.get(b.id)
    const parts: string[] = []
    if (s && s.chapterCount > 0) parts.push(`已写 ${s.chapterCount} 章`)
    if (s && s.lastChapter) parts.push(s.lastChapter.title)
    return parts.join(' · ') || b.intro || '尚未完成开书引导'
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-baseline justify-between px-5 pb-2 pt-safe">
        <h1 className="pt-3 text-2xl font-bold">书架</h1>
        <div className="flex items-center gap-3 pt-3">
          {active.length > 0 && <span className="text-xs text-stone-400">共 {active.length} 本</span>}
          <button type="button" className="text-2xl text-stone-500" onClick={() => setTab('settings')}>
            ⚙️
          </button>
        </div>
      </header>

      <div className="no-scrollbar flex-1 overflow-y-auto px-5 pb-safe">
        {isLoading && <p className="mt-10 text-center text-stone-500">加载中…</p>}
        {!isLoading && active.length === 0 && (
          <div className="mt-24 text-center text-stone-500">
            <div className="text-5xl">✍️</div>
            <p className="mt-4">还没有书</p>
            <p className="mt-1 text-sm">点下面按钮，跟导演聊出你的第一本书</p>
          </div>
        )}

        {recent && (
          <button
            type="button"
            className="relative mt-2 block w-full overflow-hidden rounded-2xl p-4 pl-5 text-left active:brightness-95"
            style={{ background: `linear-gradient(135deg, ${spineColor(recent.id)} 0%, #f59e0b 130%)` }}
            onClick={() => openBook(recent.id)}
          >
            <span className="absolute left-0 top-0 h-full w-1.5 bg-white/25" />
            <div className="text-[11px] font-medium tracking-wide text-white/75">上次打开</div>
            <div className="mt-1 line-clamp-1 text-lg font-bold text-white">{recent.title || '未命名'}</div>
            <div className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-white/85">{metaOf(recent)}</div>
            <div className="mt-2.5 flex items-center justify-between">
              <span className="text-[11px] text-white/70">{relTime(recent.updatedAt)}</span>
              <span className="rounded-full bg-white/20 px-3 py-1 text-[11px] font-medium text-white">继续 →</span>
            </div>
          </button>
        )}

        {rest.length > 0 && (
          <div className="mt-4 space-y-2.5">
            {rest.map((b) => (
              <div
                key={b.id}
                className="relative flex items-stretch rounded-2xl border border-orange-100 bg-white active:bg-orange-50"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 py-3.5 pl-4 pr-2 text-left"
                  onClick={() => openBook(b.id)}
                >
                  <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0 }}>
                    <span className="block h-full w-1 rounded-l-2xl" style={{ background: spineColor(b.id) }} />
                  </span>
                  <div className="line-clamp-1 text-[15px] font-semibold">{b.title || '未命名'}</div>
                  <div className="mt-1 line-clamp-1 text-xs text-stone-500">{metaOf(b)}</div>
                  <div className="mt-1.5 text-[11px] text-stone-400">{relTime(b.updatedAt)}</div>
                </button>
                <button
                  type="button"
                  className="shrink-0 px-3 text-stone-300 active:text-stone-500"
                  onClick={() => setMenuFor(b)}
                  aria-label="书操作"
                >
                  ⋯
                </button>
              </div>
            ))}
          </div>
        )}

        {archivedCount > 0 && (
          <button
            type="button"
            className="mt-4 w-full py-1 text-center text-xs text-stone-400 active:text-stone-600"
            onClick={() => setTab('settings')}
          >
            已归档 {archivedCount} 本 · 归档管理 →
          </button>
        )}
      </div>

      <div className="px-5 pb-safe pt-3">
        <button
          type="button"
          disabled={creating}
          onClick={() => {
            setCreating(true)
            createBook.mutate('新书')
          }}
          className="w-full rounded-xl bg-orange-600 py-3.5 font-semibold text-white active:bg-orange-700 disabled:opacity-50"
        >
          {creating ? '创建中…' : '＋ 开新书'}
        </button>
      </div>

      {menuFor && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setMenuFor(null)}>
          <div
            className="w-full rounded-t-2xl border-t border-orange-100 bg-white p-5 pb-safe"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 min-w-0">
              <div className="truncate text-sm font-medium">{menuFor.title || '未命名'}</div>
              <div className="mt-0.5 text-[11px] text-stone-400">{metaOf(menuFor)}</div>
            </div>
            <button
              type="button"
              className="w-full rounded-xl border border-orange-200 py-2.5 text-sm text-stone-600"
              onClick={() => {
                openBook(menuFor.id)
                setMenuFor(null)
              }}
            >
              打开这本书
            </button>
            <button
              type="button"
              className="mt-2.5 w-full rounded-xl bg-red-50 py-2.5 text-sm font-medium text-red-600"
              onClick={() => void archive(menuFor)}
            >
              归档（不再显示在书架）
            </button>
            <div className="mt-2 text-center text-[11px] text-stone-400">归档后可在 设置 → 已归档的书 恢复</div>
          </div>
        </div>
      )}
    </div>
  )
}
