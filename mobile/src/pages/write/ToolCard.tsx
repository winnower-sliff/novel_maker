import { useState } from 'react'
import type { ChatMessageRow } from '@shared/types'
import { TOOL_LABEL } from './labels'

/** 工具卡（agent 每次工具调用的工作日志，折叠小卡；详情是结果数据保持纯文本） */
export default function ToolCard({ msg }: { msg: ChatMessageRow }) {
  const meta = msg.meta ?? {}
  const [open, setOpen] = useState(false)
  const ok = meta.ok !== false
  const tool = typeof meta.tool === 'string' ? meta.tool : '工具'
  const summary = typeof meta.summary === 'string' ? meta.summary : ''
  return (
    <div className="px-4 py-1">
      <button
        type="button"
        className={`w-full rounded-xl border px-3 py-2 text-left ${ok ? 'border-orange-100 bg-white/70' : 'border-red-200 bg-red-50'}`}
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          <span className={`text-[10px] ${ok ? 'text-orange-500' : 'text-red-500'}`}>{ok ? '✓' : '✗'}</span>
          <span className="shrink-0 text-[11px] text-stone-400">{TOOL_LABEL[tool] ?? tool}</span>
          <span className={`min-w-0 flex-1 truncate text-xs ${ok ? 'text-stone-600' : 'text-red-600'}`}>
            {summary}
          </span>
          <span className="shrink-0 text-[10px] text-stone-300">{open ? '▲' : '▼'}</span>
        </div>
        {open && (
          <div className="mt-2 max-h-48 overflow-y-auto no-scrollbar rounded-lg bg-orange-50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-stone-500">
            {msg.content || '（无详情）'}
          </div>
        )}
      </button>
    </div>
  )
}
