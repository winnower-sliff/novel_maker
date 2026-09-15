import { useEffect, type ReactNode } from 'react'
import { splitTags } from '@shared/tags'
import { Markdown, type WikiLinkHandlers } from './Markdown'

interface PreviewPanelProps {
  title: ReactNode
  badge?: { label: string; color: string }
  tags?: string
  text: string
  wiki?: WikiLinkHandlers
  onClose: () => void
  footer?: ReactNode
}

export function PreviewPanel({ title, badge, tags, text, wiki, onClose, footer }: PreviewPanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tagList = splitTags(tags ?? '')

  return (
    <div className="flex max-h-[50vh] w-full shrink-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60 md:max-h-none md:w-96">
      <div className="flex items-start justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {badge && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
              style={{ background: `${badge.color}22`, color: badge.color }}
            >
              {badge.label}
            </span>
          )}
          <div className="min-w-0 truncate text-sm font-semibold text-zinc-100">{title}</div>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 cursor-pointer px-1 text-zinc-500 transition-colors hover:text-zinc-200"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tagList.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {tagList.map((t) => (
              <span
                key={t}
                className="rounded-full border border-amber-800/60 px-1.5 py-0.5 text-[10px] text-amber-300/90"
              >
                # {t}
              </span>
            ))}
          </div>
        )}
        <div className="text-sm leading-6 text-zinc-300">
          <Markdown text={text} wiki={wiki} />
        </div>
      </div>
      {footer && (
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-2.5">{footer}</div>
      )}
    </div>
  )
}
