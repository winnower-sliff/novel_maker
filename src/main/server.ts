import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import QRCode from 'qrcode'
import { invokeContract } from '../shared/contract.js'
import { setGlobalSink } from './broadcast.js'
import { loadServerConfig, verifyPassword } from './config.js'
import type { EventSink } from './eventSink.js'
import { appVersion, sharedHandlers } from './handlers/index.js'
import { dataDir } from './paths.js'
import { addSession, hasSession, removeSession } from './serverSessions.js'
import { getServerStatus, setServerStatus } from './serverState.js'

/**
 * v2 HTTP 服务：手机 APK 唯一入口（无浏览器/WebSocket）。
 * - 鉴权：x-nm-token header / ?token= query（APK WebView 跨站 cookie 不可用）；
 *   未设密码时仅 loopback 放行（首次引导前本机可测试）。
 * - /api/invoke/:channel（JSON-RPC）+ /api/events（SSE）+ /api/mobile/auth（密码换 token）。
 */

const MAX_BODY = 16 * 1024 * 1024
const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive'
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>()

let server: Server | null = null
let activePort = 0
const sseClients = new Map<number, ServerResponse>()
let sseSeq = 0

// ── 局域网地址选择（物理网卡优先，虚拟网卡靠后） ─────────────────────────────

function addressScore(ip: string): number {
  if (/^192\.168\./.test(ip)) return 0
  if (/^10\./.test(ip)) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  if (/^169\.254\./.test(ip)) return 90
  // 100.64.0.0/10 运营商级 NAT（Tailscale 等）：手机走 Tailscale 时可达，给中高分
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 3
  return 50
}

function interfaceScore(name: string): number {
  if (/vmware|virtualbox|vethernet|hyper-v|zerotier|loopback|tun\b|tap\b|wsl/i.test(name)) {
    return 20
  }
  // Tailscale 网卡名通常就是 Tailscale：主场景（手机经 Tailscale 访问）下不应过度降权
  if (/tailscale/i.test(name)) return 2
  if (/wi-?fi|wlan|wireless|ethernet|以太网|无线/i.test(name)) return 0
  return 5
}

/** 返回全部候选地址（按优先级排序）：主地址用物理网卡，Tailscale 地址单独提供 */
export function lanAddresses(): { primary: string | null; tailscale: string | null } {
  const candidates: Array<{ ip: string; score: number; name: string }> = []
  let tailscale: string | null = null
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        candidates.push({
          ip: ni.address,
          score: interfaceScore(name) + addressScore(ni.address),
          name
        })
        if (/tailscale/i.test(name)) tailscale = ni.address
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score)
  return { primary: candidates[0]?.ip ?? null, tailscale }
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

// ── 鉴权 ─────────────────────────────────────────────────────────────────────

function reqToken(req: IncomingMessage): string | null {
  const header = req.headers['x-nm-token']
  if (typeof header === 'string' && header) return header
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token')
  return query ?? null
}

function isAuthed(req: IncomingMessage): boolean {
  const config = loadServerConfig()
  if (!config.passwordHash) return isLoopback(req)
  const token = reqToken(req)
  if (!token) return false
  return hasSession(token)
}

// ── 响应工具 ─────────────────────────────────────────────────────────────────

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin
  const headers: Record<string, string> = {
    'access-control-allow-headers': 'content-type, x-nm-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers.vary = 'Origin'
    headers['access-control-allow-credentials'] = 'true'
  }
  return headers
}

function json(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void {
  const text = JSON.stringify(body ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(req ? corsHeaders(req) : {})
  })
  res.end(text)
}

function readRawBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req)
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

// ── SSE ──────────────────────────────────────────────────────────────────────

function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  if (!isAuthed(req)) {
    json(res, 401, { error: '未登录' }, req)
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...corsHeaders(req)
  })
  res.write(': connected\n\n')
  const id = ++sseSeq
  sseClients.set(id, res)
  setServerStatus({ clients: sseClients.size })
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 25_000)
  const cleanup = (): void => {
    clearInterval(heartbeat)
    sseClients.delete(id)
    setServerStatus({ clients: sseClients.size })
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
  res.on('error', cleanup)
}

function broadcast(channel: string, requestId: string, ...args: unknown[]): void {
  if (sseClients.size === 0) return
  const payload = `data: ${JSON.stringify({ channel, requestId, args })}\n\n`
  for (const client of sseClients.values()) {
    if (!client.writableEnded) client.write(payload)
  }
}

