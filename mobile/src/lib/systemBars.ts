import { StatusBar, Style } from '@capacitor/status-bar'

/** 阅读器外观：系统栏图标明暗跟随 */
const LIGHT = { style: Style.Dark, bg: '#f7f2e6' }
const SEPIA = { style: Style.Dark, bg: '#f1e7d0' }

export type Appearance = 'sepia' | 'light'

/**
 * 系统栏跟随应用内外观。背景色仅 API <35 生效（Android 15 强制 edge-to-edge 后透明，
 * 透出应用内容，无害）。纯浏览器无插件，静默跳过。
 */
export function applySystemBars(appearance: Appearance): void {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    if (!cap?.isNativePlatform?.()) return
    const s = appearance === 'sepia' ? SEPIA : LIGHT
    void StatusBar.setStyle({ style: s.style }).catch(() => {})
    void StatusBar.setBackgroundColor({ color: s.bg }).catch(() => {})
  } catch {
    // 插件未注册等异常：静默
  }
}
