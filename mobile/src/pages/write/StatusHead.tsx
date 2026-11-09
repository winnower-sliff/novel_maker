import { useState } from 'react'
import type { Job } from '@shared/types'
import { useQueryClient } from '@tanstack/react-query'
import { useBook, useStatusCard } from '../../lib/queries'
import { qk } from '../../lib/queries'

/** 顶部现状摘要（一行胶囊，点开展开；随流滚走）。任务运行中变体：状态+取消入口。 */
export default function StatusHead({ bookId, active }: { bookId: string; active?: Job | null }) {
  const { data: card } = useStatusCard(bookId)
  const { data: detail } = useBook(bookId)
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const [cancelConfirm, setCancelConfirm] = useState(false)

  const planMode = detail?.book.planMode ?? false
  const togglePlan = async () => {
    setPlanBusy(true)
    try {
      await window.api.book.update(bookId, { planMode: !planMode })
      await qc.invalidateQueries({ queryKey: ['book'] })
    } finally {
      setPlanBusy(false)
    }
  }

  if (active && (active.state === 'running' || active.state === 'queued')) {
    const cancel = async () => {
      setCancelConfirm(false)
      await window.api.job.cancel(active.id)
      await qc.invalidateQueries({ queryKey: qk.jobs(bookId) })
    }
    return (
      <div className="px-4 pt-3">
        <div className="flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3.5 py-1.5">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-orange-500" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-orange-700">
            {active.state === 'queued' ? '排队中，前一个任务完成后自动开始' : runText(active)}
          </span>
          <button
            type="button"
            className="shrink-0 text-[11px] text-stone-400 underline underline-offset-2"
            onClick={() =>
              active.kind === 'chat' ? void cancel() : setCancelConfirm(true)
            }
          >
            取消
          </button>
        </div>
        {cancelConfirm && (
          <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setCancelConfirm(false)}>
            <div
              className="w-full rounded-t-2xl border-t border-orange-100 bg-white p-5 pb-safe"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-1 text-sm font-medium text-red-600">
                {active.kind === 'write' ? '取消将中断本次写作' : '取消将作废本次改章（原章不受影响）'}
              </div>
              {active.kind === 'write' && (
                <div className="mb-4 text-xs text-stone-500">未定稿的内容不会入书；已入书的章节不受影响。</div>
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
                  onClick={() => void cancel()}
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

  if (!card) return null
  return (
    <div className="px-4 pt-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-full border border-orange-100 bg-white/70 px-3.5 py-1.5 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-stone-500">
          {card.lineName} · 第 {card.chapterCount + 1} 章
          {card.characters.length > 0 && ` · ${card.characters.slice(0, 3).map((c) => c.name).join('/')}`}
          {card.openForeshadows.length > 0 && ` · 未闭合伏笔 ${card.openForeshadows.length}`}
        </span>
        <span className="shrink-0 text-[10px] text-stone-300">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-2 rounded-2xl border border-orange-100 bg-white/60 p-3.5">
          <button
            type="button"
            disabled={planBusy}
            onClick={() => void togglePlan()}
            className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[11px] disabled:opacity-50 ${
              planMode ? 'bg-orange-600 text-white' : 'border border-orange-200 text-stone-500'
            }`}
          >
            <span>先计划（写章前先出计划书，过目后再动笔）</span>
            <span>{planMode ? '已开' : '关'}</span>
          </button>
          {card.characters.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
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
      )}
      {card.staleDays != null && card.staleDays > 7 && (
        <div className="mt-2 rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs leading-relaxed text-orange-700">
          已 {card.staleDays} 天没写。翻翻「阅读」接上前情，或直接开写——导演会在走向里帮你接上。
        </div>
      )}
    </div>
  )
}

function runText(job: Job): string {
  if (job.kind === 'chat') return '导演正在回话'
  if (job.kind === 'revise') return '正在改章'
  if (job.kind === 'review') return '正在审读上一章'
  if (job.kind === 'audit') return '正在全书审计'
  if (job.kind === 'diagnose') return '正在诊断'
  return '导演正在写'
}
