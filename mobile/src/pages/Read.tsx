import { useEffect, useRef, useState } from 'react'
import type { Chapter } from '@shared/types'
import QuickActionsBar from '../components/QuickActionsBar'
import { useBook } from '../lib/queries'
import { loadJson, saveJson } from '../lib/persist'
import { applySystemBars, type Appearance } from '../lib/systemBars'
import { useUiStore } from '../lib/uiStore'

const THEME_BG: Record<Appearance, string> = {
  sepia: 'bg-[#f4ecd8] text-[#433422]',
  light: 'bg-white text-stone-800'
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
  const { data } = useBook(openBookId)
  const [chapterId, setChapterId] = useState<string | null>(null)
  const [chapter, setChapter] = useState<Chapter | null>(null)
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

  if (!book) return <div className="py-20 text-center text-sm text-stone-400">加载中…</div>

  // 目录视图：本线章节 + 分叉标记
  if (listOpen || !chapter) {
    const lineNames = new Map((data?.lines ?? []).map((l) => [l.id, l.name]))
    const chapters = (data?.chapters ?? []).filter((c) => c.lineId === activeLineId)
    return (
      <div className="px-4 py-4">
        <div className="mb-3 text-sm font-semibold text-stone-600">
          目录 <span className="ml-1 text-xs font-normal text-stone-400">{lineNames.get(activeLineId)}</span>
        </div>
        <div className="space-y-1.5">
          {chapters.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-baseline gap-3 rounded-xl bg-white px-4 py-3 text-left active:bg-orange-100"
              onClick={() => {
                setChapterId(c.id)
                setListOpen(false)
                persist({ chapterId: c.id })
                boxRef.current?.scrollTo({ top: 0 })
              }}
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
        <div className="mx-4 mb-2 rounded-xl border border-orange-200 bg-orange-50 p-3">
          <div className="mb-2 flex items-center gap-3">
            <span className="text-xs opacity-60">字号</span>
            {[15, 17, 19, 21].map((s) => (
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
            {(['sepia', 'light'] as Appearance[]).map((t) => (
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
                {t === 'sepia' ? '护眼' : '日间'}
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
                key={i}
                type="button"
                className="mb-4 w-full rounded-lg px-2 py-1 text-left ring-1 ring-transparent active:ring-orange-500/60"
                onClick={() => {
                  setSegTarget(p)
                  setSegText('')
                }}
              >
                {p}
              </button>
            ) : (
              <p key={i} className="mb-4 whitespace-pre-wrap">
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
          <button
            type="button"
            className="flex-1 rounded-xl bg-orange-600 py-2.5 text-sm font-medium text-white"
            onClick={next}
          >
            下一章
          </button>
        </div>
      </div>

      {/* 选段修改弹层 */}
      {segTarget && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setSegTarget(null)}>
          <div
            className="max-h-[70vh] w-full overflow-y-auto rounded-t-2xl border-t border-orange-100 bg-white p-5 pb-safe"
            onClick={(e) => e.stopPropagation()}
          >
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
                  await window.api.job.startRevise(chapter.id, instruction, target)
                  setBookSub('write')
                }}
              >
                改这段
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 版本回看已随「改章不留档」拆除 */}
    </div>
  )
}
