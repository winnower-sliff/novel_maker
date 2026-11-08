import { Markdown } from '../../components/Markdown'
import { tickerStore } from '../../lib/tickerStore'
import { ThinkingBubble } from './MessageRow'

/**
 * 时间轴上的实时流卡（opencode 式）：当前轮思考/正文直接在时间轴对应位置流式刷新，
 * 轮结束由后端落库同款消息卡无缝接管（App.tsx onAppend 清流）。
 */
export default function StreamRow({ jobId }: { jobId: string }) {
  const useTicker = tickerStore(jobId)
  const thinking = useTicker((s) => s.thinking)
  const chatText = useTicker((s) => s.chatText)
  if (!thinking && !chatText) return null
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
    </>
  )
}
