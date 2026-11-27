import type { ChatMessageRow } from '@shared/types'
import { useState } from 'react'
import { TOOL_LABEL } from './labels'

/**
 * 工具卡（agent 每次工具调用的工作日志，折叠小卡；详情是结果数据保持纯文本）。
 * 两类附加信息随卡片 meta 落库：
 * - words：写手的累计字数，是落卡那一刻的快照（实时字数在时间轴底部的进度条）；
 * - brief：派写手时导演给的任务简报前 120 字，卡面直接露出，全文在详情里。
 */
export default function ToolCard({ msg }: { msg: ChatMessageRow }) {
  const meta = msg.meta ?? {}
  const [open, setOpen] = useState(false)
  const ok = meta.ok !== false
  const tool = typeof meta.tool === 'string' ? meta.tool : '工具'
  const summary = typeof meta.summary === 'string' ? meta.summary : ''
  const words = typeof meta.words === 'number' ? meta.words : null
  const brief = typeof meta.brief === 'string' ? meta.brief : ''
  return (
    <div className="px-4 py-1">
      {/* 卡片视觉高约 34px：点击区上下各向外延伸 4px，正好填满外层 py-1 的留白（与相邻卡不重叠），命中高度 42px。
          定位以 padding box 为准，所以写 -5px（含 1px 边框） */}
      <button
        type="button"
        className={`relative w-full rounded-xl border px-3 py-2 text-left after:absolute after:inset-x-0 after:-inset-y-[5px] after:content-[''] ${ok ? 'border-orange-100 bg-white/70' : 'border-red-200 bg-red-50'}`}
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          <span className={`text-[10px] ${ok ? 'text-orange-500' : 'text-red-500'}`}>
            {ok ? '✓' : '✗'}
          </span>
          <span className="shrink-0 text-[11px] text-stone-400">{TOOL_LABEL[tool] ?? tool}</span>
          <span
            className={`min-w-0 flex-1 truncate text-xs ${ok ? 'text-stone-600' : 'text-red-600'}`}
          >
            {summary}
          </span>
          {words !== null && (
            <span className="shrink-0 text-[11px] text-stone-500 tabular-nums">{words} 字</span>
          )}
          <span className="shrink-0 text-[10px] text-stone-300">{open ? '▲' : '▼'}</span>
        </div>
        {/* 简报摘要与展开后的详情是同一份东西：展开时只留全文 */}
        {brief && !open && (
          <div className="mt-1.5 line-clamp-4 border-l-2 border-orange-200 pl-2 text-[11px] leading-relaxed text-stone-500">
            <span className="text-stone-400">给写手的任务：</span>
            {brief}
          </div>
        )}
        {open && (
          <div className="mt-2 max-h-48 overflow-y-auto no-scrollbar rounded-lg bg-orange-50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-stone-500">
            {msg.content || '（无详情）'}
          </div>
        )}
      </button>
    </div>
  )
}
