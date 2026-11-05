/**
 * M2 冒烟（API 级第 1 回合）：导演循环全链路 + 分叉树设定独立演化。
 *
 * 前置：npm run build（产物 dist/main/index.js）
 * 环境：NM_DATA_DIR 隔离目录 + 预写 settings.json（端口 3955 + 已知密码），
 *       模型指向本地 stub（scripts/smoke-llm-stub.mjs，127.0.0.1:3922）。
 *
 * 用法：node scripts/smoke-m2.mjs
 */
import { spawn } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startLlmStub, stubCalls } from './smoke-llm-stub.mjs'

const PORT = 3955
const PASSWORD = 'nm-m2-smoke'
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = join(tmpdir(), 'nm-m2-smoke')

// ── 断言工具 ─────────────────────────────────────────────────────────────────

let failed = 0
function ok(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}`)
  }
}

async function invoke(token, channel, args) {
  const res = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nm-token': token },
    body: JSON.stringify({ args })
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`${channel} HTTP ${res.status}: ${body.error}`)
  return body.result
}

async function waitFor(token, jobId, pred, timeoutMs, label) {
  const start = Date.now()
  for (;;) {
    const job = await invoke(token, 'job:get', [jobId])
    if (pred(job)) return job
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时：${label}（state=${job.state} step=${job.step} error=${job.error ?? ''}）`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ── 准备隔离数据目录 ─────────────────────────────────────────────────────────

rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
const salt = randomBytes(16).toString('hex')
const hash = scryptSync(PASSWORD, salt, 64).toString('hex')
writeFileSync(
  join(dataDir, 'settings.json'),
  JSON.stringify({ server: { port: PORT, passwordSalt: salt, passwordHash: hash } }),
  'utf-8'
)

// ── 起服务 ───────────────────────────────────────────────────────────────────

