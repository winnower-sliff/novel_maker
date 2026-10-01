import { type ReactNode, useEffect } from 'react'

interface OverlayCardProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  widthClass?: string
  /** 手机窄屏铺满全屏（无圆角遮罩感），桌面维持居中弹窗 */
  fullscreenOnMobile?: boolean
}

export function OverlayCard({
  open,
  onClose,
  title,
  children,
  footer,
  widthClass = 'max-w-3xl',
  fullscreenOnMobile = false
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
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${
        fullscreenOnMobile ? 'p-0 sm:p-6' : 'p-2 sm:p-6'
      }`}
    >
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" onClick={onClose} />
      <div
        className={`relative flex w-full ${widthClass} flex-col border border-zinc-700 bg-zinc-900 shadow-2xl ${
          fullscreenOnMobile
            ? 'h-full max-h-full rounded-none sm:h-auto sm:max-h-[85vh] sm:rounded-xl'
            : 'max-h-[85vh] rounded-xl'
        }`}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="text-sm font-semibold text-zinc-100">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer px-1 text-zinc-500 transition-colors hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5 sm:px-5 sm:py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3 sm:px-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
