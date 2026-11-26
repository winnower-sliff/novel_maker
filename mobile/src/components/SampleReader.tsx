import type { Book, SampleSearchHit, SampleSectionView } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useBackHandler } from '../lib/backHandler'
import { FONT_MAX, FONT_MIN, useSamplePrefs } from '../lib/samplePrefs'
import { errorText } from '../lib/toastStore'
import { BottomSheet } from './BottomSheet'
import { ErrorBox } from './ErrorBox'
import { IconChevronLeft, IconLibrary, IconList, IconSearch } from './icons'

/** 阅读窗口大小（8k 字一屏，前后翻页步长） */
const WINDOW = 8000
/** readText 单次上限：整章不超过这个数就一次取全，章内不用再翻 */
const MAX_FETCH = 10000
/** 搜索命中的窗口起点往前挪这么多字，保证关键词的上下文可见 */
const HIT_LEAD = 600
/** 翻到范围末尾附近时至少留这么多字，免得翻出一屏只有一两行 */
const TAIL_KEEP = 500
/** 没解析出章节结构的范文，按这些百分比直达 */
const PERCENTS = [0, 25, 50, 75, 100]

/** 面板：目录 / 搜索 / 给哪些书用 */
type Panel = 'toc' | 'search' | 'bind' | null

interface SampleLite {
  id: string
  name: string
  chars: number
}

/** 一窗正文。secIdx 为 -1 表示不在任何一节里（开头、按百分比跳、没解析出章节） */
interface TextView {
  label: string
  from: number
  len: number
  text: string
  secIdx: number
  /** 这一窗所属范围的终点（章末 / 全文末）：章内翻页不越过它 */
  end: number
}

interface Para {
  /** 该段所在行在全文里的起点（当列表 key 用） */
  at: number
  /** 行终点（不含换行）：判断某个全文偏移落在哪一段用 */
  end: number
  text: string
}

/** 正文窗口切段落：去掉行首尾的空白缩进（渲染统一用首行缩进），空行丢弃 */
function toParas(raw: string, base: number): Para[] {
  const out: Para[] = []
  let pos = 0
  for (const line of raw.split('\n')) {
    const at = base + pos
    pos += line.length + 1
    const text = line.replace(/^[ \t　]+/, '').trim()
    if (text) out.push({ at, end: at + line.length, text })
  }
  return out
}

/** 按关键词把一段文字切开，记下每块的位置（当列表 key 用）；关键词本身的块标 hit */
function splitByWord(
  text: string,
  word: string,
  base: number
): { at: number; text: string; hit: boolean }[] {
  const out: { at: number; text: string; hit: boolean }[] = []
  let pos = 0
  for (;;) {
    const i = text.indexOf(word, pos)
    if (i < 0) {
      if (pos < text.length) out.push({ at: base + pos, text: text.slice(pos), hit: false })
      return out
    }
    if (i > pos) out.push({ at: base + pos, text: text.slice(pos, i), hit: false })
    out.push({ at: base + i, text: word, hit: true })
    pos = i + word.length
  }
}

/** 命中列表的 key：同一处可能既中章标题又中正文（位置、章名都一样），重了就加个序号 */
function hitKeys(hits: SampleSearchHit[]): string[] {
  const seen = new Map<string, number>()
  return hits.map((h) => {
    const base = `${h.index}:${h.label}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}#${n}`
  })
}

const HEADER_BTN =
  'flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-full px-2.5 text-sm text-stone-600 active:bg-orange-100'

/**
 * 范文阅读层（全屏覆盖层）：正文 + 目录 / 搜索两个面板。
 * 返回键：面板是 BottomSheet，各自接了返回键、后挂载的在栈顶——先关面板，面板都关了才轮到这里退出阅读。
 * 阅读进度按范文记在本机（samplePrefs），下次打开接着读；字号所有范文共用。
 */