const stub = await startLlmStub(3922)
const server = spawn(process.execPath, ['dist/main/index.js'], {
  env: { ...process.env, NM_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`))
server.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`))

let token = ''
try {
  // 健康探测
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) break
    } catch {}
    if (i >= 60) throw new Error('服务 30s 未就绪')
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log('— 服务就绪')

  // 密码换 token + 配 stub 模型
  const authRes = await fetch(`${BASE}/api/mobile/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, label: 'smoke' })
  })
  token = (await authRes.json()).token
  ok(!!token, '密码换 token')

  await invoke(token, 'settings:save', [
    {
      provider: 'custom',
      profiles: { custom: { baseUrl: 'http://127.0.0.1:3922/v1', defaultModel: 'stub-model' } },
      apiKeys: { custom: 'stub-key' }
    }
  ])
  ok(true, '模型配置写入（custom → stub）')

  // ── 建书 + 造设定 ──────────────────────────────────────────────────────────
  const book = await invoke(token, 'book:create', [{ title: '雾津夜航', genre: '悬疑', targetWords: 600 }])
  ok(!!book?.id && !!book?.activeLineId, 'book:create（自动建主线）')
  const mainLineId = book.activeLineId

  const saltGang = await invoke(token, 'card:save', [
    {
      lineId: mainLineId,
      kind: 'faction',
      title: '盐帮',
      readerText: '盘踞南方水路的私盐贩子，手段狠辣。',
      authorText: '盐帮控制雾津港所有私货航线，帮主「三爷」与官府有默契。',
      pinned: true
    }
  ])
  ok(!!saltGang?.id, 'card:save（钉选设定卡）')

  const linan = await invoke(token, 'character:save', [
    {
      lineId: mainLineId,
      name: '林岸',
      role: '主角',
      card: { age: '24', trait: '隐忍' },
      state: { location: '雾津港七号泊位', mood: '警觉', goal: '带断刀离开雾津港' },
      pinned: true
    }
  ])
  ok(!!linan?.id, 'character:save（含初始活状态）')

  // ── 导演循环第 1 回合 ──────────────────────────────────────────────────────
  let job = await invoke(token, 'job:startWrite', [book.id])
  ok(job.state === 'waiting_user' && job.step === 'outline', `startWrite → waiting_user/outline`)
  const cards = job.payload?.cards ?? []
  ok(cards.length === 4, `走向卡片 4 张（实际 ${cards.length}）`)
  ok(new Set(cards.map((c) => c.kind)).size === 4, '卡片类型互不相同')

  job = await invoke(token, 'job:chooseDirection', [
    job.id,
    { source: 'card', cardIndex: 3, text: 'wild：蓑衣老船工' }
  ])
  ok(job.state === 'waiting_user' && job.step === 'scene', 'chooseDirection → waiting_user/scene')
  ok(job.payload?.outline?.title === '雾夜登船', `章级大纲生成《${job.payload?.outline?.title}》`)

  job = await invoke(token, 'job:confirmOutline', [job.id])
  ok(job.state === 'waiting_user' && job.step === 'draft', 'confirmOutline → waiting_user/draft')
  ok((job.payload?.scenes ?? []).length === 3, '场景分镜 3 幕')

  job = await invoke(token, 'job:confirmScenes', [job.id, null])
  job = await waitFor(
    token,
    job.id,
    (j) => j.state === 'done' || j.state === 'failed',
    60_000,
    '正文流式→自检→定稿'
  )
  ok(job.state === 'done', `第 1 章完成（state=${job.state}${job.error ? ` error=${job.error}` : ''}）`)
  ok(!job.payload?.lint?.issues?.length, '自检零问题（一次通过）')
  ok(!!job.payload?.recap?.summary, '纪要卡生成')

  // ── 落库验证 ───────────────────────────────────────────────────────────────
  const bookAfter = await invoke(token, 'book:get', [book.id])
  ok(bookAfter.chapters.length === 1, '章节入库')
  const chapter = bookAfter.chapters[0]
  ok(chapter.title === '雾夜登船' && chapter.wordCount >= 360, `章名/字数（${chapter.wordCount} 字）`)

  const full = await invoke(token, 'chapter:get', [chapter.id])
  ok(full.content.includes('沈'), '正文含「沈」字伏笔')

  const shadows = await invoke(token, 'foreshadow:list', [mainLineId])
  ok(shadows.some((f) => f.title === '断刀的来历' && f.status === 'open'), 'recap 伏笔 plant 落库')

  const charAfter = await invoke(token, 'character:save', [
    { id: linan.id, lineId: mainLineId, name: '林岸' }
  ])
  ok(
    charAfter.state?.location === '南屿货船·蔗糖舱' && charAfter.state?.mood === '紧绷',
    `人物活状态随 recap 演化（location=${charAfter.state?.location}）`
  )

  const cardsAfter = await invoke(token, 'card:list', [mainLineId])
  ok(cardsAfter.some((c) => c.title === '雾津港'), 'recap 设定卡 create 落库')

  // ── 分叉树：设定独立演化 ───────────────────────────────────────────────────
  const fork = await invoke(token, 'line:fork', [book.id, chapter.id, '隐退线', '测试分叉'])
  ok(!!fork?.id && fork.id !== mainLineId, 'line:fork 开新线并激活')
  const forkCards = await invoke(token, 'card:list', [fork.id])
  ok(forkCards.length === cardsAfter.length, `新线深拷贝设定卡（${forkCards.length} 张）`)

  const fogCard = forkCards.find((c) => c.title === '雾津港')
  await invoke(token, 'card:save', [
    { id: fogCard.id, lineId: fork.id, title: '雾津港', authorText: '【已改】分叉后新线的雾津港真相' }
  ])
  const mainFog = (await invoke(token, 'card:list', [mainLineId])).find((c) => c.title === '雾津港')
  ok(
    mainFog?.authorText !== '【已改】分叉后新线的雾津港真相',
    '改新线卡不影响原线（独立演化）'
  )

  ok(stubCalls().length === 5, `LLM 调用 5 次（实际 ${stubCalls().length}：directions/outline/scenes/draft/recap）`)
} catch (err) {
  failed++
  console.error('冒烟中断：', err.message)
  console.error('stub 调用数：', stubCalls().length)
} finally {
  server.kill()
  stub.close()
  setTimeout(() => process.exit(failed ? 1 : 0), 300)
}

// 防止未捕获 promise 警告误判
process.on('unhandledRejection', (e) => {
  failed++
  console.error('unhandledRejection:', e)
})

// 保留 cpSync 引用（未来快照断言用），避免 lint 报未使用
void cpSync
