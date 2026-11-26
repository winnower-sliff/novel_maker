import type { Chapter } from '@shared/types'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { BottomSheet } from '../components/BottomSheet'
import { ErrorBox } from '../components/ErrorBox'
import QuickActionsBar from '../components/QuickActionsBar'
import { loadJson, saveJson } from '../lib/persist'
import { useBook } from '../lib/queries'
import { type Appearance, applySystemBars } from '../lib/systemBars'
import { errorText, toastError } from '../lib/toastStore'
import { useUiStore } from '../lib/uiStore'

const THEME_BG: Record<Appearance, string> = {
  sepia: 'bg-[#f4ecd8] text-[#433422]',
  light: 'bg-white text-stone-800',
  dark: 'bg-[#1c1917] text-[#d6cfc4]'
}

/** 段落切分：空行分段；段内换行保留 */
function splitParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
}

export default function Read() {
  const openBookId = useUiStore((s) => s.openBookId) ?? ''
  const setBookSub = useUiStore((s) => s.setBookSub)
  const setReaderDark = useUiStore((s) => s.setReaderDark)
  const { data, error, isError, refetch } = useBook(openBookId)
  const [chapterId, setChapterId] = useState<string | null>(null)
  /** 最近一次成功打开的章：切章拉取中 / 失败时屏幕上留在这一章 */
  const [lastGood, setLastGood] = useState<Chapter | null>(null)
  const [fontSize, setFontSize] = useState(17)
  const [theme, setTheme] = useState<Appearance>('sepia')
  const [showSettings, setShowSettings] = useState(false)
  const [listOpen, setListOpen] = useState(true)
  const [segmentMode, setSegmentMode] = useState(false)
  const [segTarget, setSegTarget] = useState<string | null>(null)
  const [segText, setSegText] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const book = data?.book
  const activeLineId = book?.activeLineId ?? ''

  // 阅读偏好与进度恢复
  useEffect(() => {
    loadJson<Record<string, unknown>>(`read:${openBookId}`).then((saved) => {
      if (saved) {
        const s = saved as { chapterId?: string; fontSize?: number; theme?: Appearance }
        if (s.fontSize) setFontSize(s.fontSize)
        if (s.theme && s.theme in THEME_BG) setTheme(s.theme)
        if (s.chapterId) {
          setChapterId(s.chapterId)
          setListOpen(false)
        }
      }
    })
  }, [openBookId])

  // 正文：以当前章为键的单一查询——续读、目录点开、上一章 / 下一章、失败重试都走它，
  // 同一章在途的请求由查询缓存合并，不会重复发。
  // staleTime 归零：每次回到某一章都后台刷新一次（缓存先上屏不闪空白），改章后不会盯着旧内容
  const chapterQuery = useQuery({
    queryKey: ['chapter', chapterId ?? ''],
    queryFn: async (): Promise<Chapter | null> => window.api.chapter.get(chapterId as string),
    enabled: !!chapterId,
    staleTime: 0
  })
  const fetched = chapterQuery.data
  // 想看的章还没拿到（拉取中 / 失败）时，屏幕上留在最近一次成功打开的那一章
  const chapter = fetched === undefined ? lastGood : fetched
  // 正文拉取失败：手里没有可显示的章 → 整页错误框；还停在上一章 → 顶栏下挂一条可重试的提示
  const loadFailed = !!chapterId && chapterQuery.isError
  const retry = () => void chapterQuery.refetch()

  // 记住最近一次成功打开的章（目录里不记：没在看的章不算「当前章」）
  useEffect(() => {
    if (fetched && !listOpen) setLastGood(fetched)
  }, [fetched, listOpen])

  // 章已被删（查不到）：回目录
  useEffect(() => {
    if (fetched === null) setListOpen(true)
  }, [fetched])

  const persist = (patch: { chapterId?: string; fontSize?: number; theme?: Appearance }) => {
    saveJson(`read:${openBookId}`, {
      chapterId: patch.chapterId ?? chapterId ?? undefined,
      fontSize: patch.fontSize ?? fontSize,
      theme: patch.theme ?? theme
    })
  }

  /** 切到某一章。键没变时查询不会自己重拉（比如失败后再点同一章），这里补一次 */
  const go = (id: string) => {
    persist({ chapterId: id })
    if (id !== chapterId) setChapterId(id)
    else if (!chapterQuery.isFetching) void chapterQuery.refetch()
  }
  /** 回目录：屏幕上不再有「当前章」；已保存的阅读进度不动 */
  const backToList = () => {
    setListOpen(true)
    setLastGood(null)
  }

  useEffect(() => {
    applySystemBars(theme)
    setReaderDark(theme === 'dark')
    // 离开阅读页（切子页 / 退回书架）把系统栏还给应用主界面，
    // 否则纸色 / 夜间的状态栏会一直带到别的页面
    return () => applySystemBars('light')
  }, [theme, setReaderDark])

  // 切章自动回顶：滚动容器是 BookWorkspace 的 <main>（正文 div 自身不滚），章内容渲染后滚它
  const shownId = listOpen ? null : chapter?.id
  useEffect(() => {
    if (shownId) boxRef.current?.closest('main')?.scrollTo({ top: 0 })
  }, [shownId])

  if (isError && !book) {
    return <ErrorBox error={error} onRetry={() => refetch()} />
  }

  if (!book) return <div className="py-20 text-center text-sm text-stone-400">加载中…</div>

  // 想看的章还没上屏：拉取中不闪目录；拉取失败给错误框（已保存的阅读进度不动，下次进来还会续上）
  if (!listOpen && chapterId && !chapter) {
    if (loadFailed) {
      return (
        <div className="py-6">
          <ErrorBox error={chapterQuery.error} onRetry={retry} />
          <div className="text-center">
            <button
              type="button"
              className="min-h-10 px-6 py-2.5 text-sm text-stone-500 active:text-stone-800"
              onClick={backToList}
            >
              回目录
            </button>
          </div>
        </div>
      )
    }
    return <div className="py-20 text-center text-sm opacity-40">正在打开上一回读到的章节…</div>
  }

  // 目录视图：本线章节 + 分叉标记
  if (listOpen || !chapter) {
    const lineNames = new Map((data?.lines ?? []).map((l) => [l.id, l.name]))
    const chapters = (data?.chapters ?? []).filter((c) => c.lineId === activeLineId)
    const open = (id: string) => {
      setLastGood(null)
      setListOpen(false)
      go(id)
    }
    return (
      <div className="px-4 py-4">
        <div className="mb-3 text-sm font-semibold text-stone-600">
          目录{' '}
          <span className="ml-1 text-xs font-normal text-stone-400">
            {lineNames.get(activeLineId)}
          </span>
        </div>
        <div className="space-y-1.5">
          {chapters.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-baseline gap-3 rounded-xl bg-white px-4 py-3 text-left active:bg-orange-100"
              onClick={() => open(c.id)}
            >
              <span className="w-8 shrink-0 text-xs text-stone-400">{c.orderNo}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
              <span className="shrink-0 text-[11px] text-stone-400">{c.wordCount} 字</span>
            </button>
          ))}
          {chapters.length === 0 && (
            <div className="py-16 text-center text-sm text-stone-400">还没写章节</div>
          )}
        </div>
      </div>
    )
  }

  // 正文视图
  const lineChapters = (data?.chapters ?? []).filter((c) => c.lineId === activeLineId)
  const chIdx = lineChapters.findIndex((c) => c.id === chapter.id)
  const isLast = chIdx === lineChapters.length - 1
  const prev = () => {
    const p = lineChapters[chIdx - 1]
    if (p) go(p.id)
  }
  const next = () => {
    const n = lineChapters[chIdx + 1]
    if (n) go(n.id)
    else backToList()
  }

  return (
    <div className={`min-h-full ${THEME_BG[theme]}`}>
      <div className="sticky top-0 z-10 bg-inherit">
        <div className="flex items-center justify-between px-4 py-2.5">
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-xs opacity-60"
            onClick={backToList}
          >
            ← 目录
          </button>
          <span className="min-w-0 flex-1 truncate px-2 text-center text-xs opacity-50">
            {chIdx + 1}/{lineChapters.length} · 第 {chapter.orderNo} 章 · {chapter.title}
          </span>
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-xs opacity-60"
            onClick={() => setShowSettings((v) => !v)}
          >
            Aa
          </button>
        </div>
        {/* 切章 / 刷新失败的提示挂在吸顶栏里：读到章末按「下一章」失败也看得见，随手能重试 */}
        {loadFailed && (
          <div
            role="alert"
            className="mx-4 mb-2 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            <span className="min-w-0 flex-1 leading-relaxed">
              {fetched
                ? '正文没能刷新，先显示之前打开的内容：'
                : '没能切换章节，还停在当前这一章：'}
              {errorText(chapterQuery.error)}
            </span>
            <button
              type="button"
              className="min-h-10 shrink-0 rounded-lg border border-red-200 px-3 active:bg-red-100"
              onClick={retry}
            >
              重试
            </button>
          </div>
        )}
      </div>

      {showSettings && (
        <div className="mx-4 mb-2 rounded-xl border border-orange-200 bg-orange-50 p-3">
          <div className="mb-2 flex items-center gap-3">
            <span className="text-xs opacity-60">字号</span>
            {[15, 17, 19, 21, 23].map((s) => (
              <button
                key={s}
                type="button"
                className={
                  'rounded-lg px-2.5 py-1 text-xs ' +
                  (fontSize === s ? 'bg-orange-600 text-white' : 'bg-orange-100')
                }
                onClick={() => {
                  setFontSize(s)
                  persist({ fontSize: s })
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs opacity-60">主题</span>
            {(['sepia', 'light', 'dark'] as Appearance[]).map((t) => (
              <button
                key={t}
                type="button"
                className={
                  'rounded-lg px-2.5 py-1 text-xs ' +
                  (theme === t ? 'bg-orange-600 text-white' : 'bg-orange-100')
                }
                onClick={() => {
                  setTheme(t)
                  persist({ theme: t })
                }}
              >
                {t === 'sepia' ? '护眼' : t === 'light' ? '日间' : '夜间'}
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={boxRef} className="px-6 pb-16">
        <h1 className="mb-6 pt-4 text-center text-lg font-semibold">{chapter.title}</h1>
        <div className="leading-8" style={{ fontSize }}>
          {splitParagraphs(chapter.content).map((p, i) =>
            segmentMode ? (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态展示片段，无行内状态
                key={i}
                type="button"
                className="mb-4 w-full rounded-lg px-2 py-1 text-left indent-8 ring-1 ring-transparent active:ring-orange-500/60"
                onClick={() => {
                  setSegTarget(p)
                  setSegText('')
                }}
              >
                {p}
              </button>
            ) : (
              <p
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态展示片段，无行内状态
                key={i}
                className="mb-4 whitespace-pre-wrap indent-8"
              >
                {p}
              </p>
            )
          )}
        </div>

        {/* 选段修改模式下的底部提示条 */}
        {segmentMode && (
          <div className="sticky bottom-0 -mx-6 mb-4 flex items-center justify-between bg-inherit px-6 py-3">
            <span className="text-xs opacity-60">点选要改的段落</span>
            <button
              type="button"
              className="rounded-lg border border-orange-200 px-3 py-1.5 text-xs"
              onClick={() => setSegmentMode(false)}
            >
              退出选段
            </button>
          </div>
        )}

        <QuickActionsBar chapterId={chapter.id} refresh={() => setBookSub('write')} />

        <div className="mt-3 flex gap-3">
          <button
            type="button"
            className={
              'flex-1 rounded-xl border py-2.5 text-xs ' +
              (segmentMode
                ? 'border-orange-600 font-medium text-orange-600'
                : 'border-orange-200 opacity-70')
            }
            onClick={() => setSegmentMode((v) => !v)}
          >
            选段修改
          </button>
        </div>

        <div className="mt-10 mb-4 flex gap-3">
          <button
            type="button"
            className="flex-1 rounded-xl border border-orange-200 py-2.5 text-sm opacity-70"
            onClick={prev}
          >
            上一章
          </button>
          {isLast ? (
            <button
              type="button"
              className="flex-1 rounded-xl border border-orange-600 py-2.5 text-sm font-medium text-orange-600"
              onClick={next}
            >
              已是最新 · 回目录
            </button>
          ) : (
            <button
              type="button"
              className="flex-1 rounded-xl bg-orange-600 py-2.5 text-sm font-medium text-white"
              onClick={next}
            >
              下一章
            </button>
          )}
        </div>
      </div>

      {/* 选段修改弹层 */}
      {segTarget && (
        <BottomSheet onClose={() => setSegTarget(null)} bodyClass="max-h-[70vh] overflow-y-auto">
          <div className="mb-2 text-xs text-stone-500">选中段落：</div>
          <div className="mb-3 line-clamp-3 rounded-lg bg-orange-100 p-2.5 text-xs leading-relaxed text-stone-500">
            {segTarget}
          </div>
          <textarea
            className="mb-3 min-h-20 w-full resize-none rounded-xl border border-orange-100 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-700"
            placeholder="这一段要怎么改？"
            value={segText}
            onChange={(e) => setSegText(e.target.value)}
          />
          <div className="flex gap-3">
            <button
              type="button"
              className="flex-1 rounded-xl border border-orange-200 py-2.5 text-sm text-stone-500"
              onClick={() => setSegTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              disabled={!segText.trim()}
              className="flex-1 rounded-xl bg-orange-600 py-2.5 text-sm font-medium disabled:opacity-40"
              onClick={async () => {
                const target = segTarget
                const instruction = segText.trim()
                setSegTarget(null)
                setSegmentMode(false)
                try {
                  await window.api.job.startRevise(chapter.id, instruction, target)
                  setBookSub('write')
                } catch (e) {
                  toastError(e, '修改失败')
                }
              }}
            >
              改这段
            </button>
          </div>
        </BottomSheet>
      )}

      {/* 版本回看已随「改章不留档」拆除 */}
    </div>
  )
}
