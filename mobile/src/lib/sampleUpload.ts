import { SAMPLE_UPLOAD } from '@shared/contract'
import type { SampleImportResult } from '@shared/types'

/** 作者点了「取消」：不算失败，界面不报错 */
export class UploadCancelled extends Error {
  constructor() {
    super('已取消导入')
    this.name = 'UploadCancelled'
  }
}

/** 整本文件的大小上限（字节）= 单片上限 × 最多片数 */
export const SAMPLE_UPLOAD_MAX_BYTES = SAMPLE_UPLOAD.chunkBytes * SAMPLE_UPLOAD.maxChunks

/**
 * 字节 → base64。分块拼：一次 String.fromCharCode 展开上百万个参数会栈溢出，
 * 所以每 32KB 转一段二进制字符串，拼起来再整体 btoa。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const STEP = 0x8000
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += STEP) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + STEP)))
  }
  return btoa(parts.join(''))
}

/**
 * 手机端直接选 txt 导入：文件按片读、按片传，电脑端拼回全文再解码入库。
 * 全程只把当前这一片读进内存，几十 MB 的 txt 也不会把手机卡死。
 * isCancelled：作者点了取消时返回 true，下一片不再上传并通知电脑端丢掉半截数据。
 */
export async function uploadSampleText(
  file: File,
  onProgress: (sent: number, total: number) => void,
  isCancelled: () => boolean = () => false
): Promise<SampleImportResult> {
  if (file.size === 0) throw new Error('这个 txt 是空的，没有可以导入的文字')
  const total = Math.ceil(file.size / SAMPLE_UPLOAD.chunkBytes)
  if (total > SAMPLE_UPLOAD.maxChunks) {
    throw new Error(`文件太大（超过 ${SAMPLE_UPLOAD_MAX_BYTES / 1048576} MB），请拆成几本再导入`)
  }
  const { uploadId } = await window.api.sample.uploadBegin(file.name.slice(0, 120), total)
  try {
    let sent = 0
    while (sent < total) {
      if (isCancelled()) throw new UploadCancelled()
      const bytes = await file
        .slice(sent * SAMPLE_UPLOAD.chunkBytes, (sent + 1) * SAMPLE_UPLOAD.chunkBytes)
        .arrayBuffer()
      sent = (
        await window.api.sample.uploadChunk(uploadId, sent, bytesToBase64(new Uint8Array(bytes)))
      ).received
      onProgress(sent, total)
    }
    if (isCancelled()) throw new UploadCancelled()
    return await window.api.sample.uploadFinish(uploadId)
  } catch (e) {
    // 半截上传留在电脑端只会占内存：尽力收掉（收不掉的由电脑端按超时清理），再报真正的错
    await window.api.sample.uploadAbort(uploadId).catch(() => {})
    throw e
  }
}
