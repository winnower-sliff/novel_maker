import { randomUUID } from 'node:crypto'
import { SAMPLE_UPLOAD } from '../../shared/contract.js'
import type { SampleImportResult, SampleSearchHit } from '../../shared/types.js'
import { decodeSampleBytes, listImportFiles, readImportFile } from '../samples.js'
import {
  deleteSample,
  getSample,
  listSampleSections,
  listSamples,
  sampleExists,
  saveSample,
  updateBook
} from '../store.js'
import type { HandlerTable } from './types.js'

/** 单本范文入库上限（字符数）。超出说明放错了文件（如整站合集），拒绝并提示拆分 */
const MAX_SAMPLE_CHARS = 30_000_000

/** 两条导入通路（电脑端 imports 文件夹、手机端分片上传）的公共收尾：查上限 → 起个不撞名的书名 → 切节入库 */
function importSampleText(rawName: string, text: string): SampleImportResult {
  if (text.length > MAX_SAMPLE_CHARS) {
    throw new Error(
      `这个文件有 ${text.length.toLocaleString()} 字，超过单本范文上限（3000 万字）。请拆成几本再导入`
    )
  }
  if (!text.trim()) throw new Error('这个 txt 是空的，没有可以导入的文字')
  const wanted = rawName.trim() || '未命名范文'
  const saved = saveSample(wanted, text)
  return saved.name === wanted ? saved : { ...saved, originalName: wanted }
}

/** 文件名 → 范文书名：去掉路径与 .txt 后缀 */
function sampleNameOf(fileName: string): string {
  return (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.txt$/i, '')
}

// ── 手机端分片上传 ───────────────────────────────────────────────────────────
//
// 会话只放内存，重启即弃（手机端会收到「上传已失效」并提示重新导入）。
// 片必须按序传；某片的回执在路上丢了，手机端会重发同一片，这里按「已收到几片」应答让它续上。

/** 同时在传的会话上限；超过这么久没有新片的会话视为手机端已放弃 */
const MAX_PENDING_UPLOADS = 3
const PENDING_TTL_MS = 30 * 60_000
/** 标准 base64（4 字节对齐、最多两个 = 结尾） */
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

interface PendingUpload {
  fileName: string
  total: number
  chunks: Buffer[]
  bytes: number
  at: number
}

const pendingUploads = new Map<string, PendingUpload>()

/** 清掉过期的会话；满员时让最久没动静的让位——手机端断网 / 被杀不会来收尾，不能让残留的上传堵死新导入 */
function makeRoomForUpload(): void {
  const now = Date.now()
  for (const [id, u] of pendingUploads) {
    if (now - u.at > PENDING_TTL_MS) pendingUploads.delete(id)
  }
  while (pendingUploads.size >= MAX_PENDING_UPLOADS) {
    let oldest: string | null = null
    for (const [id, u] of pendingUploads) {
      if (oldest === null || u.at < (pendingUploads.get(oldest)?.at ?? now)) oldest = id
    }
    if (oldest === null) break
    pendingUploads.delete(oldest)
  }
}

function takeUpload(uploadId: string): PendingUpload {
  const u = pendingUploads.get(uploadId)
  if (!u) throw new Error('上传已失效，请重新导入')
  u.at = Date.now()
  return u
}

const sampleHandlers: Pick<
  HandlerTable,
  | 'sample:listDir'
  | 'sample:import'
  | 'sample:uploadBegin'
  | 'sample:uploadChunk'
  | 'sample:uploadFinish'
  | 'sample:uploadAbort'
  | 'sample:list'
  | 'sample:attach'
  | 'sample:delete'
  | 'sample:sections'
  | 'sample:readText'
  | 'sample:search'
