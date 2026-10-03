import { LocalNotifications } from '@capacitor/local-notifications'
import { setNotifyProvider } from '@wizard/notify'

/**
 * APK 内的系统通知实现（Capacitor LocalNotifications）：
 * Android 13+ 首次发送前请求 POST_NOTIFICATIONS 运行时权限。
 * 纯浏览器环境不注入，走 notify.ts 的 Web Notification 默认实现。
 */
let permissionAsked = false

async function show(title: string, body: string): Promise<void> {
  if (!permissionAsked) {
    permissionAsked = true
    try {
      await LocalNotifications.requestPermissions()
    } catch {
      // 权限请求失败仍尝试发送（旧版本 Android 无需运行时权限）
    }
  }
  await LocalNotifications.schedule({
    notifications: [{ id: Date.now() % 2_147_483_647, title, body }]
  })
}

export function installNotifyProvider(): void {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor
  if (!cap?.isNativePlatform?.()) return
  setNotifyProvider((title, body) => {
    void show(title, body).catch(() => {})
  })
}
