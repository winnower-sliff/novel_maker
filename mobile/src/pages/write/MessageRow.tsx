import { memo, useState } from 'react'
import type { ChatMessageRow, Job } from '@shared/types'
import { Markdown } from '../../components/Markdown'
import JobCard from './JobCard'
import ToolCard from './ToolCard'

function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 单条消息分派：user 气泡 / 工具卡 / job 节点卡 / 导演白话气泡（memo 化） */
export const MessageRow = memo(function MessageRow({
  msg,
  jobsById,
  chaptersById,
  active,
  refresh,
  refreshAll
}: {
  msg: ChatMessageRow
  jobsById: Map<string, Job>
  chaptersById: Map<string, { id: string; orderNo: number; title: string; wordCount: number }>
  active: Job | null
  refresh: () => void
  refreshAll: () => void
}) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end px-4 py-1.5">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-orange-600 px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap text-white">
          {msg.content}
        </div>
      </div>
    )
  }

  const meta = msg.meta ?? {}
  if (meta.kind === 'tool') {
    return <ToolCard msg={msg} />
  }
  if (meta.kind === 'thinking') {
    return <ThinkingBubble text={msg.content} />
  }
  if (meta.kind === 'job' && typeof meta.jobId === 'string') {
    const job = jobsById.get(meta.jobId)
    if (job) {
      return (
        <JobCard
          job={job}
          step={typeof meta.step === 'string' ? meta.step : ''}
          active={active}
          chaptersById={chaptersById}
          refresh={refresh}
          refreshAll={refreshAll}
        />
      )
    }
  }
  // chat 对话 / 找不到 job 的孤儿节点 → 白话气泡
  return (
    <div className="flex justify-start px-4 py-1.5">
      <div className="max-w-[88%]">
        <div className="rounded-2xl rounded-tl-sm border border-orange-100 bg-white px-3.5 py-2 text-sm leading-relaxed text-stone-700">
          <Markdown text={msg.content} />
        </div>
        <div className="mt-0.5 pl-1 text-[10px] text-stone-400">{hhmm(msg.createdAt)}</div>
      </div>
    </div>
  )
})

/** 思考块（opencode 式独立卡：默认折叠，点开看全文；live=流式中，默认展开带光标） */
export function ThinkingBubble({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(live)
  return (
    <div className="px-4 py-1">
      <button
        type="button"
        className="w-full rounded-xl border border-stone-200/80 bg-stone-50/60 px-3 py-1.5 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className={`text-[11px] ${live ? 'animate-pulse text-orange-400' : 'text-stone-400'}`}>
          ✦ {live ? '思考中…' : '思考'} {open ? '▲' : '▼'}
        </span>
        {open && (
          <div className="mt-1.5 max-h-56 overflow-y-auto no-scrollbar whitespace-pre-wrap text-xs leading-relaxed text-stone-400">
            {text}
            {live && <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-orange-400 align-middle" />}
          </div>
        )}
      </button>
    </div>
  )
}
