import { registerPlugin } from '@capacitor/core'
import { useConnStore } from './conn'

/**
 * APK 自更新原生桥（仅 APK 内可用；纯浏览器下 isAvailable() 返回 false）。
 * 下载/安装均由原生执行：下载到 cacheDir/NovelMaker.apk，完成后调起系统安装器。
 */
interface ApkUpdaterPlugin {
  getVersion(): Promise<{ version: string; versionCode: number }>
  download(opts: { url: string }): Promise<{ path: string; size: number }>
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

// ── 高层封装：检查→下载→安装 ────────────────────────────────────────────────

interface MobileManifest {
  version: string | null
  buildAt: string | null
  apk?: { version: string; path: string; size: number; notes?: string[] }
}

export type UpdateCheck =
  | { state: 'latest' }
  | { state: 'found'; version: string; url: string; size: number }
  | { state: 'error'; error: string }

/** 对比服务端 manifest 与本地 APP 版本；APK 产物缺在时视为最新 */
export async function checkUpdate(): Promise<UpdateCheck> {
  const base = useConnStore.getState().conn?.baseUrl
  if (!base) return { state: 'error', error: '未连接服务器' }
  try {
    const r = await fetch(`${base}/api/mobile/version`)
    const m = (await r.json()) as MobileManifest
    if (!m.apk) return { state: 'latest' }
    const current = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''
    if (m.apk.version === current) return { state: 'latest' }
    return { state: 'found', version: m.apk.version, url: `${base}/api/mobile/apk`, size: m.apk.size }
  } catch (e) {
    return { state: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

export type DownloadState =
  | { state: 'downloading' }
  | { state: 'ready' }
  | { state: 'error'; error: string }

/** 下载 APK 到 cacheDir（原生执行），onProgress 0-100；完成后调 install() 安装 */
export async function downloadUpdate(
  url: string,
  onProgress?: (pct: number) => void
): Promise<DownloadState> {
  const plugin = apkUpdater()
  if (!plugin) return { state: 'error', error: '仅 APP 内可用' }
  try {
    const listener = await plugin.addListener('progress', (p) => {
      if (onProgress && p.total > 0) onProgress(Math.round((p.done / p.total) * 100))
    })
    await plugin.download({ url })
    listener.remove()
    return { state: 'ready' }
  } catch (e) {
    return { state: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

/** 调起系统安装器（API 26+ 未授权时跳授权页，返回 needsGrant） */
export async function installUpdate(): Promise<InstallResult> {
  const plugin = apkUpdater()
  if (!plugin) return {}
  const r = await plugin.install()
  return r ?? {}
}
