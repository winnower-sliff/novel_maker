import { useEffect, type ReactNode } from 'react'

interface OverlayCardProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  widthClass?: string
}

export function OverlayCard({
  open,
  onClose,
  title,
  children,
  footer,
  widthClass = 'max-w-3xl'
}: OverlayCardProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        className={`relative flex max-h-[85vh] w-full ${widthClass} flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl`}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
          <div className="text-sm font-semibold text-zinc-100">{title}</div>
          <button
            onClick={onClose}
            className="cursor-pointer px-1 text-zinc-500 transition-colors hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
