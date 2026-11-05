import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/**
 * Windows 开机自启：HKCU Run 键（仅当前用户，无需管理员）。
 * 命令指向 node + 编译产物入口；dev（tsx）环境下调用会被拒绝。
 */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'NovelMaker'

function entryScript(): string | null {
  const arg = process.argv[1]
  if (!arg) return null
  // 仅编译产物形态支持自启（tsx watch 等开发形态不行）
  if (!/dist[\\/]main[\\/]index\.js$/.test(arg.replace(/\\/g, '/'))) return null
  return arg
}

export function autostartSupported(): boolean {
  return process.platform === 'win32' && entryScript() !== null
}

export async function autostartEnabled(): Promise<boolean> {
  if (!autostartSupported()) return false
  try {
    const { stdout } = await execFileP('reg', ['query', RUN_KEY, '/v', VALUE_NAME])
    return stdout.includes(VALUE_NAME)
  } catch {
    return false
  }
}

export async function setAutostart(enable: boolean): Promise<boolean> {
  if (!autostartSupported()) return false
  const script = entryScript()
  if (!script) return false
  if (enable) {
    const command = `"${process.execPath}" "${script}"`
    await execFileP('reg', ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'])
  } else {
    await execFileP('reg', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'])
  }
  return autostartEnabled()
}