const webSink: EventSink = {
  send: broadcast,
  isClosed: (): boolean => false
}

// ── 业务端点 ─────────────────────────────────────────────────────────────────

async function handleInvoke(
  req: IncomingMessage,
  res: ServerResponse,
  channel: string
): Promise<void> {
  if (!isAuthed(req)) {
    json(res, 401, { error: '未登录' }, req)
    return
  }
  const contractEntry = invokeContract[channel as keyof typeof invokeContract]
  if (!contractEntry) {
    json(res, 404, { error: `未知接口: ${channel}` }, req)
    return
  }
  try {
    const body = (await readJsonBody(req)) as { args?: unknown[] } | undefined
    const rawArgs = Array.isArray(body?.args) ? body.args : []
    const parsed = contractEntry.args.safeParse(rawArgs)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path?.length ? `${issue.path.join('.')}: ` : ''
      json(res, 400, { error: `参数校验失败 ${where}${issue?.message ?? '格式不合法'}` }, req)
      return
    }
    const handler = sharedHandlers[channel as keyof typeof sharedHandlers]
    // handler 契约：第二参是契约元组（ArgsOf<C>），调用方解构，不能 spread（v1 坑 23）
    const result = await Promise.resolve(
      (handler as (ctx: { sink: EventSink }, a: unknown[]) => unknown)(
        { sink: webSink },
        parsed.data
      )
    )
    json(res, 200, { result }, req)
  } catch (err) {
    json(res, 400, { error: (err as Error)?.message ?? String(err) }, req)
  }
}

async function handleMobileAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const record = loginAttempts.get(ip)
  if (record && record.resetAt > now && record.count >= LOGIN_MAX_ATTEMPTS) {
    json(res, 429, { error: '尝试次数过多，请稍后再试' }, req)
    return
  }
  const body = (await readJsonBody(req)) as { password?: string; label?: string } | null
  const password = typeof body?.password === 'string' ? body.password : ''
  const config = loadServerConfig()
  if (!config.passwordHash) {
    if (!isLoopback(req)) {
      json(res, 403, { error: '服务器尚未设置访问密码，请在电脑托盘完成首次设置' }, req)
      return
    }
    // 本机未设密码时直接签发引导 token
    const token = randomBytes(32).toString('hex')
    addSession(token, '引导')
    json(res, 200, { token }, req)
    return
  }
  if (!verifyPassword(password, config.passwordSalt, config.passwordHash)) {
    const next =
      record && record.resetAt > now
        ? { count: record.count + 1, resetAt: record.resetAt }
        : { count: 1, resetAt: now + LOGIN_WINDOW_MS }
    loginAttempts.set(ip, next)
    json(res, 401, { error: '密码错误' }, req)
    return
  }
  loginAttempts.delete(ip)
  const token = randomBytes(32).toString('hex')
  addSession(token, typeof body?.label === 'string' ? body.label : undefined)
  json(res, 200, { token }, req)
}

// ── 二维码（连接引导，无敏感信息，不鉴权） ──────────────────────────────────

async function handleQr(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { primary, tailscale } = lanAddresses()
  const hostParam = url.searchParams.get('host')
  const host = hostParam || tailscale || primary || '127.0.0.1'
  const port = activePort || loadServerConfig().port
  const token = url.searchParams.get('token') // 可选：带上即为免密连接码
  const payload = token
    ? `nm://connect?host=${host}:${port}&token=${token}`
    : `nm://connect?host=${host}:${port}`
  const buf = await QRCode.toBuffer(payload, { width: 480, margin: 2 })
  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'x-nm-host': `${host}:${port}`,
    ...corsHeaders(req)
  })
  res.end(buf)
}

// ── mobile 部署产物（M5 APK 自更新用，先保留骨架） ───────────────────────────

interface MobileManifest {
  version: string
  buildAt: string
  apk?: { version: string; path: string; size: number; notes?: string[] }
  files: Array<{ path: string; hash: string; size: number }>
}

function readMobileManifest(): MobileManifest | null {
  try {
    const raw = readFileSync(join(dataDir(), 'mobile', 'manifest.json'), 'utf-8')
    const parsed = JSON.parse(raw) as MobileManifest
    if (!parsed?.version || !Array.isArray(parsed.files)) return null
    return parsed
  } catch {
    return null
  }
}

function handleMobileVersion(req: IncomingMessage, res: ServerResponse): void {
  if (!isAuthed(req)) {
    json(res, 401, { error: '未登录' }, req)
    return
  }
  const manifest = readMobileManifest()
  if (!manifest) {
    json(res, 200, { version: null, buildAt: null, files: [] }, req)
    return
  }
  json(res, 200, manifest, req)
}

