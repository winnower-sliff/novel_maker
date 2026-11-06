/**
 * M2 冒烟（API 级第 1 回合）：导演循环全链路 + 分叉树设定独立演化。
 *
 * 前置：npm run build（产物 dist/main/index.js）
 * 环境：NM_DATA_DIR 隔离目录 + 预写 settings.json（端口 3955，无鉴权），
 *       模型指向本地 stub（scripts/smoke-llm-stub.mjs，127.0.0.1:3922）。
 *
 * 用法：node scripts/smoke-m2.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PORT = 3955
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

// ── 准备隔离数据目录 ─────────────────────────────────────────────────────────

rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })
writeFileSync(
  join(dataDir, 'settings.json'),
  JSON.stringify({ server: { port: PORT } }),
  'utf-8'
)

// ── 起服务 ───────────────────────────────────────────────────────────────────

const stub = spawn(process.execPath, ['scripts/smoke-m3-stub.mjs'], {
  env: { ...process.env, AGENT_MODE: '1' },
  stdio: 'inherit'
})
const server = spawn(process.execPath, ['dist/main/index.js'], {
  env: { ...process.env, NM_DATA_DIR: dataDir },
  stdio: 'inherit'
})

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

  // 无鉴权直连（v2 决策：Tailscale 即信任边界）
  const status = await invoke('server:status', [])
  ok(!!status?.version, '无鉴权直连 invoke（server:status）')

  await invoke('settings:save', [
    {
      provider: 'custom',
      profiles: { custom: { baseUrl: 'http://127.0.0.1:3923/v1', defaultModel: 'stub-model' } },
      apiKeys: { custom: 'stub-key' }
    }
  ])
  ok(true, '模型配置写入（custom → stub）')

  // ── 建书 + 造设定 ──────────────────────────────────────────────────────────
  const book = await invoke('book:create', [{ title: '雾津夜航', genre: '悬疑', targetWords: 600 }])
  ok(!!book?.id && !!book?.activeLineId, 'book:create（自动建主线）')
  const mainLineId = book.activeLineId
  // 负向词触发 stub 链的 autoFix 轮（DRAFT 含「忽然」→修掉），对齐 AGENT_MODE 队列
  await invoke('book:update', [book.id, { negativeWords: ['忽然'] }])

  const saltGang = await invoke('card:save', [
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

  const linan = await invoke('character:save', [
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

  // ── 导演循环第 1 回合（聊天驱动：startWrite 直通 agent 自主到入书） ──────────
  let job = await invoke('job:startWrite', [book.id])
  job = await waitFor(
    job.id,
    (j) => j.state === 'done' || j.state === 'failed',
    90_000,
    'agent 全链（工具链→正文→自检→入书→沉淀）'
  )
  ok(job.state === 'done', `第 1 章完成（state=${job.state}${job.error ? ` error=${job.error}` : ''}）`)
  ok(!!job.payload?.recap?.summary, '纪要卡（commit_chapter summary）')

  // ── 落库验证 ───────────────────────────────────────────────────────────────
  const bookAfter = await invoke('book:get', [book.id])
  ok(bookAfter.chapters.length === 1, '章节入库')
  const chapter = bookAfter.chapters[0]
  ok(chapter.title === '雾夜登船' && chapter.wordCount >= 360, `章名/字数（${chapter.wordCount} 字）`)

  const full = await invoke('chapter:get', [chapter.id])
  ok(full.content.includes('沈'), '正文含「沈」字伏笔')

  const shadows = await invoke('foreshadow:list', [mainLineId])
  ok(shadows.some((f) => f.title === '断刀的来历' && f.status === 'open'), 'agent save_foreshadow 落库')

  const charAfter = await invoke('character:save', [
    { id: linan.id, lineId: mainLineId, name: '林岸' }
  ])
  ok(
    charAfter.state?.location === '南屿货船·蔗糖舱',
    `人物活状态被 agent patch（location=${charAfter.state?.location}）`
  )

  const cardsAfter = await invoke('card:list', [mainLineId])
  ok(cardsAfter.some((c) => c.title.includes('雾津港')), 'agent save_card 落库')

  // ── 分叉树：设定独立演化 ───────────────────────────────────────────────────
  const fork = await invoke('line:fork', [book.id, chapter.id, '隐退线', '测试分叉'])
  ok(!!fork?.id && fork.id !== mainLineId, 'line:fork 开新线并激活')
  const forkCards = await invoke('card:list', [fork.id])
  ok(forkCards.length === cardsAfter.length, `新线深拷贝设定卡（${forkCards.length} 张）`)

  const fogCard = forkCards.find((c) => c.title.includes('雾津港'))
  await invoke('card:save', [
    { id: fogCard.id, lineId: fork.id, title: fogCard.title, authorText: '【已改】分叉后新线的雾津港真相' }
  ])
  const mainFog = (await invoke('card:list', [mainLineId])).find((c) => c.id === fogCard.id)
  ok(
    mainFog?.authorText !== '【已改】分叉后新线的雾津港真相',
    '改新线卡不影响原线（独立演化）'
  )

} catch (err) {
  failed++
  console.error('冒烟中断：', err.message)
} finally {
  server.kill()
  stub.kill()
  setTimeout(() => process.exit(failed ? 1 : 0), 300)
}

// 防止未捕获 promise 警告误判
process.on('unhandledRejection', (e) => {
  failed++
  console.error('unhandledRejection:', e)
})
