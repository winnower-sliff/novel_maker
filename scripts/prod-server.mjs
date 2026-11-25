// 生产 server 定位（deploy / build-apk / pack-mobile 共用）：
// 「数据目录在哪、从哪个端口起、现在谁在应答」必须只有一个答案，否则会出现
// 「A 脚本认为没在跑、B 脚本却在跟它通信」这类互相矛盾的判断。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_PORT = 3910
/** 起始端口被占时 server.ts 的 tryListen 逐个往后试的次数 */
export const PORT_RETRIES = 10

export function argValue(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/** 与 src/main/paths.ts dataDir() 一致，外加脚本可用的 --data-dir 覆盖 */
export function resolveDataDir(args = process.argv.slice(2)) {
  const explicit = argValue(args, '--data-dir')
  if (explicit) return explicit
  if (process.env.NM_DATA_DIR) return process.env.NM_DATA_DIR
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'novel-maker-v2')
  }
  return join(homedir(), '.novel-maker-v2')
}

/** 起始端口：与 server 同源——settings.json 的 server.port，没配过则 3910 */
export function readBasePort(dataDir) {
  try {
    const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'))
    if (settings?.server?.port) return settings.server.port
  } catch {
    /* 首次部署无 settings.json */
  }
  return DEFAULT_PORT
}

/** server 可能监听的全部端口：起始端口起连续 PORT_RETRIES + 1 个 */
export function candidatePorts(base) {
  return Array.from({ length: PORT_RETRIES + 1 }, (_, i) => base + i)
}

/**
 * 探测一个端口的 /api/health；没人应答返回 null。
 * 「连接被拒」说明端口上确实没人。别的失败要再问一次：服务进程刚被替换时，fetch 可能复用了
 * 池里那条连着旧进程的长连接，这一次请求必然落空（实测于 spawnSync 阻塞之后紧跟的请求）。
 */
export async function probeHealth(port, timeoutMs = 2000) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(timeoutMs)
      })
      return res.ok ? await res.json() : null
    } catch (err) {
      if (attempt >= 1 || err?.cause?.code === 'ECONNREFUSED') return null
      await new Promise((r) => setTimeout(r, 150))
    }
  }
}

/** 依次探测候选端口，返回首个应答的 { port, health }；都没应答返回 null */
export async function findProdServer(dataDir) {
  for (const port of candidatePorts(readBasePort(dataDir))) {
    const health = await probeHealth(port)
    if (health) return { port, health }
  }
  return null
}

/** 记录生产 server 信息的文件（都在数据目录下）：PID 与运行它的 checkout */
export function serverPidFile(dataDir) {
  return join(dataDir, 'server.pid')
}

export function serverCheckoutFile(dataDir) {
  return join(dataDir, 'server.checkout')
}
