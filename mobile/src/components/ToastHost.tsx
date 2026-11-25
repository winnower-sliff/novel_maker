import { useToastStore } from '../lib/toastStore'

/** 全局轻提示：操作结果的一行反馈，点一下消失 */
export function ToastHost() {
  const items = useToastStore((s) => s.items)
  if (items.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex flex-col items-center gap-1.5 px-6">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => useToastStore.getState().dismiss(t.id)}
          className="pointer-events-auto max-w-full rounded-xl bg-stone-800 px-3.5 py-2 text-left text-xs leading-relaxed text-white shadow-lg"
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}
