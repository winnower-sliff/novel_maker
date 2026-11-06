/**
 * M4 冒烟（API 级）：改章 revise + 审读/审计/诊断报告 + recap.quickActions。
 * 前置：npm run build（dist 最新）。stub 由本脚本 spawn（SKIP_ONBOARD=1，端口 3923）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3967
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
let failed = 0
function ok(cond, label) {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.error(`  ✗ ${label}`)
  }
}

async function invoke(channel, ...args) {
  const res = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args })
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${channel} -> ${res.status}: ${body.error ?? JSON.stringify(body)}`)
  return body.result
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitJob(jobId, pred, label, timeoutMs = 90_000, allowFailed = false) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const job = await invoke('job:get', jobId)
    if (job && pred(job)) return job
    if (job && !allowFailed && (job.state === 'failed' || job.state === 'cancelled')) {
      throw new Error(`${label} 失败: ${job.state} ${job.error ?? ''}`)
    }
    await sleep(800)
  }
  throw new Error(`${label} 超时`)
}

const dataDir = mkdtempSync(join(tmpdir(), 'nm-m4-smoke-'))
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ server: { port: PORT } }))

const stub = spawn(process.execPath, ['scripts/smoke-m3-stub.mjs'], {
  env: { ...process.env, AGENT_MODE: '1', CHAT_IN_QUEUE: '0' },
  stdio: 'inherit'
})
const server = spawn(process.execPath, ['dist/main/index.js'], {
  env: { ...process.env, NM_DATA_DIR: dataDir },
  stdio: 'inherit'
})

function killAll() {
  for (const p of [server, stub]) {
    try {
      p.kill('SIGTERM')
    } catch {}
  }
  setTimeout(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {}
  }, 500)
}

try {
  // 等服务就绪
  let up = false
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) {
        up = true
        break
      }
    } catch {}
    await sleep(500)
  }
  ok(up, '服务就绪 /api/health')

  await invoke(
    'settings:save',
    { provider: 'custom', profiles: { custom: { baseUrl: 'http://127.0.0.1:3923/v1', defaultModel: 'stub-model' } }, apiKeys: { custom: 'stub-key' } }
  )
  ok(true, '模型配置 → stub')

  const book = await invoke('book:create', { title: '冒烟之书', targetWords: 600 })
  ok(!!book.id && !!book.activeLineId, 'book:create')
  const line = { id: book.activeLineId }
  // 负向词触发 stub 链的 autoFix 轮，对齐 AGENT_MODE 队列
  await invoke('book:update', book.id, { negativeWords: ['忽然'] })

  await invoke('card:save', {
    lineId: line.id,
    kind: 'geography',
    title: '雾津港',
    readerText: '常年大雾的南方深水港。',
    pinned: true
  })
  await invoke('character:save', {
    lineId: line.id,
    name: '林岸',
    role: '主角',
    state: { location: '雾津港', mood: '紧绷', goal: '查明断刀来历' }
  })
  ok(true, '基础设定（卡+人物）')

  // ── 写章 agent 全链路（走向卡已废除：startWrite 直通）──
  let job = await invoke('job:startWrite', book.id)
  job = await waitJob(job.id, (j) => j.state === 'done', 'agent 全链（工具链+正文+入书+沉淀）', 90_000)

  const quick = job.payload.recap?.quickActions ?? []
  ok(quick.length >= 1 && quick[0].label.length > 0, `recap.quickActions=${quick.length}（agent 动态建议钮）`)

  const detail = await invoke('book:get', book.id)
  ok(detail.chapters.length === 1, '章节入库')
  const ch0 = await invoke('chapter:get', detail.chapters[0].id)
  ok(ch0.content.includes('雾津港'), '正文内容正确')

  // ── 改章 revise（局部替换 plan：一命中一未命中）──
  let rj = await invoke('job:startRevise', ch0.id, '测试改章：收尾再冷一点')
  ok(rj.kind === 'revise' && rj.payload.revise?.instruction === '测试改章：收尾再冷一点', 'startRevise 落队列')
  rj = await waitJob(rj.id, (j) => j.state === 'done', '改章')
  ok((rj.payload.reviseMode ?? '').includes('局部修改 1/2'), `reviseMode=${rj.payload.reviseMode}`)
  const ch1 = await invoke('chapter:get', ch0.id)
  ok(
    ch1.content.includes('像化开的盐雾') && !ch1.content.includes('像化在水里的蛋黄'),
    '局部替换生效（命中段已换，未点名段不动）'
  )
  ok(!ch1.content.includes('不应出现'), '未命中的 edit 不落正文')

  // ── 审读 / 审计 / 诊断 ──
  let vj = await invoke('job:startReview', ch0.id)
  vj = await waitJob(vj.id, (j) => j.state === 'done', '章审读')
  ok(vj.payload.report?.kind === 'review', 'report.kind=review')
  ok((vj.payload.report?.findings ?? []).length >= 2 && vj.payload.report?.score === 82, `审读报告 findings · 82 分`)

  let aj = await invoke('job:startAudit', book.id)
  aj = await waitJob(aj.id, (j) => j.state === 'failed', '全书审计门槛', 15_000, true)
  ok((aj.error ?? '').includes('章节太少'), '审计门槛：1 章书快速失败不烧模型')

  let dj = await invoke('job:startDiagnose', book.id, '主角的动机链立得住吗？')
  dj = await waitJob(dj.id, (j) => j.state === 'done', '问导演')
  ok(dj.payload.report?.kind === 'diagnose' && (dj.payload.report?.verdict ?? '').length > 20, '诊断回答非空')

  console.log(`\n[M4 冒烟] ${passed} 通过 / ${failed} 失败`)
  killAll()
  process.exit(failed ? 1 : 0)
} catch (err) {
  console.error('\n[M4 冒烟] 异常:', err.message)
  killAll()
  process.exit(1)
}
