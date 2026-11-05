import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ChapterOutline, ChatMessageRow, Job, Scene } from '@shared/types'
import ReportCard from '../components/ReportCard'
import QuickActionsBar from '../components/QuickActionsBar'
import { qk, useBook, useJobFlow, useMessages, useStatusCard } from '../lib/queries'
import { useUiStore } from '../lib/uiStore'
import { useKeyboardInset } from '../lib/useKeyboardInset'

const KIND_LABEL: Record<string, string> = {
  steady: '顺势',
  twist: '破局',
  depth: '纵深',
  wild: '野路子'
}
const KIND_COLOR: Record<string, string> = {
  steady: 'bg-orange-100 text-orange-700',
  twist: 'bg-orange-200/80 text-orange-700',
  depth: 'bg-amber-200/90 text-orange-800',
  wild: 'bg-amber-100 text-orange-800'
}

/** 节点消息 step → 对应 waiting 时 job.step（后端状态机：waiting 在「下一步」上） */
const WAIT_STEP_FOR: Record<string, string> = {
  cards: 'outline',
  outline: 'scene',
  scenes: 'draft',
  selfcheck: 'selfcheck'
}

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function Write() {
  const bookId = useUiStore((s) => s.openBookId) ?? ''
  const qc = useQueryClient()
  const { data: flow } = useJobFlow(bookId)
  const { data: messages } = useMessages(bookId)
  const { data: detail } = useBook(bookId)
  const jobs = flow?.jobs ?? []
  const active = flow?.active ?? null

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.jobs(bookId) })
    void qc.invalidateQueries({ queryKey: qk.messages(bookId) })
  }
  const refreshAll = () => {
    refresh()
    void qc.invalidateQueries({ queryKey: qk.book(bookId) })
    void qc.invalidateQueries({ queryKey: qk.statusCard(bookId) })
  }

  const jobsById = new Map(jobs.map((j) => [j.id, j]))
  const chaptersById = new Map((detail?.chapters ?? []).map((c) => [c.id, c]))

  const listRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const msgCount = messages?.length ?? 0
  useEffect(() => {
    if (stickRef.current) {
      const el = listRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [msgCount])

  return (
    <div className="flex h-full flex-col">
      <div
        ref={listRef}
        id="write-list"
        className="min-h-0 flex-1 overflow-y-auto no-scrollbar"
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
        }}
      >
        <StatusHead bookId={bookId} />
        {(messages ?? []).map((m) => (
          <MessageRow
            key={m.id}
            msg={m}
            jobsById={jobsById}
            chaptersById={chaptersById}
            active={active}
            refresh={refresh}
            refreshAll={refreshAll}
          />
        ))}
        {active && (active.state === 'running' || active.state === 'queued') && (
          <StreamingBar job={active} refresh={refresh} />
        )}
        <div className="h-3" />
      </div>

      <InputBar bookId={bookId} active={active} detail={detail} refresh={refreshAll} />
    </div>
  )
}

// ── 顶部现状摘要（随流滚走） ─────────────────────────────────────────────────

function StatusHead({ bookId }: { bookId: string }) {
  const { data: card } = useStatusCard(bookId)
  if (!card) return null
  return (
    <div className="px-4 pt-3">
      <div className="rounded-2xl border border-orange-100 bg-white/60 p-3.5">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-stone-600">现在写到</span>
          <span className="text-[11px] text-stone-500">
            {card.lineName} · 第 {card.chapterCount + 1} 章
          </span>
        </div>
        {card.characters.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {card.characters.slice(0, 6).map((c) => (
              <span key={c.name} className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] text-stone-600">
                {c.name}
              </span>
            ))}
          </div>
        )}
        {card.openForeshadows.length > 0 && (
          <div className="mt-2 text-[11px] text-stone-500">
            未闭合伏笔 {card.openForeshadows.length} 条
            {card.openForeshadows.slice(0, 2).map((f) => (
              <span key={f.title} className="text-orange-700/80">
                {' '}
                · {f.title}
              </span>
            ))}
          </div>
        )}
      </div>
      {card.staleDays != null && card.staleDays > 7 && (
        <div className="mt-2 rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs leading-relaxed text-orange-700">
          已 {card.staleDays} 天没写。翻翻「阅读」接上前情，或直接开写——导演会在走向里帮你接上。
        </div>
      )}
    </div>
  )
}

