/**
 * 主动重启 APP：APK 内经 Capacitor 插件重建 Activity，
 * 原生启动更新流程随之重跑（检查→下载→应用新版）；
 * 浏览器环境无原生壳，降级为整页 reload。
 */
export function restartApp(): void {
  const cap = (
    window as unknown as {
      Capacitor?: { Plugins?: { AppRestart?: { restart: () => Promise<void> } } }
    }
  ).Capacitor
  if (cap?.Plugins?.AppRestart) {
    void cap.Plugins.AppRestart.restart()
  } else {
    window.location.reload()
  }
}
