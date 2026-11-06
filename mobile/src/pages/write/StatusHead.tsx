import { useState } from 'react'
import { useStatusCard } from '../../lib/queries'

/** 顶部现状摘要（一行胶囊，点开展开；随流滚走） */
export default function StatusHead({ bookId }: { bookId: string }) {
  const { data: card } = useStatusCard(bookId)
  const [open, setOpen] = useState(false)
  if (!card) return null
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
