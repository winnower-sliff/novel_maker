// 任务生命周期冒烟：启动即返回、串行不并发、取消真正中止、先来后到、重试、未知类型不堵队列、重启续跑。
// 自带慢桩（每次模型调用延迟 3 秒），不占公共桩端口 3923，无需真实 LLM key。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const PORT = 3985
const STUB_PORT = 3986
const BASE = `http://127.0.0.1:${PORT}`
const DELAY_MS = 3000
const DATA = mkdtempSync(join(tmpdir(), 'nm-jobs-smoke-'))
writeFileSync(
  join(DATA, 'settings.json'),
  JSON.stringify({
    server: { port: PORT },
    provider: 'custom',
    profiles: {
      custom: { baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, defaultModel: 'stub-model' }
    },
    apiKeys: { custom: 'stub-key' }
  })
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}

// ── 慢桩：记调用数、按任务标记记到达顺序、统计「应答前被客户端断开」 ──────────
const MARK_RE = /FIFO-[A-Z]|BOOT-Q/
const stub = { calls: 0, aborted: 0, order: [] }
const llm = createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }))
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    stub.calls += 1
    try {
      const msgs = JSON.parse(body).messages ?? []
      const task = [...msgs]
        .reverse()
        .find((m) => m.role === 'user' && typeof m.content === 'string')
      const mark = task?.content.match(MARK_RE)?.[0]
      if (mark) stub.order.push(mark)
    } catch {
      // 读不出标记不影响其余断言
    }
    let replied = false
    res.on('close', () => {
      if (!replied) stub.aborted += 1
    })
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return
      replied = true
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      res.write(
        `data: ${JSON.stringify({
          model: 'stub-model',
          choices: [{ delta: { content: '好的，收到。' } }]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          model: 'stub-model',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 5 }
        })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    }, DELAY_MS)
  })
})

const invoke = async (channel, ...args) => {
  const r = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args })
  })
  const body = await r.json()
  if (!r.ok) throw new Error(`${channel} ${r.status} ${JSON.stringify(body)}`)
  return body.result
}
const expectFail = async (name, channel, args, needle) => {
  const r = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args })
  })
  const body = await r.json().catch(() => ({}))
  ok(name, !r.ok && String(body.error ?? '').includes(needle))
}
const waitJob = async (id, pred, timeout = 20000) => {
  const t0 = Date.now()
  for (;;) {
    const j = await invoke('job:get', id)
    if (!j || pred(j) || Date.now() - t0 > timeout) return j
    await sleep(150)
  }
}
const runningCount = async () =>
  (await invoke('job:list')).filter((j) => j.state === 'running').length
const hasCard = async (bookId, jobId, step) =>
  (await invoke('message:list', bookId)).some(
    (m) => m.meta?.jobId === jobId && m.meta?.step === step
  )

let server = null
const startServer = async () => {
  server = spawn(process.execPath, ['dist/main/index.js'], {
    env: { ...process.env, NM_DATA_DIR: DATA },
    stdio: 'inherit'
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error('server 未就绪')
}
const stopServer = async () => {
  server.kill()
  server = null
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${BASE}/api/health`)
    } catch {
      return // 端口已释放
    }
    await sleep(250)
  }
  throw new Error('server 端口迟迟不释放')
}

