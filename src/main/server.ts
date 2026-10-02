import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { app } from 'electron'
import { invokeContract } from '../shared/contract'
import type { ExportFormat } from '../shared/types'
import type { EventSink } from './eventSink'
import { buildExport } from './export'
import { sharedHandlers } from './handlers'
import { addSession, hasSession, removeSession } from './serverSessions'
import { setServerStatus } from './serverState'
import { loadServerConfig, verifyPassword } from './settings'

const MAX_BODY = 64 * 1024 * 1024
const LOGIN_WINDOW_MS = 5 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
// 会话永久有效（改密码时全作废），cookie Max-Age 给 10 年
const COOKIE_MAX_AGE_S = 315360000
const SESSION_COOKIE = 'nm_session'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>()

let server: Server | null = null
let activePort = 0
const sseClients = new Map<number, ServerResponse>()
let sseSeq = 0

function addressScore(ip: string): number {
  if (/^192\.168\./.test(ip)) return 0
  if (/^10\./.test(ip)) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  if (/^169\.254\./.test(ip)) return 90
  // 100.64.0.0/10 为运营商级 NAT，常见于 Tailscale 等虚拟网卡，手机通常不可达
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 80
  return 50
}

/** 物理网卡（Wi-Fi/以太网）优先，虚拟网卡（VMware/Hyper-V/Tailscale 等）靠后。 */
function interfaceScore(name: string): number {
  if (
    /vmware|virtualbox|vethernet|hyper-v|tailscale|zerotier|loopback|tun\b|tap\b|wsl/i.test(name)
  ) {
    return 20
  }
  if (/wi-?fi|wlan|wireless|ethernet|以太网|无线/i.test(name)) return 0
  return 5
}

function lanAddress(): string | null {
  const candidates: Array<{ ip: string; score: number }> = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        candidates.push({ ip: ni.address, score: interfaceScore(name) + addressScore(ni.address) })
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score)
  return candidates[0]?.ip ?? null
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  const header = req.headers.cookie
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim())
    } catch {
      out[key] = part.slice(idx + 1).trim()
    }
  }
  return out
}

function isAuthed(req: IncomingMessage): boolean {
  const config = loadServerConfig()
  if (!config.passwordHash) return isLoopback(req)
  // APK WebView 源与服务器跨站，SameSite cookie 不可用，移动端改用 token header/query
  const token = parseCookies(req)[SESSION_COOKIE] ?? reqToken(req)
  if (!token) return false
  return hasSession(token)
}

function reqToken(req: IncomingMessage): string | null {
  const header = req.headers['x-nm-token']
  if (typeof header === 'string' && header) return header
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token')
  return query ?? null
}

function mobileRoot(): string {
  return join(app.getPath('userData'), 'mobile')
}

interface MobileManifest {
  version: string
  buildAt: string
  apk?: { version: string; path: string; size: number }
  files: Array<{ path: string; hash: string; size: number }>
}

function readMobileManifest(): MobileManifest | null {
  try {
    const raw = readFileSync(join(mobileRoot(), 'manifest.json'), 'utf-8')
    const parsed = JSON.parse(raw) as MobileManifest
    if (!parsed?.version || !Array.isArray(parsed.files)) return null
    return parsed
  } catch {
    return null
  }
}

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

