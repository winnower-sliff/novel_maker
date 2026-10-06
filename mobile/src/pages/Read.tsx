import { Button, Empty, Spinner } from '@mobile/components/ui'
import { ReaderSettingsSheet } from '@mobile/components/ReaderSettingsSheet'
import { useBackHandler } from '@mobile/lib/backHandler'
import { useTocStore } from '@mobile/lib/tocStore'
import { useSettingsStore } from '@mobile/lib/settingsStore'
import { useReaderStore } from '@mobile/lib/readerStore'
import { useReaderChromeStore } from '@mobile/lib/readerChromeStore'
import { makeBriefsQuery, makeChapterQuery } from '@mobile/lib/bookQueries'
import { pushToast } from '@wizard/toastStore'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode
} from 'react'
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

/** 拼接流窗口上限（章）：超出后砍掉最旧的头部并补偿 scrollTop */
const MAX_FLOW = 15
/** 距底部小于该距离（px）时预追加下一章 */
const APPEND_AHEAD = 1500
/** 触发上下栏收/展的滚动方向变化阈值（px） */
const SCROLL_DIR_THRESHOLD = 8

/** 阅读正文态：无缝拼接流（滚近底部自动追加下一章，窗口超限砍头重置）+ 聚焦模式
 *  （下滚收上下栏 / 上滚展 / 点屏幕中央切换，顶部保留细进度条）+ 自动滚动
 *  （底栏开关、速度在设置抽屉调、触摸或开抽屉时暂停、末章到底即停）。 */
