// 任务完成系统通知的统一入口：桌面/浏览器走 Web Notification，
// 手机端由 mobile 侧注入 Capacitor LocalNotifications 实现（依赖倒置，
// 避免 src/wizard 反向依赖仅 mobile 安装的插件包）。

export type NotifyFn = (title: string, body: string) => void

let provider: NotifyFn | null = null

export function setNotifyProvider(fn: NotifyFn): void {
  provider = fn
}

function webNotify(title: string, body: string): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission === 'granted') {
    new Notification(title, { body })
  } else if (Notification.permission === 'default') {
    void Notification.requestPermission().then((p) => {
      if (p === 'granted') new Notification(title, { body })
    })
  }
}

export function notify(title: string, body: string): void {
  try {
    if (provider) provider(title, body)
    else webNotify(title, body)
  } catch {
    // 通知失败不影响主流程
  }
}