function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Novel Maker · 登录</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #09090b; color: #e4e4e7; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  form { width: min(360px, 88vw); background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 28px 24px; }
  h1 { margin: 0 0 6px; font-size: 18px; }
  p { margin: 0 0 18px; font-size: 13px; color: #a1a1aa; line-height: 1.6; }
  input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #3f3f46; background: #09090b;
    color: #e4e4e7; font-size: 16px; }
  button { width: 100%; margin-top: 14px; padding: 10px; border: 0; border-radius: 8px; background: #d97706;
    color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  .err { margin-top: 12px; font-size: 12px; color: #f87171; }
</style>
</head>
<body>
<form method="post" action="/api/login">
  <h1>Novel Maker</h1>
  <p>请输入桌面端「设置 · 手机访问」中配置的访问密码。</p>
  <input type="password" name="password" placeholder="访问密码" autofocus required />
  <button type="submit">进入</button>
  ${error ? `<div class="err">${error}</div>` : ''}
</form>
</body>
</html>`
}

function serveLogin(res: ServerResponse, error?: string, status = 200): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'"
  })
  res.end(loginPage(error))
}

function rendererDir(): string {
  return join(__dirname, '../renderer')
}

function safeResolve(root: string, pathname: string): string | null {
  const rel = normalize(pathname).replace(/^([/\\])+/, '')
  const full = resolve(root, rel)
  return full.startsWith(resolve(root)) ? full : null
}

function serveStatic(res: ServerResponse, pathname: string): boolean {
  const root = rendererDir()
  let target = safeResolve(root, pathname === '/' ? 'index.html' : pathname)
  if (!target) return false
  if (!existsSync(target) || statSync(target).isDirectory()) {
    const index = join(root, 'index.html')
    if (!existsSync(index)) return false
    target = index
  }
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' })
  createReadStream(target).pipe(res)
  return true
}

function proxyDev(req: IncomingMessage, res: ServerResponse, target: string): void {
  const u = new URL(target)
  const proxyReq = httpRequest(
    {
      hostname: u.hostname,
      port: u.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: u.host }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    }
  )
  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('开发服务器不可用，请确认 electron-vite dev 正在运行')
  })
  req.pipe(proxyReq)
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const record = loginAttempts.get(ip)
  if (record && record.resetAt > now && record.count >= LOGIN_MAX_ATTEMPTS) {
    serveLogin(res, '尝试次数过多，请稍后再试', 429)
    return
  }
  const raw = await readRawBody(req, 4096)
  const params = new URLSearchParams(raw)
  const password = params.get('password') ?? ''
  const config = loadServerConfig()
  if (!config.passwordHash) {
    serveLogin(res, '服务器尚未设置访问密码，请在桌面端设置后再试', 403)
    return
  }
  if (!verifyPassword(password, config.passwordSalt, config.passwordHash)) {
    const next =
      record && record.resetAt > now
        ? { count: record.count + 1, resetAt: record.resetAt }
        : { count: 1, resetAt: now + LOGIN_WINDOW_MS }
    loginAttempts.set(ip, next)
    serveLogin(res, '密码错误', 401)
    return
  }
  loginAttempts.delete(ip)
  const token = randomBytes(32).toString('hex')
  addSession(token)
  res.writeHead(302, {
    location: '/',
    'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`
  })
  res.end()
}

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
    // handler 契约：第二参是契约元组（ArgsOf<C>），由调用方解构，不能 spread
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

