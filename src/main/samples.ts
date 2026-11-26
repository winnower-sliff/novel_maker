import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SampleFileInfo } from '../shared/types.js'
import { dataDir } from './paths.js'

/**
 * 范文导入源目录：数据目录/imports/。
 * 用户把完整 txt 放进来，在手机「范文」页的「从电脑导入」里点导入即全文入库（samples 表），
 * agent 写作时经 read_sample 工具按需节选翻阅。手机端直接选 txt 的上传也用这里的解码。
 */

/** 列待导入文件时只读文件头这么多字节做预览（整本几十万字，不能每个都全文读） */
const PREVIEW_BYTES = 1024

export function importsDir(): string {
  return join(dataDir(), 'imports')
}

/** 没带 BOM 的 UTF-16，只在开头这么多字节里找线索（一部小说的头几页必有换行） */
const UTF16_PROBE_BYTES = 64 * 1024

export type SampleEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'

/** 字节序整体对调（UTF-16 BE 当 LE 读）；长度为奇数时丢掉末尾半个字符 */
function swap16(b: Buffer): Buffer {
  const out = Buffer.from(b.subarray(0, b.length - (b.length % 2)))
  out.swap16()
  return out
}

/** 解出来的字符像不像中文小说正文：汉字、中文标点、全角符号、普通西文与换行 */
function isTextChar(code: number): boolean {
  return (
    (code >= 0x20 && code <= 0x7e) ||
    code === 0x0a ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  )
}

/**
 * 没带 BOM 的 UTF-16（部分下载站会去掉 BOM）：两种字节序各解开头一段，谁解出来更像中文正文就用谁；
 * 两种都不像就不认，交给 GB18030 兜底。
 * 前提是字节里有 NUL——GBK / UTF-8 的正文字节里不会出现它，ASCII 字符在 UTF-16 里则必带一个 0。
 */
function guessUtf16NoBom(bytes: Buffer): { text: string; encoding: SampleEncoding } | null {
  if (!bytes.subarray(0, UTF16_PROBE_BYTES).includes(0)) return null
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2))
  const head = even.subarray(0, 8192)
  const score = (b: Buffer): number => {
    const s = b.toString('utf16le')
    let good = 0
    for (let i = 0; i < s.length; i++) if (isTextChar(s.charCodeAt(i))) good++
    return s.length === 0 ? 0 : good / s.length
  }
  const le = score(head)
  const be = score(swap16(head))
  if (Math.max(le, be) < 0.6) return null
  if (le >= be) return { text: even.toString('utf16le'), encoding: 'utf-16le' }
  return { text: swap16(even).toString('utf16le'), encoding: 'utf-16be' }
}

/**
 * 自动识别编码并解码 txt 字节：先看 BOM（UTF-8 / UTF-16 LE / BE），再严格试 UTF-8，
 * 都不是就按 GB18030 兜底（Node 自带完整 ICU，向下兼容 GBK / GB2312）。
 * 严格 UTF-8 解出来却夹着 NUL 的，按没带 BOM 的 UTF-16 再认一次（见 guessUtf16NoBom）。
 */
export function decodeSampleBytes(bytes: Buffer): { text: string; encoding: SampleEncoding } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf-16le' }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: swap16(bytes.subarray(2)).toString('utf16le'), encoding: 'utf-16be' }
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf-8' }
  }
  let strict: string | null = null
  try {
    strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // 不是 UTF-8
  }
  if (strict !== null && !strict.includes('\u0000')) return { text: strict, encoding: 'utf-8' }
  return (
    guessUtf16NoBom(bytes) ?? {
      text: new TextDecoder('gb18030').decode(bytes),
      encoding: 'gb18030'
    }
  )
}

/**
 * 只读文件头做预览。读满一刀时末尾可能截在半个字符上：去掉最后 3 字节再判编码，免得把 UTF-8 误判成 GBK；
 * 整个文件都读完了（小文件）就不必削。
 */
function headPreview(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(PREVIEW_BYTES)
    const n = readSync(fd, buf, 0, PREVIEW_BYTES, 0)
    return decodeSampleBytes(buf.subarray(0, n >= PREVIEW_BYTES ? n - 3 : n)).text
  } finally {
    closeSync(fd)
  }
}

/** 列 imports 目录下可导入的 txt 文件（含预览；只 stat + 读文件头，不读全文） */
export function listImportFiles(): SampleFileInfo[] {
  let names: string[] = []
  try {
    names = readdirSync(importsDir())
  } catch {
    return []
  }
  const out: SampleFileInfo[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.txt')) continue
    const file = join(importsDir(), name)
    try {
      const stat = statSync(file)
      if (!stat.isFile()) continue
      out.push({ fileName: name, sizeBytes: stat.size, preview: headPreview(file).slice(0, 120) })
    } catch {
      // 单文件读取失败（权限）跳过，不阻断列表
    }
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName))
}

/** 读 imports 目录某文件全文（文件名必须来自 listImportFiles，防路径穿越）；编码自动识别 */
export function readImportFile(fileName: string): string {
  const safe = basename(fileName)
  if (safe !== fileName) throw new Error('非法文件名')
  return decodeSampleBytes(readFileSync(join(importsDir(), safe))).text
}
