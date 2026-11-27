import type { ChatMessageRow } from '@shared/types'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { TabBar } from './components/TabBar'
import { ToastHost } from './components/ToastHost'
import { consumeBack } from './lib/backHandler'
import { installBridge } from './lib/bridge'
import { useConnStore } from './lib/conn'
import { nativeApp } from './lib/nativeApp'
import { qk } from './lib/queries'
import { tickerStore } from './lib/tickerStore'
import { useUiStore } from './lib/uiStore'
import BookWorkspace from './pages/BookWorkspace'
import Connect from './pages/Connect'
import Onboard from './pages/Onboard'
import Samples from './pages/Samples'
import Settings from './pages/Settings'
import Shelf from './pages/Shelf'

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
      // 任务离开运行态（收工 / 失败 / 取消 / 重试重新排队）：写手的字数进度条清掉，不带到下一轮
      if (job.state !== 'running') tickerStore(job.id).getState().setProgress(null)
      if (job.state === 'done') {
        void qc.invalidateQueries({ queryKey: qk.book(job.bookId) })
        void qc.invalidateQueries({ queryKey: qk.statusCard(job.bookId) })
      }
    })
    // 聚合条事件 → 全局 ticker store（切页不丢、回放即读）
    const unActivity = window.api.job.onActivity((jobId, act) => {
      tickerStore(jobId)
        .getState()
        .pushAct({ ...act, ts: Date.now() })
    })
    const unProgress = window.api.job.onProgress((jobId, p) => {
      tickerStore(jobId).getState().setProgress(p)
    })
    // chat 流式：thinking 折叠区 + 正文白话。长度对不上时按服务端快照（真相源）校正——
    // 快照几秒才落一次盘，所以只允许一个在途、至多 500ms 一次；过期/重复的增量直接丢弃
    let pulling = false
    let lastPull = 0
    const onStream = (jobId: string, kind: 'thinking' | 'chat', chunk: string, total: number) => {
      const ts = tickerStore(jobId)
      const st = ts.getState()
      const isThink = kind === 'thinking'
      const cur = isThink ? st.thinking : st.chatText
      const seen = isThink ? st.thinkTotal : st.chatTotal
      const at = total - chunk.length
      const append = () => (isThink ? st.appendThink(chunk, total) : st.appendDelta(chunk, total))
      if (cur.length === at) return append()
      // at===0 是模型重试后从头重发，要接住；其余比已记录位置旧的是过期/重复增量
      if (total <= seen && at > 0) return
      if (pulling || Date.now() - lastPull < 500) return
      pulling = true
      lastPull = Date.now()
      void window.api.job
        .get(jobId)
        .then((j) => {
          const text = isThink ? (j?.payload.thinkingText ?? '') : (j?.payload.answer ?? '')
          if (isThink) ts.getState().setThinking(text)
          else ts.getState().setChatText(text)
        })
        .catch(() => {})
        .finally(() => {
          pulling = false
        })
    }
    const unDelta = window.api.job.onDelta((jobId, kind, chunk, total) => {
      onStream(jobId, kind === 'thinking' ? 'thinking' : 'chat', chunk, total)
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

  // Android 返回键：先消费弹层/子视图栈，无处理器时回「写书」页（shelf），
  // 已经在「写书」页再按才退出——范文 / 设置页按返回不会退出应用
  useEffect(() => {
    const app = nativeApp()
    if (!app) return
    let remove: (() => void) | null = null
    void app
      .addListener('backButton', () => {
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
      })
      .then((h) => {
        remove = h.remove
      })
    return () => remove?.()
  }, [])

  if (!ready) return null
  if (!conn) return <Connect />

  // 书内工作区与开书引导都是全屏层：开着时不渲染底部导航，免得它留在盖板下面的无障碍树里
  const covered = openBookId !== null || onboardBookId !== null

  return (
    <div className="flex h-full flex-col">
      {sseDown && (
        <div className="fixed inset-x-0 top-0 z-[60] bg-amber-500 py-1.5 text-center text-xs font-medium text-white">
          与电脑的连接已断开，正在重连…
        </div>
      )}
      {tab === 'shelf' && <Shelf />}
      {tab === 'samples' && <Samples />}
      {tab === 'settings' && <Settings />}
      {!covered && <TabBar />}
      {onboardBookId && <Onboard bookId={onboardBookId} />}
      {openBookId && <BookWorkspace />}
      <ToastHost />
    </div>
  )
}
