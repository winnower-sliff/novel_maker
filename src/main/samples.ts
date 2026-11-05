import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SampleFileInfo } from '../shared/types.js'
import { dataDir } from './paths.js'

/**
 * 范文导入源目录：数据目录/imports/。
 * 用户把完整 txt 放进来，APP「设置 → 范文库」点导入即全文入库（samples 表），
 * agent 写作时经 read_sample 工具按需节选翻阅。
 */

export function importsDir(): string {
  return join(dataDir(), 'imports')
}

/** 列 imports 目录下可导入的 txt 文件（含预览） */
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
      const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      out.push({
        fileName: name,
        sizeBytes: stat.size,
        chars: text.length,
        preview: text.slice(0, 120)
      })
    } catch {
      // 单文件读取失败（编码/权限）跳过，不阻断列表
    }
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName))
}

/** 读 imports 目录某文件全文（文件名必须来自 listImportFiles，防路径穿越） */
export function readImportFile(fileName: string): string {
  const safe = basename(fileName)
  if (safe !== fileName) throw new Error('非法文件名')
  return readFileSync(join(importsDir(), safe), 'utf8')
}
