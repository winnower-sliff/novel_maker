import { useEffect, useRef, useState } from 'react'
import { useUiStore } from '@mobile/lib/uiStore'
import { useKeyboardInset } from '@mobile/lib/useKeyboardInset'
import { Markdown } from '../components/Markdown'

/** 导演引导回复（契约 onboard:start/answer 的 ret 形态） */
interface OnboardReply {
  reply: string
  options: string[]
  stage: string
  draft?: unknown
  done?: boolean
}

interface Turn {
  role: 'director' | 'author'
  text: string
}

/**
 * 开书引导：四阶段对话（点子→世界观→人物→书名/文风/红线）。
 * options 是导演给的选择按钮；确认词（就这么定/书名一…）也在 options 里。
 */
export default function Onboard({ bookId }: { bookId: string }) {
  const openBook = useUiStore((s) => s.openBook)
  const finishOnboard = useUiStore((s) => s.finishOnboard)
  const [turns, setTurns] = useState<Turn[]>([])
  const [options, setOptions] = useState<string[]>([])
  const [stage, setStage] = useState<string>('premise')
  const [busy, setBusy] = useState(true)
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const kbInset = useKeyboardInset()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, options])

  async function applyReply(reply: OnboardReply) {
    setTurns((t) => [...t, { role: 'director', text: reply.reply }])
    setOptions(reply.options ?? [])
    setStage(reply.stage)
    if (reply.done) {
      setOptions([])
      setTimeout(() => {
        finishOnboard()
        openBook(bookId)
      }, 1600)
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const reply = await window.api.onboard.start(bookId)
        await applyReply(reply)
      } catch (err) {
        setTurns((t) => [...t, { role: 'director', text: `引导启动失败：${(err as Error).message}` }])
      } finally {
        setBusy(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  async function answer(text: string) {
    if (!text.trim() || busy) return
    setTurns((t) => [...t, { role: 'author', text }])
    setInput('')
    setOptions([])
    setBusy(true)
    try {
      const reply = await window.api.onboard.answer(bookId, text)
      await applyReply(reply)
    } catch (err) {
      setTurns((t) => [...t, { role: 'director', text: `出错了：${(err as Error).message}` }])
    } finally {
      setBusy(false)
    }
  }

  const stageLabel: Record<string, string> = {
    premise: '点子与基调',
    world: '世界观',
    characters: '人物',
    title: '书名与文风',
    done: '完成'
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-white">
      <header className="flex items-center justify-between border-b border-orange-100 px-4 pb-2 pt-safe">
        <button type="button" className="pt-2 text-sm text-stone-500" onClick={finishOnboard}>
          稍后再说
        </button>
        <div className="pt-2 text-sm font-medium text-orange-500">{stageLabel[stage] ?? stage}</div>
        <div className="w-16" />
      </header>

      <div className="no-scrollbar flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {turns.map((t, i) =>
          t.role === 'director' ? (
            <div key={i} className="max-w-[85%] rounded-2xl rounded-tl-sm bg-orange-100 px-4 py-3 text-[15px] leading-relaxed">
              <Markdown text={t.text} />
            </div>
          ) : (
            <div key={i} className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-orange-700/80 px-4 py-3 text-[15px]">
              {t.text}
            </div>
          )
        )}
        {busy && <div className="text-sm text-stone-500">导演思考中…</div>}
        <div ref={bottomRef} />
      </div>

      {options.length > 0 && (
        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-2">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              disabled={busy}
              onClick={() => void answer(opt)}
              className="shrink-0 rounded-full border border-orange-600/60 px-4 py-2 text-sm text-orange-600 active:bg-orange-700 active:text-white"
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      <div
        className="flex gap-2 px-4 pb-safe pt-2"
        style={kbInset ? { paddingBottom: kbInset } : undefined}
      >
        <input
          className="flex-1 rounded-xl border border-orange-200 bg-white px-4 py-3 text-[15px] focus:border-orange-500 focus:outline-none"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229)
              void answer(input)
          }}
          placeholder="或直接输入你的想法…"
        />
        <button
          type="button"
          disabled={busy || !input.trim()}
          onClick={() => void answer(input)}
          className="rounded-xl bg-orange-600 px-5 font-semibold text-white active:bg-orange-700 disabled:opacity-50"
        >
          发送
        </button>
      </div>
    </div>
  )
}
