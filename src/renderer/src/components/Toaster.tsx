import { dismissToast, useToasts } from '../lib/toastStore'

export function Toaster() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-72 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-xl ${
            t.tone === 'success'
              ? 'border-emerald-800 bg-emerald-950/95 text-emerald-200'
              : 'border-red-800 bg-red-950/95 text-red-200'
          }`}
        >
          <span className="flex-1 leading-5">{t.text}</span>
          <button
            onClick={() => dismissToast(t.id)}
            className="cursor-pointer shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
