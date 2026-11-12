import { registerPlugin } from '@capacitor/core'
import { useConnStore } from './conn'

/**
 * APK 自更新原生桥（仅 APK 内可用；纯浏览器下 isAvailable() 返回 false）。
 * 下载/安装均由原生执行：下载到 cacheDir/NovelMaker.apk，完成后调起系统安装器。
 */
interface ApkUpdaterPlugin {
  getVersion(): Promise<{ version: string; versionCode: number }>
  download(opts: { url: string; versionCode?: number }): Promise<{ path: string; size: number }>
  status(opts?: { versionCode?: number }): Promise<DownloadStatus>
  install(opts?: { versionCode?: number }): Promise<void | { needsGrant?: boolean }>
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
  apk?: { version: string; versionCode?: number; path: string; size: number; notes?: string[] }
}

export type UpdateCheck =
  | { state: 'latest' }
  | { state: 'found'; version: string; versionCode: number; url: string; size: number }
  | { state: 'error'; error: string }

/** 对比服务端 manifest 与本地 APP 版本：versionCode 数值判新（单调递增），versionName 仅作展示 */
export async function checkUpdate(): Promise<UpdateCheck> {
  const base = useConnStore.getState().conn?.baseUrl
  if (!base) return { state: 'error', error: '未连接服务器' }
  const plugin = apkUpdater()
  if (!plugin) return { state: 'latest' } // 纯浏览器无 APK 自更新概念
  try {
    const [r, cur] = await Promise.all([fetch(`${base}/api/mobile/version`), plugin.getVersion()])
    const m = (await r.json()) as MobileManifest
    if (!m.apk) return { state: 'latest' }
    // manifest 缺 versionCode（旧部署链）时回退标签不等比较，宁多提示不漏更新
    const isNewer =
      m.apk.versionCode != null
        ? m.apk.versionCode > cur.versionCode
        : m.apk.version !== cur.version
    if (!isNewer) return { state: 'latest' }
    return {
      state: 'found',
      version: m.apk.version,
      versionCode: m.apk.versionCode ?? 0,
      url: `${base}/api/mobile/apk`,
      size: m.apk.size,
    }
  } catch (e) {
    return { state: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

/** 原生下载状态快照：downloading 进行中；size=cacheDir 里该 versionCode 文件字节数（跨进程重启仍准确） */export interface DownloadStatus {
  downloading: boolean
  done: number
  total: number
  size: number
  error?: string
}

/** versionCode 必传：下载文件按版本隔离（nm-<vc>.apk），旧版本残留永不误判 */
export async function getDownloadStatus(versionCode: number): Promise<DownloadStatus | null> {
  const plugin = apkUpdater()
  if (!plugin) return null
  return plugin.status({ versionCode })
}

/**
 * 触发下载（原生后台线程执行，立即返回，不等待完成）。
 * 进度/完成/失败一律经 getDownloadStatus() 轮询——切走再回来、甚至 WebView 重载后状态都不丢。
 */
export async function startDownload(url: string, versionCode: number): Promise<void> {
  const plugin = apkUpdater()
  if (!plugin) throw new Error('仅 APP 内可用')
  await plugin.download({ url, versionCode })
}

/** 调起系统安装器（API 26+ 未授权时跳授权页，返回 needsGrant）；versionCode 指定装哪个文件 */
export async function installUpdate(versionCode: number): Promise<InstallResult> {
  const plugin = apkUpdater()
  if (!plugin) return {}
  const r = await plugin.install({ versionCode })
  return r ?? {}
}
