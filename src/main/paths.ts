import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 数据目录：所有用户数据（settings.json / sessions.json / usage_log.jsonl / data/novel.db）的根。
 * - Windows 默认 %APPDATA%/novel-maker-v2，其他平台 ~/.novel-maker-v2
 *   （与 v1 Electron userData 目录隔离：v1 settings 含 safeStorage 密文与旧 schema，混读必炸）
 * - 环境变量 NM_DATA_DIR 可覆盖（开发/测试隔离用，避免污染真实数据）
 */
export function dataDir(): string {
  if (process.env.NM_DATA_DIR) return process.env.NM_DATA_DIR
  const appData = process.env.APPDATA
  if (process.platform === 'win32' && appData) return join(appData, 'novel-maker-v2')
  return join(homedir(), '.novel-maker-v2')
}

export function ensureDataDir(): string {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 静态资源目录（tray.png 等）：dev 与编译产物布局一致（<root>/resources） */
export function resourcesDir(): string {
  return join(import.meta.dirname, '..', '..', 'resources')
}
