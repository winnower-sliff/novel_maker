import { ONBOARD_PROGRESS_KEY, type OnboardTurn, readOnboardProgress } from '@mobile/lib/onboard'
import { useUiStore } from '@mobile/lib/uiStore'
import { useKeyboardInset } from '@mobile/lib/useKeyboardInset'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Markdown } from '../components/Markdown'
import { errorText } from '../lib/toastStore'

/** 导演引导回复（契约 onboard:start/answer 的 ret 形态） */
interface OnboardReply {
  reply: string
  options: string[]
  stage: string
  draft?: unknown
  done?: boolean
}

type Turn = OnboardTurn

/**
 * 开书引导：四阶段对话（点子→世界观→人物→书名/文风/红线）。
 * options 是导演给的选择按钮；确认词（就这么定/书名一…）也在 options 里。
 * 中途退出再进来时从对话记录接着聊（不重新问）。
 */
export default function Onboard({ bookId }: { bookId: string }) {
  const openBook = useUiStore((s) => s.openBook)
  const finishOnboard = useUiStore((s) => s.finishOnboard)
  const qc = useQueryClient()
  const [turns, setTurns] = useState<Turn[]>([])
  const [options, setOptions] = useState<string[]>([])
  const [stage, setStage] = useState<string>('premise')
  const [busy, setBusy] = useState(true)
  /** 启动/恢复引导失败的原因（空串=没失败）；显示在对话区，附「再试一次」 */
  const [bootFail, setBootFail] = useState('')
  const [bootNonce, setBootNonce] = useState(0)

  // 打开期间锁住底层页面滚动（防滚动穿透）
  useEffect(() => {
    const old = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = old
    }
  }, [])
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const kbInset = useKeyboardInset()

  // biome-ignore lint/correctness/useExhaustiveDependencies: turns/options 是滚动触发器，内容每变一次滚到底
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

  // 进入引导：先看这本书之前聊到哪了（对话记录是唯一事实源）——中途退出再进来直接接上，
  // 没开始过才向导演要第一问。alive 守卫：离开引导（或开发模式的效果重放）后不再动界面
  // biome-ignore lint/correctness/useExhaustiveDependencies: 进入时与点「再试一次」时各启动/恢复一次
  useEffect(() => {
    let alive = true
    setBusy(true)
    setBootFail('')
    void (async () => {
      try {
        const progress = readOnboardProgress(await window.api.message.list(bookId))
        if (!alive) return
        if (progress?.done) {
          // 已经开完了（书架上的状态还没刷新）：直接进书
          finishOnboard()
          openBook(bookId)
          return
        }
        if (progress) {
          setTurns(progress.turns)
          setOptions(progress.options)
          setStage(progress.stage)
          return
        }
        const reply = await window.api.onboard.start(bookId)
        if (!alive) return
        await applyReply(reply)
      } catch (err) {
        if (!alive) return
        setBootFail(errorText(err))
      } finally {
        if (alive) setBusy(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [bookId, bootNonce])

  // 离开引导（聊完或稍后再说）后让书架重新判断哪些书还在「开书中」
  useEffect(
    () => () => {
      void qc.invalidateQueries({ queryKey: ['books'] })
      void qc.invalidateQueries({ queryKey: ONBOARD_PROGRESS_KEY })
    },
    [qc]
  )

  async function answer(text: string) {
    if (!text.trim() || busy) return
    setTurns((t) => [...t, { role: 'author', text }])
    setInput('')
    setBusy(true)
    try {
      // 带上此刻看到的阶段：请求超时后再点一次时，后端据此认出「重复确认」
      const reply = await window.api.onboard.answer(bookId, text, stage)
      await applyReply(reply)
    } catch (err) {
      setTurns((t) => [...t, { role: 'director', text: `出错了：${errorText(err)}` }])
      // 手输的话放回输入框，免得作者重打；选项按钮一直留着，可以直接再点
      if (!options.includes(text)) setInput(text)
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
    <div className="fixed inset-0 z-30 flex flex-col bg-white">
      <header className="flex items-center justify-between border-b border-orange-100 px-4 pb-2 pt-safe">
        <button type="button" className="pt-2 text-sm text-stone-500" onClick={finishOnboard}>
          稍后再说
        </button>
        <div className="pt-2 text-sm font-medium text-orange-500">{stageLabel[stage] ?? stage}</div>
        <div className="w-16" />
      </header>

      <div className="no-scrollbar flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
        {turns.map((t, i) =>
          t.role === 'director' ? (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态展示片段，无行内状态
              key={i}
              className="max-w-[85%] rounded-2xl rounded-tl-sm bg-orange-100 px-4 py-3 text-[15px] leading-relaxed"
            >
              <Markdown text={t.text} />
            </div>
          ) : (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态展示片段，无行内状态
              key={i}
              className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-orange-700/80 px-4 py-3 text-[15px]"
            >
              {t.text}
            </div>
          )
        )}
        {busy && <div className="text-sm text-stone-500">导演思考中…</div>}
        {bootFail && (
          <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-orange-100 px-4 py-3 text-[15px] leading-relaxed">
            <Markdown text={`引导启动失败：${bootFail}`} />
            <button
              type="button"
              className="mt-2 min-h-10 rounded-full border border-orange-600/60 px-4 text-sm text-orange-600 active:bg-orange-700 active:text-white"
              onClick={() => setBootNonce((n) => n + 1)}
            >
              再试一次
            </button>
          </div>
        )}
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
              className="shrink-0 rounded-full border border-orange-600/60 px-4 py-2 text-sm text-orange-600 active:bg-orange-700 active:text-white disabled:opacity-50"
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
