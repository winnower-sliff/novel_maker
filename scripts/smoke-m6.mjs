/**
 * M6 冒烟（API 级·全面 agent 化）：startWrite 直通 agent 自主段（工具链+流式正文+自动修+入书+沉淀）
 * + 负向词硬闸（「忽然」触发 autoFix）+ chat free agent（带工具调用）。
 * 前置：npm run build（dist 最新）。stub 由本脚本 spawn（AGENT_MODE=1，端口 3923）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3969
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

const dataDir = mkdtempSync(join(tmpdir(), 'nm-m6-smoke-'))
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ server: { port: PORT } }))

const stub = spawn(process.execPath, ['scripts/smoke-m3-stub.mjs'], {
  env: { ...process.env, AGENT_MODE: '1', SUBAGENT: '1' },
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

  await invoke('settings:save', {
    provider: 'custom',
    profiles: { custom: { baseUrl: 'http://127.0.0.1:3923/v1', defaultModel: 'stub-model' } },
    apiKeys: { custom: 'stub-key' }
  })
  ok(true, '模型配置 → stub')

  const book = await invoke('book:create', { title: '冒烟之书', targetWords: 600 })
  // 负向词硬闸：DRAFT 里有「忽然」，agent 写出后 lint 应 major → autoFix → 修掉
  await invoke('book:update', book.id, { negativeWords: ['忽然'] })
  await invoke('character:save', {
    lineId: book.activeLineId,
    name: '林岸',
    role: '主角',
    state: { location: '雾津港', mood: '紧绷', goal: '查明断刀来历' }
  })
  ok(true, '建书+负向词+人物')

  // ── 写章 agent 全链路（走向卡已废除：startWrite 直通 agent）──
  let job = await invoke('job:startWrite', book.id)
  job = await waitJob(job.id, (j) => j.state === 'done', 'agent 自主写章全链路', 90_000)
  ok(job.kind === 'write' && job.payload.recap != null, '写章 job done + recap')

  // 章节入库 + 负向词已修
  const detail = await invoke('book:get', book.id)
  ok(detail.chapters.length === 1, `章节入库（${detail.chapters.length} 章）`)
  const ch = await invoke('chapter:get', detail.chapters[0].id)
  ok((ch?.title ?? '') === '雾夜登船', `章标题（${ch?.title}）`)
  ok(!(ch?.content ?? '').includes('忽然'), '负向词「忽然」已被自动修掉')
  ok((ch?.content ?? '').length > 300, `正文字数（${ch?.content ?? ''.length}）`)

  // 工具卡消息序列
  let msgs = await invoke('message:list', book.id)
  const tools = msgs.filter((m) => m.meta?.kind === 'tool').map((m) => m.meta.tool)
  ok(
    tools.join(',') ===
      'get_write_context,write_chapter_draft,commit_chapter,patch_character_state,save_foreshadow,save_card,finish',
    `工具卡序列（${tools.join(',')}）`
  )
  const draftCard = msgs.find((m) => m.meta?.kind === 'tool' && m.meta.tool === 'write_chapter_draft')
  ok((draftCard?.meta?.summary ?? '').includes('字'), `write_chapter_draft 卡带字数（${draftCard?.meta?.summary}）`)

  // 节点消息：chapter（走向卡已废除，无 cards 节点）
  const steps = msgs.filter((m) => m.meta?.kind === 'job').map((m) => m.meta.step)
  ok(steps.join(',') === 'chapter', `节点消息序列（${steps.join(',')}）`)
  const chapterMsg = msgs.find((m) => m.meta?.kind === 'job' && m.meta.step === 'chapter')
  ok((chapterMsg?.content ?? '').includes('已入书'), `入书节点（${chapterMsg?.content}）`)

  // 沉淀：人物状态被 agent patch（name 兜底路径）
  const chars = await invoke('character:list', book.activeLineId)
  const lin = chars.find((c) => c.name === '林岸')
  ok((lin?.state?.location ?? '') === '南屿货船·蔗糖舱', `人物状态被 patch（location=${lin?.state?.location}）`)

  // recap quickActions（commit_chapter 传入）
  ok((job.payload.recap?.quickActions ?? []).length === 1, 'recap.quickActions 来自 commit_chapter')

  // ── chat free agent（带工具调用）──
  let cj = await invoke('job:startChat', book.id, '现在写到哪了？伏笔怎么安排？')
  cj = await waitJob(cj.id, (j) => j.state === 'done', 'chat free agent')
  ok((cj.payload.answer ?? '').includes('沈') || (cj.payload.answer ?? '').length > 20, 'chat agent 回答非空')

  msgs = await invoke('message:list', book.id)
  const chatTools = msgs.filter((m) => m.meta?.kind === 'tool' && m.meta.jobId === cj.id)
  ok(chatTools.length >= 1 && chatTools[0].meta.tool === 'list_chapters', 'chat agent 用了 list_chapters 工具')

  // ── spawn_subagent：父派只读调查员，子静默执行，结论回父 ──
  {
    let sj = await invoke('job:startChat', book.id, '派个调查员查一下写到第几章了，回头告诉我。')
    sj = await waitJob(sj.id, (j) => j.state === 'done', 'subagent chat')
    ok(String(sj.payload.answer ?? '').includes('调查员回报'), '父代理收尾带调查结论')
    const sMsgs = await invoke('message:list', book.id)
    const sCards = sMsgs.filter((m) => m.meta?.kind === 'tool' && m.meta.jobId === sj.id)
    ok(
      !sCards.some((m) => m.meta.tool === 'list_chapters'),
      `子代理工具调用没落卡（实际 ${sCards.map((m) => m.meta.tool).join(',')}）`
    )
    ok((sCards[0].meta.summary ?? '').includes('调查员回报'), `spawn_subagent 卡带回合数（${sCards[0].meta.summary}）`)
  }

  console.log(`\n[M6 冒烟] ${passed} 通过 / ${failed} 失败`)
  killAll()
  process.exit(failed ? 1 : 0)
} catch (err) {
  console.error('\n[M6 冒烟] 异常:', err.message)
  killAll()
  process.exit(1)
}
