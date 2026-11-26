// 长期记忆冒烟（阶段一「堵漏」）：旧库迁移、合并式前情梗概、写作简报注入、改稿刷新纪要、
// 沉淀证据校验、callJson 重试、分叉与删章。不起 dist 服务——直接调 dist 里的模块，
// 模型请求打到本进程内的桩（端口 3980）。须先 npm run build（冒烟打的是 dist）。

import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { removeTempDir } from './temp-dir.mjs'

const root = process.cwd()
const STUB_PORT = 3980
const DATA = mkdtempSync(join(tmpdir(), 'nm-memory-smoke-'))
process.env.NM_DATA_DIR = DATA
writeFileSync(
  join(DATA, 'settings.json'),
  JSON.stringify({
    server: { port: STUB_PORT },
    provider: 'custom',
    profiles: {
      custom: { baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, defaultModel: 'stub-model' }
    },
    apiKeys: { custom: 'stub-key' }
  })
)

let failed = 0
let passed = 0
const ok = (name, cond) => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
}
const url = (file) => pathToFileURL(join(root, 'dist/main', file)).href
const dbMod = await import(url('db.js'))
const store = await import(url('store.js'))

// ── ① 旧结构造库：先用现行代码建一个全新库，再把 memories 退回旧结构（去掉新列、版本号回 1）──
dbMod.getDb()
dbMod.closeDb()
const raw = new DatabaseSync(join(DATA, 'novel.db'))
raw.exec('ALTER TABLE memories DROP COLUMN kind')
raw.exec('ALTER TABLE memories DROP COLUMN last_chapter_id')
raw.exec('PRAGMA user_version = 1')
const now = Date.now()
raw
  .prepare(
    'INSERT INTO books (id, title, active_line_id, draft, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)'
  )
  .run('old-book', '老书', 'old-line', now, now)
raw
  .prepare('INSERT INTO lines (id, book_id, name, created_at) VALUES (?, ?, ?, ?)')
  .run('old-line', 'old-book', '主线', now)
const oldCh = raw.prepare(
  'INSERT INTO chapters (id, line_id, parent_chapter_id, order_no, title, content, word_count, summary, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)'
)
for (const n of [1, 2, 3]) {
  oldCh.run(
    `old-ch${n}`,
    'old-line',
    n > 1 ? `old-ch${n - 1}` : '',
    n,
    `第${n}章`,
    `第${n}章的正文。断刀刻着「沈」字。`,
    `第${n}章的旧纪要。`,
    '{}',
    now,
    now
  )
}
const oldMem = raw.prepare(
  'INSERT INTO memories (id, line_id, from_order, to_order, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
)
oldMem.run('old-mem-1', 'old-line', 13, 16, '旧压缩块甲：林岸离开雾津港。', now)
oldMem.run('old-mem-2', 'old-line', 17, 20, '旧压缩块乙：抵达南屿。', now)
raw.close()

// ── 本进程内的模型桩：按系统提示的身份应答，并记下每个请求 ──────────────────
const seen = []
const queue = []
let recapCalls = 0
let summaryCalls = 0
let badJsonPending = false
let callSeq = 0
const userText = (messages) =>
  (messages ?? [])
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content)
    .join('\n')
