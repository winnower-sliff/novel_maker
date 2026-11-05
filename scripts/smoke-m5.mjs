/**
 * M5 冒烟（API 级·智能体页）：自由对话 chat + 写作循环节点消息时间轴。
 * 前置：npm run build（dist 最新）。stub 由本脚本 spawn（SKIP_ONBOARD=1，端口 3923）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3968
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

const dataDir = mkdtempSync(join(tmpdir(), 'nm-m5-smoke-'))
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ server: { port: PORT } }))

const stub = spawn(process.execPath, ['scripts/smoke-m3-stub.mjs'], {
  env: { ...process.env, AGENT_MODE: '1' },
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
  // 负向词触发 stub 链的 autoFix 轮，对齐 AGENT_MODE 队列
  await invoke('book:update', book.id, { negativeWords: ['忽然'] })
  await invoke('card:save', {
    lineId: book.activeLineId,
    kind: 'geography',
    title: '雾津港',
    readerText: '常年大雾的南方深水港。',
    pinned: true
  })
  await invoke('character:save', {
    lineId: book.activeLineId,
    name: '林岸',
    role: '主角',
    state: { location: '雾津港', mood: '紧绷', goal: '查明断刀来历' }
  })
  ok(true, '建书+基础设定')

  // ── 写章 agent 全链路（M6：选完走向 agent 自主到入书；节点消息序列）──
  let job = await invoke('job:startWrite', book.id)
  job = await waitJob(job.id, (j) => j.state === 'waiting_user' && j.step === 'outline', '走向提案')
  job = await invoke('job:chooseDirection', job.id, { source: 'card', cardIndex: 0, text: '随船南下' })
  job = await waitJob(job.id, (j) => j.state === 'done', 'agent 自主段（工具链+正文+入书+沉淀）')
  ok(job.payload.recap != null, '写作 job done + recap')

  let msgs = await invoke('message:list', book.id)
  const steps = msgs
    .filter((m) => m.meta?.kind === 'job')
    .map((m) => m.meta.step)
  ok(steps.join(',') === 'cards,chapter', `节点消息序列（${steps.join(',')}）`)
  const chapterMsg = msgs.find((m) => m.meta?.kind === 'job' && m.meta.step === 'chapter')
  ok((chapterMsg?.content ?? '').includes('已入书'), `入书节点文案（${chapterMsg?.content}）`)
  const actions = msgs
    .filter((m) => m.role === 'user' && m.meta?.kind === 'action')
    .map((m) => m.content)
  ok(
    actions.length === 2 &&
      actions[0].includes('第 1 章') &&
      actions[1].includes('随船南下'),
    `动作消息 2 条（${actions.join(' / ')}）`
  )

  // ── chat 两轮（free agent：第 1 轮带工具调用，第 2 轮纯文本）──
  let cj = await invoke('job:startChat', book.id, '断刀上的「沈」字伏笔你是怎么设计的？')
  ok(cj.kind === 'chat' && cj.state !== 'failed', 'startChat 落队列')
  cj = await waitJob(cj.id, (j) => j.state === 'done', 'chat 第 1 轮')
  ok((cj.payload.answer ?? '').includes('沈'), `chat 回答非空（${(cj.payload.answer ?? '').slice(0, 24)}…）`)

  msgs = await invoke('message:list', book.id)
  const chatUser = msgs.find((m) => m.role === 'user' && m.content.includes('沈'))
  const chatBot = msgs.find((m) => m.role === 'assistant' && m.meta?.kind === 'chat')
  ok(!!chatUser && chatUser.meta?.kind === 'chat', 'chat 用户发言落库（meta.kind=chat）')
  ok(!!chatBot && chatBot.content === cj.payload.answer, 'chat 导演回答落库')
  const chatToolMsgs = msgs.filter((m) => m.meta?.kind === 'tool' && m.meta.jobId === cj.id)
  ok(chatToolMsgs.length >= 1, 'chat agent 用了工具')

  let c2 = await invoke('job:startChat', book.id, '下一章能不能从老船工的视角切入？')
  c2 = await waitJob(c2.id, (j) => j.state === 'done', 'chat 第 2 轮')
  ok((c2.payload.answer ?? '').length > 10, 'chat 第 2 轮回答非空')

  msgs = await invoke('message:list', book.id)
  const chatCount = msgs.filter((m) => m.meta?.kind === 'chat').length
  ok(chatCount === 4, `chat 消息共 4 条（user×2+assistant×2，实际 ${chatCount}）`)

  console.log(`\n[M5 冒烟] ${passed} 通过 / ${failed} 失败`)
  killAll()
  process.exit(failed ? 1 : 0)
} catch (err) {
  console.error('\n[M5 冒烟] 异常:', err.message)
  killAll()
  process.exit(1)
}
