/**
 * M6 冒烟（API 级·全面 agent 化）：startWrite 直通 agent 自主段（主智能体写任务简报→派写作子智能体
 * 分段交稿+自检退回+回执→入书+沉淀）+ 负向词硬闸（「忽然」触发退回给写手自己改）+ chat free agent（带工具调用）。
 * 前置：npm run build（dist 最新）。stub 由本脚本 spawn（AGENT_MODE=1，端口 3923）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { removeTempDir, stopChild } from './temp-dir.mjs'

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
// 桩把每个请求体追加到这个文件：断言提示词内容用（导演系统提示、写手提示）
const dumpFile = join(dataDir, 'stub-dump.jsonl')
const dumped = () =>
  readFileSync(dumpFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

const stub = spawn(process.execPath, ['scripts/smoke-m3-stub.mjs'], {
  env: { ...process.env, AGENT_MODE: '1', SUBAGENT: '1', STUB_DUMP: dumpFile },
  stdio: 'inherit'
})
const server = spawn(process.execPath, ['dist/main/index.js'], {
  env: { ...process.env, NM_DATA_DIR: dataDir },
  stdio: 'inherit'
})

/** 收尾：等 server 与桩真正退出，再删临时目录（它们没退出时 novel.db 删不掉） */
async function killAll() {
  await Promise.all([stopChild(server), stopChild(stub)])
  await removeTempDir(dataDir)
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
  // 负向词硬闸：桩交的稿里有「忽然」，写手 done 时自检应 major → 退回 → 写手 revise_draft 改掉；文风进导演系统提示
  await invoke('book:update', book.id, { negativeWords: ['忽然'], styleName: '冷硬短句' })
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
  ok(
    !(ch?.content ?? '').includes('忽然'),
    '负向词「忽然」被写手自己改掉（自检退回 → revise_draft）'
  )
  ok((ch?.content ?? '').length > 300, `正文字数（${ch?.content ?? ''.length}）`)

  // 前情梗概：入书后后台合并出本线唯一一行 running 梗概（合并是 fire-and-forget，直读临时库等它落库）
  {
    const db = new DatabaseSync(join(dataDir, 'novel.db'))
    const runningSql = "SELECT * FROM memories WHERE line_id = ? AND kind = 'running'"
    let row = null
    for (let i = 0; i < 40 && !row; i++) {
      row = db.prepare(runningSql).get(book.activeLineId) ?? null
      if (!row) await sleep(250)
    }
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM memories WHERE line_id = ? AND kind = 'running'`)
      .get(book.activeLineId).n
    db.close()
    ok(
      !!row &&
        row.to_order === 1 &&
        row.last_chapter_id === detail.chapters[0].id &&
        String(row.content).includes('林岸雾夜藏身'),
      '入书后生成一行前情梗概（覆盖到第 1 章）'
    )
    ok(count === 1, `running 梗概只有一行（${count}）`)

    // 写作子智能体的提示：吃的是和导演同一份写作简报（出场人物带人设），稳定内容在前、简报在后
    {
      const writerReq = dumped().find((b) =>
        String(b.messages?.[0]?.content ?? '').startsWith('你是写作子智能体')
      )
      const system = String(writerReq?.messages?.[0]?.content ?? '')
      const firstUser = String(writerReq?.messages?.[1]?.content ?? '')
      const toolNames = (writerReq?.tools ?? []).map((t) => t.function?.name)
      ok(
        system.includes('## 本章目标字数') &&
          system.includes('## 负向词') &&
          system.includes('## 文风') &&
          system.includes('## 记忆简报') &&
          system.indexOf('## 本章目标字数') < system.indexOf('## 记忆简报'),
        '写手系统提示：硬约束在前（字数/负向词/文风）、记忆简报在后'
      )
      ok(
        system.includes('本章出场人物') && system.includes('【林岸】（主角）'),
        '写手提示带出场人物人设'
      )
      ok(!system.includes('作者选定的走向'), '写手提示不再出现过时的「作者选定的走向」')
      ok(
        firstUser.includes('## 任务简报') && firstUser.includes('## 交稿规则'),
        '写手首条消息=任务简报+交稿规则'
      )
      ok(writerReq?.max_tokens === 8000, `写手每轮输出预算 8000（${writerReq?.max_tokens}）`)
      ok(
        [
          'submit_draft',
          'revise_draft',
          'finish',
          'get_character',
          'get_card',
          'read_sample'
        ].every((t) => toolNames.includes(t)) &&
          ['save_card', 'commit_chapter', 'write_chapter_draft', 'spawn_subagent'].every(
            (t) => !toolNames.includes(t)
          ),
        `写手工具=读工具+交稿三件套，没有写类工具（${toolNames.length} 个）`
      )
    }

    // 自检退回 → 写手自己改 → 复检通过：看写手后续请求里的工具结果
    {
      const writerReqs = dumped().filter((b) =>
        String(b.messages?.[0]?.content ?? '').startsWith('你是写作子智能体')
      )
      const toolResults = writerReqs.flatMap((b) =>
        (b.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content))
      )
      ok(
        toolResults.some((t) => t.includes('自检退回（第 1/2 次）')),
        '负向词触发自检退回'
      )
      ok(
        toolResults.some((t) => t.includes('已替换 2 处')),
        '写手用 revise_draft 改掉两处「忽然」'
      )
      ok(
        toolResults.some((t) => t.includes('自检通过')),
        '改完复检通过'
      )
      ok(
        toolResults.some((t) => t.includes('已累计 ') && t.includes('末尾：')),
        '分段交稿：每段回累计字数与末尾'
      )
    }

    // 回给主智能体的回执不含全文
    {
      const mainReq = dumped().find(
        (b) =>
          !String(b.messages?.[0]?.content ?? '').startsWith('你是写作子智能体') &&
          (b.messages ?? []).some(
            (m) => m.role === 'tool' && String(m.content).includes('写手交稿')
          )
      )
      const receipt = String(
        (mainReq?.messages ?? []).find(
          (m) => m.role === 'tool' && String(m.content).includes('写手交稿')
        )?.content ?? ''
      )
      ok(
        receipt.includes('纪要：') && receipt.includes('伏笔线索') && receipt.includes('设定线索'),
        '回执带纪要与沉淀线索'
      )
      ok(!receipt.includes('正文全文：'), '回执不回灌正文全文')
    }
  }

  // 工具卡消息序列：派写手先落一张带任务简报的卡，写手的每一步（查人设 / 交稿 / 回改 / 回执）跟在后面，
  // 整章交回再落一张「写手交稿」卡
  let msgs = await invoke('message:list', book.id)
  const tools = msgs.filter((m) => m.meta?.kind === 'tool').map((m) => m.meta.tool)
  ok(
    tools.join(',') ===
      'get_write_context,write_chapter_draft,get_character,submit_draft,submit_draft,revise_draft,submit_draft,finish,write_chapter_draft,commit_chapter,patch_character_state,save_foreshadow,save_card,finish',
    `工具卡序列（${tools.join(',')}）`
  )
  const draftCards = msgs.filter(
    (m) => m.meta?.kind === 'tool' && m.meta.tool === 'write_chapter_draft'
  )
  const [dispatchCard, doneCard] = draftCards
  const excerpt = dispatchCard?.meta?.brief
  ok(
    draftCards.length === 2 &&
      typeof excerpt === 'string' &&
      excerpt.length === 121 &&
      excerpt.endsWith('…') &&
      dispatchCard.content.length > 120 &&
      dispatchCard.content.startsWith(excerpt.slice(0, 120)),
    `派写手卡：卡面露任务简报前 120 字，详情是全文（${dispatchCard?.meta?.summary}）`
  )
  ok(
    (doneCard?.meta?.summary ?? '').includes('字') &&
      doneCard?.meta?.brief === undefined &&
      String(doneCard?.content ?? '').includes('自检通过') &&
      !String(doneCard?.content ?? '').includes(ch.content.slice(0, 40)),
    `写手交稿卡带字数与自检结论、详情不带正文（${doneCard?.meta?.summary}）`
  )
  // 写手的卡（夹在派写手卡与交稿卡之间）带累计字数；所有工具卡的详情都不带没入书的正文
  {
    const writerCards = msgs.slice(msgs.indexOf(dispatchCard) + 1, msgs.indexOf(doneCard))
    const text = msgs
      .filter((m) => m.meta?.kind === 'tool')
      .map((m) => m.content)
      .join('\n')
    ok(
      writerCards.length === 6 &&
        writerCards.every((m) => typeof m.meta.words === 'number') &&
        writerCards.at(-1)?.meta?.words === ch.content.replace(/\s/g, '').length,
      `写手的每张卡带累计字数，收工那张等于入书字数（${writerCards.at(-1)?.meta.words}）`
    )
    ok(
      !text.includes(ch.content.slice(0, 40)) && !text.includes(ch.content.slice(-40)),
      '工具卡详情不带没入书的正文'
    )
  }

  // 节点消息：chapter（走向卡已废除，无 cards 节点）
  const steps = msgs.filter((m) => m.meta?.kind === 'job').map((m) => m.meta.step)
  ok(steps.join(',') === 'chapter', `节点消息序列（${steps.join(',')}）`)
  const chapterMsg = msgs.find((m) => m.meta?.kind === 'job' && m.meta.step === 'chapter')
  ok((chapterMsg?.content ?? '').includes('已入书'), `入书节点（${chapterMsg?.content}）`)

  // 沉淀：人物状态被 agent patch（name 兜底路径）
  const chars = await invoke('character:list', book.activeLineId)
  const lin = chars.find((c) => c.name === '林岸')
  ok(
    (lin?.state?.location ?? '') === '南屿货船·蔗糖舱',
    `人物状态被 patch（location=${lin?.state?.location}）`
  )

  // recap quickActions（commit_chapter 传入）
  ok((job.payload.recap?.quickActions ?? []).length === 1, 'recap.quickActions 来自 commit_chapter')

  // 沉淀带证据（M5）：桩给的 evidence 是本章原句才通过校验；伏笔默认埋在这一章，save_card 不再丢标签
  const wharf = (await invoke('card:list', book.activeLineId)).find(
    (c) => c.title === '雾津港七号泊位'
  )
  ok(!!wharf && (wharf.tags ?? []).includes('港口'), 'save_card 带原句证据落库，标签不丢')
  const knife = (await invoke('foreshadow:list', book.activeLineId)).find(
    (f) => f.title === '断刀的来历'
  )
  ok(
    !!knife && knife.plantedChapterId === detail.chapters[0].id,
    'save_foreshadow 带原句证据落库，埋设章默认记为原句所在章'
  )

  // ── chat free agent（带工具调用）──
  let cj = await invoke('job:startChat', book.id, '现在写到哪了？伏笔怎么安排？')
  cj = await waitJob(cj.id, (j) => j.state === 'done', 'chat free agent')
  ok(
    (cj.payload.answer ?? '').includes('沈') || (cj.payload.answer ?? '').length > 20,
    'chat agent 回答非空'
  )

  msgs = await invoke('message:list', book.id)
  const chatTools = msgs.filter((m) => m.meta?.kind === 'tool' && m.meta.jobId === cj.id)
  ok(
    chatTools.length >= 1 && chatTools[0].meta.tool === 'list_chapters',
    'chat agent 用了 list_chapters 工具'
  )

  // 导演系统提示（每轮重建）：带文风与记忆简报（梗概 + 主要人物名单）
  {
    const chatReq = dumped().find((b) =>
      b.messages?.some((m) => m.role === 'user' && String(m.content).includes('现在写到哪了'))
    )
    const system = String(chatReq?.messages?.[0]?.content ?? '')
    ok(
      system.includes('## 文风') && system.includes('记忆简报') && system.includes('林岸雾夜藏身'),
      '导演系统提示带文风与前情梗概'
    )
    ok(system.includes('主要人物：林岸（主角）'), '导演系统提示带主要人物名单')
    ok(
      system.includes('## 记忆简报') &&
        system.indexOf('## 文风') < system.indexOf('## 记忆简报') &&
        system.indexOf('## 工具纪律') < system.indexOf('## 记忆简报'),
      '稳定内容在前、记忆简报在后'
    )
    ok(
      system.includes('先查再答') &&
        system.includes('get_write_context / get_character / get_card') &&
        system.includes('长期偏好') &&
        system.includes('save_card 存成钉选卡'),
      '聊天纪律：先查再答、查不到明说、作者长期偏好存钉选卡'
    )
  }

  // 用户动作消息（role=user）触发草稿转正：写章+chat 后书必须是正书
  const bookNow = await invoke('book:get', book.id)
  ok(bookNow?.book?.draft === false, '用户发言后草稿书转正（draft=false）')

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
    ok(
      (sCards[0].meta.summary ?? '').includes('调查员回报'),
      `spawn_subagent 卡带回合数（${sCards[0].meta.summary}）`
    )
  }

  console.log(`\n[M6 冒烟] ${passed} 通过 / ${failed} 失败`)
} catch (err) {
  console.error('\n[M6 冒烟] 异常:', err.message)
  failed++
} finally {
  await killAll()
}
process.exitCode = failed ? 1 : 0
