import type { Job } from '@shared/types'
import { useLayoutEffect, useRef, useState } from 'react'
import { useKeyboardInset } from '../../lib/useKeyboardInset'

/**
 * 底部输入栏：恒定只发消息（startChat）——开章也靠对话（如「写下一章，倾向XX」），
 * 没有任何隐式路由，杜绝「随便聊天被误判成走向」。
 */
export default function InputBar({
  active,
  refresh,
  onSend
}: {
  active: Job | null
  refresh: () => void
  onSend: (text: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const kbInset = useKeyboardInset()
  const busyRunning = !!active && (active.state === 'running' || active.state === 'queued')

  // 输入（含输入法组合输入）后在布局阶段同步量高，不会先画出一帧旧高度。量法：先还原 auto 才测得到
  // 真实内容高度（上限约 6 行，由 max-h 兜住）；到顶后要保住 scrollTop，否则每次输入都会先跳回
  // 顶部再被系统拉回光标处，输入法组合输入时看着一抖一抖
  // biome-ignore lint/correctness/useExhaustiveDependencies: text 只是触发器，量的是 DOM 里的内容高度
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    const fit = () => {
      const top = el.scrollTop
      el.style.height = 'auto'
      const border = el.offsetHeight - el.clientHeight
      el.style.height = `${el.scrollHeight + border}px`
      const clamped = el.scrollHeight > el.clientHeight
      el.style.overflowY = clamped ? 'auto' : 'hidden'
      el.scrollTop = top
    }
    fit()
    // 转屏等视口宽度变化会改变换行
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [text])

  const send = async () => {
    const t = text.trim()
    if (!t || busy) return
    setText('')
    setBusy(true)
    try {
      await onSend(t)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  return (
    <div
      className="border-t border-orange-100 bg-[#fbf6ec] px-3 pt-2 pb-safe"
      style={kbInset ? { paddingBottom: kbInset } : undefined}
    >
      <div className="flex items-end gap-2 pb-2">
        <textarea
          ref={taRef}
          rows={1}
          className="min-h-[42px] max-h-[142px] min-w-0 flex-1 resize-none rounded-2xl border border-orange-100 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-orange-700"
          placeholder={
            busyRunning ? '跟导演说…（会排队）' : '跟导演聊剧情、要建议；想写新章直接说…'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button
          type="button"
          disabled={busy || !text.trim()}
          className="h-[42px] shrink-0 rounded-2xl bg-orange-600 px-4 text-sm font-medium text-white disabled:opacity-40"
          onClick={send}
        >
          发送
        </button>
      </div>
    </div>
  )
}
