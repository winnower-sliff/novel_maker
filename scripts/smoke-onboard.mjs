// 开书引导冒烟：确认草案「先问后存」不重复入库、重复确认幂等、下一阶段看得到已确认草案
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3982
const STUB_PORT = 3984
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'nm-onboard-smoke-'))
const DUMP = join(DATA, 'stub-dump.jsonl')
writeFileSync(join(DATA, 'settings.json'), JSON.stringify({ server: { port: PORT } }))

// 桩进程：正常流程用默认队列（4 项）；失败路径重启桩并注入「第 3-5 次请求返回 500」
function startStub(failTimes) {
  return spawn(process.execPath, ['scripts/smoke-m3-stub.mjs'], {
    env: {
      ...process.env,
      STUB_PORT: String(STUB_PORT),
      STUB_DUMP: DUMP,
      STUB_FAIL_TIMES: failTimes
    },
    stdio: 'inherit'
  })
}
let stub = startStub('')
const server = spawn(process.execPath, ['dist/main/index.js'], {
  env: { ...process.env, NM_DATA_DIR: DATA },
  stdio: 'inherit'
})

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

async function waitUp(url, label) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error(`${label} 未就绪`)
}

async function waitDown(url) {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) })
      await sleep(150)
    } catch {
      return
    }
  }
}

const cardCount = async (lineId) => (await invoke('card:list', lineId)).length
const charCount = async (lineId) => (await invoke('character:list', lineId)).length
const lastMessage = async (bookId) => (await invoke('message:list', bookId)).at(-1)
const messageCount = async (bookId) => (await invoke('message:list', bookId)).length
const dumpLines = () => readFileSync(DUMP, 'utf8').split('\n').filter(Boolean)
/** 转储里第 n 个请求（1 起）的最后一条 user 文本 */
function lastUserOf(n) {
  const msgs = JSON.parse(dumpLines()[n - 1] ?? '{}').messages ?? []
  return msgs.filter((m) => m.role === 'user').at(-1)?.content ?? ''
}

try {
  await waitUp(`${BASE}/api/health`, 'server')
  await waitUp(`${STUB_URL}/v1/models`, 'stub')
  ok(true, '服务与桩就绪')
  await invoke('settings:save', {
    provider: 'custom',
    profiles: { custom: { baseUrl: `${STUB_URL}/v1`, defaultModel: 'stub-model' } },
    apiKeys: { custom: 'stub-key' }
  })

  // ── 书 A：正常流程 + 重复确认（桩请求 1-4：开场问题 / 世界观 / 人物 / 书名） ──
  const a = await invoke('book:create', { title: '开书冒烟之书' })
  const aLine = (await invoke('book:get', a.id)).book.activeLineId
  const as = await invoke('onboard:start', a.id)
  ok(as.stage === 'premise' && as.options.length === 3, '开场问题带 3 个选项')

  const aw = await invoke('onboard:answer', a.id, '冷峻悬疑', 'premise')
  ok(aw.stage === 'world', '世界观草案')
  ok((await cardCount(aLine)) === 0, '草案阶段设定卡不入库')

  const ac = await invoke('onboard:answer', a.id, '就这么定', 'world')
  ok(ac.stage === 'characters', '确认世界观 → 进入人物阶段')
  ok((await cardCount(aLine)) === 2, '确认后设定卡入库（2 张）')

  const dumpBefore = dumpLines().length
  const msgBefore = await messageCount(a.id)
  const again = await invoke('onboard:answer', a.id, '就这么定', 'world')
  ok(again.stage === 'characters', '重复确认：仍停在人物阶段（不会误确认人物草案）')
  ok(again.reply.includes('已经确认过了'), '重复确认：提示这一步已确认')
  ok(
    JSON.stringify(again.options) === JSON.stringify(ac.options) && again.reply.includes(ac.reply),
    '重复确认：原样带回最新草案'
  )
  ok(
    dumpLines().length === dumpBefore && (await messageCount(a.id)) === msgBefore,
    '重复确认：不调模型、不新增消息'
  )
  ok((await cardCount(aLine)) === 2 && (await charCount(aLine)) === 0, '重复确认：没有重复入库')

  const user3 = lastUserOf(3)
  ok(
    user3.includes('上一阶段作者已确认的草案') && user3.includes('雾津港'),
    '人物阶段提示词带上了已确认的世界观草案'
  )

  const ach = await invoke('onboard:answer', a.id, '就这么定', 'characters')
  ok(ach.stage === 'title', '确认人物 → 进入书名阶段')
  ok((await charCount(aLine)) === 2, '确认后人物入库（2 人）')

  const at = await invoke('onboard:answer', a.id, '第二个', 'title')
  ok(at.done === true && at.stage === 'done', '选定书名 → 开书完成')
  const ab = (await invoke('book:get', a.id)).book
  ok(ab.title === '沉舟录', `书名写入《${ab.title}》`)
  ok(ab.styleName === '冷硬短句' && ab.targetWords === 2000, '文风与单章目标写入')
  ok(Array.isArray(ab.redlines) && ab.redlines.length === 2, '红线写入（2 条）')
  ok(!ab.draft, '开书完成后不再是草稿书')

  // ── 书 B：确认时模型连续失败 → 草案不入库；再确认只入库一次 ──
  stub.kill()
  await waitDown(`${STUB_URL}/v1/models`)
  stub = startStub('3,4,5')
  await waitUp(`${STUB_URL}/v1/models`, 'stub（重启）')

  const b = await invoke('book:create', { title: '失败重试之书' })
  const bLine = (await invoke('book:get', b.id)).book.activeLineId
  const bs = await invoke('onboard:start', b.id)
  ok(bs.stage === 'premise', '书B 开场问题')
  const bw = await invoke('onboard:answer', b.id, '热血爽文', 'premise')
  ok(bw.stage === 'world', '书B 世界观草案')

  let threw = false
  try {
    await invoke('onboard:answer', b.id, '就这么定', 'world')
  } catch (e) {
    threw = true
    console.log(`    （预期的失败：${String(e.message).slice(0, 80)}）`)
  }
  ok(threw, '书B 确认时模型连续失败 → 请求报错')
  ok((await cardCount(bLine)) === 0, '书B 失败后草案没有入库（卡数 0）')
  ok((await lastMessage(b.id)).meta?.stage === 'world', '书B 仍停在世界观草案这一步')

  const bc = await invoke('onboard:answer', b.id, '就这么定', 'world')
  ok(bc.stage === 'characters', '书B 再次确认 → 进入人物阶段')
  ok((await cardCount(bLine)) === 2, '书B 重试后设定卡只入库一次（2 张）')
} catch (e) {
  ok(false, `异常：${e.message}`)
} finally {
  server.kill()
  stub.kill()
  await sleep(500)
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {}
}
console.log(`\n[开书引导冒烟] ${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
