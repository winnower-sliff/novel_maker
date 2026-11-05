import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useBooks } from '@mobile/lib/queries'
import { useUiStore } from '@mobile/lib/uiStore'

/** 书架：全部书 + 开新书（进引导） */
export default function Shelf() {
  const { data: books, isLoading } = useBooks()
  const openBook = useUiStore((s) => s.openBook)
  const startOnboard = useUiStore((s) => s.startOnboard)
  const setTab = useUiStore((s) => s.setTab)
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)

  const createBook = useMutation({
    mutationFn: async (title: string) => window.api.book.create({ title, targetWords: 2000 }),
    onSuccess: (book) => {
      void qc.invalidateQueries({ queryKey: ['books'] })
      setCreating(false)
      startOnboard(book.id)
    },
    onError: () => setCreating(false)
  })

  const active = (books ?? []).filter((b) => !b.archived)

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-5 pb-2 pt-safe">
        <h1 className="pt-3 text-2xl font-bold">书架</h1>
        <button
          type="button"
          className="pt-3 text-2xl text-zinc-400"
          onClick={() => setTab('settings')}
        >
          ⚙️
        </button>
      </header>

      <div className="no-scrollbar flex-1 overflow-y-auto px-5 pb-safe">
        {isLoading && <p className="mt-10 text-center text-zinc-500">加载中…</p>}
        {!isLoading && active.length === 0 && (
          <div className="mt-24 text-center text-zinc-500">
            <div className="text-5xl">✍️</div>
            <p className="mt-4">还没有书</p>
            <p className="mt-1 text-sm">点下面按钮，跟导演聊出你的第一本书</p>
          </div>
        )}
        <div className="space-y-3">
          {active.map((b) => (
            <button
              key={b.id}
              type="button"
              className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-left active:bg-zinc-800"
              onClick={() => openBook(b.id)}
            >
              <div className="text-lg font-semibold">{b.title || '未命名'}</div>
              <div className="mt-1 line-clamp-1 text-sm text-zinc-400">{b.intro || '尚未完成开书引导'}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 pb-safe pt-3">
        <button
          type="button"
          disabled={creating}
          onClick={() => {
            setCreating(true)
            createBook.mutate('新书')
          }}
          className="w-full rounded-xl bg-amber-600 py-3.5 font-semibold text-zinc-950 active:bg-amber-500 disabled:opacity-50"
        >
          {creating ? '创建中…' : '＋ 开新书'}
        </button>
      </div>
    </div>
  )
}
