import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ChatMessageRow } from '@shared/types'
import { installBridge } from './lib/bridge'
import { useConnStore } from './lib/conn'
import { consumeBack } from './lib/backHandler'
import { nativeApp } from './lib/nativeApp'
import { qk } from './lib/queries'
import { tickerStore } from './lib/tickerStore'
import { useUiStore } from './lib/uiStore'
import Connect from './pages/Connect'
import Shelf from './pages/Shelf'
import Settings from './pages/Settings'
import Onboard from './pages/Onboard'
import BookWorkspace from './pages/BookWorkspace'

export default function App() {
  const { conn, ready } = useConnStore()
  const { tab, openBookId, onboardBookId } = useUiStore()
  const [sseDown, setSseDown] = useState(false)

  // 连接建立后安装 API bridge（首启未连接时 window.api 尚未装，幂等）
  useEffect(() => {
    if (conn) installBridge()
  }, [conn])

  // 全局事件 → 缓存失效/实时上墙：写作任务推进时刷新书/章/设定
  const qc = useQueryClient()
  useEffect(() => {
    if (!conn || !window.api) return
    // 聊天流新行直接进缓存（agent 运行中实时上墙，不等 job 结束）；
    // 思考/白话落库时清对应实时流（时间轴上的流式卡被落库卡无缝接管）
    const unAppend = window.api.message.onAppend((msg) => {
      qc.setQueryData<ChatMessageRow[]>(qk.messages(msg.bookId), (old) =>
        old && !old.some((m) => m.id === msg.id)
          ? [...old, msg].sort((a, b) => a.createdAt - b.createdAt)
          : (old ?? [msg])
      )
      const meta = msg.meta as { kind?: string; jobId?: string } | undefined
      if (msg.role === 'assistant' && typeof meta?.jobId === 'string') {
        const tk = tickerStore(meta.jobId).getState()
        if (meta.kind === 'thinking') tk.setThinking('')
        else if (meta.kind === 'chat') tk.setChatText('')
      }
    })
    const unUpdate = window.api.job.onUpdate((_jobId, job) => {
      void qc.invalidateQueries({ queryKey: qk.jobs(job.bookId) })
      void qc.invalidateQueries({ queryKey: qk.messages(job.bookId) })
      if (job.state === 'done') {
        void qc.invalidateQueries({ queryKey: qk.book(job.bookId) })
        void qc.invalidateQueries({ queryKey: qk.statusCard(job.bookId) })
      }
    })
    // 聚合条事件 → 全局 ticker store（切页不丢、回放即读）
    const unActivity = window.api.job.onActivity((jobId, act) => {
      tickerStore(jobId).getState().pushAct({ ...act, ts: Date.now() })
    })
    const unProgress = window.api.job.onProgress((jobId, p) => {
      tickerStore(jobId).getState().setProgress(p)
    })
    // chat 流式：thinking 折叠区 + 正文白话；total 失配时 job.get 兜底（服务端真相源）
    const unDelta = window.api.job.onDelta((jobId, kind, chunk, total) => {
      const ts = tickerStore(jobId)
      if (kind === 'thinking') {
        const st = ts.getState()
        if (st.thinking.length !== total - chunk.length) {
          void window.api.job.get(jobId).then((j) => {
            const t = j?.payload.thinkingText ?? ''
            ts.getState().setThinking(t)
          })
        } else ts.getState().appendThink(chunk, total)
      } else {
        const st = ts.getState()
        if (st.chatText.length !== total - chunk.length) {
          void window.api.job.get(jobId).then((j) => {
            const t = j?.payload.answer ?? ''
            ts.getState().setChatText(t)
          })
        } else ts.getState().appendDelta(chunk, total)
      }
    })
    return () => {
      unAppend()
      unUpdate()
      unActivity()
      unProgress()
      unDelta()
    }
  }, [conn, qc])

  // SSE 断连横幅 + 恢复后全量补拉（防断连窗口内错过事件）
  useEffect(() => {
    const onState = (ev: Event) => setSseDown(!(ev as CustomEvent<{ ok: boolean }>).detail.ok)
    const onReconnect = () => {
      setSseDown(false)
      void qc.invalidateQueries()
    }
    window.addEventListener('nm-sse-state', onState)
    window.addEventListener('nm-sse-reconnect', onReconnect)
    return () => {
      window.removeEventListener('nm-sse-state', onState)
      window.removeEventListener('nm-sse-reconnect', onReconnect)
    }
  }, [qc])

  // Android 返回键：先消费弹层/子视图栈，无处理器时回书架，书架再按退出
  useEffect(() => {
    const app = nativeApp()
    if (!app) return
    let remove: (() => void) | null = null
    void app.addListener('backButton', () => {
      const s = useUiStore.getState()
      if (consumeBack()) return
      if (s.onboardBookId) {
        s.finishOnboard()
        return
      }
      if (s.openBookId) {
        s.closeBook()
        return
      }
      if (s.tab !== 'shelf') {
        s.setTab('shelf')
        return
      }
      void app.exitApp()
    }).then((h) => {
      remove = h.remove
    })
    return () => remove?.()
  }, [])

  if (!ready) return null
  if (!conn) return <Connect />

  return (
    <div className="h-full">
      {sseDown && (
        <div className="fixed inset-x-0 top-0 z-[60] bg-amber-500 py-1.5 text-center text-xs font-medium text-white">
          与电脑的连接已断开，正在重连…
        </div>
      )}
      {tab === 'shelf' ? <Shelf /> : <Settings />}
      {onboardBookId && <Onboard bookId={onboardBookId} />}
      {openBookId && <BookWorkspace />}
    </div>
  )
}
