import { exportBookZip } from '@mobile/lib/exportPlugin'
import { onboardProgressKey, readOnboardProgress } from '@mobile/lib/onboard'
import { useBooks, useShelfStatus } from '@mobile/lib/queries'
import { toastError, useToastStore } from '@mobile/lib/toastStore'
import { useUiStore } from '@mobile/lib/uiStore'
import type { Book, StatusCard } from '@shared/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet'
import { Cover } from '../components/Cover'
import { ErrorBox } from '../components/ErrorBox'
import {
  IconArchive,
  IconArrowRight,
  IconBookOpen,
  IconChevronRight,
  IconMore,
  IconPlus
} from '../components/icons'
import { OfflineBanner } from '../components/OfflineBanner'
import { PageShell } from '../components/PageShell'
import { coverBackground, coverGlyph } from '../lib/cover'

/** 点「开新书」时先占位的书名；真正的书名在引导最后一步才定 */
const NEW_BOOK_TITLE = '新书'
const UNTITLED = '未命名新书'

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

/** 「继续写」主卡：最近在写的那本书，大面积色块封面，点一下进书 */
function HeroCard({
  book,
  status,
  onOpen,
  onMenu
}: {
  book: Book
  status: StatusCard | undefined
  onOpen: () => void
  onMenu: () => void
}) {
  const title = book.title || '未命名'
  const chapters = status?.chapterCount ?? 0
  const lastTitle = status?.lastChapter?.title
  const hint =
    chapters > 0 && lastTitle
      ? `上次写到「${lastTitle}」，接着往下写`
      : chapters > 0
        ? `已写 ${chapters} 章，接着往下写`
        : book.intro
          ? '还没动笔，和导演聊聊第一章'
          : '还没完成开书引导，接着聊'
  // 按钮文案跟着书的状态走：写过的是「继续写」，没动笔的是「开始写」，引导没聊完的是「接着聊」
  const cta = chapters > 0 ? '继续写' : book.intro ? '开始写' : '接着聊'
  return (
    <section className="relative mt-1">
      <button
        type="button"
        className="relative block w-full overflow-hidden rounded-3xl p-[18px] text-left text-white active:brightness-95"
        style={{ background: coverBackground(book.id) }}
        onClick={onOpen}
      >
        {/* 左侧压一道暗纱：白字落在最亮的书脊色上也读得清 */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'linear-gradient(90deg, rgba(0, 0, 0, 0.30) 0%, rgba(0, 0, 0, 0) 78%)'
          }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-1 top-1/2 -translate-y-1/2 select-none font-serif text-[150px] font-bold leading-none text-white/[0.12]"
        >
          {coverGlyph(title)}
        </span>
        <span className="relative block">
          <span className="inline-block rounded-full bg-white/25 px-2.5 py-1 text-[11px] font-medium tracking-wider">
            最近在写
          </span>
          <span className="mt-2.5 line-clamp-2 block text-2xl font-bold leading-tight">
            {title}
          </span>
          <span className="mt-1.5 line-clamp-1 block text-[13px] text-white/90">{hint}</span>
          <span className="mt-3.5 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-xs text-white/85">
              {chapters > 0
                ? `${chapters} 章 · ${relTime(book.updatedAt)}`
                : relTime(book.updatedAt)}
            </span>
            <span
              aria-hidden="true"
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white py-2 pl-3.5 pr-3 text-[13px] font-semibold leading-none text-orange-700"
            >
              {cta}
              <IconArrowRight size={14} />
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`更多操作：《${title}》`}
        className="absolute right-1.5 top-1.5 flex h-11 w-11 items-center justify-center"
        onClick={onMenu}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/15 text-white">
          <IconMore />
        </span>
      </button>
    </section>
  )
}

/** 两列书格里的一格：色块封面 + 书名（最多两行）+ 章数与更新时间 */
function BookTile({
  book,
  status,
  onOpen,
  onMenu
}: {
  book: Book
  status: StatusCard | undefined
  onOpen: () => void
  onMenu: () => void
}) {
  const title = book.title || '未命名'
  const chapters = status?.chapterCount ?? 0
  const meta =
    chapters > 0
      ? `${chapters} 章 · ${relTime(book.updatedAt)}`
      : book.intro
        ? `未动笔 · ${relTime(book.updatedAt)}`
        : '尚未完成开书引导'
  return (
    <div className="relative">
      <button type="button" className="block w-full text-left active:opacity-90" onClick={onOpen}>
        <Cover
          id={book.id}
          name={title}
          glyphSize={48}
          className="aspect-[3/4] w-full rounded-md rounded-r-xl shadow-[0_10px_18px_-10px_rgba(124,45,18,0.55)]"
        />
        <span className="mt-2.5 line-clamp-2 block text-[15px] font-semibold leading-5">
          {title}
        </span>
        <span className="mt-0.5 block truncate text-xs text-stone-400">{meta}</span>
      </button>
      {/* ⋯ 压在封面的右上角：不遮书名，命中区域 40px 全落在色块封面内 */}
      <button
        type="button"
        aria-label={`更多操作：《${title}》`}
        className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center"
        onClick={onMenu}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/20 text-white">
          <IconMore size={16} />
        </span>
      </button>
    </div>
  )
}