const llm = createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }))
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const parsed = JSON.parse(body)
    const system = parsed.messages?.find((m) => m.role === 'system')?.content ?? ''
    const user = userText(parsed.messages)
    seen.push({ system, user, messages: parsed.messages })
    let text = '{}'
    let toolCalls = null
    if (system.includes('你是前情梗概维护员')) {
      // 每次合并回一份带版号的梗概：断言「原地更新」时看得出换没换
      recapCalls += 1
      text = JSON.stringify({
        plot: `主线第${recapCalls}版`,
        foreshadowsOpen: '断刀的来历',
        foreshadowsResolved: '',
        relations: '林岸与老船工互相警惕',
        timePlace: '货船蔗糖舱'
      })
    } else if (system.includes('你是章纪要维护员')) {
      summaryCalls += 1
      text = JSON.stringify({ summary: `改稿后的纪要第${summaryCalls}版` })
    } else if (user.includes('BADJSON-PROBE')) {
      // 第一次回一段不是 JSON 的话，第二次才给合法 JSON
      if (badJsonPending) text = '{"ok":true}'
      else {
        badJsonPending = true
        text = '这不是 JSON，只是一段话。'
      }
    } else {
      // 其余请求（agent 循环）按队列走：{ text } 纯文本，{ toolCalls } 工具调用
      const item = queue.shift() ?? {}
      if (item.toolCalls) toolCalls = item.toolCalls
      else text = item.text ?? '{}'
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    if (toolCalls) {
      callSeq += 1
      res.write(
        `data: ${JSON.stringify({
          model: 'stub-model',
          choices: [
            {
              delta: {
                role: 'assistant',
                tool_calls: toolCalls.map((t, i) => ({
                  index: i,
                  id: `call_${callSeq}_${i}`,
                  type: 'function',
                  function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) }
                }))
              }
            }
          ]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          model: 'stub-model',
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 100, completion_tokens: 300 }
        })}\n\n`
      )
    } else {
      for (let i = 0; i < text.length; i += 40)
        res.write(
          `data: ${JSON.stringify({
            model: 'stub-model',
            choices: [{ delta: { content: text.slice(i, i + 40) } }]
          })}\n\n`
        )
      res.write(
        `data: ${JSON.stringify({
          model: 'stub-model',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 300 }
        })}\n\n`
      )
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

try {
  llm.listen(STUB_PORT)
  // ── ① 升级：旧行全部变成 legacy 且仍在，升级前留了快照 ──
  const db = dbMod.getDb()
  const memCols = db
    .prepare('PRAGMA table_info(memories)')
    .all()
    .map((c) => c.name)
  ok(
    'memories 补了 kind / last_chapter_id 两列',
    memCols.includes('kind') && memCols.includes('last_chapter_id')
  )
  ok('结构版本号升到 2', db.prepare('PRAGMA user_version').get().user_version === 2)
  const oldRows = db.prepare('SELECT id, kind, content FROM memories ORDER BY id').all()
  ok(
    '旧 memories 行全部变成 legacy 且内容原样保留',
    oldRows.length === 2 &&
      oldRows.every((r) => r.kind === 'legacy') &&
      oldRows[0].content.includes('旧压缩块甲') &&
      oldRows[1].content.includes('旧压缩块乙')
  )
  ok(
    '升级前自动留了快照',
    readdirSync(DATA).some((f) => f.startsWith('backup-pre-migrate-'))
  )
  ok(
    '新列有默认值',
    db
      .prepare('SELECT DISTINCT last_chapter_id FROM memories')
      .all()
      .every((r) => r.last_chapter_id === '')
  )

  const { buildWriteContext, buildStoryBrief } = await import(url('director/context.js'))
  const recap = await import(url('director/storyRecap.js'))
  const book = store.getBook('old-book')
  const main = 'old-line'
  const addChapter = (lineId, title, summary) => {
    const prev = store.listChapters(lineId).at(-1)
    return store.insertChapter({
      lineId,
      parentChapterId: prev?.id ?? '',
      title,
      content: `${title}的正文。老船工提灯下舱。`,
      summary,
      meta: {}
    })
  }

  // ── 还没有 running 梗概：回退到旧压缩块（旧行为）──
  const before = buildWriteContext(book, main)
  ok(
    '没有 running 梗概时回退注入旧压缩块',
    before.includes('更早前情（压缩摘要）') && before.includes('旧压缩块甲')
  )

  // ── ② 首次合并：生成一行 running；旧压缩块当参考材料 ──
  const legacyCount = () => store.listMemories(main, 'legacy').length
  recap.scheduleStoryRecap(main)
  await recap.storyRecapSettled()
  const first = store.getRunningMemory(main)
  ok(
    '入书后生成一行 running 梗概',
    !!first && first.kind === 'running' && first.content.includes('主线第1版')
  )
  ok(
    '覆盖章号记到最新一章（第 3 章）',
    !!first && first.toOrder === 3 && first.lastChapterId === 'old-ch3' && first.fromOrder === 1
  )
  ok('旧压缩块不再新增（仍是 2 块）', legacyCount() === 2)
  const firstMerge = seen.find((s) => s.system.includes('前情梗概维护员'))
  ok(
    '首次合并带上了旧压缩块作参考',
    !!firstMerge &&
      firstMerge.user.includes('旧压缩块甲') &&
      firstMerge.user.includes('第3章的旧纪要')
  )

  // ── ③ 简报注入的是 running 梗概，旧压缩块让位 ──
  const after = buildWriteContext(book, main)
  ok(
    '简报注入 running 梗概（整段，标明覆盖范围）',
    after.includes('前情梗概（第 1-3 章）') && after.includes('主线第1版')
  )
  ok('有 running 后不再注入旧压缩块', !after.includes('更早前情（压缩摘要）'))

  // ── ② 再次入书：原地更新，不是追加 ──
  const ch4 = addChapter(main, '第4章', '第4章的纪要：船到南屿。')
  recap.scheduleStoryRecap(main)
  await recap.storyRecapSettled()
  const second = store.getRunningMemory(main)
  ok(
    '再次入书是原地更新（同一行 id，内容已换）',
    !!second && !!first && second.id === first.id && second.content.includes('主线第2版')
  )
  ok('覆盖章号前进到第 4 章', !!second && second.toOrder === 4 && second.lastChapterId === ch4.id)
  ok('没有追加新行（仍是 2 块 legacy + 1 行 running）', store.listMemories(main).length === 3)
  ok(
    '合并材料带了新章纪要和结尾原文',
    seen
      .filter((s) => s.system.includes('前情梗概维护员'))
      .at(-1)
      .user.includes('船到南屿') &&
      seen
        .filter((s) => s.system.includes('前情梗概维护员'))
        .at(-1)
        .user.includes('老船工提灯下舱')
  )
  const callsBefore = seen.length
  recap.scheduleStoryRecap(main)
  await recap.storyRecapSettled()
  ok('没有新章时再触发不调模型', seen.length === callsBefore)

  // ── ③ 写作简报：本章点名的出场人物带人设，相关设定卡带完整 data，已批准的计划进简报 ──
  store.saveCharacter({
    lineId: main,
    name: '林岸',
    role: '主角',
    data: { 背景: '前水手，父亲留下断刀', 性格: '能忍，出手狠' },
    state: { location: '蔗糖舱' },
    relations: [{ to: '老船工', label: '警惕' }]
  })
  store.saveCharacter({
    lineId: main,
    name: '蓑衣老船工',
    role: '关键配角',
    data: { 背景: '南屿货船上的老船工' }
  })
  store.saveCard({
    lineId: main,
    kind: 'geography',
    title: '南屿',
    readerText: '悬赏画像贴满码头',
    data: { 泊位: [{ 名称: '七号泊位', 用途: '私货' }] }
  })
  store.saveCard({ lineId: main, kind: 'item', title: '无关的卡', readerText: '不相关' })
  const focusBrief = buildStoryBrief(book, main, {
    text: '林岸随船抵达南屿，码头上的悬赏画像……',
    plan: '- **走向**：老船工试探林岸'
  })
  ok(
    '出场人物带人设 data 与现状',
    focusBrief.includes('本章出场人物') &&
      focusBrief.includes('人设：背景：前水手') &&
      focusBrief.includes('location=蔗糖舱')
  )
  ok('没点名的人物只进人物现状、不带人设', !focusBrief.includes('南屿货船上的老船工'))
  ok(
    '相关设定卡带完整 data',
    focusBrief.includes('本章相关设定卡') &&
      focusBrief.includes('悬赏画像贴满码头') &&
      focusBrief.includes('"名称":"七号泊位"')
  )
  ok('没被本章提到的设定卡不进相关卡', !focusBrief.includes('无关的卡'))
  ok(
    '已批准的本章计划进简报',
    focusBrief.includes('本章计划（作者已批准') && focusBrief.includes('老船工试探林岸')
  )
  const plainBrief = buildWriteContext(book, main)
  ok(
    '通用简报（get_write_context）不带本章专属段',
    !plainBrief.includes('本章出场人物') &&
      !plainBrief.includes('本章计划') &&
      plainBrief.includes('主线第2版')
  )

  // ── 写手提示：吃同一份简报，文风范例在末尾，过时措辞已去掉 ──
  const { draftPrompt } = await import(url('director/steps.js'))
  store.updateBook(book.id, { styleSample: '短句。短句。雾很重。' })
  const writerBook = store.getBook(book.id)
  const outline = { title: '夜探', synopsis: '林岸夜探南屿码头', beats: ['登岸'] }
  const prompt = draftPrompt({
    book: writerBook,
    lineId: main,
    outline,
    scenes: null,
    direction: { source: 'free', text: '作者：多写雾' }
  })
  ok(
    '写手提示带出场人物人设与走向交代',
    prompt.user.includes('本章出场人物') &&
      prompt.user.includes('人设：背景：前水手') &&
      prompt.user.includes('本章走向与作者交代\n作者：多写雾')
  )
  ok('写手提示带前情梗概', prompt.user.includes('主线第2版'))
  ok('过时措辞「作者选定的走向」已去掉', !prompt.user.includes('作者选定的走向'))
  ok(
    '文风范例在提示末尾（大纲之后、动笔指令之前）',
    prompt.user.includes('文风范例') &&
      prompt.user.includes('短句。短句。雾很重。') &&
      prompt.user.indexOf('文风范例') > prompt.user.indexOf('## 本章大纲') &&
      prompt.user.trimEnd().endsWith('现在，写本章正文。')
  )
  const silent = draftPrompt({
    book: writerBook,
    lineId: main,
    outline,
    scenes: null,
    direction: { source: 'free', text: '' }
  })
  ok('作者没给倾向时不硬造走向段', !silent.user.includes('本章走向与作者交代'))
  const planned = draftPrompt({
    book: writerBook,
    lineId: main,
    outline,
    scenes: null,
    direction: { source: 'free', text: '' },
    plan: '- **走向**：按批准的计划写'
  })
  ok(
    '计划模式下写手提示带已批准的计划',
    planned.user.includes('本章计划（作者已批准') && planned.user.includes('按批准的计划写')
  )

  // ── ⑦ 分叉：新线有自己的梗概，此后各线独立演化 ──
  const forkA = store.forkLine(book.id, ch4.id, '甲线', '')
  const runA = store.getRunningMemory(forkA.id)
  ok(
    '分叉线拷到一份自己的梗概（内容相同、行不同）',
    !!runA && runA.id !== second.id && runA.content === second.content && runA.kind === 'running'
  )
  const ch5 = addChapter(forkA.id, '甲线第5章', '甲线第5章的纪要。')
  recap.scheduleStoryRecap(forkA.id)
  await recap.storyRecapSettled()
  ok(
    '新线入书后更新的是自己的梗概，原线不受影响',
    store.getRunningMemory(forkA.id).content.includes('主线第3版') &&
      store.getRunningMemory(main).content.includes('主线第2版')
  )
  ok(
    '分叉线自己的章序号从 1 重排，覆盖位置仍按有效章序列记',
    store.getRunningMemory(forkA.id).toOrder === 5
  )
  // 从更早的章分叉：原线梗概盖过分叉点，不能带过去（会泄露分叉点之后的剧情）
  store.activateLine(book.id, main)
  const forkB = store.forkLine(book.id, 'old-ch2', '乙线', '')
  ok('盖过分叉点的梗概不拷给新线', store.getRunningMemory(forkB.id) === null)
  recap.scheduleStoryRecap(forkB.id)
  await recap.storyRecapSettled()
  const runB = store.getRunningMemory(forkB.id)
  ok(
    '新线按自己的有效章重建梗概（只盖到分叉点第 2 章）',
    !!runB && runB.toOrder === 2 && runB.lastChapterId === 'old-ch2'
  )

  // ── 删末章：盖到被删章的梗概删掉；下次取写作上下文时后台补建 ──
  store.activateLine(book.id, forkA.id)
  const removed = store.deleteLastChapter(forkA.id)
  ok('删掉的正是梗概覆盖到的那一章', removed.id === ch5.id)
  ok('梗概盖到了被删的章 → running 行删掉，旧压缩块不动', store.getRunningMemory(forkA.id) === null)
  const { execTool } = await import(url('agent/tools.js'))
  const ctx = buildWriteContext(book, forkA.id)
  ok('补建之前的简报里没有前情梗概', !ctx.includes('主线第'))
  const toolRes = execTool('get_write_context', {}, { bookId: book.id })
  await recap.storyRecapSettled()
  const rebuilt = store.getRunningMemory(forkA.id)
  ok(
    '取写作上下文后后台补建（按现有 4 章重建）',
    !!rebuilt && rebuilt.toOrder === 4 && rebuilt.lastChapterId === ch4.id
  )
  ok('取上下文当次返回的仍是补建前的内容（不阻塞）', toolRes.ok && toolRes.data.includes(ctx))
  ok('删章后没有动旧压缩块', legacyCount() === 2)

  // ── ⑥ callJson 重试：原消息原样保留，上次输出与纠错说明追加在后 ──
  const { callJson } = await import(url('director/callJson.js'))
  const probeStart = seen.length
  const probed = await callJson({
    slot: 'utility',
    system: '你是测试助手，只输出 JSON。',
    user: 'BADJSON-PROBE 原始材料：断刀刻着「沈」字，老船工点破悬赏。',
    jsonHint: '{"ok":true}'
  })
  const retryReq = seen[seen.length - 1]
  const turns = retryReq.messages.filter((m) => m.role !== 'system')
  ok('第一次不合规、第二次拿到合法 JSON', probed.ok === true && seen.length === probeStart + 2)
  ok(
    '重试请求保留原 user 消息（原材料还在）',
    turns[0].role === 'user' &&
      turns[0].content.includes('BADJSON-PROBE') &&
      turns[0].content.includes('断刀刻着「沈」字')
  )
  ok(
    '重试请求在原消息后追加了上次输出与纠错说明',
    turns.length === 3 &&
      turns[1].role === 'assistant' &&
      turns[1].content.includes('这不是 JSON') &&
      turns[2].role === 'user' &&
      turns[2].content.includes('不是合法 JSON')
  )

  // ── ④ 改稿后刷新纪要：走 agent 的 revise_chapter（改章任务走的是同一个后台入口）──
  const { runAgentLoop, interceptorDefs } = await import(url('agent/loop.js'))
  const { toolDefs } = await import(url('agent/tools.js'))
  const summaryBefore = store.getChapter('old-ch2').summary
  queue.push(
    {
      toolCalls: [
        {
          name: 'revise_chapter',
          arguments: { chapterId: 'old-ch2', instruction: '把刻痕写细一点' }
        }
      ]
    },
    {
      text: JSON.stringify({
        edits: [{ find: '断刀刻着「沈」字', replace: '断刀上刻着被磨掉一半的「沈」字' }]
      })
    },
    { toolCalls: [{ name: 'finish', arguments: { message: '改好了' } }] }
  )
  const runMainBefore = store.getRunningMemory(main)
  const said = []
  const loopRes = await runAgentLoop({
    jobId: 'smoke-revise',
    bookId: book.id,
    task: '把第 2 章断刀的细节改细一点',
    history: [],
    mode: 'free',
    tools: [...toolDefs(), ...interceptorDefs('free')],
    say: (content, meta) => said.push({ content, meta })
  })
  await recap.storyRecapSettled()
  const ch2After = store.getChapter('old-ch2')
  ok(
    '改稿生效（局部替换命中）',
    loopRes.text === '改好了' && ch2After.content.includes('被磨掉一半的「沈」字')
  )
  ok(
    '改稿后章纪要按新正文重写',
    ch2After.summary === '改稿后的纪要第1版' && summaryBefore !== ch2After.summary
  )
  const reviseMerge = seen.filter((s) => s.system.includes('前情梗概维护员')).at(-1)
  ok(
    '梗概做了增量合并（说明本章已改稿，以新纪要为准）',
    reviseMerge.user.includes('已改稿的章') &&
      reviseMerge.user.includes('第2章《第2章》：改稿后的纪要第1版')
  )
  const runMainAfter = store.getRunningMemory(main)
  ok(
    '合并更新的是原线梗概，覆盖章号不变',
    runMainAfter.id === runMainBefore.id &&
      runMainAfter.content.includes('主线第6版') &&
      runMainAfter.toOrder === 4
  )
  ok('别的章的纪要不动', store.getChapter('old-ch1').summary === '第1章的旧纪要。')
  ok(
    '改章工具卡告诉 agent：纪要与梗概会在后台刷新',
    said.some((s) => s.meta?.tool === 'revise_chapter' && s.content.includes('后台按新正文刷新'))
  )

  console.log(`\n[长期记忆冒烟] ${passed} 通过 / ${failed} 失败`)
} catch (e) {
  ok(`异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, false)
} finally {
  llm.close()
  try {
    dbMod.closeDb()
  } catch {}
  await removeTempDir(DATA)
}
process.exitCode = failed ? 1 : 0