export function SampleReader({ sample, onClose }: { sample: SampleLite; onClose: () => void }) {
  useBackHandler(onClose)
  const fontSize = useSamplePrefs((s) => s.fontSize)
  const setFontSize = useSamplePrefs((s) => s.setFontSize)
  const [panel, setPanel] = useState<Panel>(null)
  const [view, setView] = useState<TextView | null>(null)
  /** 搜索命中后要滚到眼前的全文偏移 */
  const [focusAt, setFocusAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<unknown>(null)
  const [q, setQ] = useState('')
  const [search, setSearch] = useState<{ query: string; hits: SampleSearchHit[] } | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<unknown>(null)
  const [bindBusy, setBindBusy] = useState('')
  const [bindErr, setBindErr] = useState<unknown>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  /** 最近一次取正文的请求序号：慢响应回来时已被更新的请求取代就不上屏 */
  const seqRef = useRef(0)
  const retryRef = useRef<(() => void) | null>(null)
  const openedRef = useRef(false)

  const sectionsQ = useQuery({
    queryKey: ['sampleSections', sample.id],
    queryFn: async (): Promise<SampleSectionView[]> => window.api.sample.sections(sample.id)
  })
  const sections = sectionsQ.data
  const sectionsReady = sections !== undefined || sectionsQ.isError
  const chapterCount = sections?.filter((s) => s.kind === 'chapter').length ?? 0

  const queryClient = useQueryClient()
  const { data: books } = useQuery({
    queryKey: ['books'],
    queryFn: async (): Promise<Book[]> => window.api.book.list()
  })
  /** 与范文页一致：归档书和还没开完的书不参与绑定 */
  // 按书名排序：绑定会刷新 books，接口按最近更新排，不排的话点一本书它自己跳到最前
  const bindable = (books ?? [])
    .filter((b) => !b.archived && !b.draft)
    .sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  const boundCount = bindable.filter((b) => b.sampleSources?.includes(sample.id)).length

  /** 勾一下就立即保存（与范文页的绑定胶囊同一套语义，多本可同时绑） */
  const toggleBind = async (book: Book) => {
    const on = book.sampleSources?.includes(sample.id) ?? false
    const nextIds = on
      ? (book.sampleSources ?? []).filter((x) => x !== sample.id)
      : [...(book.sampleSources ?? []), sample.id]
    setBindBusy(book.id)
    setBindErr(null)
    try {
      await window.api.sample.attach(book.id, nextIds)
      await queryClient.invalidateQueries({ queryKey: ['books'] })
      await queryClient.invalidateQueries({ queryKey: ['samples'] })
    } catch (e) {
      setBindErr(e)
    } finally {
      setBindBusy('')
    }
  }

  // 打开期间锁住底层页面滚动（防滚动穿透）
  useEffect(() => {
    const old = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = old
    }
  }, [])

  // 打开搜索面板就把光标放进输入框（随手的点击手势还在，键盘能直接弹出来）
  useEffect(() => {
    if (panel === 'search') searchInputRef.current?.focus()
  }, [panel])

  /**
   * 取一窗正文。end 是这一窗所属范围的终点（章末 / 全文末）：章内翻页不越过它，下一章靠「下一章」。
   * focus：搜索命中的位置，上屏后滚到眼前并把关键词标出来。
   */
  const openText = async (
    label: string,
    from: number,
    secIdx: number,
    len = WINDOW,
    end = Number.POSITIVE_INFINITY,
    focus: number | null = null
  ): Promise<void> => {
    const seq = ++seqRef.current
    retryRef.current = () => void openText(label, from, secIdx, len, end, focus)
    setLoading(true)
    setLoadErr(null)
    try {
      const start = Math.max(0, Math.min(from, sample.chars))
      const t = await window.api.sample.readText(
        sample.id,
        start,
        Math.max(200, Math.min(len, end - start))
      )
      if (seq !== seqRef.current) return
      setView({ label, from: t.from, len: t.chars, text: t.text, secIdx, end })
      setFocusAt(focus)
      useSamplePrefs.getState().remember(sample.id, {
        from: t.from,
        len: t.chars,
        label,
        secIdx
      })
    } catch (e) {
      if (seq !== seqRef.current) return
      setLoadErr(e)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }

  // 首次定位只做一次，且等目录到手（窗口才不会跨章）：接着上次读到的位置；没读过从第一章开头。
  // 第一章前面还有书名页、引言时不跳过它们——目录里给一个「开头」条目，这里仍然直接进第一章。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在目录首次到手时定位一次，openText 只用到 sample 的字段
  useEffect(() => {
    if (openedRef.current || !sectionsReady) return
    openedRef.current = true
    const saved = useSamplePrefs.getState().progress[sample.id]
    const sec = saved && saved.secIdx >= 0 ? sections?.[saved.secIdx] : undefined
    const first = sections?.[0]
    if (saved && saved.from < sample.chars) {
      void openText(saved.label, saved.from, sec ? saved.secIdx : -1, saved.len, sec?.end)
    } else if (first) {
      void openText(
        first.label,
        first.start,
        0,
        Math.min(MAX_FETCH, Math.max(200, first.chars)),
        first.end
      )
    } else {
      void openText('全文', 0, -1)
    }
  }, [sample.chars, sample.id, sectionsReady])

  // 换了一窗内容就回到顶部；从搜索命中进来的把命中那段滚到屏幕中间
  useEffect(() => {
    const box = boxRef.current
    if (!box || view === null) return
    const hit = focusAt === null ? null : box.querySelector('[data-hit]')
    if (hit) hit.scrollIntoView({ block: 'center' })
    else box.scrollTo({ top: 0 })
  }, [view, focusAt])

  const openSection = (i: number) => {
    const s = sections?.[i]
    if (!s) return
    // 整章一次取全（readText 单次上限）；长章先取开头一窗，章内再翻
    void openText(s.label, s.start, i, Math.min(MAX_FETCH, Math.max(200, s.chars)), s.end)
  }

  const jump = (delta: number) => {
    if (view) openSection(view.secIdx + delta)
  }

  /** 章内翻页：向后从窗口最后一段的段首起步、向前从窗口第一段回退，有意轻微重叠，绝不在句子中间接续 */
  const page = (delta: 1 | -1) => {
    if (!view) return
    let from: number
    if (delta > 0) {
      const nl = view.text.lastIndexOf('\n')
      // 整窗都没有换行（一大段到底）就只能直接接在窗口末尾
      from = nl >= 0 ? view.from + nl + 1 : view.from + view.len
    } else {
      const nl = view.text.indexOf('\n')
      from = view.from + (nl >= 0 ? nl + 1 : 0) - WINDOW
    }
    const floor = sections?.[view.secIdx]?.start ?? 0
    from = Math.max(floor, Math.min(from, Math.max(floor, view.end - TAIL_KEEP)))
    // 向前翻被夹回了原位（窗口开头到上一个换行超过一整窗）：退到本范围开头
    if (delta < 0 && from >= view.from) from = floor
    if (from === view.from) return
    void openText(view.label, from, view.secIdx, WINDOW, view.end)
  }

  const pctJump = (p: number) => {
    const from = Math.min(
      Math.floor((sample.chars * p) / 100),
      Math.max(0, sample.chars - TAIL_KEEP)
    )
    void openText(`全文 ${p}%`, from, -1)
  }

  const openPreamble = () => {
    const first = sections?.[0]
    if (first) {
      void openText('开头', 0, -1, Math.min(MAX_FETCH, Math.max(200, first.start)), first.start)
    }
  }

  const doSearch = async () => {
    const query = q.trim()
    if (!query || searching) return
    setSearching(true)
    setSearchErr(null)
    try {
      setSearch({ query, hits: await window.api.sample.search(sample.id, query) })
    } catch (e) {
      setSearchErr(e)
    } finally {
      setSearching(false)
    }
  }

  const openHit = (h: SampleSearchHit) => {
    const i = sections ? sections.findIndex((s) => s.start <= h.index && h.index < s.end) : -1
    const sec = i >= 0 ? sections?.[i] : undefined
    setPanel(null)
    // 窗口起点：命中前 600 字，但不早于所在章的开头（章标题才对得上）
    void openText(
      h.label,
      Math.max(sec?.start ?? 0, h.index - HIT_LEAD),
      i,
      WINDOW,
      sec?.end,
      h.index
    )
  }

  const sec = view && view.secIdx >= 0 ? sections?.[view.secIdx] : undefined
  const canBack = view !== null && view.from > (sec?.start ?? 0)
  const canFwd = view !== null && view.from + view.len < view.end
  const pct = view
    ? Math.min(100, Math.round(((view.from + view.len) / Math.max(1, sample.chars)) * 100))
    : 0
  const hasPrev = view !== null && sections !== undefined && sections[view.secIdx - 1] !== undefined
  const hasNext = view !== null && sections !== undefined && sections[view.secIdx + 1] !== undefined

  // 窗口从章开头起时，章标题已经用大字排在最前面，正文里不再重复一遍
  const skipBefore = sec && view?.from === sec.start ? view.from + view.text.indexOf('\n') + 1 : -1
  const paras = useMemo(() => {
    const all = view ? toParas(view.text, view.from) : []
    return skipBefore > 0 ? all.filter((p) => p.at >= skipBefore) : all
  }, [view, skipBefore])

  // 搜索命中的那一段：标黄关键词并滚到眼前
  const word = focusAt === null ? '' : (search?.query ?? '')
  const focus = focusAt ?? 0
  const hitAt = word ? (paras.find((p) => p.at <= focus && focus < p.end)?.at ?? -1) : -1
  const hitKeyList = search ? hitKeys(search.hits) : []

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#fbf6ec]">
      <header className="flex shrink-0 items-center gap-1 border-b border-orange-100 bg-white px-2 pb-2 pt-safe">
        <button
          type="button"
          className="flex h-11 min-w-11 shrink-0 items-center gap-0.5 rounded-full pl-1.5 pr-2 text-sm text-stone-600 active:bg-orange-100"
          onClick={onClose}
        >
          <IconChevronLeft size={18} />
          返回
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-sm font-medium text-orange-500">
          {sample.name}
        </div>
        <button type="button" className={HEADER_BTN} onClick={() => setPanel('search')}>
          <IconSearch />
          搜索
        </button>
        <button type="button" className={HEADER_BTN} onClick={() => setPanel('toc')}>
          <IconList />
          目录
        </button>
      </header>

      {/* 翻页 / 跳章失败：手里还有内容就留在原地，只在顶栏下挂一条可重试的提示 */}
      {loadErr !== null && view && (
        <div
          role="alert"
          className="mx-4 mt-2 flex shrink-0 items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <span className="min-w-0 flex-1 leading-relaxed">
            没能翻开新的一页，还停在当前内容：{errorText(loadErr)}
          </span>
          <button
            type="button"
            className="min-h-10 shrink-0 rounded-lg border border-red-200 px-3 active:bg-red-100"
            onClick={() => retryRef.current?.()}
          >
            重试
          </button>
        </div>
      )}

      {view && (
        <div className="flex shrink-0 items-center justify-between border-b border-orange-100 bg-white/70 px-4 py-2 text-[11px] text-stone-400">
          <span className="min-w-0 flex-1 truncate">{view.label}</span>
          <span className="ml-2 shrink-0 tabular-nums">{pct}%</span>
        </div>
      )}

      <div
        ref={boxRef}
        className="no-scrollbar flex-1 overflow-y-auto overscroll-contain px-5 py-5"
      >
        {view === null && loadErr !== null && !loading && (
          <ErrorBox error={loadErr} onRetry={() => retryRef.current?.()} />
        )}
        {view === null && loading && (
          <div className="py-16 text-center text-sm text-stone-400">加载中…</div>
        )}
        {view && (
          <>
            {sec && (
              <h1
                className="mb-4 border-l-4 border-orange-400 pl-3 font-bold leading-snug text-stone-800"
                style={{ fontSize: fontSize + 3 }}
              >
                {sec.label}
              </h1>
            )}
            {paras.map((p) => (
              <p
                key={p.at}
                data-hit={p.at === hitAt || undefined}
                className="mb-2.5 indent-[2em] [text-justify:inter-ideograph] tracking-[0.01em] text-stone-800"
                style={{ fontSize, lineHeight: 1.9 }}
              >
                {p.at === hitAt
                  ? splitByWord(p.text, word, p.at).map((seg) =>
                      seg.hit ? (
                        <mark key={seg.at} className="rounded-sm bg-amber-200 px-0.5 text-inherit">
                          {seg.text}
                        </mark>
                      ) : (
                        <Fragment key={seg.at}>{seg.text}</Fragment>
                      )
                    )
                  : p.text}
              </p>
            ))}
          </>
        )}
      </div>

      <footer className="shrink-0 border-t border-orange-100 bg-white px-4 pb-safe pt-2.5">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={loading || !hasPrev}
            className="h-11 rounded-xl border border-orange-200 text-sm text-stone-600 active:bg-orange-50 disabled:opacity-40"
            onClick={() => jump(-1)}
          >
            上一章
          </button>
          <button
            type="button"
            disabled={loading || !hasNext}
            className="h-11 rounded-xl border border-orange-200 text-sm text-orange-700 active:bg-orange-50 disabled:opacity-40"
            onClick={() => jump(1)}
          >
            下一章
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <span className="mr-1 text-[11px] text-stone-400">字号</span>
            <button
              type="button"
              aria-label="字小一点"
              disabled={fontSize <= FONT_MIN}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-orange-200 text-sm font-semibold text-stone-600 active:bg-orange-50 disabled:opacity-40"
              onClick={() => setFontSize(fontSize - 1)}
            >
              A−
            </button>
            <button
              type="button"
              aria-label="字大一点"
              disabled={fontSize >= FONT_MAX}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-orange-200 text-sm font-semibold text-stone-600 active:bg-orange-50 disabled:opacity-40"
              onClick={() => setFontSize(fontSize + 1)}
            >
              A＋
            </button>
          </div>
          {/* 章内翻页：整章都在屏里时两钮都灰着，长章与没解析出章节的书才用得上 */}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading || !canBack}
              className="min-h-10 rounded-full bg-orange-50 px-3 text-xs text-stone-600 active:bg-orange-100 disabled:opacity-40"
              onClick={() => page(-1)}
            >
              向前翻
            </button>
            <button
              type="button"
              disabled={loading || !canFwd}
              className="min-h-10 rounded-full bg-orange-50 px-3 text-xs text-stone-600 active:bg-orange-100 disabled:opacity-40"
              onClick={() => page(1)}
            >
              向后翻
            </button>
          </div>
        </div>
      </footer>

      {/* 目录 */}
      {panel === 'toc' && (
        <BottomSheet onClose={() => setPanel(null)}>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-base font-bold">目录</h2>
            <span className="shrink-0 text-xs text-stone-400">
              {sample.chars.toLocaleString()} 字{sections ? ` · ${chapterCount} 章` : ''}
            </span>
          </div>
          {sectionsQ.isError && !sections ? (
            <ErrorBox error={sectionsQ.error} onRetry={() => void sectionsQ.refetch()} />
          ) : !sections ? (
            <div className="py-6 text-center text-xs text-stone-400">目录加载中…</div>
          ) : sections.length === 0 ? (
            <div className="text-center text-xs leading-relaxed text-stone-400">
              这本范文没解析出章节结构（可能是连续文本），按位置翻阅：
              <div className="mt-3 flex justify-center gap-2">
                {PERCENTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="min-h-10 rounded-full border border-orange-200 px-3.5 text-xs text-stone-600 active:bg-orange-50"
                    onClick={() => {
                      pctJump(p)
                      setPanel(null)
                    }}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="-mx-2 max-h-[60vh] overflow-y-auto no-scrollbar px-2">
              {(sections[0]?.start ?? 0) > 0 && (
                <button
                  type="button"
                  className="flex min-h-10 w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-stone-500 active:bg-orange-50"
                  onClick={() => {
                    openPreamble()
                    setPanel(null)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">开头（第一章之前）</span>
                </button>
              )}
              {sections.map((s, i) => {
                const current = i === view?.secIdx
                return (
                  <button
                    key={s.start}
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    className={`flex min-h-10 w-full items-baseline gap-3 rounded-xl px-3 py-2.5 text-left active:bg-orange-50 ${
                      current ? 'bg-orange-50' : ''
                    }`}
                    onClick={() => {
                      openSection(i)
                      setPanel(null)
                    }}
                  >
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${
                        current
                          ? 'font-semibold text-orange-700'
                          : s.kind === 'chapter'
                            ? 'text-stone-700'
                            : 'text-stone-500'
                      }`}
                    >
                      {s.kind === 'chapter' ? '' : '§ '}
                      {s.label}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-stone-400">
                      {s.chars.toLocaleString()} 字
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          <div className="mt-2 border-t border-orange-100 pt-2">
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-3 text-left text-sm text-stone-600 active:bg-orange-50"
              onClick={() => setPanel('bind')}
            >
              <span className="flex items-center gap-2">
                <IconLibrary className="h-4 w-4" />
                给哪些书用
              </span>
              <span className="shrink-0 text-xs text-stone-400">
                {boundCount > 0 ? `已绑定 ${boundCount} 本` : '未绑定'} ›
              </span>
            </button>
          </div>
        </BottomSheet>
      )}

      {/* 搜索 */}
      {panel === 'search' && (
        <BottomSheet onClose={() => setPanel(null)}>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void doSearch()
            }}
          >
            <input
              ref={searchInputRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜人名、桥段、词句…"
              enterKeyHint="search"
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-orange-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-orange-400"
            />
            <button
              type="submit"
              disabled={searching || !q.trim()}
              className="min-h-11 shrink-0 rounded-xl bg-orange-600 px-4 text-sm text-white active:bg-orange-700 disabled:opacity-50"
            >
              {searching ? '搜索中…' : '搜索'}
            </button>
          </form>
          <div className="-mx-2 mt-3 max-h-[55vh] overflow-y-auto no-scrollbar px-2 pb-1">
            {searchErr !== null ? (
              <ErrorBox error={searchErr} onRetry={() => void doSearch()} />
            ) : search ? (
              search.hits.length > 0 ? (
                <div className="space-y-2">
                  {search.hits.map((h, i) => (
                    <button
                      key={hitKeyList[i] ?? `${h.index}`}
                      type="button"
                      className="block w-full rounded-xl border border-orange-100 bg-white p-3 text-left active:bg-orange-50"
                      onClick={() => openHit(h)}
                    >
                      <div className="mb-1 text-[11px] font-medium text-orange-700">{h.label}</div>
                      <div className="text-xs leading-relaxed text-stone-500">{h.snippet}</div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-stone-400">
                  没找到「{search.query}」
                </div>
              )
            ) : (
              <div className="py-8 text-center text-xs leading-relaxed text-stone-400">
                在这本范文的全文里找人名、地名、桥段、词句，点结果直接跳过去
              </div>
            )}
          </div>
        </BottomSheet>
      )}

      {/* 给哪些书用 */}
      {panel === 'bind' && (
        <BottomSheet onClose={() => setPanel(null)}>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-base font-bold">给哪些书用</h2>
            <span className="shrink-0 text-xs text-stone-400">可多选，点一下即保存</span>
          </div>
          {bindErr !== null && <ErrorBox error={bindErr} onRetry={() => setBindErr(null)} />}
          {bindable.length === 0 ? (
            <div className="py-8 text-center text-xs leading-relaxed text-stone-400">
              还没有可以绑定的书。先到「写书」里开一本。
            </div>
          ) : (
            <div className="-mx-2 max-h-[55vh] overflow-y-auto no-scrollbar px-2 pb-1">
              {bindable.map((b) => {
                const on = b.sampleSources?.includes(sample.id) ?? false
                return (
                  <button
                    key={b.id}
                    type="button"
                    aria-pressed={on}
                    disabled={bindBusy === b.id}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left active:bg-orange-50 disabled:opacity-60"
                    onClick={() => void toggleBind(b)}
                  >
                    <span
                      aria-hidden="true"
                      className={
                        on
                          ? 'flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-orange-600 text-[11px] font-bold text-white'
                          : 'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-stone-300 text-[11px] font-bold text-transparent'
                      }
                    >
                      ✓
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-stone-700">
                      {b.title}
                    </span>
                    {bindBusy === b.id && (
                      <span className="shrink-0 text-[11px] text-stone-400">保存中…</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-stone-400">
            绑上之后，写这本书时导演能翻到这本范文找语感。
          </p>
        </BottomSheet>
      )}
    </div>
  )
}
