import { useEffect, useState } from 'react'
import type { Job } from '@shared/types'
import { tickerStore } from '../../lib/tickerStore'
import { RUN_LABEL, TOOL_LABEL } from './labels'

/**
 * agent 聚合条（时间轴尾部）：干完收一行，过程只报进度。
 * chat 白话不再流式预览（曾长期显示「提笔中…」看不到字）——
 * 回复靠 message:append 实时上墙，这里只报状态行。
 */
export default function AgentTicker({ job, refresh }: { job: Job; refresh: () => void }) {
  // 聚合条状态在全局 store（App 接线 SSE 写入）：切子页卸载再回来不丢进度
  const useTicker = tickerStore(job.id)
  const acts = useTicker((s) => s.acts)
  const progress = useTicker((s) => s.progress)
  const [open, setOpen] = useState(false)
  const [cancelConfirm, setCancelConfirm] = useState(false)

  useEffect(() => {
    if (stickToBottom()) {
      const el = document.getElementById('write-stream-box')
      if (el) el.scrollIntoView({ block: 'end' })
    }
  }, [acts.length, progress?.chars])

  if (job.state === 'queued') {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-stone-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400" />
        排队中，前一个任务完成后自动开始
      </div>
    )
  }

  const last = acts[acts.length - 1]
  const isChat = job.kind === 'chat'
  const statusLine = isChat
    ? '导演正在回话'
    : last
      ? `${TOOL_LABEL[last.tool] ?? last.tool}·${last.summary}`
      : (RUN_LABEL[job.step] ?? '处理中…')
  const progressLine =
    progress && (progress.phase === 'draft' ? `正在写正文·已 ${progress.chars} 字` : `改章中·已 ${progress.chars} 字`)

  return (
    <div id="write-stream-box" className="px-4 py-2">
      <div className="rounded-2xl border border-orange-100 bg-white p-3.5">
        <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(!open)}>
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-orange-400" />
          <span className="min-w-0 flex-1 truncate text-xs text-stone-600">
            {progressLine ?? statusLine}
          </span>
          {!isChat && acts.length > 0 && (
            <span className="shrink-0 text-[10px] text-stone-400">
              {acts.length} 步 {open ? '▲' : '▼'}
            </span>
          )}
        </button>

        {open && !isChat && acts.length > 0 && (
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto no-scrollbar border-t border-orange-100/70 pt-2">
            {acts.map((a, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[11px]">
                <span className={a.ok ? 'text-orange-400' : 'text-red-500'}>{a.ok ? '✓' : '✗'}</span>
                <span className="shrink-0 text-stone-400">{TOOL_LABEL[a.tool] ?? a.tool}</span>
                <span className={`min-w-0 flex-1 truncate ${a.ok ? 'text-stone-500' : 'text-red-600'}`}>{a.summary}</span>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="rounded-lg border border-orange-100 px-2.5 py-1 text-[11px] text-stone-500"
            onClick={() => (isChat ? cancel() : setCancelConfirm(true))}
          >
            取消
          </button>
        </div>
      </div>
      {cancelConfirm && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={() => setCancelConfirm(false)}>
          <div
            className="w-full rounded-t-2xl border-t border-orange-100 bg-white p-5 pb-safe"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-sm font-medium text-red-600">
              {job.kind === 'write' ? '取消将中断本次写作' : '取消将作废本次改章（原章不受影响）'}
            </div>
            {job.kind === 'write' && (
              <div className="mb-4 text-xs text-stone-500">
                未定稿的内容不会入书；已入书的章节不受影响。
              </div>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                className="flex-1 rounded-xl border border-orange-200 py-2.5 text-sm text-stone-500"
                onClick={() => setCancelConfirm(false)}
              >
                继续写
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-medium"
                onClick={() => {
                  setCancelConfirm(false)
                  cancel()
                }}
              >
                作废
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  async function cancel() {
    await window.api.job.cancel(job.id)
    refresh()
  }
}

function stickToBottom(): boolean {
  const el = document.getElementById('write-list')
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 160
}
