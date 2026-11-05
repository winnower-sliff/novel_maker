import { registerPlugin } from '@capacitor/core'

/**
 * Android 壳（Capacitor WebView）环境探测与官方 App 插件访问（backButton/exitApp）。
 * 纯浏览器返回 null。
 */
interface BackButtonEvent {
  canGoBack: boolean
}

interface NativeAppPlugin {
  addListener(event: 'backButton', cb: (e: BackButtonEvent) => void): Promise<{ remove: () => void }>
  exitApp(): Promise<void>
}

const appPlugin = registerPlugin<NativeAppPlugin>('App')

export function nativeApp(): NativeAppPlugin | null {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return cap?.isNativePlatform?.() ? appPlugin : null
}
