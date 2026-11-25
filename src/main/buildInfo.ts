// 构建指纹：dist/build-info.json 由 scripts/build-info.mjs 在 tsc 之后写入（版本 / commit / 构建时间 / 主进程源码哈希）。
// /api/health 原样返回，deploy 探测后比对——确认应答的就是本次构建。
import { existsSync, readFileSync } from 'node:fs'

export interface BuildInfo {
  version: string
  commit: string
  builtAt: string
  sourceHash: string
}

const file = new URL('../build-info.json', import.meta.url)

/** tsx 开发模式没有构建产物，返回 null（调用方回退读 package.json） */
export function buildInfo(): BuildInfo | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BuildInfo
  } catch {
    return null
  }
}
