import { Button, Empty } from '@mobile/components/ui'
import { useBackHandler } from '@mobile/lib/backHandler'
import { useTocStore } from '@mobile/lib/tocStore'
import { useSettingsStore } from '@mobile/lib/settingsStore'
import { useReaderStore } from '@mobile/lib/readerStore'
import {
  getCachedBriefs,
  getCachedChapter,
  prefetchBook,
  putBriefs,
  putChapters
} from '@mobile/lib/readerCache'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { groupChapterSegments, SEGMENT_SIZE } from '@shared/chapterSegments'
import type { ChapterBrief } from '@shared/types'

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

/** 阅读页：卷分组目录（只列已写章）+ 排版阅读（字号可调）+ 上下章 + 进度记忆（重进续读）。
 *  打开即后台整本预取正文到 IndexedDB；断网时目录/正文自动回退缓存（顶栏标「离线」）。 */
export default function Read({ projectId, title }: { projectId: string; title?: string }) {
  const { data: briefs = [], isLoading } = useQuery({
    queryKey: ['novel', 'chapterBriefs', projectId],
    queryFn: async (): Promise<ChapterBrief[]> => {
      try {
        const fresh = await window.api.novel.chapterBriefs(projectId)
        setOffline('briefs', false)
        void putBriefs({ projectId, title: title ?? '', briefs: fresh, cachedAt: Date.now() })
        return fresh
      } catch (err) {
        const cached = await getCachedBriefs(projectId)
        if (cached) {
          setOffline('briefs', true)
          return cached.briefs
        }
        throw err
      }
    }
  })
  const written = useMemo(
    () =>
      briefs.filter((b) => b.hasDraft).sort((a, b) => a.volume - b.volume || a.chapterNo - b.chapterNo),
    [briefs]
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [hlId, setHlId] = useState<string | null>(null)
  const font = useSettingsStore((s) => s.font)
  const setFont = useSettingsStore((s) => s.setFont)
  const setOffline = useReaderStore((s) => s.setOffline)
  const offlineChapter = useReaderStore((s) => s.offlineChapter)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const idx = openId ? written.findIndex((b) => b.id === openId) : -1
  const current = idx >= 0 ? (written[idx] ?? null) : null
  const { data: chapter, isLoading: loadingChapter, isError: chapterError } = useQuery({
    queryKey: ['novel', 'chapter', current?.id],
    queryFn: async () => {
      if (!current) throw new Error('no chapter')
      try {
        const fresh = await window.api.novel.chapter(current.id)
        if (!fresh) throw new Error('chapter not written')
        setOffline('chapter', false)
        void putChapters([
          {
            id: current.id,
            projectId,
            volume: current.volume,
            chapterNo: current.chapterNo,
            title: current.title,
            content: fresh.content,
            wordCount: fresh.wordCount,
            cachedAt: Date.now()
          }
        ])
        return fresh
      } catch (err) {
        const cached = await getCachedChapter(current.id)
        if (cached) {
          setOffline('chapter', true)
          return cached
        }
        throw err
      }
    },
    enabled: !!current
  })

  // 进度记忆：只在拿到书目后首次进入时续读上次章节；
  // 之后用户退出阅读（点目录/返回键）不再自动弹回（修复回目录被续读吞掉的 bug）
  const restoredForRef = useRef<string | null>(null)
  useEffect(() => {
    if (restoredForRef.current === projectId || written.length === 0) return
    restoredForRef.current = projectId
    const saved = useSettingsStore.getState().readPos[projectId]
    if (saved && written.some((b) => b.id === saved)) setOpenId(saved)
  }, [written, projectId])

  // 目录定位：每次回到目录，自动展开上次阅读章节所在段、滚动到该章并短暂高亮
  useEffect(() => {
    if (openId || written.length === 0) return
    const last = useSettingsStore.getState().readPos[projectId]
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
    if (current) useSettingsStore.getState().setReadPos(projectId, current.id)
  }, [current, projectId])

  // 整本预取：目录就绪后后台增量拉取全部已写章正文（跳过已缓存），失败静默、下次续传
  useEffect(() => {
    if (written.length === 0) return
    void prefetchBook(projectId, written)
  }, [written, projectId])

  // 阅读中返回键先回目录
  useBackHandler(() => setOpenId(null), openId !== null)

  const isSepia = useSettingsStore((s) => s.appearance) === 'sepia'
  const toggleSepia = useSettingsStore((s) => s.toggleSepia)
  const openSegs = useTocStore((s) => s.openSegs)
  const toggleSeg = useTocStore((s) => s.toggleSeg)

  const go = (next: number): void => {
    const target = written[next]
    if (!target) return
    setOpenId(target.id)
    scrollRef.current?.scrollTo({ top: 0 })
  }

  const nudgeFont = (delta: number): void => {
    setFont(font + delta)
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
            {offlineChapter && !loadingChapter && (
              <span className="mr-1 text-amber-500/90">离线</span>
            )}
            第{current.chapterNo}章 {current.title || ''}
          </div>
          <Button
            variant={isSepia ? 'default' : 'ghost'}
            className="px-2 py-1.5 text-xs"
            onClick={toggleSepia}
          >
            护眼
          </Button>
          <Button variant="ghost" className="px-2 py-1.5 text-xs" onClick={() => nudgeFont(-2)}>
            A-
          </Button>
          <Button variant="ghost" className="px-2 py-1.5 text-xs" onClick={() => nudgeFont(2)}>
            A+
          </Button>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 leading-loose">
          {loadingChapter ? (
            <Empty text="加载中…" />
          ) : chapterError && !chapter ? (
            <Empty text="本章正文未缓存，联网后重试" />
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
