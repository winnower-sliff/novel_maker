// 软键盘高度 → CSS 变量 --kb：Android 15 edge-to-edge 强制启用后 windowSoftInputMode
// 的 adjustResize 已失效（WebView 不会被键盘压缩布局），flex 布局的页内输入条会被键盘挡住。
// 原生端用官方 @capacitor/keyboard 的 inset 事件取键盘高度；浏览器端回退 visualViewport
// （Android Chrome 键盘弹出会缩小 visual viewport）。
import { Capacitor } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'

let ready = false

function setKb(px: number): void {
  document.documentElement.style.setProperty('--kb', `${Math.max(0, Math.round(px))}px`)
  // 通知消费方（如聊天区回滚到底部）
  window.dispatchEvent(new CustomEvent('nm-kb'))
}

function fallbackVisualViewport(): void {
  const vv = window.visualViewport
  if (!vv) return
  const apply = (): void => setKb(window.innerHeight - vv.height - vv.offsetTop)
  vv.addEventListener('resize', apply)
  vv.addEventListener('scroll', apply)
  apply()
}

/** 挂软键盘高度同步（幂等）。在 App 根组件连接就绪后调用 */
export function installKeyboardViewport(): void {
  if (ready || typeof window === 'undefined') return
  ready = true
  if (!Capacitor.isNativePlatform()) {
    fallbackVisualViewport()
    return
  }
  void Keyboard.addListener('keyboardWillShow', (i) => setKb(i.keyboardHeight)).catch(() => {})
  void Keyboard.addListener('keyboardDidShow', (i) => setKb(i.keyboardHeight)).catch(() => {})
  void Keyboard.addListener('keyboardWillHide', () => setKb(0)).catch(() => {})
  void Keyboard.addListener('keyboardDidHide', () => setKb(0)).catch(() => {})
}
