import { useEffect, useState } from 'react'
import type { Job } from '@shared/types'
import { tickerStore } from '../../lib/tickerStore'
import { RUN_LABEL, TOOL_LABEL } from './labels'

/**
 * 时间轴尾部「进行中」状态行（opencode 式）：无卡片容器——思考/正文流式在
 * StreamRow 卡内刷新，工具卡/消息各自独立上墙；这里只一行小字报状态+取消。
 */
export default function LiveRow({ job, refresh }: { job: Job; refresh: () => void }) {
  const useTicker = tickerStore(job.id)
  const acts = useTicker((s) => s.acts)
  const progress = useTicker((s) => s.progress)
  const thinking = useTicker((s) => s.thinking)
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
    ? thinking
      ? '导演思考中…'
      : '导演正在回话'
    : last
      ? `${TOOL_LABEL[last.tool] ?? last.tool}·${last.summary}`
      : (RUN_LABEL[job.step] ?? '处理中…')
  const progressLine =
    progress &&
    (progress.phase === 'draft' ? `正在写正文·已 ${progress.chars} 字` : `改章中·已 ${progress.chars} 字`)

  return (
    <div id="write-stream-box">
      <div className="flex items-center gap-1.5 px-4 py-1 text-[11px] text-stone-400">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-orange-400" />
        <span className="min-w-0 flex-1 truncate">
          {progressLine ?? statusLine}
          {acts.length > 0 && ` · ${acts.length} 步`}
        </span>
        <button
          type="button"
          className="shrink-0 underline underline-offset-2"
          onClick={() => (isChat ? cancel() : setCancelConfirm(true))}
        >
          取消
        </button>
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
