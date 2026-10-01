import { registerPlugin } from '@capacitor/core'

/**
 * APK 自更新原生桥（仅 APK 内可用；纯浏览器下 isAvailable() 返回 false）。
 * 下载/安装均由原生执行：下载到 cacheDir/NovelMaker.apk，完成后调起系统安装器。
 */
interface ApkUpdaterPlugin {
  getVersion(): Promise<{ version: string; versionCode: number }>
  download(opts: { url: string; token: string }): Promise<{ path: string; size: number }>
  install(): Promise<void | { needsGrant?: boolean }>
  addListener(
    event: 'progress',
    cb: (data: { done: number; total: number }) => void
  ): Promise<{ remove: () => void }>
}

const apk = registerPlugin<ApkUpdaterPlugin>('ApkUpdater')

/** 仅 APK（Capacitor WebView）环境返回桥，纯浏览器返回 null */
export function apkUpdater(): ApkUpdaterPlugin | null {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return cap?.isNativePlatform?.() ? apk : null
}

export interface ApkProgress {
  done: number
  total: number
}

/** install() 的结果：needsGrant=true 表示已跳转「安装未知应用」授权页 */
export interface InstallResult {
  needsGrant?: boolean
}
