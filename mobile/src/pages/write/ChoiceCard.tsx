import { useState } from 'react'
import type { Job } from '@shared/types'
import { KIND_COLOR, KIND_LABEL } from './labels'

/**
 * 通用选择卡（走向提案）：可交互=对应 job 正在 waiting_user。
 * 选择全部显式化——点卡=精确选第 i 张；自定义走向走卡内入口，
 * 底部输入栏恒定只跟导演说话，杜绝「说话被误识别成选走向」。
 */
export default function ChoiceCard({ job, refresh }: { job: Job; refresh: () => void }) {
  const cards = job.payload.cards ?? []
  const [busy, setBusy] = useState(false)
  const [regen, setRegen] = useState(false)
  const [custom, setCustom] = useState(false)
  const [text, setText] = useState('')

  const choose = async (choice: { source: 'card' | 'free'; cardIndex?: number; text: string }) => {
    setBusy(true)
    try {
      await window.api.job.chooseDirection(job.id, choice)
      refresh()
    } finally {
      setBusy(false)
    }
  }
  const sendCustom = async () => {
    const t = text.trim()
    if (!t || busy) return
    await choose({ source: 'free', text: t })
  }

  return (
    <div className="px-4 py-2">
      <div className="mb-2 text-xs text-stone-500">本章往哪走？点一张卡直接开写</div>
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

      {custom ? (
        <div className="mt-2.5 flex items-end gap-2">
          <textarea
            rows={2}
            autoFocus
            disabled={busy}
            className="min-h-[46px] min-w-0 flex-1 resize-none rounded-2xl border border-orange-100 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-orange-700"
            placeholder="直接描述你要的走向（例如：这章写雨夜追凶，结尾留悬念）"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !text.trim()}
            className="h-[42px] shrink-0 rounded-2xl bg-orange-600 px-4 text-sm font-medium text-white disabled:opacity-40"
            onClick={sendCustom}
          >
            就这么写
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          className="mt-2.5 w-full rounded-xl border border-dashed border-orange-200 py-2 text-xs text-stone-500 disabled:opacity-50"
          onClick={() => setCustom(true)}
        >
          都不满意？自定义走向…
        </button>
      )}

      <button
        type="button"
        disabled={busy}
        className="mt-2 w-full rounded-xl border border-orange-100 py-2 text-xs text-stone-500 disabled:opacity-50"
        onClick={() => setRegen(true)}
      >
        换一批
      </button>
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
