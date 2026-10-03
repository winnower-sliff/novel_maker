import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import Book from '@mobile/pages/Book'
import { consumeBack } from '@mobile/lib/backHandler'
import { installNotifyProvider } from '@mobile/lib/notifyCapacitor'
import { nativeApp } from '@mobile/lib/nativeApp'
import Connect from '@mobile/pages/Connect'
import More from '@mobile/pages/More'
import Shelf from '@mobile/pages/Shelf'
import { MobileToaster } from '@mobile/components/MobileToaster'
import { useConnStore } from '@mobile/lib/conn'
import { pushToast } from '@wizard/toastStore'
import { ensureRuntimeSync } from '@wizard/runtimeSync'

type Page = 'shelf' | 'more'

const PAGES: Array<{ key: Page; label: string; icon: string }> = [
  { key: 'shelf', label: '书架', icon: '📚' },
  { key: 'more', label: '更多', icon: '⋯' }
]

export default function App() {
  const conn = useConnStore((s) => s.conn)
  const queryClient = useQueryClient()
  const [page, setPage] = useState<Page>('shelf')
  const [bookId, setBookId] = useState<string | null>(null)
  const [newBook, setNewBook] = useState(false)

  // 「基本设定」创建/改元数据后失效书架与书内门禁查询；创建成功即进入该书
  const invalidateProjects = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['novel', 'projects'] })
  }, [queryClient])
  const handleCreated = useCallback(
    (id: string) => {
      invalidateProjects()
      setNewBook(false)
      setBookId(id)
    },
    [invalidateProjects]
  )
  const { data: projects } = useQuery({
    queryKey: ['novel', 'projects'],
    queryFn: () => window.api.novel.projects(),
    enabled: !!conn
  })
  const book = projects?.find((p) => p.id === bookId) ?? null

  // Android 返回键：返回栈优先；栈空时根页双击退出、未连接直退。
  // 挂载一次，conn 经 ref 读取避免重复注册。
  const connRef = useRef(conn)
  useEffect(() => {
    connRef.current = conn
  }, [conn])
  useEffect(() => {
    const app = nativeApp()
    if (!app) return
    let lastBackAt = 0
    const onBack = (): void => {
      if (consumeBack()) return
      if (!connRef.current) {
        void app.exitApp()
        return
      }
      const now = Date.now()
      if (now - lastBackAt < 2000) {
        void app.exitApp()
      } else {
        lastBackAt = now
        pushToast('success', '再按一次退出')
      }
    }
    void Promise.resolve(app.addListener('backButton', onBack)).catch(() => {})
  }, [])

  // 连接就绪后挂中央同步器（拉为兜底）与系统通知（幂等）
  useEffect(() => {
    if (!conn) return
    installNotifyProvider()
    ensureRuntimeSync()
  }, [conn])

  if (!conn) return <Connect />

  return (
    <div className="flex h-full flex-col">
      {newBook || (bookId && book) ? (
        <Book
          projectId={bookId}
          title={book?.title ?? ''}
          onClose={() => {
            setBookId(null)
            setNewBook(false)
          }}
          onCreated={handleCreated}
        />
      ) : (
        <>
          <main className="min-h-0 flex-1 overflow-y-auto">
            {page === 'shelf' && <Shelf onOpen={setBookId} onCreate={() => setNewBook(true)} />}
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
      <MobileToaster />
    </div>
  )
}
