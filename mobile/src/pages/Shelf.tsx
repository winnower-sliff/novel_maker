import { exportBookZip } from '@mobile/lib/exportPlugin'
import { onboardProgressKey, readOnboardProgress } from '@mobile/lib/onboard'
import { useBooks, useShelfStatus } from '@mobile/lib/queries'
import { toastError } from '@mobile/lib/toastStore'
import { useUiStore } from '@mobile/lib/uiStore'
import type { Book } from '@shared/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet'
import { ErrorBox } from '../components/ErrorBox'
import { OfflineBanner } from '../components/OfflineBanner'

/** 点「开新书」时先占位的书名；真正的书名在引导最后一步才定 */
const NEW_BOOK_TITLE = '新书'
const UNTITLED = '未命名新书'

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

/**
 * 写书页（界面原叫「书架」，tab 取值仍是 shelf）：开书中途退出的书置顶为虚线卡（接着聊）
 * + 最近的书大卡续写 + 其余列表卡 + ⋯ 菜单归档（归档不在书架显示，设置里可恢复）。
 * 底部导航栏在 App 里，页面只管导航上方的内容。
 */
export default function Shelf() {
  const { data: books, error, isError, isLoading, refetch } = useBooks()
  const openBook = useUiStore((s) => s.openBook)
  const startOnboard = useUiStore((s) => s.startOnboard)
  const setTab = useUiStore((s) => s.setTab)
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [menuFor, setMenuFor] = useState<Book | null>(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)
  const [exportMsg, setExportMsg] = useState('')

  // 断网期间每隔几秒自己试一次：连上后刷新成功，顶部提示自动消失。
  // 不依赖事件连接的恢复通知——桌面浏览器的事件连接是静默自动重连的，不会通知
  useEffect(() => {
    if (!(isError && books)) return
    const timer = setInterval(() => void refetch({ cancelRefetch: false }), 5000)
    return () => clearInterval(timer)
  }, [isError, books, refetch])

  const doExport = async (b: Book) => {
    setMenuFor(null)
    setExporting(b.id)
    setExportMsg('')
    try {
      await exportBookZip(b.id, b.title)
      setExportMsg(`已导出《${b.title || '未命名'}》压缩包`)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (m !== 'cancelled') setExportMsg(`导出失败：${m}`)
    } finally {
      setExporting(null)
      setTimeout(() => setExportMsg(''), 5000)
    }
  }

  // 开书没聊完的书要能接着开：
  // ① draft 书（作者还没说过话）一定没开完，直接算「开书中」；
  // ② 说过话、但简介还没写进书里的（书名/简介在引导最后一步才落库），要查对话记录确认没走到最后一步
  const toCheck = (books ?? []).filter((b) => !b.archived && !b.draft && !b.intro).map((b) => b.id)
  const {
    data: unfinished,
    isError: checkError,
    isSuccess: checkDone
  } = useQuery({
    queryKey: onboardProgressKey(toCheck),
    queryFn: async (): Promise<string[]> => {
      const rows = await Promise.all(toCheck.map((id) => window.api.message.list(id)))
      return toCheck.filter((_, i) => {
        const progress = readOnboardProgress(rows[i] ?? [])
        return progress !== null && !progress.done
      })
    },
    enabled: toCheck.length > 0,
    staleTime: 30_000
  })
  // 查询出结论前先把待查的书摘出正式书架，免得它先按正式书出现、再跳进「开书中」；
  // 查不了（出错）就按正式书照旧显示
  const pendingIds = new Set(!checkDone && !checkError ? toCheck : [])
  const unfinishedIds = new Set(unfinished ?? [])
  const isOpening = (b: Book): boolean => !b.archived && (b.draft || unfinishedIds.has(b.id))
  // 开书中途退出的书：接回引导，而不是当正式书打开
  const opening = (books ?? []).filter(isOpening)
  const active = (books ?? [])
    .filter((b) => !b.archived && !b.draft && !unfinishedIds.has(b.id) && !pendingIds.has(b.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
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
    onError: (e) => {
      setCreating(false)
      toastError(e, '开新书失败')
    }
  })

  const archive = async (b: Book) => {
    setMenuFor(null)
    try {
      await window.api.book.update(b.id, { archived: true })
    } catch (e) {
      toastError(e, '归档失败')
      return
    }
    void qc.invalidateQueries({ queryKey: ['books'] })
    void qc.invalidateQueries({ queryKey: ['shelfStatus'] })
  }

  const wipe = async (b: Book) => {
    setMenuFor(null)
    setConfirmWipe(false)
    try {
      await window.api.book.delete(b.id, true)
    } catch (e) {
      toastError(e, '删除失败')
      return
    }
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
    if (s?.lastChapter) parts.push(s.lastChapter.title)
    return parts.join(' · ') || b.intro || '尚未完成开书引导'
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-baseline justify-between px-5 pb-2 pt-safe">
        <h1 className="pt-3 text-2xl font-bold">写书</h1>
        <div className="flex items-center gap-3 pt-3">
          {active.length > 0 && (
            <span className="text-xs text-stone-400">共 {active.length} 本</span>
          )}
          {archivedCount > 0 && (
            <button
              type="button"
              className="-my-3 py-3 text-xs text-stone-400 underline underline-offset-2"
              onClick={() => setTab('settings')}
            >
              已归档 {archivedCount}
            </button>
          )}
          {/* 小图标按钮：视觉保持 32px，命中区域用外层撑到 40px（负 margin 抵消多出的占位） */}
          <button
            type="button"
            disabled={creating}
            className="group -my-1 flex h-10 w-10 items-center justify-center disabled:opacity-50"
            aria-label="开新书"
            onClick={() => {
              setCreating(true)
              createBook.mutate(NEW_BOOK_TITLE)
            }}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-orange-200 text-lg font-light text-orange-600 group-active:bg-orange-50">
              ＋
            </span>
          </button>
        </div>
      </header>

      {/* 刷新失败但手里还有书：照常显示，只提醒一句这些不是最新的；恢复后自动消失 */}
      {isError && !!books && <OfflineBanner />}

      <div className="no-scrollbar flex-1 overflow-y-auto px-5 pb-6">
        {(exporting || exportMsg) && (
          <div className="mt-2 rounded-xl bg-orange-50 px-3 py-2 text-center text-xs text-stone-600">
            {exporting
              ? `正在打包下载《${(books ?? []).find((b) => b.id === exporting)?.title ?? ''}》，完成后选择保存位置…`
              : exportMsg}
          </div>
        )}
        {isLoading && <p className="mt-10 text-center text-stone-500">加载中…</p>}
        {isError && !books && <ErrorBox error={error} onRetry={() => refetch()} />}
        {!isLoading && books && active.length === 0 && opening.length === 0 && (
          <div className="mt-24 text-center text-stone-500">
            <div className="text-5xl">✍️</div>
            <p className="mt-4">还没有书</p>
            <p className="mt-1 text-sm">点下面按钮，跟导演聊出你的第一本书</p>
          </div>
        )}

        {opening.length > 0 && (
          <div className="mt-2 space-y-2.5">
            {opening.map((b) => (
              <div
                key={b.id}
                className="relative flex items-stretch rounded-2xl border border-dashed border-orange-300 bg-orange-50/60"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 py-3.5 pl-4 pr-12 text-left active:bg-orange-100/60"
                  onClick={() => startOnboard(b.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">
                      开书中
                    </span>
                    <span className="mt-1.5 block truncate text-[15px] font-semibold text-stone-700">
                      {b.title && b.title !== NEW_BOOK_TITLE ? b.title : UNTITLED}
                    </span>
                    <span className="mt-1 block text-[11px] text-stone-400">
                      还没聊完 · {relTime(b.createdAt)}开的
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-orange-600 px-3 py-1.5 text-xs font-medium text-white">
                    继续开书 →
                  </span>
                </button>
                <button
                  type="button"
                  className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-stone-400 active:bg-orange-100 active:text-stone-600"
                  onClick={() => setMenuFor(b)}
                  aria-label="书操作"
                >
                  ⋯
                </button>
              </div>
            ))}
          </div>
        )}

        {recent && (
          <div className={opening.length > 0 ? 'relative mt-4' : 'relative mt-2'}>
            <button
              type="button"
              className="block w-full overflow-hidden rounded-2xl p-4 pl-5 text-left active:brightness-95"
              style={{
                background: `linear-gradient(135deg, ${spineColor(recent.id)} 0%, #f59e0b 130%)`
              }}
              onClick={() => openBook(recent.id)}
            >
              <span className="absolute left-0 top-0 h-full w-1.5 bg-white/25" />
              <div className="text-[11px] font-medium tracking-wide text-white/75">上次打开</div>
              <div className="mt-1 line-clamp-1 text-lg font-bold text-white">
                {recent.title || '未命名'}
              </div>
              <div className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-white/85">
                {metaOf(recent)}
              </div>
              <div className="mt-2.5 flex items-center justify-between">
                <span className="text-[11px] text-white/70">{relTime(recent.updatedAt)}</span>
                <span className="rounded-full bg-white/20 px-3 py-1 text-[11px] font-medium text-white">
                  继续 →
                </span>
              </div>
            </button>
            <button
              type="button"
              className="group absolute right-2 top-2 flex h-10 w-10 items-center justify-center"
              onClick={() => setMenuFor(recent)}
              aria-label="书操作"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/25 text-lg font-light text-white group-active:bg-white/40">
                ⋯
              </span>
            </button>
          </div>
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
                    <span
                      className="block h-full w-1 rounded-l-2xl"
                      style={{ background: spineColor(b.id) }}
                    />
                  </span>
                  <div className="line-clamp-1 text-[15px] font-semibold">
                    {b.title || '未命名'}
                  </div>
                  <div className="mt-1 line-clamp-1 text-xs text-stone-500">{metaOf(b)}</div>
                  <div className="mt-1.5 text-[11px] text-stone-400">{relTime(b.updatedAt)}</div>
                </button>
                <button
                  type="button"
                  className="-mx-0.5 my-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-stone-400 active:bg-orange-100 active:text-stone-600"
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
            className="-mb-4 mt-4 w-full py-3 text-center text-xs text-stone-400 active:text-stone-600"
            onClick={() => setTab('settings')}
          >
            已归档 {archivedCount} 本 · 归档管理 →
          </button>
        )}
      </div>

      {books && active.length === 0 && opening.length === 0 && (
        <div className="px-5 pb-4 pt-3">
          <button
            type="button"
            disabled={creating}
            onClick={() => {
              setCreating(true)
              createBook.mutate(NEW_BOOK_TITLE)
            }}
            className="w-full rounded-xl bg-orange-600 py-3.5 font-semibold text-white active:bg-orange-700 disabled:opacity-50"
          >
            {creating ? '创建中…' : '＋ 开新书'}
          </button>
        </div>
      )}

      {menuFor && (
        <BottomSheet
          onClose={() => {
            setMenuFor(null)
            setConfirmWipe(false)
          }}
        >
          <div className="mb-3 min-w-0">
            <div className="truncate text-sm font-medium">
              {isOpening(menuFor)
                ? menuFor.title && menuFor.title !== NEW_BOOK_TITLE
                  ? menuFor.title
                  : UNTITLED
                : menuFor.title || '未命名'}
            </div>
            <div className="mt-0.5 text-[11px] text-stone-400">{metaOf(menuFor)}</div>
          </div>
          {isOpening(menuFor) ? (
            <button
              type="button"
              className="w-full rounded-xl border border-orange-200 py-2.5 text-sm text-stone-600"
              onClick={() => {
                startOnboard(menuFor.id)
                setMenuFor(null)
              }}
            >
              继续开书
            </button>
          ) : (
            <>
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
                disabled={exporting !== null}
                className="mt-2.5 w-full rounded-xl border border-orange-200 py-2.5 text-sm text-stone-600 disabled:opacity-50"
                onClick={() => void doExport(menuFor)}
              >
                {exporting === menuFor.id ? '导出中…' : '导出压缩包（每章一个 TXT）'}
              </button>
            </>
          )}
          <button
            type="button"
            className="mt-2.5 w-full rounded-xl bg-red-50 py-2.5 text-sm font-medium text-red-600"
            onClick={() => void archive(menuFor)}
          >
            归档（不再显示在书架）
          </button>
          {confirmWipe ? (
            <div className="mt-2.5 flex gap-2.5">
              <button
                type="button"
                disabled={creating}
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void wipe(menuFor)}
              >
                确认彻底删除
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl border border-orange-200 py-2.5 text-sm text-stone-500"
                onClick={() => setConfirmWipe(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="-mb-3 mt-2.5 w-full py-3 text-xs text-stone-400 active:text-red-600"
              onClick={() => setConfirmWipe(true)}
            >
              彻底删除这本书…
            </button>
          )}
          <div className="mt-2 text-center text-[11px] text-stone-400">
            归档后可在 设置 → 已归档的书 恢复；彻底删除无法找回
          </div>
        </BottomSheet>
      )}
    </div>
  )
}
