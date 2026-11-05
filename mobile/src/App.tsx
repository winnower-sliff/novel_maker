import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { installBridge } from './lib/bridge'
import { useConnStore } from './lib/conn'
import { consumeBack } from './lib/backHandler'
import { nativeApp } from './lib/nativeApp'
import { qk } from './lib/queries'
import { useUiStore } from './lib/uiStore'
import Connect from './pages/Connect'
import Shelf from './pages/Shelf'
import Settings from './pages/Settings'
import Onboard from './pages/Onboard'
import BookWorkspace from './pages/BookWorkspace'

export default function App() {
  const { conn, ready } = useConnStore()
  const { tab, openBookId, onboardBookId } = useUiStore()

  // 连接建立后安装 API bridge（首启未连接时 window.api 尚未装，幂等）
  useEffect(() => {
    if (conn) installBridge()
  }, [conn])

  // 全局事件 → 缓存失效：写作任务推进时刷新书/章/设定
  const qc = useQueryClient()
  useEffect(() => {
    if (!conn || !window.api) return
    return window.api.job.onUpdate((_jobId, job) => {
      void qc.invalidateQueries({ queryKey: qk.jobs(job.bookId) })
      void qc.invalidateQueries({ queryKey: qk.messages(job.bookId) })
      if (job.state === 'done') {
        void qc.invalidateQueries({ queryKey: qk.book(job.bookId) })
        void qc.invalidateQueries({ queryKey: qk.statusCard(job.bookId) })
      }
    })
  }, [conn, qc])

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
      {tab === 'shelf' ? <Shelf /> : <Settings />}
      {onboardBookId && <Onboard bookId={onboardBookId} />}
      {openBookId && <BookWorkspace />}
    </div>
  )
}