> = {
  'sample:listDir': () => listImportFiles(),
  'sample:import': async (_ctx, [{ fileName, name }]) =>
    importSampleText(name || sampleNameOf(fileName), await readImportFile(fileName)),
  'sample:uploadBegin': (_ctx, [fileName, totalChunks]) => {
    makeRoomForUpload()
    const uploadId = randomUUID()
    pendingUploads.set(uploadId, {
      fileName,
      total: totalChunks,
      chunks: [],
      bytes: 0,
      at: Date.now()
    })
    return { uploadId }
  },
  'sample:uploadChunk': (_ctx, [uploadId, index, dataBase64]) => {
    const u = takeUpload(uploadId)
    const buf = B64_RE.test(dataBase64) ? Buffer.from(dataBase64, 'base64') : null
    if (!buf || buf.length === 0 || buf.length > SAMPLE_UPLOAD.chunkBytes) {
      pendingUploads.delete(uploadId)
      throw new Error('上传数据不完整，请重新导入')
    }
    if (index < u.chunks.length) return { received: u.chunks.length }
    if (index !== u.chunks.length) {
      pendingUploads.delete(uploadId)
      throw new Error('上传顺序不对，请重新导入')
    }
    u.chunks.push(buf)
    u.bytes += buf.length
    return { received: u.chunks.length }
  },
  'sample:uploadFinish': (_ctx, [uploadId]) => {
    const u = takeUpload(uploadId)
    pendingUploads.delete(uploadId)
    if (u.chunks.length !== u.total) {
      throw new Error(`文件没有传完（${u.chunks.length}/${u.total} 片），请重新导入`)
    }
    const { text } = decodeSampleBytes(Buffer.concat(u.chunks, u.bytes))
    return importSampleText(sampleNameOf(u.fileName), text)
  },
  'sample:uploadAbort': (_ctx, [uploadId]) => pendingUploads.delete(uploadId),
  'sample:list': () => listSamples(),
  /** 整组设置绑定（多本；空数组=全解绑）。sampleId 不存在时拒绝，防悬空 */
  'sample:attach': (_ctx, [bookId, sampleIds]) => {
    for (const id of sampleIds) {
      if (!sampleExists(id)) throw new Error(`范文不存在：${id}`)
    }
    const book = updateBook(bookId, { sampleSources: sampleIds })
    if (!book) throw new Error('书不存在')
    return book
  },
  'sample:delete': (_ctx, [sampleId]) => deleteSample(sampleId),
  'sample:sections': (_ctx, [sampleId]) => {
    if (!sampleExists(sampleId)) throw new Error('范文不存在')
    return listSampleSections(sampleId)
  },
  'sample:readText': (_ctx, [sampleId, from, size]) => {
    const s = getSample(sampleId)
    if (!s) throw new Error('范文不存在')
    const start = Math.max(0, Math.min(from, s.chars))
    const len = Math.max(200, Math.min(size, 10000))
    const text = s.content.slice(start, start + len)
    return { from: start, chars: text.length, text }
  },
  'sample:search': (_ctx, [sampleId, q]) => {
    const s = getSample(sampleId)
    if (!s) throw new Error('范文不存在')
    const query = q.trim()
    if (!query) return []
    const sections = listSampleSections(sampleId)
    const hits: SampleSearchHit[] = []
    // 章标题命中优先
    const byLabel = sections.find((x) => x.label.includes(query))
    if (byLabel) {
      hits.push({
        label: byLabel.label,
        index: byLabel.start,
        snippet: `章标题命中 · ${s.content.slice(byLabel.start, byLabel.start + 80)}…`
      })
    }
    // 正文位置命中，最多 20 条
    let idx = s.content.indexOf(query)
    while (idx >= 0 && hits.length < 20) {
      const sec = [...sections].reverse().find((x) => x.start <= idx && idx < x.end)
      hits.push({
        label: sec?.label ?? '（正文前部）',
        index: idx,
        snippet: `…${s.content.slice(Math.max(0, idx - 40), idx + query.length + 100)}…`
      })
      idx = s.content.indexOf(query, idx + query.length)
    }
    if (hits.length === 0) {
      // 宽松兜底：忽略大小写再找一轮
      const lower = s.content.toLowerCase()
      const lq = query.toLowerCase()
      let i2 = lower.indexOf(lq)
      while (i2 >= 0 && hits.length < 8) {
        hits.push({
          label: '（近义命中）',
          index: i2,
          snippet: `…${s.content.slice(Math.max(0, i2 - 40), i2 + query.length + 100)}…`
        })
        i2 = lower.indexOf(lq, i2 + lq.length)
      }
    }
    return hits
  }
}

export { sampleHandlers }
