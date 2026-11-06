import { useState } from 'react'
import type { Job } from '@shared/types'
import { useKeyboardInset } from '../../lib/useKeyboardInset'

/**
 * 底部输入栏：恒定只发消息（startChat）。
 * 与选走向彻底解耦——等走向确认时想自定义，用 ChoiceCard 卡内的
 * 「自己写走向」输入框显式提交，杜绝「随便聊天被误判成走向」。
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
  const kbInset = useKeyboardInset()
  const busyRunning = !!active && (active.state === 'running' || active.state === 'queued')

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
          rows={1}
          className="min-h-[42px] max-h-28 min-w-0 flex-1 resize-none rounded-2xl border border-orange-100 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-orange-700"
          placeholder={busyRunning ? '跟导演说…（会排队）' : '跟导演聊剧情、要建议；想写新章直接说…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
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
