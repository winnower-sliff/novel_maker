import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ChapterOutline, Job, Scene } from '@shared/types'
import ReportCard from '../components/ReportCard'
import QuickActionsBar from '../components/QuickActionsBar'
import { qk, useBook, useJobFlow, useReports, useStatusCard } from '../lib/queries'
import { useUiStore } from '../lib/uiStore'

const KIND_LABEL: Record<string, string> = {
  steady: '顺势',
  twist: '破局',
  depth: '纵深',
  wild: '野路子'
}
const KIND_COLOR: Record<string, string> = {
  steady: 'bg-orange-950/70 text-orange-300',
  twist: 'bg-orange-900/70 text-orange-300',
  depth: 'bg-orange-800/70 text-orange-200',
  wild: 'bg-orange-700/70 text-orange-100'
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-zinc-500">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-orange-400" />
      <div className="text-sm">{label}</div>
    </div>
  )
}

export default function Write() {
  const openBookId = useUiStore((s) => s.openBookId) ?? ''
  const { data: flow } = useJobFlow(openBookId)
  const job = flow?.active ?? null
  const lastDone = flow?.lastDone ?? null
  const queryClient = useQueryClient()

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: qk.jobs(openBookId) })
    queryClient.invalidateQueries({ queryKey: qk.book(openBookId) })
    queryClient.invalidateQueries({ queryKey: qk.statusCard(openBookId) })
  }

  if (!job) return <IdleView bookId={openBookId} lastDone={lastDone} refresh={refresh} />

  if (job.state === 'failed') {
    return (
      <div className="px-4 py-10">
        <div className="rounded-xl border border-red-900/60 bg-red-950/40 p-4">
          <div className="mb-2 text-sm font-semibold text-red-300">生成失败</div>
          <div className="text-xs leading-relaxed break-all text-zinc-400">{job.error || '未知错误'}</div>
        </div>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            className="flex-1 rounded-xl bg-orange-600 py-3 text-sm font-medium"
            onClick={async () => {
              await window.api.job.retry(job.id)
              refresh()
            }}
          >
            重试
          </button>
          <button
            type="button"
            className="flex-1 rounded-xl border border-zinc-700 py-3 text-sm text-zinc-300"
            onClick={refresh}
          >
            放弃
          </button>
        </div>
      </div>
    )
  }

  const running = job.state === 'queued' || job.state === 'running'

  if (job.kind !== 'write') {
    return <SubJobView job={job} bookId={openBookId} refresh={refresh} />
  }

  if (running && job.step === 'proposal') return <Spinner label="导演正在构思走向…" />
  if (running && job.step === 'outline') return <Spinner label="正在展开章级大纲…" />
  if (running && job.step === 'scene') return <Spinner label="正在拆分场景分镜…" />
  if (running && job.step === 'selfcheck') return <Spinner label="自检中…" />
  if (running && job.step === 'finalize') return <Spinner label="落章收尾中…" />
  if (running && job.step === 'draft') return <DraftStreaming job={job} refresh={refresh} />

  if (job.state === 'waiting_user' && job.step === 'outline') {
    return <DirectionView job={job} refresh={refresh} />
  }
  if (job.state === 'waiting_user' && job.step === 'scene') {
    return <OutlineView job={job} refresh={refresh} />
  }
  if (job.state === 'waiting_user' && job.step === 'draft') {
    return <ScenesView job={job} refresh={refresh} />
  }
  if (job.state === 'waiting_user' && job.step === 'selfcheck') {
    return <SelfcheckView job={job} refresh={refresh} />
  }
  if (job.state === 'done') {
    return <RecapView bookId={openBookId} job={job} refresh={refresh} />
  }
  return <Spinner label="处理中…" />
}

// ── 非 write 任务：改章/审读/审计/诊断 ────────────────────────────────────────

