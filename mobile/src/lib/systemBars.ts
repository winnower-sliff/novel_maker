import { StatusBar, Style } from '@capacitor/status-bar'
import type { Appearance } from '@mobile/lib/settingsStore'

/** 各外观的系统栏形态：Dark 图标配浅底（护眼/浅色），Light 图标配深底（深色） */
const BAR_STYLE: Record<Appearance, { style: Style; bg: string }> = {
  dark: { style: Style.Light, bg: '#09090b' },
  light: { style: Style.Dark, bg: '#f4f4f5' },
  sepia: { style: Style.Dark, bg: '#f1e7d0' }
}

/**
 * 系统栏跟随应用内外观：图标明暗全 API 段有效（含 edge-to-edge）；
 * 背景色仅 API <35 生效（Android 15 强制 edge-to-edge 后透明透出应用内容，无害）。
 * 纯浏览器无插件，静默跳过。
 */
export function applySystemBars(appearance: Appearance): void {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    if (!cap?.isNativePlatform?.()) return
    const s = BAR_STYLE[appearance]
    void StatusBar.setStyle({ style: s.style }).catch(() => {})
    void StatusBar.setBackgroundColor({ color: s.bg }).catch(() => {})
  } catch {
    // 插件未注册等异常：静默，不影响主链路
  }
}