async function handleExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthed(req)) {
    json(res, 401, { error: '未登录' }, req)
    return
  }
  try {
    const opts = (await readJsonBody(req)) as {
      projectId: string
      format: ExportFormat
      scope: 'all' | 'single'
      outlineId?: string
    }
    const built = await buildExport(opts)
    const encoded = encodeURIComponent(built.filename)
    res.writeHead(200, {
      'content-type': built.mime,
      'content-length': built.data.length,
      'x-words': String(built.words),
      'content-disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
      ...corsHeaders(req)
    })
    res.end(built.data)
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
  const body = (await readJsonBody(req)) as { password?: string } | null
  const password = typeof body?.password === 'string' ? body.password : ''
  const config = loadServerConfig()
  if (!config.passwordHash) {
    json(res, 403, { error: '服务器尚未设置访问密码，请在桌面端设置后再试' }, req)
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
  addSession(token)
  json(res, 200, { token }, req)
}

async function handleMobileVersion(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

function handleMobileFile(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!isAuthed(req)) {
    json(res, 401, { error: '未登录' }, req)
    return
  }
  const manifest = readMobileManifest()
  const rel = url.searchParams.get('path') ?? ''
  const entry = manifest?.files.find((f) => f.path === rel)
  if (!manifest || !entry) {
    json(res, 404, { error: '文件不存在' }, req)
    return
  }
  const full = join(mobileRoot(), 'files', normalize(entry.path))
  if (!full.startsWith(resolve(join(mobileRoot(), 'files'))) || !existsSync(full)) {
    json(res, 404, { error: '文件不存在' }, req)
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
    'content-length': statSync(full).size,
    etag: `"${entry.hash}"`,
    'x-content-type-options': 'nosniff',
    ...corsHeaders(req)
  })
  createReadStream(full).pipe(res)
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-max-age': '86400', ...corsHeaders(req) })
    res.end()
    return
  }
  if (path === '/api/login' && req.method === 'POST') return handleLogin(req, res)
  if (path === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req)[SESSION_COOKIE]
    if (token) removeSession(token)
    res.writeHead(302, {
      location: '/login',
      'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    })
    res.end()
    return
  }
  if (path === '/api/session') {
    json(res, 200, { authenticated: isAuthed(req) })
    return
  }
  if (path === '/api/events' && req.method === 'GET') return handleEvents(req, res)
  if (path === '/api/export' && req.method === 'POST') return handleExport(req, res)
  if (path === '/api/mobile/auth' && req.method === 'POST') return handleMobileAuth(req, res)
  if (path === '/api/mobile/version' && req.method === 'GET') return handleMobileVersion(req, res)
  if (path === '/api/mobile/file' && req.method === 'GET') return handleMobileFile(req, res, url)
  if (path.startsWith('/api/invoke/') && req.method === 'POST') {
    return handleInvoke(req, res, decodeURIComponent(path.slice('/api/invoke/'.length)))
  }
  json(res, 404, { error: '接口不存在' })
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname
    if (pathname.startsWith('/api/')) return handleApi(req, res, url)

    if (req.method === 'GET') {
      if (pathname === '/login') return serveLogin(res)
      if (!isAuthed(req) && pathname === '/') {
        res.writeHead(302, { location: '/login' })
        res.end()
        return
      }
      if (!isAuthed(req) && extname(pathname) === '') {
        res.writeHead(302, { location: '/login' })
        res.end()
        return
      }
      const devTarget = process.env.ELECTRON_RENDERER_URL
      if (devTarget) return proxyDev(req, res, devTarget)
      if (serveStatic(res, pathname)) return
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('未找到资源')
      return
    }
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Method Not Allowed')
  })().catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end((err as Error)?.message ?? '服务器内部错误')
  })
}

function handleUpgrade(
  req: IncomingMessage,
  socket: import('node:net').Socket,
  head: Buffer
): void {
  const devTarget = process.env.ELECTRON_RENDERER_URL
  if (!devTarget) {
    socket.destroy()
    return
  }
  const target = new URL(devTarget)
  const upstream = connect(Number(target.port) || 80, target.hostname, () => {
    const headers = { ...req.headers, host: target.host }
    const headerLines = Object.entries(headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n')
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
}

export async function startServer(): Promise<void> {
  if (server) return
  const config = loadServerConfig()
  const lanIp = lanAddress()
  if (!config.enabled) {
    setServerStatus({
      enabled: false,
      running: false,
      port: config.port,
      url: null,
      lanReachable: !!lanIp,
      hasPassword: !!config.passwordHash,
      clients: 0,
      error: null
    })
    return
  }

  const tryListen = (port: number, remaining: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const s = createServer(handleRequest)
      s.on('upgrade', handleUpgrade)
      s.once('error', (err: NodeJS.ErrnoException) => {
        s.removeAllListeners()
        if (err.code === 'EADDRINUSE' && remaining > 0) {
          resolve(tryListen(port + 1, remaining - 1))
        } else {
          reject(err)
        }
      })
      s.listen(port, '0.0.0.0', () => {
        server = s
        resolve(port)
      })
    })

  try {
    activePort = await tryListen(config.port, 10)
    setServerStatus({
      enabled: true,
      running: true,
      port: activePort,
      url: lanIp ? `http://${lanIp}:${activePort}` : `http://localhost:${activePort}`,
      lanReachable: !!lanIp,
      hasPassword: !!config.passwordHash,
      clients: sseClients.size,
      error: null
    })
  } catch (err) {
    activePort = 0
    setServerStatus({
      enabled: true,
      running: false,
      port: config.port,
      url: null,
      lanReachable: !!lanIp,
      hasPassword: !!config.passwordHash,
      clients: 0,
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
  await new Promise<void>((resolve) => {
    current.close(() => resolve())
    // 强制关闭 keep-alive 连接，避免重启时被空闲连接阻塞
    current.closeAllConnections?.()
  })
  setServerStatus({
    running: false,
    url: null,
    clients: 0
  })
}

export async function restartServer(): Promise<void> {
  await stopServer()
  await startServer()
}
