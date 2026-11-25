import { QUICK_ACTIONS } from '@shared/types'
import { useState } from 'react'
import { useBackHandler } from '../lib/backHandler'
import { toastError } from '../lib/toastStore'

/**
 * 章末快捷改章条：固定通用钮 + agent 本章动态建议钮（recap.quickActions）+ 自由输入。
 * 点任意钮 → job.startRevise(chapterId, instruction)。
 * 固定五钮（更狠/更柔/加长/缩短/重写）的指令都是整章改动，会盖掉现有内容：先行内确认再执行。
 * 动态建议钮与自由输入默认是局部修改，不拦。
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
  /** 等作者确认的整章改稿 */
  const [pending, setPending] = useState<(typeof QUICK_ACTIONS)[number] | null>(null)

  // 确认条开着时，返回键先收回确认条（否则会直接关书）
  useBackHandler(() => setPending(null), pending !== null)

  const revise = async (instruction: string) => {
    if (!chapterId) return
    setBusy(true)
    try {
      await window.api.job.startRevise(chapterId, instruction)
      refresh()
    } catch (e) {
      toastError(e, '改稿失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-orange-100 bg-white/40 p-4">
      <div className="mb-3 text-xs font-semibold opacity-60">想改改这章？</div>
      {pending ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-xs leading-relaxed text-red-600">
            「{pending.label}」会覆盖这一章现在的内容，改完找不回原样。确定要改吗？
          </span>
          <button
            type="button"
            className="min-h-10 shrink-0 rounded-lg bg-red-100 px-3 text-xs font-medium text-red-600 active:bg-red-200"
            onClick={() => {
              const instruction = pending.instruction
              setPending(null)
              void revise(instruction)
            }}
          >
            确认
          </button>
          <button
            type="button"
            className="min-h-10 shrink-0 rounded-lg border border-orange-200 px-3 text-xs text-stone-500 active:bg-orange-50"
            onClick={() => setPending(null)}
          >
            取消
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={busy || !chapterId}
              className="rounded-full border border-orange-200 px-3 py-1.5 text-xs active:border-orange-700 disabled:opacity-40"
              onClick={() => setPending(a)}
            >
              {a.label}
            </button>
          ))}
          {(quickActions ?? []).map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={busy}
              className="rounded-full border border-orange-800/80 bg-orange-950/30 px-3 py-1.5 text-xs text-orange-700 active:border-orange-600 disabled:opacity-40"
              onClick={() => void revise(a.instruction)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs outline-none focus:border-orange-600"
          placeholder="或直接说要怎么改…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || !freeText.trim() || !chapterId}
          className="rounded-xl bg-orange-100 px-4 text-xs text-orange-700 disabled:opacity-40"
          onClick={() => revise(freeText.trim())}
        >
          改
        </button>
      </div>
    </div>
  )
}