function ReaderFlow({
  projectId,
  written,
  startIdx,
  onExit
}: {
  projectId: string
  written: ChapterBrief[]
  startIdx: number
  onExit: () => void
}) {
  const [flow, setFlow] = useState({ start: startIdx, end: startIdx })
  const chrome = useReaderChromeStore((s) => s.visible)
  const setChrome = useReaderChromeStore((s) => s.setVisible)
  const [autoOn, setAutoOn] = useState(false)
  const [topIdx, setTopIdx] = useState(startIdx)
  const [sheetOpen, setSheetOpen] = useState(false)
  const font = useSettingsStore((s) => s.font)
  const speed = useSettingsStore((s) => s.autoScrollSpeed)
  const offlineChapter = useReaderStore((s) => s.offlineChapter)
  const setOffline = useReaderStore((s) => s.setOffline)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const progressRef = useRef<HTMLDivElement | null>(null)
  const lastTopRef = useRef(0)
  const touchPauseRef = useRef(false)
  const resumeTimerRef = useRef<number | null>(null)
  const trimRef = useRef<{ cutH: number } | null>(null)
  const jumpRef = useRef<number | null>(null)

  const flowBriefs = useMemo(
    () => written.slice(flow.start, flow.end + 1),
    [written, flow.start, flow.end]
  )

  // 走了离线缓存的章 id 集合：任一命中即顶栏标「离线」，全部新鲜才清除（避免并发覆盖闪烁）
  const offlineIdsRef = useRef(new Set<string>())
  const syncOffline = useCallback((): void => {
    setOffline('chapter', offlineIdsRef.current.size > 0)
  }, [setOffline])

  const chapterQueries = useQueries({
    queries: flowBriefs.map((b) =>
      makeChapterQuery(projectId, b, (id, offline) => {
        if (offline) offlineIdsRef.current.add(id)
        else offlineIdsRef.current.delete(id)
        syncOffline()
      })
    )
  })

  // 砍头补偿 / 跳章定位：flow 变化后的绘制前修正，避免视口跳动
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const trim = trimRef.current
    if (trim) {
      trimRef.current = null
      el.scrollTop -= trim.cutH
    }
    const jump = jumpRef.current
    if (jump != null) {
      jumpRef.current = null
      const sec = el.querySelector<HTMLElement>(`[data-flow-idx="${jump}"]`)
      if (sec) el.scrollTop = sec.offsetTop
    }
    lastTopRef.current = el.scrollTop
  }, [flow])

  // 进度记忆：跟随视口顶部所在章（setReadPos 内部防抖持久化）
  useEffect(() => {
    const b = written[topIdx]
    if (b) useSettingsStore.getState().setReadPos(projectId, b.id)
  }, [topIdx, projectId, written])

  const loadingFlow = chapterQueries.some((q) => q.isLoading)

  // 进入阅读态先清掉上一次会话残留的「离线」标记，由本流 fetch 结果重算
  useEffect(() => {
    setOffline('chapter', false)
  }, [setOffline])

  // 触摸结束后的惯性滚动宽限期：期间不叠加 rAF 推进，避免瞬时加速
  useEffect(
    () => () => {
      if (resumeTimerRef.current != null) clearTimeout(resumeTimerRef.current)
    },
    []
  )

  // 自动滚动：rAF 匀速推进；触摸或设置抽屉打开时暂停；流内全部加载完且到末章底部才停并提示
  useEffect(() => {
    if (!autoOn) return
    let raf = 0
    let last = performance.now()
    let stopped = false
    const step = (now: number): void => {
      raf = requestAnimationFrame(step)
      const el = scrollRef.current
      if (!el) return
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (touchPauseRef.current || sheetOpen || stopped) return
      el.scrollTop += speed * dt
      if (
        !loadingFlow &&
        flow.end >= written.length - 1 &&
        el.scrollTop + el.clientHeight >= el.scrollHeight - 2
      ) {
        stopped = true
        setAutoOn(false)
        pushToast('success', '已到最后一章')
      }
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [autoOn, speed, sheetOpen, loadingFlow, flow.end, written.length])

  // 返回键：设置抽屉优先关，再回目录（后注册者在栈顶）
  useBackHandler(onExit, true)
  useBackHandler(() => setSheetOpen(false), sheetOpen)

  /** 跳到目标章章首：在流内直接定位，否则扩流/重建流后由 layoutEffect 定位 */
  const jumpTo = (targetIdx: number): void => {
    if (targetIdx < 0 || targetIdx >= written.length) return
    if (targetIdx >= flow.start && targetIdx <= flow.end) {
      const el = scrollRef.current
      const sec = el?.querySelector<HTMLElement>(`[data-flow-idx="${targetIdx}"]`)
      if (el && sec) {
        el.scrollTop = sec.offsetTop
        lastTopRef.current = el.scrollTop
      }
      return
    }
    jumpRef.current = targetIdx
    if (targetIdx < flow.start) setFlow({ start: targetIdx, end: Math.max(targetIdx, flow.end) })
    else setFlow({ start: flow.start, end: targetIdx })
  }

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const st = el.scrollTop
    const delta = st - lastTopRef.current
    if (Math.abs(delta) > SCROLL_DIR_THRESHOLD) setChrome(delta < 0)
    lastTopRef.current = st

    // 所在章 = 视口顶部（+40px 容差）落进的 section；滚动容器 relative，offsetTop 即内容坐标
    const secs = el.querySelectorAll<HTMLElement>('[data-flow-idx]')
    let cur = -1
    secs.forEach((s) => {
      if (s.offsetTop <= st + 40) cur = Number(s.dataset.flowIdx)
    })
    if (cur < 0 && secs.length > 0) cur = Number(secs[0].dataset.flowIdx)
    setTopIdx(cur)

    // 细进度条：所在章章内进度（直接改 style，不经过 state）
    const sec = el.querySelector<HTMLElement>(`[data-flow-idx="${cur}"]`)
    if (progressRef.current && sec) {
      const span = sec.offsetHeight - el.clientHeight
      const p = span > 0 ? (st - sec.offsetTop) / span : st >= sec.offsetTop ? 1 : 0
      progressRef.current.style.width = `${Math.min(100, Math.max(0, p * 100))}%`
    }

  // 滚近底部追加下一章；流末章未加载完时暂缓（防止 Spinner 矮内容连环占满窗口）；
  // 窗口超上限时砍头（先量被砍高度，绘制前补偿 scrollTop）
  const tailLoading = chapterQueries[chapterQueries.length - 1]?.isLoading ?? false
  if (
    !tailLoading &&
    flow.end < written.length - 1 &&
    el.scrollHeight - st - el.clientHeight < APPEND_AHEAD
  ) {
      const newEnd = flow.end + 1
      const overflow = newEnd - flow.start + 1 - MAX_FLOW
      if (overflow > 0) {
        let cutH = 0
        for (let i = flow.start; i < flow.start + overflow; i++) {
          cutH += el.querySelector<HTMLElement>(`[data-flow-idx="${i}"]`)?.offsetHeight ?? 0
        }
        trimRef.current = { cutH }
        setFlow({ start: flow.start + overflow, end: newEnd })
      } else {
        setFlow({ start: flow.start, end: newEnd })
      }
    }
  }

  // 点屏幕中央 1/3 区域手动切换上下栏显隐
  const handleBodyClick = (e: MouseEvent): void => {
    const el = scrollRef.current
    if (!el) return
    const y = e.clientY - el.getBoundingClientRect().top
    if (y > el.clientHeight * 0.3 && y < el.clientHeight * 0.7) setChrome(!chrome)
  }

  const chromeWrap = (inner: ReactNode): ReactNode => (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out ${
        chrome ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      }`}
    >
      <div className="min-h-0 overflow-hidden">{inner}</div>
    </div>
  )

  return (
    <div className="relative flex h-full flex-col">
      <div
        ref={progressRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-amber-500"
        style={{ width: 0 }}
      />
      {chromeWrap(
        <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-950/95 px-2 py-1.5">
          <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={onExit}>
            目录
          </Button>
          <div className="min-w-0 flex-1 truncate text-center text-xs text-zinc-400">
            {offlineChapter && !loadingFlow && (
              <span className="mr-1 text-amber-500/90">离线</span>
            )}
            {written[topIdx] ? `第${written[topIdx].chapterNo}章 ${written[topIdx].title || ''}` : ''}
          </div>
          <Button variant="ghost" className="px-2 py-1.5 text-xs" onClick={() => setSheetOpen(true)}>
            Aa
          </Button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4 leading-loose"
        onScroll={handleScroll}
        onClick={handleBodyClick}
        onTouchStart={() => {
          if (resumeTimerRef.current != null) clearTimeout(resumeTimerRef.current)
          touchPauseRef.current = true
        }}
        onTouchEnd={() => {
          // 惯性滚动宽限期后恢复自动推进，避免与 momentum 叠加瞬时加速
          if (resumeTimerRef.current != null) clearTimeout(resumeTimerRef.current)
          resumeTimerRef.current = window.setTimeout(() => {
            touchPauseRef.current = false
          }, 500)
        }}
        onTouchCancel={() => {
          if (resumeTimerRef.current != null) clearTimeout(resumeTimerRef.current)
          resumeTimerRef.current = window.setTimeout(() => {
            touchPauseRef.current = false
          }, 500)
        }}
      >
        {flow.start > 0 && (
          <button
            type="button"
            className="mx-auto mb-4 block rounded-full border border-zinc-800 px-4 py-1.5 text-xs text-zinc-500 active:bg-zinc-900"
            onClick={(e) => {
              e.stopPropagation()
              jumpTo(flow.start - 1)
            }}
          >
            · 回到第 {written[flow.start - 1].chapterNo} 章 ·
          </button>
        )}
        {flowBriefs.map((b, i) => {
          const q = chapterQueries[i]
          if (!q) return null
          return (
            <section key={b.id} data-flow-idx={flow.start + i} className="mb-10">
              <h2 className="mb-4 font-medium text-zinc-100" style={{ fontSize: font + 3 }}>
                第{b.chapterNo}章 {b.title || '（未命名）'}
              </h2>
              {q.isLoading ? (
                <Spinner />
              ) : q.isError ? (
                <div className="text-xs text-zinc-500">本章正文未缓存，联网后重试</div>
              ) : (
                parseParagraphs(q.data?.content ?? '').map((p, pi) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 一次性渲染的静态段落，无重排语义
                  <p
                    key={pi}
                    className="mb-3 text-zinc-200 indent-[2em]"
                    style={{ fontSize: `${font}px` }}
                  >
                    {p}
                  </p>
                ))
              )}
            </section>
          )
        })}
      </div>
      {chromeWrap(
        <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <Button
            variant="ghost"
            className="flex-1 px-3 py-2 text-xs"
            disabled={topIdx <= 0}
            onClick={() => jumpTo(topIdx - 1)}
          >
            ← 上一章
          </Button>
          <Button
            variant="ghost"
            className={`px-3 py-2 text-xs ${autoOn ? 'text-amber-400' : ''}`}
            onClick={() => setAutoOn((v) => !v)}
          >
            {autoOn ? '停止' : '自动'}
          </Button>
          <span className="text-[11px] text-zinc-600">
            {topIdx + 1}/{written.length}
          </span>
          <Button
            variant="ghost"
            className="flex-1 px-3 py-2 text-xs"
            disabled={topIdx >= written.length - 1}
            onClick={() => jumpTo(topIdx + 1)}
          >
            下一章 →
          </Button>
        </div>
      )}
      {sheetOpen && <ReaderSettingsSheet onClose={() => setSheetOpen(false)} />}
    </div>
  )
}

/** 阅读页：卷分组目录（只列已写章）+ 拼接流正文阅读 + 进度记忆（重进续读）。
 *  整本预取在进书时由 Book 层触发（不依赖本页挂载）；断网时目录/正文自动回退缓存（顶栏标「离线」）。 */
export default function Read({ projectId, title }: { projectId: string; title?: string }) {
  const setOffline = useReaderStore((s) => s.setOffline)
  const { data: briefs = [], isLoading } = useQuery(
    makeBriefsQuery(projectId, title ?? '', (offline) => setOffline('briefs', offline))
  )
  const written = useMemo(
    () =>
      briefs.filter((b) => b.hasDraft).sort((a, b) => a.volume - b.volume || a.chapterNo - b.chapterNo),
    [briefs]
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [hlId, setHlId] = useState<string | null>(null)
  const openSegs = useTocStore((s) => s.openSegs)
  const toggleSeg = useTocStore((s) => s.toggleSeg)
  const idx = openId ? written.findIndex((b) => b.id === openId) : -1

  // 进度记忆：只在拿到书目后首次进入时续读上次章节；
  // 之后用户退出阅读（点目录/返回键）不再自动弹回（修复回目录被续读吞掉的 bug）
  const restoredForRef = useRef<string | null>(null)
  useEffect(() => {
    if (restoredForRef.current === projectId || written.length === 0) return
    restoredForRef.current = projectId
    const saved = useSettingsStore.getState().readPos[projectId]
    if (saved && written.some((b) => b.id === saved)) setOpenId(saved)
  }, [written, projectId])

  // 正文流挂载期间启用 Book 壳层联动收展；退出复位，防目录态/换 tab 残留收起态。
  // 依赖用「是否正文态」布尔而非 openId：换章重挂载 ReaderFlow 不经过 active=false 中间态
  const inFlow = openId !== null
  useEffect(() => {
    if (!inFlow) return
    useReaderChromeStore.getState().setActive(true)
    return () => {
      const st = useReaderChromeStore.getState()
      st.setActive(false)
      st.setVisible(true)
    }
  }, [inFlow])

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

  if (isLoading) return <Empty text="加载中…" />
  if (written.length === 0) return <Empty text="还没有已写的章节——先去「写作」子页生成" />

  if (idx >= 0)
    return (
      <ReaderFlow
        key={openId}
        projectId={projectId}
        written={written}
        startIdx={idx}
        onExit={() => setOpenId(null)}
      />
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
