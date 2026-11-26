import { QUICK_ACTIONS } from '@shared/types'
import { useState } from 'react'
import { useBackHandler } from '../lib/backHandler'
import { toastError } from '../lib/toastStore'

/**
 * 章末快捷改章条：固定通用钮 + agent 本章动态建议钮（recap.quickActions）+ 自由输入。
 * 点任意钮 → job.startRevise(chapterId, instruction)。
 * 固定五钮（更狠/更柔/加长/缩短/重写）的指令都是整章改动，会盖掉现有内容：先行内确认再执行。
 * 动态建议钮与自由输入默认是局部修改，不拦。
 * dark：落在深色页面上时用（阅读页夜间主题），换成深色底的写法。
 */
export default function QuickActionsBar({
  chapterId,
  quickActions,
  refresh,
  dark = false
}: {
  chapterId: string | null
  quickActions?: Array<{ label: string; instruction: string }>
  refresh: () => void
  dark?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [freeText, setFreeText] = useState('')
  /** 等作者确认的整章改稿 */
  const [pending, setPending] = useState<(typeof QUICK_ACTIONS)[number] | null>(null)
  /** 浅色 / 夜间两套类名里挑一套 */
  const tone = (light: string, night: string) => (dark ? night : light)

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
    <div
      className={`mt-4 rounded-2xl border p-4 ${tone('border-orange-100 bg-white/40', 'border-stone-800 bg-white/5')}`}
    >
      <div className="mb-3 text-xs font-semibold opacity-60">想改改这章？</div>
      {/* 胶囊视觉高 28px，点击区域撑到 40px（负 margin 抵消占位）；换行间距留足，上下两行的点击区域不重叠 */}
      {pending ? (
        <div className="flex items-center gap-2">
          <span
            className={`min-w-0 flex-1 text-xs leading-relaxed ${tone('text-red-600', 'text-red-400')}`}
          >
            「{pending.label}」会覆盖这一章现在的内容，改完找不回原样。确定要改吗？
          </span>
          <button
            type="button"
            className={`min-h-10 shrink-0 rounded-lg px-3 text-xs font-medium ${tone('bg-red-100 text-red-600 active:bg-red-200', 'bg-red-950/60 text-red-300 active:bg-red-900')}`}
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
            className={`min-h-10 shrink-0 rounded-lg border px-3 text-xs ${tone('border-orange-200 text-stone-500 active:bg-orange-50', 'border-stone-600 text-stone-400 active:bg-white/5')}`}
            onClick={() => setPending(null)}
          >
            取消
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-x-2 gap-y-3">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={busy || !chapterId}
              className={`min-h-10 -my-1.5 rounded-full border px-3 py-1.5 text-xs disabled:opacity-40 ${tone('border-orange-200 active:border-orange-700', 'border-stone-600 active:border-orange-400')}`}
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
              className={`min-h-10 -my-1.5 rounded-full border px-3 py-1.5 text-xs disabled:opacity-40 ${tone('border-orange-300 bg-orange-100 text-orange-800 active:border-orange-600', 'border-orange-900/80 bg-orange-950/40 text-orange-300 active:border-orange-500')}`}
              onClick={() => void revise(a.instruction)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <input
          className={`min-h-10 min-w-0 flex-1 rounded-xl border px-3 py-3 text-xs outline-none ${tone('border-orange-200 bg-orange-50 focus:border-orange-600', 'border-stone-700 bg-white/5 placeholder:text-stone-500 focus:border-orange-500')}`}
          placeholder="或直接说要怎么改…"
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || !freeText.trim() || !chapterId}
          className={`min-h-10 min-w-10 rounded-xl px-4 text-xs disabled:opacity-40 ${tone('bg-orange-100 text-orange-700', 'bg-orange-950/60 text-orange-300')}`}
          onClick={() => revise(freeText.trim())}
        >
          改
        </button>
      </div>
    </div>
  )
}