function SectionTitle({ title, extra }: { title: string; extra?: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 className="text-base font-bold">{title}</h2>
      {extra && <span className="text-xs text-stone-400">{extra}</span>}
    </div>
  )
}

/**
 * 写书页（界面原叫「书架」，tab 取值仍是 shelf）：进去就接着写——
 * 顶栏「＋ 开新书」→「继续写」主卡（最近打开的书）→「我的书」两列书格 →「开书中」的草稿书
 * → 已归档入口行。⋯ 菜单：打开 / 导出 / 归档 / 彻底删除（归档不在写书页显示，设置里可恢复）。
 */
export default function Shelf() {
  const { data: books, error, isError, isLoading, refetch } = useBooks()
  const openBook = useUiStore((s) => s.openBook)
  const startOnboard = useUiStore((s) => s.startOnboard)
  const goArchived = useUiStore((s) => s.goArchived)
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [menuFor, setMenuFor] = useState<Book | null>(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)

  // 断网期间每隔几秒自己试一次：连上后刷新成功，顶部提示自动消失。
  // 不依赖事件连接的恢复通知——桌面浏览器的事件连接是静默自动重连的，不会通知
  useEffect(() => {
    if (!(isError && books)) return
    const timer = setInterval(() => void refetch({ cancelRefetch: false }), 5000)
    return () => clearInterval(timer)
  }, [isError, books, refetch])

  // 导出的进度与结果都走全局轻提示：弹层已经关了，书架停在哪一段都看得见
  const doExport = async (b: Book) => {
    setMenuFor(null)
    setExporting(b.id)
    const toast = useToastStore.getState()
    toast.push(`正在打包下载《${b.title || '未命名'}》，完成后选择保存位置…`)
    try {
      await exportBookZip(b.id, b.title)
      toast.push(`已导出《${b.title || '未命名'}》压缩包`)
    } catch (e) {
      // 用户在系统保存器里点了取消：静默
      if ((e instanceof Error ? e.message : String(e)) !== 'cancelled') toastError(e, '导出失败')
    } finally {
      setExporting(null)
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
    const m = new Map<string, StatusCard>()
    for (const s of statuses ?? []) m.set(s.bookId, s)
    return m
  }, [statuses])
  const statusOf = (b: Book): StatusCard | undefined => statusById.get(b.id)

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
  const startCreate = () => {
    setCreating(true)
    createBook.mutate(NEW_BOOK_TITLE)
  }

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

  // 主卡跟上次打开的书；没打开过（或那本已归档）就取最近有动静的
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
  const empty = !!books && active.length === 0 && opening.length === 0
  const displayName = (b: Book): string =>
    isOpening(b)
      ? b.title && b.title !== NEW_BOOK_TITLE
        ? b.title
        : UNTITLED
      : b.title || '未命名'
  const metaOf = (b: Book): string => {
    const s = statusOf(b)
    const parts: string[] = []
    if (s && s.chapterCount > 0) parts.push(`已写 ${s.chapterCount} 章`)
    if (s?.lastChapter) parts.push(s.lastChapter.title)
    return parts.join(' · ') || b.intro || '尚未完成开书引导'
  }
  const open = (b: Book) => {
    if (isOpening(b)) startOnboard(b.id)
    else openBook(b.id)
    setMenuFor(null)
  }
  const closeMenu = () => {
    setMenuFor(null)
    setConfirmWipe(false)
  }

  // 刷新失败但手里还有书：照常显示，只在顶栏下常驻一条提醒（看到的不是最新的）；恢复后自动消失
  const offline = isError && !!books

  return (
    <PageShell
      title="写书"
      subtitle={
        books && !empty
          ? `共 ${active.length} 本${opening.length ? ` · ${opening.length} 本开书中` : ''}`
          : undefined
      }
      action={
        <button
          type="button"
          disabled={creating}
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-full bg-orange-600 pl-3 pr-4 text-sm font-semibold text-white active:bg-orange-700 disabled:opacity-50"
          onClick={startCreate}
        >
          <IconPlus size={16} />
          {creating ? '创建中…' : '开新书'}
        </button>
      }
      banner={offline ? <OfflineBanner /> : undefined}
      bodyClass="flex flex-col"
    >
      {isLoading && (
        <div className="flex flex-1 items-center justify-center py-16">
          <p className="text-sm text-stone-500">加载中…</p>
        </div>
      )}
      {isError && !books && (
        <div className="flex flex-1 items-center justify-center py-10">
          <ErrorBox error={error} onRetry={() => refetch()} />
        </div>
      )}

      {empty && (
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <span className="relative flex h-28 w-28 items-center justify-center rounded-full bg-orange-100">
            <IconBookOpen size={48} className="text-orange-600" />
            <span className="absolute bottom-1 right-1 flex h-10 w-10 items-center justify-center rounded-full border-4 border-[#fbf6ec] bg-orange-600 text-white">
              <IconPlus size={18} />
            </span>
          </span>
          <p className="mt-7 text-xl font-bold">还没有书</p>
          <p className="mt-2 text-sm leading-relaxed text-stone-500">
            点「开新书」，跟导演聊出你的第一本书
          </p>
          <button
            type="button"
            disabled={creating}
            className="mt-8 inline-flex h-12 items-center gap-1.5 rounded-2xl bg-orange-600 px-8 text-base font-semibold text-white active:bg-orange-700 disabled:opacity-50"
            onClick={startCreate}
          >
            <IconPlus size={18} />
            {creating ? '创建中…' : '开新书'}
          </button>
        </div>
      )}

      {recent && (
        <HeroCard
          book={recent}
          status={statusOf(recent)}
          onOpen={() => open(recent)}
          onMenu={() => setMenuFor(recent)}
        />
      )}

      {rest.length > 0 && (
        <section className="mt-6">
          <SectionTitle title="我的书" extra={`${rest.length} 本`} />
          <div className="grid grid-cols-2 gap-x-3.5 gap-y-5">
            {rest.map((b) => (
              <BookTile
                key={b.id}
                book={b}
                status={statusOf(b)}
                onOpen={() => open(b)}
                onMenu={() => setMenuFor(b)}
              />
            ))}
          </div>
        </section>
      )}

      {opening.length > 0 && (
        <section className="mt-6">
          <SectionTitle title="开书中" extra={`${opening.length} 本`} />
          <div className="space-y-2.5">
            {opening.map((b) => (
              <div
                key={b.id}
                className="relative flex items-stretch rounded-2xl border border-dashed border-orange-300 bg-orange-50/70"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 py-4 pl-4 pr-14 text-left active:bg-orange-100/60"
                  onClick={() => startOnboard(b.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block text-[15px] font-semibold leading-5">
                      {displayName(b)}
                    </span>
                    <span className="mt-1 block text-xs text-stone-400">
                      还没聊完 · {relTime(b.createdAt)}开的
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-orange-600 py-2 pl-3.5 pr-3 text-xs font-medium leading-none text-white">
                    继续开书
                    <IconArrowRight size={14} />
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`更多操作：《${displayName(b)}》`}
                  className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-stone-400 active:bg-orange-100 active:text-stone-600"
                  onClick={() => setMenuFor(b)}
                >
                  <IconMore />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {archivedCount > 0 && (
        <button
          type="button"
          className="mt-6 flex w-full items-center gap-3.5 rounded-2xl border border-orange-100 bg-white py-3 pl-3 pr-3.5 text-left active:bg-orange-50"
          onClick={goArchived}
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-orange-50 text-orange-600">
            <IconArchive />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">已归档的书</span>
            <span className="block text-xs text-stone-400">
              {archivedCount} 本 · 可恢复或彻底删除
            </span>
          </span>
          <IconChevronRight size={18} className="shrink-0 text-stone-300" />
        </button>
      )}

      {menuFor && (
        <BottomSheet onClose={closeMenu}>
          <div className="mb-4 flex items-center gap-3">
            <Cover
              id={menuFor.id}
              name={displayName(menuFor)}
              glyphSize={18}
              className="h-14 w-10.5 shrink-0 rounded"
            />
            <div className="min-w-0">
              <div className="line-clamp-2 text-base font-semibold leading-snug">
                {displayName(menuFor)}
              </div>
              <div className="mt-0.5 text-xs text-stone-400">{metaOf(menuFor)}</div>
            </div>
          </div>
          {isOpening(menuFor) ? (
            <button
              type="button"
              className="w-full rounded-xl border border-orange-200 py-3 text-sm text-stone-600"
              onClick={() => open(menuFor)}
            >
              继续开书
            </button>
          ) : (
            <>
              <button
                type="button"
                className="w-full rounded-xl border border-orange-200 py-3 text-sm text-stone-600"
                onClick={() => open(menuFor)}
              >
                打开这本书
              </button>
              <button
                type="button"
                disabled={exporting !== null}
                className="mt-2.5 w-full rounded-xl border border-orange-200 py-3 text-sm text-stone-600 disabled:opacity-50"
                onClick={() => void doExport(menuFor)}
              >
                {exporting === menuFor.id ? '导出中…' : '导出压缩包（每章一个 TXT）'}
              </button>
            </>
          )}
          <button
            type="button"
            className="mt-2.5 w-full rounded-xl bg-red-50 py-3 text-sm font-medium text-red-600"
            onClick={() => void archive(menuFor)}
          >
            归档（不再显示在写书页）
          </button>
          {confirmWipe ? (
            <div className="mt-2.5 flex gap-2.5">
              <button
                type="button"
                disabled={creating}
                className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-medium text-white disabled:opacity-50"
                onClick={() => void wipe(menuFor)}
              >
                确认彻底删除
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl border border-orange-200 py-3 text-sm text-stone-500"
                onClick={() => setConfirmWipe(false)}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="-mb-3 mt-1 w-full py-3 text-xs text-stone-400 active:text-red-600"
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
    </PageShell>
  )
}
