import { Button, Empty } from '@mobile/components/ui'
import { useBackHandler } from '@mobile/lib/backHandler'
import { useTocStore } from '@mobile/lib/tocStore'
import { useThemeStore } from '@mobile/lib/themeStore'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { groupChapterSegments, SEGMENT_SIZE } from '@shared/chapterSegments'
import type { ChapterBrief } from '@shared/types'

const FONT_KEY = 'nm-read-font'
const posKey = (pid: string): string => `nm-read-pos:${pid}`

/** 剥掉章节正文的 md 标题行与 [[链接]] 语法，得到纯文本段落 */
export function parseParagraphs(content: string): string[] {
  return content
    .split(/\r?\n/)
    .filter((l) => !/^#{1,3}\s/.test(l.trim()))
    .map((l) =>
      l.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1').trim()
    )
    .filter(Boolean)
}

/** 阅读页：卷分组目录（只列已写章）+ 排版阅读（字号可调）+ 上下章 + 进度记忆（重进续读） */
export default function Read({ projectId }: { projectId: string }) {
  const { data: briefs = [], isLoading } = useQuery({
    queryKey: ['novel', 'chapterBriefs', projectId],
    queryFn: () => window.api.novel.chapterBriefs(projectId)
  })
  const written = useMemo(
    () =>
      briefs.filter((b) => b.hasDraft).sort((a, b) => a.volume - b.volume || a.chapterNo - b.chapterNo),
    [briefs]
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [hlId, setHlId] = useState<string | null>(null)
  const [font, setFont] = useState(() => {
    const v = Number.parseInt(localStorage.getItem(FONT_KEY) ?? '', 10)
    return Number.isFinite(v) && v >= 12 && v <= 28 ? v : 17
  })
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const idx = openId ? written.findIndex((b) => b.id === openId) : -1
  const current = idx >= 0 ? (written[idx] ?? null) : null
  const { data: chapter, isLoading: loadingChapter } = useQuery({
    queryKey: ['novel', 'chapter', current?.id],
    queryFn: () => window.api.novel.chapter(current!.id),
    enabled: !!current
  })

  // 进度记忆：只在拿到书目后首次进入时续读上次章节；
  // 之后用户退出阅读（点目录/返回键）不再自动弹回（修复回目录被续读吞掉的 bug）
  const restoredForRef = useRef<string | null>(null)
  useEffect(() => {
    if (restoredForRef.current === projectId || written.length === 0) return
    restoredForRef.current = projectId
    const saved = localStorage.getItem(posKey(projectId))
    if (saved && written.some((b) => b.id === saved)) setOpenId(saved)
  }, [written, projectId])

  // 目录定位：每次回到目录，自动展开上次阅读章节所在段、滚动到该章并短暂高亮
  useEffect(() => {
    if (openId || written.length === 0) return
    const last = localStorage.getItem(posKey(projectId))
    const target = last ? written.find((b) => b.id === last) : undefined
    if (!target) return
    useTocStore
      .getState()
      .expandSeg(`${projectId}:${target.volume}:${Math.floor((target.chapterNo - 1) / SEGMENT_SIZE)}`)
    setHlId(target.id)
    // 等分段折叠动画（200ms）铺开后估算的行高稳定，再滚动定位
    const scrollTimer = setTimeout(() => {
      document.querySelector(`[data-chapter-id="${target.id}"]`)?.scrollIntoView({ block: 'center' })
    }, 260)
    const clearTimer = setTimeout(() => setHlId(null), 2400)
    return () => {
      clearTimeout(scrollTimer)
      clearTimeout(clearTimer)
    }
  }, [openId, written, projectId])

  useEffect(() => {
    if (current) localStorage.setItem(posKey(projectId), current.id)
  }, [current, projectId])

  // 阅读中返回键先回目录
  useBackHandler(() => setOpenId(null), openId !== null)

  const isSepia = useThemeStore((s) => s.appearance) === 'sepia'
  const toggleSepia = useThemeStore((s) => s.toggleSepia)
  const openSegs = useTocStore((s) => s.openSegs)
  const toggleSeg = useTocStore((s) => s.toggleSeg)

  const go = (next: number): void => {
    const target = written[next]
    if (!target) return
    setOpenId(target.id)
    scrollRef.current?.scrollTo({ top: 0 })
  }

  const setFontClamped = (v: number): void => {
    const n = Math.min(28, Math.max(12, v))
    setFont(n)
    localStorage.setItem(FONT_KEY, String(n))
  }

  if (isLoading) return <Empty text="加载中…" />
  if (written.length === 0) return <Empty text="还没有已写的章节——先去「写作」子页生成" />

  if (current)
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950/95 px-2 py-1.5">
          <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => setOpenId(null)}>
            目录
          </Button>
          <div className="min-w-0 flex-1 truncate text-center text-xs text-zinc-400">
            第{current.chapterNo}章 {current.title || ''}
          </div>
          <Button
            variant={isSepia ? 'default' : 'ghost'}
            className="px-2 py-1.5 text-xs"
            onClick={toggleSepia}
          >
            护眼
          </Button>
          <Button variant="ghost" className="px-2 py-1.5 text-xs" onClick={() => setFontClamped(font - 2)}>
            A-
          </Button>
          <Button variant="ghost" className="px-2 py-1.5 text-xs" onClick={() => setFontClamped(font + 2)}>
            A+
          </Button>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 leading-loose">
          {loadingChapter ? (
            <Empty text="加载中…" />
          ) : (
            (parseParagraphs(chapter?.content ?? '') ?? []).map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 一次性渲染的静态段落，无重排语义
              <p
                key={i}
                className="mb-3 text-zinc-200 indent-[2em]"
                style={{ fontSize: `${font}px` }}
              >
                {p}
              </p>
            ))
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <Button
            variant="ghost"
            className="flex-1 px-3 py-2 text-xs"
            disabled={idx <= 0}
            onClick={() => go(idx - 1)}
          >
            ← 上一章
          </Button>
          <span className="text-[11px] text-zinc-600">
            {idx + 1}/{written.length}
          </span>
          <Button
            variant="ghost"
            className="flex-1 px-3 py-2 text-xs"
            disabled={idx >= written.length - 1}
            onClick={() => go(idx + 1)}
          >
            下一章 →
          </Button>
        </div>
      </div>
    )

  const groups = groupChapterSegments(written)
  return (
    <div className="h-full overflow-y-auto p-3">
      {groups.map(({ volume, segments }) => (
        <div key={volume} className="mb-4">
          <div className="mb-1.5 px-1 text-xs font-medium text-zinc-500">第 {volume} 卷</div>
          {segments.map((seg) => {
            const key = `${projectId}:${volume}:${seg.segNo}`
            const open = openSegs.has(key)
            return (
              <div key={key} className="mb-2">
                <button
                  type="button"
                  onClick={() => toggleSeg(key)}
                  className="flex w-full items-center gap-1.5 rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2.5 text-xs active:bg-zinc-900"
                >
                  <span
                    className={`text-[10px] text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}
                  >
                    ▸
                  </span>
                  <span className="text-zinc-300">
                    第 {seg.from}-{seg.to} 章
                  </span>
                  <span className="ml-auto text-[11px] text-zinc-500">{seg.chapters.length} 章</span>
                </button>
                <div
                  aria-hidden={!open}
                  className={`grid transition-[grid-template-rows,visibility] duration-200 ease-out ${
                    open ? 'visible grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'
                  }`}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="mt-1.5 space-y-1.5">
                      {seg.chapters.map((b: ChapterBrief) => (
                        <div
                          key={b.id}
                          role="button"
                          tabIndex={0}
                          data-chapter-id={b.id}
                          className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors active:bg-zinc-900 ${
                            hlId === b.id
                              ? 'border-amber-500 bg-amber-600/10'
                              : 'border-zinc-800 bg-zinc-900/60'
                          }`}
                          onClick={() => setOpenId(b.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') setOpenId(b.id)
                          }}
                        >
                          <span className="w-10 shrink-0 text-center text-sm text-zinc-500">
                            {b.chapterNo}
                          </span>
                          <div className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                            {b.title || '（未命名）'}
                          </div>
                          <span className="shrink-0 text-[11px] text-zinc-600">
                            {fmtWords(b.wordCount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function fmtWords(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`
}
