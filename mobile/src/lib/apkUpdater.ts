import { registerPlugin } from '@capacitor/core'
import { useConnStore } from './conn'

/**
 * APK 自更新原生桥（仅 APK 内可用；纯浏览器下返回 null）。
 * 下载/安装均由原生执行：下载到 cacheDir/nm-<versionCode>.apk（原生校验过完整性
 * 与包内真实版本号才算下载好），完成后调起系统安装器。
 */
interface ApkUpdaterPlugin {
  getVersion(): Promise<{ version: string; versionCode: number }>
  download(opts: {
    url: string
    versionCode: number
    expectedSize?: number
  }): Promise<{ path: string; size: number }>
  status(opts: { versionCode: number }): Promise<DownloadStatus>
  install(opts: { versionCode: number }): Promise<{ needsGrant?: boolean } | undefined>
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

/** 原生下载状态快照：complete=该 versionCode 的安装包已下载并校验通过（跨进程重启仍准确） */
export interface DownloadStatus {
  downloading: boolean
  done: number
  total: number
  size: number
  complete: boolean
  error?: string
}

/** install() 的结果：needsGrant=true 表示已跳转「安装未知应用」授权页 */
export interface InstallResult {
  needsGrant?: boolean
}

// ── 高层封装：检查→下载→安装 ──────────────────────────────────

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
    const vc = m.apk.versionCode
    // 下载文件按 versionCode 隔离，没有它原生就无法区分新旧包——宁可报错也不下载
    if (vc == null || !Number.isInteger(vc) || vc <= 0) {
      return { state: 'error', error: '更新信息缺少版本号，请先升级电脑端' }
    }
    if (vc <= cur.versionCode) return { state: 'latest' }
    return {
      state: 'found',
      version: m.apk.version,
      versionCode: vc,
      // 带上版本号：下载地址随版本变化，中间缓存不会交出旧包
      url: `${base}/api/mobile/apk?vc=${vc}`,
      size: m.apk.size
    }
  } catch (e) {
    return { state: 'error', error: e instanceof Error ? e.message : String(e) }
  }
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
 * expectedSize 是服务端声明的字节数，原生下载完会比对。
 */
export async function startDownload(
  url: string,
  versionCode: number,
  expectedSize = 0
): Promise<void> {
  const plugin = apkUpdater()
  if (!plugin) throw new Error('仅 APP 内可用')
  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    throw new Error('更新信息缺少版本号，请先升级电脑端')
  }
  await plugin.download({ url, versionCode, expectedSize })
}

/** 调起系统安装器（API 26+ 未授权时跳授权页，返回 needsGrant）；versionCode 指定装哪个文件 */
export async function installUpdate(versionCode: number): Promise<InstallResult> {
  const plugin = apkUpdater()
  if (!plugin) return {}
  const r = await plugin.install({ versionCode })
  return r ?? {}
}
