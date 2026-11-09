import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { qk, useBook, useJobFlow, useMessages } from '../lib/queries'
import { useUiStore } from '../lib/uiStore'
import StatusHead from './write/StatusHead'
import StreamRow from './write/StreamRow'
import InputBar from './write/InputBar'
import { MessageRow } from './write/MessageRow'

/**
 * 写作页=聊天时间轴。组件按域拆在 ./write/：
 * StatusHead 现状胶囊（运行中变体=状态+取消）/ MessageRow 消息分派 / JobCard 节点卡（DoneCards 成品、
 * ToolCard 工具）/ InputBar 恒定聊天（开章也靠对话）。
 */
export default function Write() {
  const bookId = useUiStore((s) => s.openBookId) ?? ''
  const qc = useQueryClient()
  const { data: flow } = useJobFlow(bookId)
  const active = flow?.active ?? null
  const { data: messages } = useMessages(bookId, !!active)
  const { data: detail } = useBook(bookId)
  const jobs = flow?.jobs ?? []

  // 乐观消息：点发送立刻上墙（半透明+转圈），服务器确认落库后撤掉由真实消息顶上
  const [pending, setPending] = useState<Array<{ id: string; text: string; at: number; failed?: boolean }>>([])
  const sendPending = async (text: string, replaceId?: string) => {
    if (replaceId) setPending((l) => l.filter((p) => p.id !== replaceId))
    const id = `pend-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setPending((l) => [...l, { id, text, at: Date.now() }])
    try {
      await window.api.job.startChat(bookId, text)
      // 等 messages 拉取完成再撤气泡，避免真实行还没上墙就闪空
      await qc.invalidateQueries({ queryKey: qk.messages(bookId) })
      await qc.invalidateQueries({ queryKey: qk.jobs(bookId) })
      setPending((l) => l.filter((p) => p.id !== id))
    } catch {
      setPending((l) => l.map((p) => (p.id === id ? { ...p, failed: true } : p)))
    }
  }
  // 对账：服务端 userMsg 比请求回执先到（SSE 触头的 invalidate）也撤掉气泡（容忍 30s 时钟偏移）
  useEffect(() => {
    setPending((list) => {
      const rows = (messages ?? []).filter((m) => m.role === 'user')
      const next = list.filter(
        (p) => p.failed || !rows.some((m) => m.content === p.text && m.createdAt >= p.at - 30000)
      )
      return next.length === list.length ? list : next
    })
  }, [messages])

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.jobs(bookId) })
    void qc.invalidateQueries({ queryKey: qk.messages(bookId) })
  }, [qc, bookId])
  const refreshAll = useCallback(() => {
    refresh()
    void qc.invalidateQueries({ queryKey: qk.book(bookId) })
    void qc.invalidateQueries({ queryKey: qk.statusCard(bookId) })
  }, [qc, bookId, refresh])

  const jobsById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs])
  const chaptersById = useMemo(
    () => new Map((detail?.chapters ?? []).map((c) => [c.id, c])),
    [detail?.chapters]
  )

  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  // 内容高度不断变化（流式/聚合条）：只要用户仍贴底就跟随滚底
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const stick = () => {
      if (stickRef.current) {
        const list = listRef.current
        if (list) list.scrollTop = list.scrollHeight
      }
    }
    stick()
    const ro = new ResizeObserver(stick)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div
        ref={listRef}
        id="write-list"
        className="min-h-0 flex-1 overflow-y-auto no-scrollbar"
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
        }}
      >
        <StatusHead bookId={bookId} active={active} />
        <div ref={contentRef}>
          {(messages ?? []).map((m) => (
            <MessageRow
              key={m.id}
              msg={m}
              jobsById={jobsById}
              chaptersById={chaptersById}
              active={active}
              refresh={refresh}
              refreshAll={refreshAll}
            />
          ))}
          {pending.map((p) => (
            <div key={p.id} className="flex justify-end px-4 py-1.5">
              <div className="max-w-[85%] text-right">
                <div
                  className={`rounded-2xl rounded-tr-sm px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap text-white ${
                    p.failed ? 'bg-stone-400' : 'bg-orange-600 opacity-65'
                  }`}
                >
                  {p.text}
                </div>
                <div className="mt-0.5 pr-1 text-[10px] text-stone-400">
                  {p.failed ? (
                    <button
                      type="button"
                      className="text-red-500"
                      onClick={() => void sendPending(p.text, p.id)}
                    >
                      发送失败 · 点按重发
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-orange-300" />
                      发送中…
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
          {active && (active.state === 'running' || active.state === 'queued') && (
            <StreamRow jobId={active.id} />
          )}
        </div>
        <div className="h-3" />
      </div>

      <InputBar active={active} refresh={refreshAll} onSend={sendPending} />
    </div>
  )
}
