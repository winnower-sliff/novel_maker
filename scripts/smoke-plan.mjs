/**
 * 计划模式冒烟：planMode 开关 → startWrite 出计划书（waiting_user）→ 聊天可见计划 → approvePlan → 全链入书。
 *
 * 前置：npm run build。stub 需 PLAN_MODE=1（队列头多一条 genChapterPlan 响应）。
 * 用法：node scripts/smoke-plan.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PORT = 3961
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = join(tmpdir(), 'nm-plan-smoke')

let failed = 0
function ok(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}`)
  }
}

async function invoke(channel, args) {
  const res = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args })
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${channel} HTTP ${res.status}: ${body.error}`)
  return body.result
}

async function waitFor(jobId, pred, timeoutMs, label) {
  const start = Date.now()
  for (;;) {
    const job = await invoke('job:get', [jobId])
    if (pred(job)) return job
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时：${label}（state=${job.state} step=${job.step} error=${job.error ?? ''}）`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ server: { port: PORT } }), 'utf-8')

const stub = spawn(process.execPath, ['scripts/smoke-m3-stub.mjs'], {
  env: { ...process.env, AGENT_MODE: '1', PLAN_MODE: '1', CHAT_IN_QUEUE: '0' },
  stdio: 'inherit'
})
const server = spawn(process.execPath, ['dist/main/index.js'], {
  env: { ...process.env, NM_DATA_DIR: dataDir },
  stdio: 'inherit'
})

try {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) break
    } catch {}
    if (i >= 60) throw new Error('服务 30s 未就绪')
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log('— 服务就绪')

  await invoke('settings:save', [
    {
      provider: 'custom',
      profiles: { custom: { baseUrl: 'http://127.0.0.1:3923/v1', defaultModel: 'stub-model' } },
      apiKeys: { custom: 'stub-key' }
    }
  ])

  const book = await invoke('book:create', [{ title: '计划模式测试书', genre: '悬疑', targetWords: 600 }])
  // 负向词触发 autoFix 轮（对齐 AGENT_MODE 队列）
  await invoke('book:update', [book.id, { negativeWords: ['忽然'] }])
  // 计划模式开启
  const b1 = await invoke('book:update', [book.id, { planMode: true }])
  ok(b1.planMode === true, 'book:update planMode 开关写入')

  // 开计划模式后 startWrite → 出计划书停在 waiting_user
  let job = await invoke('job:startWrite', [book.id])
  job = await waitFor(
    job.id,
    (j) => j.state === 'waiting_user' || j.state === 'failed',
    60_000,
    '计划书生成'
  )
  ok(job.state === 'waiting_user' && job.step === 'plan', `停在计划确认（state=${job.state} step=${job.step}）`)
  ok((job.payload?.plan ?? '').includes('走向'), `计划书落 payload.plan（${job.payload?.plan?.length ?? 0} 字）`)

  const msgs1 = await invoke('message:list', [book.id])
  ok(msgs1.some((m) => m.meta?.kind === 'job' && m.meta?.step === 'plan'), '计划节点消息上墙')

  // 等待期聊天：chat job 不炸（导演带计划上下文；stub 队列 CHAT_IN_QUEUE=0 无 chat 响应也该容错落 done）
  const chatJob = await invoke('job:startChat', [book.id, '这份计划我觉得可以'])
  await waitFor(chatJob.id, (j) => j.state === 'done' || j.state === 'failed', 60_000, '等待期聊天')
  ok(true, '计划等待期聊天不冲突')

  // 按计划执行 → 全链入书
  job = await invoke('job:approvePlan', [job.id])
  job = await waitFor(
    job.id,
    (j) => j.state === 'done' || j.state === 'failed',
    90_000,
    '按计划执行全链'
  )
  ok(job.state === 'done', `按计划写完（state=${job.state}${job.error ? ` error=${job.error}` : ''}）`)

  const after = await invoke('book:get', [book.id])
  ok(after.chapters.length === 1, '章节入库（1 章）')
  ok(after.chapters[0]?.title === '雾夜登船', '章标题（雾夜登船）')
  const full = await invoke('chapter:get', [after.chapters[0].id])
  ok(full.content.includes('沈'), '正文含「沈」字伏笔')

  // 重复确认应被拒（已 done）
  let dupRejected = false
  try {
    await invoke('job:approvePlan', [job.id])
  } catch {
    dupRejected = true
  }
  ok(dupRejected, '计划已执行后重复确认被拒')
} catch (err) {
  failed++
  console.error('冒烟中断：', err.message)
} finally {
  server.kill()
  stub.kill()
  setTimeout(() => process.exit(failed ? 1 : 0), 300)
}

process.on('unhandledRejection', (e) => {
  failed++
  console.error('unhandledRejection:', e)
})
