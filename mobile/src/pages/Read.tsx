import { useEffect, useRef, useState } from 'react'
import type { Chapter } from '@shared/types'
import { useBook } from '../lib/queries'
import { loadJson, saveJson } from '../lib/persist'
import { applySystemBars, type Appearance } from '../lib/systemBars'
import { useUiStore } from '../lib/uiStore'

const THEME_BG: Record<Appearance, string> = {
  dark: 'bg-zinc-950 text-zinc-200',
  sepia: 'bg-[#f4ecd8] text-[#433422]',
  light: 'bg-white text-zinc-800'
}

export default function Read() {
  const openBookId = useUiStore((s) => s.openBookId) ?? ''
  const { data } = useBook(openBookId)
  const [chapterId, setChapterId] = useState<string | null>(null)
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [fontSize, setFontSize] = useState(17)
  const [theme, setTheme] = useState<Appearance>('dark')
  const [showSettings, setShowSettings] = useState(false)
  const [listOpen, setListOpen] = useState(true)
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

  // 拉正文
  useEffect(() => {
    if (!chapterId) return
    let alive = true
    window.api.chapter.get(chapterId).then((c) => {
      if (alive) setChapter(c)
    })
    return () => {
      alive = false
    }
  }, [chapterId])

  const persist = (patch: { chapterId?: string; fontSize?: number; theme?: Appearance }) => {
    saveJson(`read:${openBookId}`, {
      chapterId: patch.chapterId ?? chapterId ?? undefined,
      fontSize: patch.fontSize ?? fontSize,
      theme: patch.theme ?? theme
    })
  }

  useEffect(() => {
    applySystemBars(theme)
  }, [theme])

  if (!book) return <div className="py-20 text-center text-sm text-zinc-600">加载中…</div>

  // 目录视图：本线章节 + 分叉标记
  if (listOpen || !chapter) {
    const lineNames = new Map((data?.lines ?? []).map((l) => [l.id, l.name]))
    const chapters = (data?.chapters ?? []).filter((c) => c.lineId === activeLineId)
    return (
      <div className="px-4 py-4">
        <div className="mb-3 text-sm font-semibold text-zinc-300">
          目录 <span className="ml-1 text-xs font-normal text-zinc-600">{lineNames.get(activeLineId)}</span>
        </div>
        <div className="space-y-1.5">
          {chapters.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-baseline gap-3 rounded-xl bg-zinc-900/60 px-4 py-3 text-left active:bg-zinc-800"
              onClick={() => {
                setChapterId(c.id)
                setListOpen(false)
                persist({ chapterId: c.id })
                boxRef.current?.scrollTo({ top: 0 })
              }}
            >
              <span className="w-8 shrink-0 text-xs text-zinc-600">{c.orderNo}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
              <span className="shrink-0 text-[11px] text-zinc-600">{c.wordCount} 字</span>
            </button>
          ))}
          {chapters.length === 0 && (
            <div className="py-16 text-center text-sm text-zinc-600">还没写章节</div>
          )}
        </div>
      </div>
    )
  }

  // 正文视图
  const prev = () => {
    const list = (data?.chapters ?? []).filter((c) => c.lineId === activeLineId)
    const idx = list.findIndex((c) => c.id === chapter.id)
    const p = list[idx - 1]
    if (p) {
      setChapterId(p.id)
      persist({ chapterId: p.id })
      window.api.chapter.get(p.id).then(setChapter)
    }
  }
  const next = () => {
    const list = (data?.chapters ?? []).filter((c) => c.lineId === activeLineId)
    const idx = list.findIndex((c) => c.id === chapter.id)
    const n = list[idx + 1]
    if (n) {
      setChapterId(n.id)
      persist({ chapterId: n.id })
      window.api.chapter.get(n.id).then(setChapter)
    } else {
      setListOpen(true)
      setChapter(null)
    }
  }

  return (
    <div className={`min-h-full ${THEME_BG[theme]}`}>
      <div className="sticky top-0 z-10 flex items-center justify-between bg-inherit px-4 py-2.5">
        <button
          type="button"
          className="rounded-lg px-2 py-1 text-xs opacity-60"
          onClick={() => {
            setListOpen(true)
            setChapter(null)
          }}
        >
          ← 目录
        </button>
        <span className="truncate px-2 text-xs opacity-50">
          第 {chapter.orderNo} 章 · {chapter.title}
        </span>
        <button type="button" className="rounded-lg px-2 py-1 text-xs opacity-60" onClick={() => setShowSettings((v) => !v)}>
          Aa
        </button>
      </div>

      {showSettings && (
        <div className="mx-4 mb-2 rounded-xl border border-black/10 bg-black/5 p-3 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-2 flex items-center gap-3">
            <span className="text-xs opacity-60">字号</span>
            {[15, 17, 19, 21].map((s) => (
              <button
                key={s}
                type="button"
                className={
                  'rounded-lg px-2.5 py-1 text-xs ' +
                  (fontSize === s ? 'bg-emerald-600 text-white' : 'bg-black/10 dark:bg-zinc-800')
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
            {(['dark', 'sepia', 'light'] as Appearance[]).map((t) => (
              <button
                key={t}
                type="button"
                className={
                  'rounded-lg px-2.5 py-1 text-xs ' +
                  (theme === t ? 'bg-emerald-600 text-white' : 'bg-black/10 dark:bg-zinc-800')
                }
                onClick={() => {
                  setTheme(t)
                  persist({ theme: t })
                }}
              >
                {t === 'dark' ? '夜间' : t === 'sepia' ? '护眼' : '日间'}
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={boxRef} className="px-6 pb-16">
        <h1 className="mb-6 pt-4 text-center text-lg font-semibold">{chapter.title}</h1>
        <div className="whitespace-pre-wrap leading-8" style={{ fontSize }}>
          {chapter.content}
        </div>
        <div className="mt-10 mb-4 flex gap-3">
          <button
            type="button"
            className="flex-1 rounded-xl border border-black/10 py-2.5 text-sm opacity-70 dark:border-zinc-700"
            onClick={prev}
          >
            上一章
          </button>
          <button
            type="button"
            className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-medium text-white"
            onClick={next}
          >
            下一章
          </button>
        </div>
      </div>
    </div>
  )
}