function handleApkDownload(req: IncomingMessage, res: ServerResponse): void {
  if (!isAuthed(req)) {
    json(res, 401, { error: '未登录' }, req)
    return
  }
  const manifest = readMobileManifest()
  const apk = manifest?.apk
  if (!manifest || !apk) {
    json(res, 404, { error: '暂无 APK 产物' }, req)
    return
  }
  const root = resolve(join(dataDir(), 'mobile'))
  const full = resolve(root, normalize(apk.path.replace(/^([/\\])+/, '')))
  if (!full.startsWith(root) || !existsSync(full)) {
    json(res, 404, { error: 'APK 文件不存在' }, req)
    return
  }
  res.writeHead(200, {
    'content-type': MIME['.apk']!,
    'content-length': statSync(full).size,
    'x-content-type-options': 'nosniff',
    ...corsHeaders(req)
  })
  createReadStream(full).pipe(res)
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-max-age': '86400', ...corsHeaders(req) })
    res.end()
    return
  }
  if (path === '/api/health') {
    json(res, 200, { ok: true, version: appVersion(), authenticated: isAuthed(req) }, req)
    return
  }
  if (path === '/api/mobile/auth' && req.method === 'POST') return handleMobileAuth(req, res)
  if (path === '/api/events' && req.method === 'GET') return handleEvents(req, res)
  if (path === '/api/qr.png' && req.method === 'GET') return handleQr(req, res, url)
  if (path === '/api/mobile/version' && req.method === 'GET') return handleMobileVersion(req, res)
  if (path === '/api/mobile/apk' && req.method === 'GET') return handleApkDownload(req, res)
  if (path.startsWith('/api/invoke/') && req.method === 'POST') {
    return handleInvoke(req, res, decodeURIComponent(path.slice('/api/invoke/'.length)))
  }
  if (path === '/api/logout' && req.method === 'POST') {
    const token = reqToken(req)
    if (token) removeSession(token)
    json(res, 200, { ok: true }, req)
    return
  }
  json(res, 404, { error: '接口不存在' }, req)
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url)
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found（v2 无浏览器界面，请使用手机 APP）')
  })().catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end((err as Error)?.message ?? '服务器内部错误')
  })
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────

export async function startServer(): Promise<void> {
  if (server) return
  const config = loadServerConfig()
  const { primary, tailscale } = lanAddresses()
  // 串行队列等无请求上下文的场景也经 SSE 广播 job:update/job:delta
  setGlobalSink(webSink)

  const tryListen = (port: number, remaining: number): Promise<number> =>
    new Promise((resolveP, reject) => {
      const s = createServer(handleRequest)
      s.once('error', (err: NodeJS.ErrnoException) => {
        s.removeAllListeners()
        if (err.code === 'EADDRINUSE' && remaining > 0) {
          resolveP(tryListen(port + 1, remaining - 1))
        } else {
          reject(err)
        }
      })
      s.listen(port, '0.0.0.0', () => {
        server = s
        resolveP(port)
      })
    })

  try {
    activePort = await tryListen(config.port, 10)
    const displayIp = tailscale ?? primary
    setServerStatus({
      running: true,
      port: activePort,
      url: displayIp ? `http://${displayIp}:${activePort}` : `http://localhost:${activePort}`,
      lanReachable: !!primary || !!tailscale,
      hasPassword: !!config.passwordHash,
      clients: sseClients.size,
      version: appVersion(),
      error: null
    })
  } catch (err) {
    activePort = 0
    setServerStatus({
      running: false,
      port: config.port,
      url: null,
      lanReachable: !!primary || !!tailscale,
      hasPassword: !!config.passwordHash,
      clients: 0,
      version: appVersion(),
      error: (err as Error)?.message ?? String(err)
    })
  }
}

export async function stopServer(): Promise<void> {
  for (const client of sseClients.values()) client.end()
  sseClients.clear()
  const current = server
  server = null
  activePort = 0
  if (!current) return
  await new Promise<void>((resolveP) => {
    current.close(() => resolveP())
    // 强制关闭 keep-alive 连接，避免重启时被空闲连接阻塞（v1 坑）
    current.closeAllConnections?.()
  })
  setServerStatus({ running: false, url: null, clients: 0 })
}

export async function restartServer(): Promise<void> {
  await stopServer()
  await startServer()
}