function SubJobView({ job, bookId, refresh }: { job: Job; bookId: string; refresh: () => void }) {
  const running = job.state === 'queued' || job.state === 'running'
  if (running && job.kind === 'revise') return <ReviseStreaming job={job} refresh={refresh} />
  if (running && job.kind === 'review') return <Spinner label="审稿编辑正在读这一章…" />
  if (running && job.kind === 'audit') return <Spinner label="正在审计最近的章节…" />
  if (running && job.kind === 'diagnose') return <Spinner label="导演正在翻查卷宗…" />
  if (job.state === 'done' && job.kind === 'revise') {
    return <ReviseDoneView job={job} bookId={bookId} refresh={refresh} />
  }
  if (job.state === 'done' && job.payload.report) {
    return <ReportDoneView job={job} bookId={bookId} refresh={refresh} />
  }
  return <Spinner label="处理中…" />
}

function ReviseStreaming({ job, refresh }: { job: Job; refresh: () => void }) {
  const [text, setText] = useState('')
  const [cancelConfirm, setCancelConfirm] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const instruction = job.payload.revise?.instruction ?? ''

  useEffect(() => {
    setText('')
    const off = window.api.job.onDelta((jobId, chunk) => {
      if (jobId === job.id) setText((t) => t + chunk)
    })
    return off
  }, [job.id])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
  }, [text])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-orange-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-orange-400" />
          改章中
        </div>
        <button
          type="button"
          className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400"
          onClick={() => setCancelConfirm(true)}
        >
          取消
        </button>
      </div>
      {instruction && (
        <div className="px-4 pb-2 text-xs text-zinc-500">指令：{instruction}</div>
      )}
      <div ref={boxRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 no-scrollbar">
        <div className="whitespace-pre-wrap text-[15px] leading-8 text-zinc-200">
          {text || '导演提笔中…'}
          <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-orange-400 align-middle" />
        </div>
      </div>
      {cancelConfirm && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setCancelConfirm(false)}>
          <div
            className="w-full rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-5 pb-safe"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 text-sm text-zinc-300">取消将作废本次改章（原章不受影响），继续？</div>
            <div className="flex gap-3">
              <button
                type="button"
                className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400"
                onClick={() => setCancelConfirm(false)}
              >
                继续改
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-medium"
                onClick={async () => {
                  setCancelConfirm(false)
                  await window.api.job.cancel(job.id)
                  refresh()
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
}

function ReviseDoneView({ job, bookId, refresh }: { job: Job; bookId: string; refresh: () => void }) {
  const setBookSub = useUiStore((s) => s.setBookSub)
  const [busy, setBusy] = useState(false)
  const lint = job.payload.lint
  const issues = lint?.issues ?? []

  return (
    <div className="px-4 py-5">
      <div className="mb-4 rounded-2xl border border-orange-900/50 bg-orange-950/20 p-4">
        <div className="text-sm font-semibold text-orange-300">✓ 改章完成（已生成新版本）</div>
        <div className="mt-1 text-xs text-zinc-400">
          {job.payload.draftWordCount ? `${job.payload.draftWordCount} 字 · ` : ''}
          自检 {issues.length === 0 ? '零问题' : `${issues.length} 条提示（仅展示，不拦截）`}
        </div>
      </div>
      {issues.length > 0 && (
        <div className="mb-4 space-y-2">
          {issues.map((iss, i) => (
            <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                {iss.rule}
              </span>
              <div className="mt-1 text-xs leading-relaxed text-zinc-400">{iss.advice}</div>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="w-full rounded-2xl border border-zinc-700 py-3 text-sm text-zinc-200"
        onClick={() => setBookSub('read')}
      >
        去读读这章
      </button>
      <button
        type="button"
        disabled={busy}
        className="mt-3 w-full rounded-2xl bg-orange-600 py-3.5 text-sm font-semibold disabled:opacity-50"
        onClick={async () => {
          setBusy(true)
          try {
            await window.api.job.startWrite(bookId)
            refresh()
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? '提交…' : '继续写下一章'}
      </button>
    </div>
  )
}

function ReportDoneView({ job, bookId, refresh }: { job: Job; bookId: string; refresh: () => void }) {
  const report = job.payload.report
  const [busy, setBusy] = useState(false)
  if (!report) return <Spinner label="处理中…" />
  return (
    <div className="px-4 py-5">
      <ReportCard report={report} />
      <button
        type="button"
        disabled={busy}
        className="mt-5 w-full rounded-2xl bg-orange-600 py-3.5 text-sm font-semibold disabled:opacity-50"
        onClick={async () => {
          setBusy(true)
          try {
            await window.api.job.startWrite(bookId)
            refresh()
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? '提交…' : '继续写'}
      </button>
    </div>
  )
}

// ── 章末快捷钮（共享组件 QuickActionsBar，见 components/） ───────────────────

// ── 空闲：现状卡 + 开写 ─────────────────────────────────────────────────────

function IdleView({
  bookId,
  lastDone,
  refresh
}: {
  bookId: string
  lastDone: Job | null
  refresh: () => void
}) {
  const { data: card } = useStatusCard(bookId)
  const { data: detail } = useBook(bookId)
  const { data: reports } = useReports(bookId)
  const [busy, setBusy] = useState(false)
  const [question, setQuestion] = useState('')

  const lastChapter = detail?.chapters[detail.chapters.length - 1] ?? null
  const latestReport = reports?.[0]?.payload.report ?? null

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const start = () => run(() => window.api.job.startWrite(bookId))

  return (
    <div className="px-4 py-5">
      {card && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-semibold text-zinc-200">现在写到</span>
            <span className="text-xs text-zinc-500">
              {card.lineName} · 第 {card.chapterCount + 1} 章
            </span>
          </div>
          {card.lastChapter && (
            <div className="mb-3 rounded-lg bg-zinc-800/60 p-3">
              <div className="text-xs text-zinc-500">
                上一章 · {card.lastChapter.title}
              </div>
              <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-400">
                {card.lastChapter.summary || '（无摘要）'}
              </div>
            </div>
          )}
          {card.characters.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {card.characters.slice(0, 6).map((c) => (
                <span key={c.name} className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
                  {c.name}
                </span>
              ))}
            </div>
          )}
          {card.openForeshadows.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-zinc-500">未闭合伏笔 {card.openForeshadows.length} 条</div>
              {card.openForeshadows.slice(0, 3).map((f) => (
                <div key={f.title} className="truncate text-xs text-orange-300/80">
                  · {f.title}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {card && card.staleDays && card.staleDays > 7 && (
        <div className="mt-3 rounded-xl border border-orange-900/50 bg-orange-950/30 p-3 text-xs leading-relaxed text-orange-300/90">
          已 {card.staleDays} 天没写。点开「阅读」翻翻前情，或直接开写——导演会在走向里帮你接上。
        </div>
      )}

      {lastDone?.payload.recap && (
        <div className="mt-4">
          <RecapCard recap={lastDone.payload.recap} />
        </div>
      )}

      {(lastDone || lastChapter) && (
        <QuickActionsBar
          chapterId={lastDone?.chapterId ?? lastChapter?.id ?? null}
          quickActions={lastDone?.payload.recap?.quickActions}
          refresh={refresh}
        />
      )}

      {latestReport && (
        <div className="mt-4">
          <ReportCard report={latestReport} />
        </div>
      )}

      <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="mb-3 text-xs font-semibold text-zinc-500">体检台</div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || !lastChapter}
            className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-xs text-zinc-300 disabled:opacity-40"
            onClick={() => lastChapter && run(() => window.api.job.startReview(lastChapter.id))}
          >
            审读上一章
          </button>
          <button
            type="button"
            disabled={busy}
            className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-xs text-zinc-300 disabled:opacity-40"
            onClick={() => run(() => window.api.job.startAudit(bookId))}
          >
            全书审计
          </button>
        </div>
        <div className="mt-3 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none focus:border-orange-700"
            placeholder="问导演：剧情哪里不对劲？人物立得住吗？"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !question.trim()}
            className="rounded-xl bg-zinc-800 px-4 text-xs text-orange-300 disabled:opacity-40"
            onClick={() => {
              const q = question.trim()
              setQuestion('')
              run(() => window.api.job.startDiagnose(bookId, q))
            }}
          >
            问
          </button>
        </div>
      </div>

      <button
        type="button"
        disabled={busy}
        className="mt-5 w-full rounded-2xl bg-orange-600 py-4 text-base font-semibold active:bg-orange-700 disabled:opacity-50"
        onClick={start}
      >
        {busy ? '提交…' : detail?.chapters.length ? '写下一章' : '写第 1 章'}
      </button>
    </div>
  )
}

// ── 第一步：走向卡片 ────────────────────────────────────────────────────────

function DirectionView({ job, refresh }: { job: Job; refresh: () => void }) {
  const cards = job.payload.cards ?? []
  const [freeText, setFreeText] = useState('')
  const [regenConfirm, setRegenConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const choose = async (choice: { source: 'card' | 'free'; cardIndex?: number; text: string }) => {
    setBusy(true)
    try {
      await window.api.job.chooseDirection(job.id, choice)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const regen = async () => {
    setRegenConfirm(false)
    setBusy(true)
    try {
      await window.api.job.cancel(job.id)
      await window.api.job.startWrite(job.bookId)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-5">
      <div className="mb-4 text-sm text-zinc-500">下一章往哪走？选一个方向</div>
      <div className="space-y-3">
        {cards.map((c, i) => (
          <button
            key={i}
            type="button"
            disabled={busy}
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-left active:border-orange-700 disabled:opacity-50"
            onClick={() => choose({ source: 'card', cardIndex: i, text: c.title })}
          >
            <div className="mb-2 flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs ${KIND_COLOR[c.kind] ?? ''}`}>
                {KIND_LABEL[c.kind] ?? c.kind}
              </span>
              <span className="text-sm font-semibold">{c.title}</span>
            </div>
            <div className="text-xs leading-relaxed text-zinc-400">{c.preview}</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-600">
              <span>{c.structure}</span>
              {c.arc && <span className="text-zinc-500">◦ {c.arc}</span>}
            </div>
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={busy}
        className="mt-4 w-full rounded-xl border border-zinc-800 py-2.5 text-sm text-zinc-400 disabled:opacity-50"
        onClick={() => setRegenConfirm(true)}
      >
        换一批
      </button>

      <div className="mt-5">
        <div className="mb-2 text-xs text-zinc-500">或者，你说了算：</div>
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm outline-none focus:border-orange-700"
            placeholder="自由输入走向…"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !freeText.trim()}
            className="rounded-xl bg-zinc-800 px-4 text-sm text-orange-300 disabled:opacity-40"
            onClick={() => choose({ source: 'free', text: freeText.trim() })}
          >
            走起
          </button>
        </div>
      </div>

      {regenConfirm && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setRegenConfirm(false)}>
          <div
            className="w-full rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-5 pb-safe"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 text-sm text-zinc-300">换一批会重新提案（当前选择作废），继续？</div>
            <div className="flex gap-3">
              <button
                type="button"
                className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400"
                onClick={() => setRegenConfirm(false)}
              >
                再想想
              </button>
              <button
                type="button"
                disabled={busy}
                className="flex-1 rounded-xl bg-orange-600 py-2.5 text-sm font-medium"
                onClick={regen}
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

// ── 第二步：章级大纲确认 ────────────────────────────────────────────────────

function OutlineView({ job, refresh }: { job: Job; refresh: () => void }) {
  const outline: ChapterOutline = job.payload.outline ?? { title: '', synopsis: '', beats: [] }
  const [title, setTitle] = useState(outline.title)
  const [synopsis, setSynopsis] = useState(outline.synopsis)
  const [beats, setBeats] = useState<string[]>(outline.beats)
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    setBusy(true)
    try {
      const edits: ChapterOutline = {
        title,
        synopsis,
        beats: beats.filter((b) => b.trim())
      }
      await window.api.job.confirmOutline(job.id, edits)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-5">
      <div className="mb-4 text-sm text-zinc-500">章级大纲——可改，确认后拆分镜</div>
      <input
        className="mb-3 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm font-semibold outline-none focus:border-orange-700"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="mb-3 min-h-28 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-xs leading-relaxed outline-none focus:border-orange-700"
        value={synopsis}
        onChange={(e) => setSynopsis(e.target.value)}
      />
      <div className="space-y-2">
        {beats.map((b, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-center text-xs text-zinc-600">{i + 1}</span>
            <input
              className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-xs outline-none focus:border-orange-700"
              value={b}
              onChange={(e) => setBeats(beats.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              type="button"
              className="shrink-0 rounded-full p-1.5 text-zinc-600 hover:text-red-400"
              onClick={() => setBeats(beats.filter((_, j) => j !== i))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
        <button
          type="button"
          className="w-full rounded-lg border border-dashed border-zinc-800 py-2 text-xs text-zinc-500"
          onClick={() => setBeats([...beats, ''])}
        >
          + 加一拍
        </button>
      </div>
      <button
        type="button"
        disabled={busy || !title.trim()}
        className="mt-5 w-full rounded-2xl bg-orange-600 py-3.5 text-sm font-semibold disabled:opacity-50"
        onClick={confirm}
      >
        {busy ? '提交…' : '就这样，出分镜'}
      </button>
    </div>
  )
}

// ── 第三步：分镜确认（可跳过） ──────────────────────────────────────────────

function ScenesView({ job, refresh }: { job: Job; refresh: () => void }) {
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
    <div className="px-4 py-5">
      <div className="mb-4 text-sm text-zinc-500">场景分镜——每一幕的镜头感，可微调</div>
      <div className="space-y-3">
        {list.map((s, i) => (
          <div key={s.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                幕 {i + 1}
              </span>
              <span className="text-[11px] text-zinc-600">
                {s.viewpoint} · {s.pace}
              </span>
            </div>
            <textarea
              className="min-h-16 w-full resize-none rounded-lg bg-zinc-900 px-2.5 py-2 text-xs leading-relaxed outline-none"
              value={s.summary}
              onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, summary: e.target.value } : x)))}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        className="mt-5 w-full rounded-2xl bg-orange-600 py-3.5 text-sm font-semibold disabled:opacity-50"
        onClick={() => go(list)}
      >
        {busy ? '提交…' : '开写正文'}
      </button>
      <button
        type="button"
        disabled={busy}
        className="mt-2 w-full rounded-xl py-2.5 text-xs text-zinc-500 disabled:opacity-50"
        onClick={() => go(null)}
      >
        跳过分镜，直接开写
      </button>
    </div>
  )
}

// ── 正文流式 ────────────────────────────────────────────────────────────────

function DraftStreaming({ job, refresh }: { job: Job; refresh: () => void }) {
  const [text, setText] = useState('')
  const [cancelConfirm, setCancelConfirm] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setText('')
    const off = window.api.job.onDelta((jobId, chunk) => {
      if (jobId === job.id) setText((t) => t + chunk)
    })
    return off
  }, [job.id])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
  }, [text])

  const cancel = async () => {
    setCancelConfirm(false)
    await window.api.job.cancel(job.id)
    refresh()
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-orange-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-orange-400" />
          正文生成中
        </div>
        <button
          type="button"
          className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400"
          onClick={() => setCancelConfirm(true)}
        >
          取消
        </button>
      </div>
      <div ref={boxRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 no-scrollbar">
        <div className="whitespace-pre-wrap text-[15px] leading-8 text-zinc-200">
          {text || '导演提笔中…'}
          <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-orange-400 align-middle" />
        </div>
      </div>
      {cancelConfirm && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setCancelConfirm(false)}>
          <div
            className="w-full rounded-t-2xl border-t border-zinc-800 bg-zinc-900 p-5 pb-safe"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-sm font-medium text-red-300">取消将作废本章</div>
            <div className="mb-4 text-xs text-zinc-500">已生成内容不会保留，需要重头再来。</div>
            <div className="flex gap-3">
              <button
                type="button"
                className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400"
                onClick={() => setCancelConfirm(false)}
              >
                继续写
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-medium"
                onClick={cancel}
              >
                作废
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 自检结果 ────────────────────────────────────────────────────────────────

function SelfcheckView({ job, refresh }: { job: Job; refresh: () => void }) {
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
    <div className="px-4 py-5">
      <div className="mb-3 text-sm font-semibold text-orange-300">
        {autoFixed ? '自动修了一轮，还有这些问题' : '自检发现这些问题'}
      </div>
      <div className="space-y-2">
        {lint?.issues.map((iss, i) => (
          <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="mb-1 flex items-center gap-2">
              <span
                className={
                  'rounded-full px-2 py-0.5 text-[11px] ' +
                  (iss.level === 'major' ? 'bg-red-900/60 text-red-300' : 'bg-zinc-800 text-zinc-400')
                }
              >
                {iss.rule}
              </span>
            </div>
            {iss.quote && <div className="mb-1 truncate text-xs text-zinc-500">「{iss.quote}」</div>}
            <div className="text-xs leading-relaxed text-zinc-400">{iss.advice}</div>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        className="mt-5 w-full rounded-2xl bg-orange-600 py-3.5 text-sm font-semibold disabled:opacity-50"
        onClick={() => act(() => window.api.job.retry(job.id))}
      >
        再修一轮
      </button>
      <button
        type="button"
        disabled={busy}
        className="mt-2 w-full rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400 disabled:opacity-50"
        onClick={() => act(() => window.api.job.acceptFlaws(job.id))}
      >
        接受瑕疵，直接入书
      </button>
    </div>
  )
}

// ── 完成纪要卡 ──────────────────────────────────────────────────────────────

function RecapView({ bookId, job, refresh }: { bookId: string; job: Job; refresh: () => void }) {
  const [busy, setBusy] = useState(false)
  const { data: detail } = useBook(bookId)
  const chapter = detail?.chapters.find((c) => c.id === job.chapterId)

  const next = async () => {
    setBusy(true)
    try {
      await window.api.job.startWrite(bookId)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-5">
      <div className="mb-4 rounded-2xl border border-orange-900/50 bg-orange-950/20 p-4">
        <div className="text-sm font-semibold text-orange-300">✓ 本章已入书</div>
        {chapter && (
          <div className="mt-1 text-xs text-zinc-400">
            第 {chapter.orderNo} 章 · {chapter.title} · {chapter.wordCount} 字
          </div>
        )}
      </div>
      {job.payload.recap && <RecapCard recap={job.payload.recap} />}
      <button
        type="button"
        disabled={busy}
        className="mt-5 w-full rounded-2xl bg-orange-600 py-3.5 text-sm font-semibold disabled:opacity-50"
        onClick={next}
      >
        {busy ? '提交…' : '写下一章'}
      </button>
    </div>
  )
}

function RecapCard({ recap }: { recap: NonNullable<Job['payload']['recap']> }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-2 text-xs font-semibold text-zinc-500">本章纪要</div>
      <div className="text-xs leading-relaxed text-zinc-300">{recap.summary}</div>
      {recap.stateChanges.length > 0 && (
        <div className="mt-3 border-t border-zinc-800/70 pt-2">
          <div className="mb-1 text-[11px] text-zinc-500">人物动向</div>
          {recap.stateChanges.map((sc, i) => (
            <div key={i} className="text-xs text-zinc-400">
              <span className="text-zinc-300">{sc.name}</span>
              {typeof sc.patch.location === 'string' && <span> · {sc.patch.location}</span>}
              {typeof sc.patch.mood === 'string' && <span> · {sc.patch.mood}</span>}
            </div>
          ))}
        </div>
      )}
      {recap.foreshadowOps.length > 0 && (
        <div className="mt-3 border-t border-zinc-800/70 pt-2">
          <div className="mb-1 text-[11px] text-zinc-500">伏笔</div>
          {recap.foreshadowOps.map((f, i) => (
            <div key={i} className="text-xs text-orange-300/80">
              {f.op === 'plant' ? '埋下' : f.op === 'plan' ? '计划' : '回收'} · {f.title}
            </div>
          ))}
        </div>
      )}
      {recap.cardOps.length > 0 && (
        <div className="mt-3 border-t border-zinc-800/70 pt-2">
          <div className="mb-1 text-[11px] text-zinc-500">设定沉淀</div>
          {recap.cardOps.map((c, i) => (
            <div key={i} className="text-xs text-zinc-400">
              {c.op === 'create' ? '新增' : c.op === 'update' ? '更新' : '删除'} · {c.title}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
