import { registerPlugin } from '@capacitor/core'
import { useConnStore } from './conn'

/**
 * 导出原生桥（仅 APK）：SAF ACTION_CREATE_DOCUMENT 系统保存器选位置，
 * JS 拿 content uri 后写 base64 内容。纯浏览器无此能力（返回 null 桥）。
 */
interface ExportPlugin {
  presentCreateDocument(opts: { fileName: string; mimeType?: string }): Promise<{ uri: string }>
  writeFileToUri(opts: { uri: string; base64: string }): Promise<void>
}

const plugin = registerPlugin<ExportPlugin>('ExportPlugin')

function bridge(): ExportPlugin | null {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return cap?.isNativePlatform?.() ? plugin : null
}

/**
 * 全书导出：server 拉当前线全章 zip → 系统保存器选位置（预填 书名.zip）→ 写入。
 * 用户在保存器点取消时 reject('cancelled')，调用方静默即可。
 */
export async function exportBookZip(bookId: string, title: string): Promise<void> {
  const p = bridge()
  if (!p) throw new Error('仅手机 APP 支持导出到本地')
  const base = useConnStore.getState().conn?.baseUrl
  if (!base) throw new Error('未连接服务器')
  const r = await fetch(`${base}/api/export/${encodeURIComponent(bookId)}`)
  if (!r.ok) {
    const err = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `导出失败（${r.status}）`)
  }
  const bytes = new Uint8Array(await r.arrayBuffer())
  // 分块转 base64：大书避免 String.fromCharCode 参数上限
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const { uri } = await p.presentCreateDocument({ fileName: `${(title || '未命名').trim()}.zip` })
  await p.writeFileToUri({ uri, base64: btoa(bin) })
}
