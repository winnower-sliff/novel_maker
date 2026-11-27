import type { Job } from '@shared/types'
import { useEffect } from 'react'
import { Markdown } from '../../components/Markdown'
import { tickerStore } from '../../lib/tickerStore'
import { ThinkingBubble } from './MessageRow'

/**
 * 时间轴上的实时流卡（opencode 式）：当前轮思考/正文直接在时间轴对应位置流式刷新，
 * 轮结束由后端落库同款消息卡无缝接管（App.tsx onAppend 清流）。
 * 写手的字数进度条也在这里：正文不进聊天流，只报「写手已写 N 字」。
 */
export default function StreamRow({ job }: { job: Job }) {
  const useTicker = tickerStore(job.id)
  const thinking = useTicker((s) => s.thinking)
  const chatText = useTicker((s) => s.chatText)
  const live = useTicker((s) => s.progress)

  // SSE 重连后以服务端为准：断线窗口里的进度事件补不回来，拉一次任务快照覆盖本地的
  useEffect(() => {
    const resync = () => {
      void window.api.job
        .get(job.id)
        .then((j) =>
          tickerStore(job.id)
            .getState()
            .setProgress(j?.payload.progress ?? null)
        )
        .catch(() => {
          /* 拉不到就等下一条进度事件 */
        })
    }
    window.addEventListener('nm-sse-reconnect', resync)
    return () => window.removeEventListener('nm-sse-reconnect', resync)
  }, [job.id])

  // 本地还没有实时进度时（刚打开页面 / 重开应用）用任务快照里的；
  // 排队、等作者确认时写手没在写，不拿上一轮的旧字数顶上
  const progress = live ?? (job.state === 'running' ? (job.payload.progress ?? null) : null)
  if (!thinking && !chatText && !progress) return null
  return (
    <>
      {thinking && <ThinkingBubble text={thinking} live />}
      {chatText && (
        <div className="flex justify-start px-4 py-1.5">
          <div className="max-w-[88%]">
            <div className="rounded-2xl rounded-tl-sm border border-orange-100 bg-white px-3.5 py-2 text-sm leading-relaxed text-stone-700">
              <Markdown text={chatText} />
              <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-orange-400 align-middle" />
            </div>
          </div>
        </div>
      )}
      {progress && <ProgressLine phase={progress.phase} chars={progress.chars} />}
    </>
  )
}

/** 写手进度条：字数随 job:progress 更新；0 字 = 刚领到任务、正在动笔。样式与顶部运行中的胶囊同款 */
function ProgressLine({ phase, chars }: { phase: string; chars: number }) {
  const verb = phase === 'revise' ? '改写' : '写'
  return (
    <div className="px-4 py-1.5">
      <div
        className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs text-orange-700"
        role="status"
      >
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-orange-500" />
        <span className="tabular-nums">
          {chars > 0 ? `写手已${verb} ${chars} 字` : `写手正在${verb}…`}
        </span>
      </div>
    </div>
  )
}
