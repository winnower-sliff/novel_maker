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

function readInfo(): BuildInfo | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BuildInfo
  } catch {
    return null
  }
}

/** 本进程启动时加载的那一份构建（模块加载时读一次）；tsx 开发模式没有构建产物，为 null */
const loaded = readInfo()

/**
 * 这个进程实际运行的构建。tsx 开发模式没有构建产物，返回 null（调用方回退读 package.json）。
 *
 * 不能每次都直接照文件上报：dist/build-info.json 会被后来的构建改写（npm test / verify / apk
 * 都会重新 build），旧进程若照文件上报，deploy --if-stale 会把「文件已是新的」当成「进程已是
 * 新的」而跳过部署——生产就带着旧代码给新 APK 提供服务。文件与加载时一致（只是出包后回填了
 * 版本号）才用文件里的，否则如实报加载时那一份。
 */
export function buildInfo(): BuildInfo | null {
  const current = readInfo()
  if (!current || !loaded) return current ?? loaded
  return current.sourceHash === loaded.sourceHash ? current : loaded
}