// ── 消息分派 ────────────────────────────────────────────────────────────────

function MessageRow({
  msg,
  jobsById,
  chaptersById,
  active,
  refresh,
  refreshAll
}: {
  msg: ChatMessageRow
  jobsById: Map<string, Job>
  chaptersById: Map<string, { id: string; orderNo: number; title: string; wordCount: number }>
  active: Job | null
  refresh: () => void
  refreshAll: () => void
}) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end px-4 py-1.5">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-orange-600 px-3.5 py-2 text-sm leading-relaxed text-white">
          {msg.content}
        </div>
      </div>
    )
  }

  const meta = msg.meta ?? {}
  if (meta.kind === 'job' && typeof meta.jobId === 'string') {
    const job = jobsById.get(meta.jobId)
    if (job) {
      return (
        <JobCard
          job={job}
          step={typeof meta.step === 'string' ? meta.step : ''}
          active={active}
          chaptersById={chaptersById}
          refresh={refresh}
          refreshAll={refreshAll}
        />
      )
    }
  }
  // chat 对话 / 找不到 job 的孤儿节点 → 白话气泡
  return (
    <div className="flex justify-start px-4 py-1.5">
      <div className="max-w-[88%]">
        <div className="rounded-2xl rounded-tl-sm border border-orange-100 bg-white px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap text-stone-700">
          {msg.content}
        </div>
        <div className="mt-0.5 pl-1 text-[10px] text-stone-400">{hhmm(msg.createdAt)}</div>
      </div>
    </div>
  )
}

// ── 节点卡（按 job step 分派） ──────────────────────────────────────────────

function JobCard({
  job,
  step,
  active,
  chaptersById,
  refresh,
  refreshAll
}: {
  job: Job
  step: string
  active: Job | null
  chaptersById: Map<string, { id: string; orderNo: number; title: string; wordCount: number }>
  refresh: () => void
  refreshAll: () => void
}) {
  const interactive =
    !!active &&
    active.id === job.id &&
    active.state === 'waiting_user' &&
    WAIT_STEP_FOR[step] === active.step

  if (step === 'cards') {
    return interactive ? (
      <CardsInteractive job={job} refresh={refresh} />
    ) : (
      <StaticBubble>
        {job.payload.direction
          ? `本章走向：${job.payload.direction.text}`
          : `本章走向备选 ${job.payload.cards?.length ?? 0} 张`}
      </StaticBubble>
    )
  }
  if (step === 'outline') {
    return interactive ? (
      <OutlineInteractive job={job} refresh={refresh} />
    ) : (
      <OutlineStatic job={job} />
    )
  }
  if (step === 'scenes') {
    return interactive ? (
      <ScenesInteractive job={job} refresh={refresh} />
    ) : (
      <ScenesStatic job={job} />
    )
  }
  if (step === 'selfcheck') {
    return interactive ? (
      <SelfcheckInteractive job={job} refresh={refresh} />
    ) : (
      <StaticBubble>自检发现问题 · {job.payload.autoFixed ? '自动修过一轮' : '已处理'}</StaticBubble>
    )
  }
  if (step === 'chapter') return <ChapterDoneCard job={job} chaptersById={chaptersById} refresh={refreshAll} />
  if (step === 'revised') return <RevisedCard job={job} />
  if (step === 'report') {
    return job.payload.report ? (
      <div className="px-4 py-2">
        <ReportCard report={job.payload.report} />
      </div>
    ) : null
  }
  if (step === 'failed') {
    return (
      <div className="px-4 py-2">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3.5">
          <div className="mb-1 text-xs font-semibold text-red-600">卡住了</div>
          <div className="text-xs leading-relaxed break-all text-stone-500">{job.error || '未知错误'}</div>
          {active && active.id === job.id && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-xl bg-orange-600 py-2 text-xs font-medium"
                onClick={async () => {
                  await window.api.job.retry(job.id)
                  refresh()
                }}
              >
                重试
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl border border-orange-200 py-2 text-xs text-stone-500"
                onClick={refresh}
              >
                算了
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }
  if (step === 'cancelled') return <StaticBubble>{msg0(job)}</StaticBubble>
  return <StaticBubble>{step}</StaticBubble>
}

function msg0(job: Job): string {
  return job.error ? `已取消：${job.error}` : '已按你的要求取消'
}

function StaticBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-start px-4 py-1.5">
      <div className="rounded-2xl rounded-tl-sm border border-orange-100 bg-orange-50 px-3.5 py-2 text-sm leading-relaxed text-stone-600">
        {children}
      </div>
    </div>
  )
}