try {
  llm.listen(STUB_PORT)
  await startServer()
  ok('服务就绪', true)

  const book = await invoke('book:create', { title: '队列测试书' })
  const db = new DatabaseSync(join(DATA, 'novel.db'))
  // 重启场景下草稿书会被清掉，先让这本书转正
  db.prepare('UPDATE books SET draft=0 WHERE id=?').run(book.id)
  const insertJob = db.prepare(
    'INSERT INTO jobs (id, book_id, line_id, kind, state, step, payload, error, chapter_id, watchdog_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  )

  // ①② 启动即返回；忙时排队
  const t0 = Date.now()
  const a = await invoke('job:startChat', book.id, '你好')
  const elapsed = Date.now() - t0
  ok(`① 启动即返回（${elapsed}ms < 1500ms）且已是运行中`, elapsed < 1500 && a.state === 'running')
  const b = await invoke('job:startChat', book.id, '第二条')
  ok('② 忙时排队（queued）', b.state === 'queued')
  for (let i = 0; i < 100 && stub.calls < 1; i++) await sleep(100) // 等第一个请求真的到了模型

  // ⑥ 运行中不能重试
  await expectFail('⑥ 运行中的任务不能重试', 'job:retry', [a.id], '只有失败/取消的任务可重试')

  // ③ 取消运行中的任务：真正中止模型请求，且不会被跑完的结果覆盖
  const ac = await invoke('job:cancel', a.id)
  ok('③ 取消后立即是 cancelled', ac.state === 'cancelled')
  const bd = await waitJob(b.id, (j) => j.state === 'done')
  ok('③ 排队的下一条照常完成', bd.state === 'done')
  const a2 = await invoke('job:get', a.id)
  ok('③ 已取消的任务没有被跑完的结果覆盖', a2.state === 'cancelled')
  ok('③ 时间轴留有取消卡', await hasCard(book.id, a.id, 'cancelled'))
  ok(`③ 模型请求被真正中止（桩侧断连 ${stub.aborted} 次）`, stub.aborted >= 1)

  // ⑥ 已结束/不存在的任务不能取消
  await expectFail('⑥ 已结束的任务不能取消', 'job:cancel', [a.id], '任务已结束，无法取消')
  await expectFail('⑥ 不存在的任务报错', 'job:cancel', ['no-such-job'], '不存在')

  // ④⑤ 先来后到、串行不并发；取消排队中的任务后它不会被执行
  const e = await invoke('job:startChat', book.id, 'FIFO-E')
  const f = await invoke('job:startChat', book.id, 'FIFO-F')
  const g = await invoke('job:startChat', book.id, 'FIFO-G')
  ok('⑤ 后发的两条都在排队', f.state === 'queued' && g.state === 'queued')
  await invoke('job:cancel', f.id)
  let overlapped = false
  for (let i = 0; i < 200; i++) {
    if ((await runningCount()) > 1) overlapped = true
    if ((await invoke('job:get', e.id)).state !== 'running') break
    await sleep(100)
  }
  const ed = await waitJob(e.id, (j) => j.state === 'done')
  const gd = await waitJob(g.id, (j) => j.state === 'done')
  const f2 = await invoke('job:get', f.id)
  ok('④ 被取消的排队任务始终是 cancelled', f2.state === 'cancelled')
  ok('④ 其余两条都完成', ed.state === 'done' && gd.state === 'done')
  ok('④ 一条在跑时没有第二条任务并发启动', !overlapped)
  const tail = stub.order.slice(-2)
  ok(`⑤ 到模型的顺序=先来后到（${tail.join(' → ')}）`, tail.join() === 'FIFO-E,FIFO-G')

  // ⑦ 重试被取消的任务
  const h = await invoke('job:startChat', book.id, 'FIFO-H')
  const callsBeforeH = stub.calls
  for (let i = 0; i < 100 && stub.calls === callsBeforeH; i++) await sleep(100)
  await invoke('job:cancel', h.id)
  for (let i = 0; i < 60 && (await runningCount()) > 0; i++) await sleep(100)
  const hr = await invoke('job:retry', h.id)
  ok(`⑦ 重试后重新排队/运行（${hr.state}）`, hr.state === 'queued' || hr.state === 'running')
  const hd = await waitJob(h.id, (j) => j.state === 'done')
  ok('⑦ 重试后跑完', hd.state === 'done')
  ok('⑦ 被取消的那次中止后重新请求了模型', stub.order.filter((x) => x === 'FIFO-H').length === 2)

  // ⑧ 入书后才失败的写章任务：重试不会重写一章
  const t8 = Date.now()
  insertJob.run(
    'job-ghost',
    book.id,
    book.activeLineId,
    'write',
    'failed',
    '',
    '{}',
    '收尾失败',
    'ch-ghost',
    0,
    t8,
    t8
  )
  const calls8 = stub.calls
  const r8 = await invoke('job:retry', 'job-ghost')
  ok('⑧ 已入书的失败写章任务：重试直接按完成处理', r8.state === 'done')
  ok('⑧ 没有再调用模型', stub.calls === calls8)
  ok('⑧ 留下入书卡说明', await hasCard(book.id, 'job-ghost', 'chapter'))

  // ⑨ 没有执行器的任务类型：判失败并留卡，不堵后面的队列
  const t9 = Date.now()
  insertJob.run(
    'job-bogus',
    book.id,
    book.activeLineId,
    'bogus',
    'queued',
    '',
    '{}',
    '',
    '',
    0,
    t9,
    t9
  )
  const k = await invoke('job:startChat', book.id, 'FIFO-K')
  const kd = await waitJob(k.id, (j) => j.state === 'done')
  await sleep(300)
  const bogus = await invoke('job:get', 'job-bogus')
  ok(
    `⑨ 堵在队首的未知类型任务被跳过（${bogus?.state}）`,
    bogus?.state === 'failed' && String(bogus.error).includes('未知任务类型')
  )
  ok('⑨ 留有失败卡', await hasCard(book.id, 'job-bogus', 'failed'))
  ok('⑨ 后面的任务照常完成', kd.state === 'done')

  // ⑩ 服务重启：上个进程遗留的运行中任务标失败，排队中的继续跑
  const now = Date.now()
  insertJob.run(
    'job-boot-run',
    book.id,
    book.activeLineId,
    'chat',
    'running',
    'agent',
    JSON.stringify({ question: 'BOOT-R' }),
    '',
    '',
    now,
    now,
    now
  )
  insertJob.run(
    'job-boot-q',
    book.id,
    book.activeLineId,
    'chat',
    'queued',
    '',
    JSON.stringify({ question: 'BOOT-Q' }),
    '',
    '',
    0,
    now + 1,
    now + 1
  )
  db.close()
  await stopServer()
  await startServer()
  const br = await waitJob('job-boot-run', (j) => j.state === 'failed', 8000)
  ok(
    `⑩ 重启后遗留的运行中任务标失败（${br?.error}）`,
    br?.state === 'failed' && String(br.error).includes('服务重启')
  )
  ok('⑩ 留有失败卡（作者知道可以重试）', await hasCard(book.id, 'job-boot-run', 'failed'))
  const bq = await waitJob('job-boot-q', (j) => j.state === 'done')
  ok('⑩ 重启前排队的任务自动跑完', bq.state === 'done')
  ok('⑩ 确实请求了模型', stub.order.includes('BOOT-Q'))

  const briefs = await invoke('job:listBriefs')
  const full = await invoke('job:list')
  ok(
    '⑪ 任务摘要覆盖全部任务且不含正文/思考/回答长文本',
    Array.isArray(briefs) &&
      briefs.length >= full.length &&
      briefs.every(
        (j) =>
          !Object.hasOwn(j.payload, 'draftText') &&
          !Object.hasOwn(j.payload, 'thinkingText') &&
          !Object.hasOwn(j.payload, 'answer')
      )
  )
  ok(
    '⑪ 最近的任务列表仍是完整数据',
    full.some((j) => Object.hasOwn(j.payload, 'answer'))
  )
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  llm.close()
  server?.kill()
  await sleep(600)
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {}
}
console.log(`\n[任务生命周期冒烟] ${failed ? `失败 ×${failed}` : '全部通过'}`)
process.exit(failed ? 1 : 0)
