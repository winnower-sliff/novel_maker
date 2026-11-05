import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { qk, useBook } from '../lib/queries'
import { useUiStore } from '../lib/uiStore'

export default function Lines() {
  const openBookId = useUiStore((s) => s.openBookId) ?? ''
  const { data } = useBook(openBookId)
  const queryClient = useQueryClient()
  const [forkOpen, setForkOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const book = data?.book
  const lines = data?.lines ?? []
  const chapters = data?.chapters ?? []
  const activeLineId = book?.activeLineId ?? ''
  const mainLine = lines.find((l) => !l.parentLineId)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: qk.book(openBookId) })
    queryClient.invalidateQueries({ queryKey: qk.books })
    queryClient.invalidateQueries({ queryKey: qk.cards(book?.activeLineId ?? '') })
    queryClient.invalidateQueries({ queryKey: qk.statusCard(openBookId) })
  }

  if (!book) return <div className="py-20 text-center text-sm text-zinc-600">加载中…</div>

  /** 线的祖先链（含自身），主线在最前 */
  const chainOf = (lineId: string): typeof lines => {
    const byId = new Map(lines.map((l) => [l.id, l]))
    const chain: typeof lines = []
    let cur = byId.get(lineId)
    while (cur) {
      chain.unshift(cur)
      cur = cur.parentLineId ? byId.get(cur.parentLineId) : undefined
    }
    return chain
  }

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-4">
      <div className="mb-1 text-sm font-semibold text-zinc-300">故事线</div>
      <div className="mb-4 text-xs leading-relaxed text-zinc-600">
        分叉=平行宇宙：从某一章另开一线，之后设定各线独立演化，互不影响。
      </div>

      <div className="space-y-2">
        {lines.map((l) => {
          const active = l.id === activeLineId
          const chain = chainOf(l.id)
          const depth = Math.max(0, chain.length - 1)
          const forkAt = l.forkChapterId
            ? chapters.find((c) => c.id === l.forkChapterId)
            : undefined
          return (
            <div
              key={l.id}
              className={
                'rounded-xl border p-3 ' +
                (active ? 'border-orange-800 bg-orange-950/20' : 'border-zinc-800 bg-zinc-900/60')
              }
              style={{ marginLeft: depth * 16 }}
            >
              <div className="flex items-center gap-2">
                <span className={'min-w-0 flex-1 truncate text-sm ' + (active ? 'font-semibold text-orange-300' : '')}>
                  {l.name}
                </span>
                {active ? (
                  <span className="rounded-full bg-orange-900/60 px-2 py-0.5 text-[11px] text-orange-300">写作中</span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-lg border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-400 disabled:opacity-50"
                    onClick={() => act(() => window.api.line.activate(book.id, l.id))}
                  >
                    切到这条线
                  </button>
                )}
                {mainLine?.id !== l.id && (
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-full p-1 text-zinc-700 hover:text-red-400"
                    onClick={() => setConfirmDelete(l.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>
              {forkAt && (
                <div className="mt-1 text-[11px] text-zinc-600">
                  从第 {forkAt.orderNo} 章《{forkAt.title}》分出
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button
        type="button"
        disabled={busy}
        className="mt-5 w-full rounded-2xl bg-orange-600 py-3.5 text-sm font-semibold disabled:opacity-50"
        onClick={() => setForkOpen(true)}
      >
        从某章开新线
      </button>

      {forkOpen && (
        <ForkSheet
          bookId={book.id}
          chapters={chapters.filter((c) => c.lineId === activeLineId)}
          busy={busy}
          onClose={() => setForkOpen(false)}
          onDone={async () => {
            setForkOpen(false)
            await act(async () => undefined)
          }}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setConfirmDelete(null)}>
          <div
            className="w-full rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-5 pb-safe"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-sm font-medium text-red-300">删除这条故事线？</div>
            <div className="mb-4 text-xs leading-relaxed text-zinc-500">
              该线及其子线的章节与设定变更都会消失（删前自动快照备份）。主线不可删。
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400"
                onClick={() => setConfirmDelete(null)}
              >
                再想想
              </button>
              <button
                type="button"
                disabled={busy}
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-medium"
                onClick={() => {
                  const id = confirmDelete
                  setConfirmDelete(null)
                  act(() => window.api.line.delete(id, true))
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ForkSheet({
  bookId,
  chapters,
  busy,
  onClose,
  onDone
}: {
  bookId: string
  chapters: Array<{ id: string; orderNo: number; title: string }>
  busy: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [chapterId, setChapterId] = useState(chapters[chapters.length - 1]?.id ?? '')
  const [name, setName] = useState('')

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={onClose}>
      <div
        className="max-h-[75vh] w-full overflow-y-auto rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-5 pb-safe no-scrollbar"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-sm font-semibold">开新线</div>
        <div className="mb-4 text-xs text-zinc-500">选一个分叉点——新线从这一章之后独立展开。</div>

        <div className="mb-2 text-xs text-zinc-500">分叉点</div>
        <div className="mb-4 max-h-48 space-y-1 overflow-y-auto no-scrollbar">
          {chapters.map((c) => (
            <button
              key={c.id}
              type="button"
              className={
                'flex w-full items-baseline gap-2 rounded-lg px-3 py-2 text-left text-sm ' +
                (chapterId === c.id ? 'bg-orange-900/40 text-orange-200' : 'bg-zinc-800/50 text-zinc-300')
              }
              onClick={() => setChapterId(c.id)}
            >
              <span className="text-xs text-zinc-600">第 {c.orderNo} 章</span>
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
            </button>
          ))}
          {chapters.length === 0 && <div className="py-6 text-center text-xs text-zinc-600">本线还没有章节</div>}
        </div>

        <div className="mb-2 text-xs text-zinc-500">线名（留空让导演起名）</div>
        <input
          className="mb-5 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm outline-none focus:border-orange-700"
          placeholder="如：复仇线"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="flex gap-3">
          <button
            type="button"
            className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || !chapterId}
            className="flex-1 rounded-xl bg-orange-600 py-2.5 text-sm font-medium disabled:opacity-50"
            onClick={async () => {
              await window.api.line.fork(bookId, chapterId, name.trim() || undefined)
              onDone()
            }}
          >
            开线并切入
          </button>
        </div>
      </div>
    </div>
  )
}