// ── 走向卡（交互） ──────────────────────────────────────────────────────────

function CardsInteractive({ job, refresh }: { job: Job; refresh: () => void }) {
  const cards = job.payload.cards ?? []
  const [busy, setBusy] = useState(false)
  const [regen, setRegen] = useState(false)

  const choose = async (choice: { source: 'card' | 'free'; cardIndex?: number; text: string }) => {
    setBusy(true)
    try {
      await window.api.job.chooseDirection(job.id, choice)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-2">
      <div className="mb-2 text-xs text-stone-500">本章往哪走？选一个方向</div>
      <div className="space-y-2.5">
        {cards.map((c, i) => (
          <button
            key={i}
            type="button"
            disabled={busy}
            className="w-full rounded-2xl border border-orange-100 bg-white p-3.5 text-left active:border-orange-700 disabled:opacity-50"
            onClick={() => choose({ source: 'card', cardIndex: i, text: c.title })}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${KIND_COLOR[c.kind] ?? ''}`}>
                {KIND_LABEL[c.kind] ?? c.kind}
              </span>
              <span className="text-sm font-semibold">{c.title}</span>
            </div>
            <div className="text-xs leading-relaxed text-stone-500">{c.preview}</div>
            <div className="mt-1.5 flex flex-wrap gap-2 text-[11px] text-stone-400">
              <span>{c.structure}</span>
              {c.arc && <span className="text-stone-500">◦ {c.arc}</span>}
            </div>
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        className="mt-3 w-full rounded-xl border border-orange-100 py-2 text-xs text-stone-500 disabled:opacity-50"
        onClick={() => setRegen(true)}
      >
        换一批
      </button>
      <div className="mt-1 text-center text-[11px] text-stone-400">或在下方输入框直接说你要的走向</div>
      {regen && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setRegen(false)}>
          <div
            className="w-full rounded-t-2xl border-t border-orange-100 bg-white p-5 pb-safe"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 text-sm text-stone-600">换一批会重新提案（当前选择作废），继续？</div>
            <div className="flex gap-3">
              <button
                type="button"
                className="flex-1 rounded-xl border border-orange-200 py-2.5 text-sm text-stone-500"
                onClick={() => setRegen(false)}
              >
                再想想
              </button>
              <button
                type="button"
                disabled={busy}
                className="flex-1 rounded-xl bg-orange-600 py-2.5 text-sm font-medium"
                onClick={async () => {
                  setRegen(false)
                  setBusy(true)
                  try {
                    await window.api.job.cancel(job.id)
                    await window.api.job.startWrite(job.bookId)
                    refresh()
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                换一批
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 大纲（交互/静态） ───────────────────────────────────────────────────────

function OutlineInteractive({ job, refresh }: { job: Job; refresh: () => void }) {
  const outline: ChapterOutline = job.payload.outline ?? { title: '', synopsis: '', beats: [] }
  const [title, setTitle] = useState(outline.title)
  const [synopsis, setSynopsis] = useState(outline.synopsis)
  const [beats, setBeats] = useState<string[]>(outline.beats)
  const [busy, setBusy] = useState(false)

  return (
    <div className="px-4 py-2">
      <div className="mb-2 text-xs text-stone-500">章级大纲——可改，确认后拆分镜</div>
      <div className="rounded-2xl border border-orange-100 bg-white p-3.5">
        <input
          className="mb-2 w-full rounded-lg border border-orange-100 px-2.5 py-2 text-sm font-semibold outline-none focus:border-orange-700"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="mb-2 min-h-24 w-full resize-none rounded-lg border border-orange-100 px-2.5 py-2 text-xs leading-relaxed outline-none focus:border-orange-700"
          value={synopsis}
          onChange={(e) => setSynopsis(e.target.value)}
        />
        <div className="space-y-1.5">
          {beats.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-4 shrink-0 text-center text-[11px] text-stone-400">{i + 1}</span>
              <input
                className="min-w-0 flex-1 rounded-lg border border-orange-100 px-2 py-1.5 text-xs outline-none focus:border-orange-700"
                value={b}
                onChange={(e) => setBeats(beats.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button
                type="button"
                className="shrink-0 rounded-full p-1 text-stone-400 hover:text-red-600"
                onClick={() => setBeats(beats.filter((_, j) => j !== i))}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
          <button
            type="button"
            className="w-full rounded-lg border border-dashed border-orange-100 py-1.5 text-[11px] text-stone-500"
            onClick={() => setBeats([...beats, ''])}
          >
            + 加一拍
          </button>
        </div>
      </div>
      <button
        type="button"
        disabled={busy || !title.trim()}
        className="mt-3 w-full rounded-2xl bg-orange-600 py-3 text-sm font-semibold disabled:opacity-50"
        onClick={async () => {
          setBusy(true)
          try {
            await window.api.job.confirmOutline(job.id, {
              title,
              synopsis,
              beats: beats.filter((b) => b.trim())
            })
            refresh()
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? '提交…' : '就这样，出分镜'}
      </button>
    </div>
  )
}

function OutlineStatic({ job }: { job: Job }) {
  const o = job.payload.outline
  if (!o) return null
  return (
    <div className="px-4 py-2">
      <div className="rounded-2xl border border-orange-100 bg-orange-50 p-3.5">
        <div className="text-sm font-semibold">《{o.title}》</div>
        <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-stone-500">{o.synopsis}</div>
        {o.beats.length > 0 && (
          <div className="mt-1.5 text-[11px] text-stone-400">{o.beats.length} 拍</div>
        )}
      </div>
    </div>
  )
}

// ── 分镜（交互/静态） ───────────────────────────────────────────────────────

function ScenesInteractive({ job, refresh }: { job: Job; refresh: () => void }) {
  const scenes: Scene[] = job.payload.scenes ?? []
  const [list, setList] = useState<Scene[]>(scenes)
  const [busy, setBusy] = useState(false)

  const go = async (final: Scene[] | null) => {
    setBusy(true)
    try {
      await window.api.job.confirmScenes(job.id, final)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-2">
      <div className="mb-2 text-xs text-stone-500">场景分镜——每一幕的镜头感，可微调</div>
      <div className="space-y-2">
        {list.map((s, i) => (
          <div key={s.id} className="rounded-xl border border-orange-100 bg-white p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] text-stone-500">
                幕 {i + 1}
              </span>
              <span className="text-[11px] text-stone-400">
                {s.viewpoint} · {s.pace}
              </span>
            </div>
            <textarea
              className="min-h-14 w-full resize-none rounded-lg px-1 py-1 text-xs leading-relaxed outline-none"
              value={s.summary}
              onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, summary: e.target.value } : x)))}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        className="mt-3 w-full rounded-2xl bg-orange-600 py-3 text-sm font-semibold disabled:opacity-50"
        onClick={() => go(list)}
      >
        {busy ? '提交…' : '开写正文'}
      </button>
      <button
        type="button"
        disabled={busy}
        className="mt-2 w-full rounded-xl py-2 text-xs text-stone-500 disabled:opacity-50"
        onClick={() => go(null)}
      >
        跳过分镜，直接开写
      </button>
    </div>
  )
}

function ScenesStatic({ job }: { job: Job }) {
  const scenes = job.payload.scenes
  return (
    <div className="px-4 py-2">
      <div className="rounded-2xl border border-orange-100 bg-orange-50 p-3.5">
        <div className="text-xs font-semibold text-stone-600">
          {scenes ? `${scenes.length} 幕分镜` : '跳过分镜直接开写'}
        </div>
        {scenes?.map((s, i) => (
          <div key={s.id} className="mt-1 line-clamp-1 text-[11px] text-stone-500">
            {i + 1}. {s.summary}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 自检（交互） ────────────────────────────────────────────────────────────

function SelfcheckInteractive({ job, refresh }: { job: Job; refresh: () => void }) {
  const lint = job.payload.lint
  const autoFixed = job.payload.autoFixed
  const [busy, setBusy] = useState(false)

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-2">
      <div className="mb-2 text-xs font-semibold text-orange-700">
        {autoFixed ? '自动修了一轮，还有这些问题——你来定夺' : '自检发现这些问题'}
      </div>
      <div className="space-y-2">
        {lint?.issues.map((iss, i) => (
          <div key={i} className="rounded-xl border border-orange-100 bg-white p-3">
            <div className="mb-1 flex items-center gap-2">
              <span
                className={
                  'rounded-full px-2 py-0.5 text-[11px] ' +
                  (iss.level === 'major' ? 'bg-red-100 text-red-600' : 'bg-orange-100 text-stone-500')
                }
              >
                {iss.rule}
              </span>
            </div>
            {iss.quote && <div className="mb-1 truncate text-[11px] text-stone-500">「{iss.quote}」</div>}
            <div className="text-xs leading-relaxed text-stone-500">{iss.advice}</div>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        className="mt-3 w-full rounded-2xl bg-orange-600 py-3 text-sm font-semibold disabled:opacity-50"
        onClick={() => act(() => window.api.job.retry(job.id))}
      >
        再修一轮
      </button>
      <button
        type="button"
        disabled={busy}
        className="mt-2 w-full rounded-xl border border-orange-200 py-2.5 text-sm text-stone-500 disabled:opacity-50"
        onClick={() => act(() => window.api.job.acceptFlaws(job.id))}
      >
        接受瑕疵，直接入书
      </button>
    </div>
  )
}

// ── 章节完成卡（正文折叠+纪要+快捷钮） ──────────────────────────────────────

function ChapterDoneCard({
  job,
  chaptersById,
  refresh
}: {
  job: Job
  chaptersById: Map<string, { id: string; orderNo: number; title: string; wordCount: number }>
  refresh: () => void
}) {
  const setBookSub = useUiStore((s) => s.setBookSub)
  const [expanded, setExpanded] = useState(false)
  const ch = chaptersById.get(job.chapterId ?? '')
  const draft = job.payload.draftText ?? ''
  const recap = job.payload.recap

  return (
    <div className="px-4 py-2">
      <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-orange-700">✓ 已入书</div>
          {ch && (
            <div className="text-[11px] text-stone-500">
              第 {ch.orderNo} 章 · {ch.title} · {ch.wordCount} 字
            </div>
          )}
        </div>
        {draft && (
          <div className="mt-2.5">
            <div
              className={
                'text-xs leading-relaxed whitespace-pre-wrap text-stone-600 ' +
                (expanded ? '' : 'line-clamp-3')
              }
            >
              {draft}
            </div>
            <button
              type="button"
              className="mt-1 text-[11px] text-orange-700"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '收起' : '展开全文'}
            </button>
          </div>
        )}
      </div>
      {recap && (
        <div className="mt-2">
          <RecapCard recap={recap} />
        </div>
      )}
      {job.chapterId && (
        <div className="mt-2">
          <QuickActionsBar chapterId={job.chapterId} quickActions={recap?.quickActions} refresh={refresh} />
        </div>
      )}
      <button
        type="button"
        className="mt-2 w-full rounded-xl border border-orange-200 py-2.5 text-sm text-stone-700"
        onClick={() => setBookSub('read')}
      >
        去读读这章
      </button>
    </div>
  )
}

function RevisedCard({ job }: { job: Job }) {
  const setBookSub = useUiStore((s) => s.setBookSub)
  const issues = job.payload.lint?.issues ?? []
  return (
    <div className="px-4 py-2">
      <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
        <div className="text-sm font-semibold text-orange-700">✓ 改好了（新版本已生效）</div>
        {job.payload.revise && (
          <div className="mt-1 text-[11px] text-stone-500">指令：{job.payload.revise.instruction}</div>
        )}
        <div className="mt-1 text-[11px] text-stone-500">
          {job.payload.draftWordCount ? `${job.payload.draftWordCount} 字 · ` : ''}
          自检 {issues.length === 0 ? '零问题' : `${issues.length} 条提示`}
        </div>
      </div>
      <button
        type="button"
        className="mt-2 w-full rounded-xl border border-orange-200 py-2.5 text-sm text-stone-700"
        onClick={() => setBookSub('read')}
      >
        去读读这章
      </button>
    </div>
  )
}

function RecapCard({ recap }: { recap: NonNullable<Job['payload']['recap']> }) {
  return (
    <div className="rounded-2xl border border-orange-100 bg-white p-4">
      <div className="mb-2 text-xs font-semibold text-stone-500">本章纪要</div>
      <div className="text-xs leading-relaxed text-stone-600">{recap.summary}</div>
      {recap.stateChanges.length > 0 && (
        <div className="mt-3 border-t border-orange-100/70 pt-2">
          <div className="mb-1 text-[11px] text-stone-500">人物动向</div>
          {recap.stateChanges.map((sc, i) => (
            <div key={i} className="text-xs text-stone-500">
              <span className="text-stone-600">{sc.name}</span>
              {typeof sc.patch.location === 'string' && <span> · {sc.patch.location}</span>}
              {typeof sc.patch.mood === 'string' && <span> · {sc.patch.mood}</span>}
            </div>
          ))}
        </div>
      )}
      {recap.foreshadowOps.length > 0 && (
        <div className="mt-3 border-t border-orange-100/70 pt-2">
          <div className="mb-1 text-[11px] text-stone-500">伏笔</div>
          {recap.foreshadowOps.map((f, i) => (
            <div key={i} className="text-xs text-orange-700/80">
              {f.op === 'plant' ? '埋下' : f.op === 'plan' ? '计划' : '回收'} · {f.title}
            </div>
          ))}
        </div>
      )}
      {recap.cardOps.length > 0 && (
        <div className="mt-3 border-t border-orange-100/70 pt-2">
          <div className="mb-1 text-[11px] text-stone-500">设定沉淀</div>
          {recap.cardOps.map((c, i) => (
            <div key={i} className="text-xs text-stone-500">
              {c.op === 'create' ? '新增' : c.op === 'update' ? '更新' : '删除'} · {c.title}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 生成中流式条（时间轴尾部） ──────────────────────────────────────────────

const RUN_LABEL: Record<string, string> = {
  proposal: '导演正在构思走向…',
  outline: '正在展开章级大纲…',
  scene: '正在拆分场景分镜…',
  selfcheck: '自检中…',
  finalize: '落章收尾中…'
}

function StreamingBar({ job, refresh }: { job: Job; refresh: () => void }) {
  const streaming =
    (job.kind === 'write' && job.step === 'draft') ||
    job.kind === 'revise' ||
    job.kind === 'chat'
  const [text, setText] = useState('')
  const [cancelConfirm, setCancelConfirm] = useState(false)

  useEffect(() => {
    setText(job.payload.draftText ?? '')
    const off = window.api.job.onDelta((jobId, chunk) => {
      if (jobId === job.id) setText((t) => t + chunk)
    })
    return off
  }, [job.id, job.payload.draftText])

  useEffect(() => {
    if (stickToBottom()) {
      const el = document.getElementById('write-stream-box')
      if (el) el.scrollIntoView({ block: 'end' })
    }
  }, [text])

  if (job.state === 'queued') {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-stone-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400" />
        排队中，前一个任务完成后自动开始
      </div>
    )
  }

  if (!streaming) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-stone-500">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-orange-200 border-t-orange-500" />
        {RUN_LABEL[job.step] ?? '处理中…'}
      </div>
    )
  }

  const label =
    job.kind === 'write' ? '正文生成中' : job.kind === 'revise' ? '改章中' : '导演正在回话'

  return (
    <div id="write-stream-box" className="px-4 py-2">
      <div className="rounded-2xl border border-orange-100 bg-white p-3.5">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-orange-600">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400" />
            {label}
          </div>
          <button
            type="button"
            className="rounded-lg border border-orange-100 px-2.5 py-1 text-[11px] text-stone-500"
            onClick={() => (job.kind === 'chat' ? cancel() : setCancelConfirm(true))}
          >
            取消
          </button>
        </div>
        <div className="max-h-56 overflow-y-auto no-scrollbar">
          <div className="text-sm leading-relaxed whitespace-pre-wrap text-stone-700">
            {text || '提笔中…'}
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-orange-400 align-middle" />
          </div>
        </div>
      </div>
      {cancelConfirm && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setCancelConfirm(false)}>
          <div
            className="w-full rounded-t-2xl border-t border-orange-100 bg-white p-5 pb-safe"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-sm font-medium text-red-600">
              {job.kind === 'write' ? '取消将作废本章' : '取消将作废本次改章（原章不受影响）'}
            </div>
            {job.kind === 'write' && (
              <div className="mb-4 text-xs text-stone-500">已生成内容不会保留，需要重头再来。</div>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                className="flex-1 rounded-xl border border-orange-200 py-2.5 text-sm text-stone-500"
                onClick={() => setCancelConfirm(false)}
              >
                继续写
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-medium"
                onClick={() => {
                  setCancelConfirm(false)
                  cancel()
                }}
              >
                作废
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  async function cancel() {
    await window.api.job.cancel(job.id)
    refresh()
  }
}

function stickToBottom(): boolean {
  const el = document.getElementById('write-list')
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 160
}

// ── 底部输入栏 ──────────────────────────────────────────────────────────────

function InputBar({
  bookId,
  active,
  detail,
  refresh
}: {
  bookId: string
  active: Job | null
  detail: { chapters: Array<{ id: string }> } | undefined
  refresh: () => void
}) {
  const setBookSub = useUiStore((s) => s.setBookSub)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(false)
  const kbInset = useKeyboardInset()
  const lastChapter = detail?.chapters[detail.chapters.length - 1] ?? null
  const choosingDirection =
    !!active && active.state === 'waiting_user' && active.step === 'outline'
  const busyRunning = !!active && (active.state === 'running' || active.state === 'queued')

  useEffect(() => {
    if (!busyRunning) setQueued(false)
  }, [busyRunning])

  const send = async () => {
    const t = text.trim()
    if (!t) return
    setText('')
    setBusy(true)
    try {
      if (choosingDirection && active) {
        await window.api.job.chooseDirection(active.id, { source: 'free', text: t })
      } else {
        await window.api.job.startChat(bookId, t)
      }
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="border-t border-orange-100 bg-[#fbf6ec] px-3 pt-2 pb-safe"
      style={kbInset ? { paddingBottom: kbInset } : undefined}
    >
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          className="flex-[1.6] rounded-xl bg-orange-600 py-2.5 text-sm font-semibold text-white active:bg-orange-700 disabled:opacity-50"
          onClick={async () => {
            setBusy(true)
            setQueued(busyRunning)
            try {
              await window.api.job.startWrite(bookId)
              refresh()
            } finally {
              setBusy(false)
            }
          }}
        >
          {queued ? '已排队 ✓' : detail?.chapters.length ? '写下一章' : '写第 1 章'}
        </button>
        <button
          type="button"
          disabled={busy || !lastChapter}
          className="flex-1 rounded-xl border border-orange-200 py-2.5 text-xs text-stone-600 disabled:opacity-40"
          onClick={async () => {
            if (!lastChapter) return
            setBusy(true)
            try {
              await window.api.job.startReview(lastChapter.id)
              refresh()
            } finally {
              setBusy(false)
            }
          }}
        >
          审读上一章
        </button>
        <button
          type="button"
          disabled={busy}
          className="flex-1 rounded-xl border border-orange-200 py-2.5 text-xs text-stone-600 disabled:opacity-40"
          onClick={async () => {
            setBusy(true)
            try {
              await window.api.job.startAudit(bookId)
              refresh()
            } finally {
              setBusy(false)
            }
          }}
        >
          全书审计
        </button>
        <button
          type="button"
          className="flex-1 rounded-xl border border-orange-200 py-2.5 text-xs text-stone-600"
          onClick={() => setBookSub('read')}
        >
          改这章
        </button>
      </div>
      <div className="mt-2 flex items-end gap-2 pb-2">
        <textarea
          rows={1}
          className="min-h-[42px] max-h-28 min-w-0 flex-1 resize-none rounded-2xl border border-orange-100 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-orange-700"
          placeholder={
            choosingDirection
              ? '或直接说你要的走向…'
              : busyRunning
                ? '跟导演说…（会排队）'
                : '跟导演聊剧情、要建议…'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button
          type="button"
          disabled={busy || !text.trim()}
          className="h-[42px] shrink-0 rounded-2xl bg-orange-600 px-4 text-sm font-medium text-white disabled:opacity-40"
          onClick={send}
        >
          发送
        </button>
      </div>
    </div>
  )
}
