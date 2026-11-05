import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { getPort, setPassword } from './config.js'
import { dataDir, ensureDataDir } from './paths.js'
import { lanAddresses } from './server.js'

/**
 * 连接引导：二维码 PNG（nm://connect?host=…，M3 手机扫码自动填充）+ 首次运行密码文件。
 */

export function randomPassword(len = 8): string {
  // 去混淆字符集（无 0/O/1/I/l）
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += chars[bytes[i]! % chars.length]
  return out
}

export function connectHost(): { host: string; port: number } {
  const { primary, tailscale } = lanAddresses()
  return { host: tailscale ?? primary ?? '127.0.0.1', port: getPort() }
}

export async function writeConnectQr(): Promise<string> {
  const { host, port } = connectHost()
  const payload = `nm://connect?host=${host}:${port}`
  const file = join(ensureDataDir(), 'connect-qr.png')
  await QRCode.toFile(file, payload, { width: 480, margin: 2 })
  return file
}

/** 用系统默认程序打开文件（图片查看器/记事本） */
export function openWithSystem(file: string): void {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', file], {
      detached: true,
      stdio: 'ignore',
      shell: false
    }).unref()
  } else if (process.platform === 'darwin') {
    spawn('open', [file], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref()
  }
}

/** 首次运行引导：写 first-run.txt（密码+连接步骤）并打开记事本，返回生成的密码 */
export function firstRunInit(): string {
  const password = randomPassword()
  const { host, port } = connectHost()
  setPassword(password)
  const file = join(dataDir(), 'first-run.txt')
  writeFileSync(
    file,
    [
      '《手机小说工坊》首次启动',
      '',
      `访问密码：${password}`,
      '',
      '手机连接步骤：',
      '1. 手机安装 NovelMaker.apk（之后可从 APP 内检查更新）',
      `2. 连接页填地址：http://${host}:${port}`,
      `3. 输入上面的访问密码`,
      '',
      `本文件位于：${file}`,
      '密码可随时在托盘菜单「重置访问密码」重新生成，或在 APP 设置页修改。'
    ].join('\n'),
    'utf-8'
  )
  openWithSystem(file)
  return password
}
