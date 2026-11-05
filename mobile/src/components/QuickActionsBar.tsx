import { useState } from 'react'
import { QUICK_ACTIONS } from '@shared/types'

/**
 * 章末快捷改章条：固定通用钮 + agent 本章动态建议钮（recap.quickActions）+ 自由输入。
 * 点任意钮 → job.startRevise(chapterId, instruction)。
 */
export default function QuickActionsBar({
  chapterId,
  quickActions,
  refresh
}: {
  chapterId: string | null
  quickActions?: Array<{ label: string; instruction: string }>
  refresh: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [freeText, setFreeText] = useState('')

  const revise = async (instruction: string) => {
    if (!chapterId) return
    setBusy(true)
    try {
      await window.api.job.startRevise(chapterId, instruction)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-3 text-xs font-semibold opacity-60">想改改这章？</div>
      <div className="flex flex-wrap gap-2">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.label}
            type="button"
            disabled={busy || !chapterId}
            className="rounded-full border border-black/10 px-3 py-1.5 text-xs active:border-orange-700 disabled:opacity-40 dark:border-zinc-700"
            onClick={() => revise(a.instruction)}
          >
            {a.label}
          </button>
        ))}
        {(quickActions ?? []).map((a) => (
          <button
            key={a.label}
            type="button"
            disabled={busy}
            className="rounded-full border border-orange-800/80 bg-orange-950/30 px-3 py-1.5 text-xs text-orange-300 active:border-orange-600 disabled:opacity-40"
            onClick={() => revise(a.instruction)}
          >
            {a.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-xl border border-black/10 bg-black/5 px-3 py-2 text-xs outline-none focus:border-orange-700 dark:border-zinc-800 dark:bg-zinc-900"
          placeholder="或直接说要怎么改…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || !freeText.trim() || !chapterId}
          className="rounded-xl bg-black/10 px-4 text-xs text-orange-300 disabled:opacity-40 dark:bg-zinc-800"
          onClick={() => revise(freeText.trim())}
        >
          改
        </button>
      </div>
    </div>
  )
}
