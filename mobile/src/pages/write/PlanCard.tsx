import { useState } from 'react'
import type { Job } from '@shared/types'
import { Markdown } from '../../components/Markdown'

/** 计划模式卡：计划书 Markdown + 按计划执行（可带补充）/算了；等待期聊天框照常可用（导演看得到计划） */
export default function PlanCard({ job, refresh }: { job: Job; refresh: () => void }) {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [withFeedback, setWithFeedback] = useState(false)
  const plan = job.payload.plan ?? ''

  const run = async () => {
    setBusy(true)
    try {
      await window.api.job.approvePlan(job.id, feedback.trim() || undefined)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-2">
      <div className="rounded-2xl border border-orange-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-orange-700">✦ 本章计划</div>
          <div className="text-[11px] text-stone-400">过目后再动笔</div>
        </div>
        <div className="max-h-[55vh] overflow-y-auto no-scrollbar text-sm leading-relaxed text-stone-700">
          <Markdown text={plan} />
        </div>
        {withFeedback ? (
          <div className="mt-3">
            <textarea
              className="w-full resize-none rounded-xl border border-orange-200 bg-orange-50/60 p-2.5 text-xs leading-relaxed text-stone-700 outline-none focus:border-orange-400"
              rows={3}
              placeholder="补充调整（可留空）…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busy}
                className="flex-1 rounded-xl bg-orange-600 py-2.5 text-sm font-medium disabled:opacity-50"
                onClick={() => void run()}
              >
                按计划执行
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-xl border border-orange-200 px-3.5 py-2.5 text-xs text-stone-500 disabled:opacity-50"
                onClick={() => setWithFeedback(false)}
              >
                收起
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              className="flex-1 rounded-xl bg-orange-600 py-2.5 text-sm font-medium disabled:opacity-50"
              onClick={() => void run()}
            >
              按计划执行
            </button>
            <button
              type="button"
              disabled={busy}
              className="flex-1 rounded-xl border border-orange-200 py-2.5 text-xs text-stone-500 disabled:opacity-50"
              onClick={() => setWithFeedback(true)}
            >
              带点补充…
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-xl border border-orange-200 px-3.5 py-2.5 text-xs text-stone-500 disabled:opacity-50"
              onClick={async () => {
                setBusy(true)
                try {
                  await window.api.job.cancel(job.id)
                  refresh()
                } finally {
                  setBusy(false)
                }
              }}
            >
              算了
            </button>
          </div>
        )}
        <div className="mt-2 text-[10px] text-stone-400">拿不准可以在下面聊天框先跟导演聊聊这份计划</div>
      </div>
    </div>
  )
}
