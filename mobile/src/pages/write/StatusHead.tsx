import { useState } from 'react'
import { useStatusCard } from '../../lib/queries'
import { useBook } from '../../lib/queries'
import { useQueryClient } from '@tanstack/react-query'

/** 顶部现状摘要（一行胶囊，点开展开；随流滚走） */
export default function StatusHead({ bookId }: { bookId: string }) {
  const { data: card } = useStatusCard(bookId)
  const { data: detail } = useBook(bookId)
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  if (!card) return null
  const planMode = detail?.book.planMode ?? false
  const togglePlan = async () => {
    setPlanBusy(true)
    try {
      await window.api.book.update(bookId, { planMode: !planMode })
      await qc.invalidateQueries({ queryKey: ['book'] })
    } finally {
      setPlanBusy(false)
    }
  }
  return (
    <div className="px-4 pt-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-full border border-orange-100 bg-white/70 px-3.5 py-1.5 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-stone-500">
          {card.lineName} · 第 {card.chapterCount + 1} 章
          {card.characters.length > 0 && ` · ${card.characters.slice(0, 3).map((c) => c.name).join('/')}`}
          {card.openForeshadows.length > 0 && ` · 未闭合伏笔 ${card.openForeshadows.length}`}
        </span>
        <span className="shrink-0 text-[10px] text-stone-300">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-2 rounded-2xl border border-orange-100 bg-white/60 p-3.5">
          <button
            type="button"
            disabled={planBusy}
            onClick={() => void togglePlan()}
            className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-[11px] disabled:opacity-50 ${
              planMode ? 'bg-orange-600 text-white' : 'border border-orange-200 text-stone-500'
            }`}
          >
            <span>先计划（写章前先出计划书，过目后再动笔）</span>
            <span>{planMode ? '已开' : '关'}</span>
          </button>
          {card.characters.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {card.characters.slice(0, 6).map((c) => (
                <span key={c.name} className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] text-stone-600">
                  {c.name}
                </span>
              ))}
            </div>
          )}
          {card.openForeshadows.length > 0 && (
            <div className="mt-2 text-[11px] text-stone-500">
              未闭合伏笔 {card.openForeshadows.length} 条
              {card.openForeshadows.slice(0, 2).map((f) => (
                <span key={f.title} className="text-orange-700/80">
                  {' '}
                  · {f.title}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {card.staleDays != null && card.staleDays > 7 && (
        <div className="mt-2 rounded-xl border border-orange-200 bg-orange-50 p-3 text-xs leading-relaxed text-orange-700">
          已 {card.staleDays} 天没写。翻翻「阅读」接上前情，或直接开写——导演会在走向里帮你接上。
        </div>
      )}
    </div>
  )
}
