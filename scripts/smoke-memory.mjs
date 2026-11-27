// 长期记忆冒烟（阶段一「堵漏」）：旧库迁移、合并式前情梗概、写作简报注入、改稿刷新纪要、
// 沉淀证据校验、callJson 重试、分叉与删章、改到子线继承的章时子线梗概重建。
// 不起 dist 服务——直接调 dist 里的模块，模型请求打到本进程内的桩（端口 3980）。
// 须先 npm run build（冒烟打的是 dist）。

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
let holdNext = null
let holdSummaryNext = null
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
  req.on('end', async () => {
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
    // 「扣住下一次合并应答」：测试在合并进行中去换库，验证换库前算出的结果不会落库
    if (holdNext && system.includes('你是前情梗概维护员')) {
      const hold = holdNext
      holdNext = null
      hold.arrived()
      await hold.release
    }
    // 「扣住下一次章纪要应答」：让原线重写纪要停在半路，验证这期间子线重建不会并进旧纪要
    if (holdSummaryNext && system.includes('你是章纪要维护员')) {
      const hold = holdSummaryNext
      holdSummaryNext = null
      hold.arrived()
      await hold.release
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
  // 最常见的情形：改的正是梗概覆盖到的最新一章（回归：位置比较差一位时会漏掉）
  store.replaceChapterContent(ch4.id, '第4章改稿后的正文。老船工提灯下舱。')
  recap.noteRevisedChapter(ch4.id)
  await recap.storyRecapSettled()
  ok(
    '改的是最新一章（梗概盖到的那章）也重写纪要并重并',
    store.getChapter(ch4.id).summary === '改稿后的纪要第2版' &&
      store.getRunningMemory(main).content.includes('主线第7版') &&
      store.getRunningMemory(main).toOrder === 4
  )

  // ── ⑤ 沉淀证据校验：写章任务里 save_card / save_foreshadow 必须附本章原句 ──
  // 此刻 main 上：第 1 章原样，第 2 章已改稿，第 4 章是最新一章（正文「老船工提灯下舱」）
  store.activateLine(book.id, main)
  const writing = { bookId: book.id, requireEvidence: true }
  const cardTitles = () => store.listCards(main).map((c) => c.title)
  const foreTitles = () => store.listForeshadows(main).map((f) => f.title)
  const forged = execTool(
    'save_card',
    {
      kind: 'custom',
      title: '伪造的卡',
      authorText: '正文里没有的事',
      evidence: '这句原话正文里根本没有'
    },
    writing
  )
  ok(
    '伪造的原句被拒',
    forged.ok === false && forged.summary.includes('原句') && !cardTitles().includes('伪造的卡')
  )
  const bare = execTool('save_card', { kind: 'custom', title: '没带证据的卡' }, writing)
  ok(
    '没附原句被拒并说明要补 evidence',
    bare.ok === false && bare.data.includes('evidence') && !cardTitles().includes('没带证据的卡')
  )
  const spliced = execTool(
    'save_card',
    { kind: 'custom', title: '拼接的卡', evidence: '第4章的正文……老船工提灯下舱' },
    writing
  )
  ok('用省略号拼接的两处不算连续原句', spliced.ok === false && !cardTitles().includes('拼接的卡'))
  const tiny = execTool(
    'save_card',
    { kind: 'custom', title: '太短的卡', evidence: '提灯' },
    writing
  )
  ok('过短的片语被拒', tiny.ok === false && tiny.data.includes('6 个字'))
  const wrongChapter = execTool(
    'save_card',
    { kind: 'custom', title: '章号点错的卡', evidence: '断刀上刻着被磨掉一半的', chapterNo: 1 },
    writing
  )
  ok(
    '原句不在所指定的那一章 → 拒',
    wrongChapter.ok === false && !cardTitles().includes('章号点错的卡')
  )
  const outOfRange = execTool(
    'save_card',
    { kind: 'custom', title: '章号越界的卡', evidence: '老船工提灯下舱', chapterNo: 99 },
    writing
  )
  ok(
    '章号越界不会悄悄退回最新一章核对 → 拒',
    outOfRange.ok === false &&
      outOfRange.summary.includes('章节对不上') &&
      !cardTitles().includes('章号越界的卡')
  )
  const quoted = execTool(
    'save_card',
    {
      kind: 'custom',
      title: '引号变体的卡',
      evidence: '断刀上刻着被磨掉一半的“沈”字',
      chapterId: 'old-ch2'
    },
    writing
  )
  ok(
    '引号写法不同（“”↔「」）仍算原句；chapterId 指到对应章',
    quoted.ok === true && cardTitles().includes('引号变体的卡')
  )
  const real = execTool(
    'save_card',
    {
      kind: 'custom',
      title: '真设定',
      authorText: '老船工夜里下舱',
      evidence: '……老船工提灯下舱……',
      tags: ['夜航'],
      data: { 下舱: [{ 时间: '夜', 地点: '蔗糖舱' }] }
    },
    writing
  )
  const saved = store.listCards(main).find((c) => c.title === '真设定')
  ok('真实原句通过（不传章=最新一章，首尾省略号不影响）', real.ok === true && !!saved)
  ok(
    'save_card 不再丢 data / tags',
    !!saved && saved.tags.includes('夜航') && JSON.stringify(saved.data).includes('蔗糖舱')
  )
  const noEvidence = execTool(
    'save_card',
    { kind: 'custom', title: '聊天里点名要存的卡' },
    { bookId: book.id }
  )
  ok(
    '聊天模式（作者点名）不要求证据',
    noEvidence.ok === true && cardTitles().includes('聊天里点名要存的卡')
  )
  const fore = execTool(
    'save_foreshadow',
    { title: '悬赏画像', detail: '老船工点破悬赏已送南屿', evidence: '老船工提灯下舱' },
    writing
  )
  const planted = store.listForeshadows(main).find((f) => f.title === '悬赏画像')
  ok(
    'save_foreshadow 带原句通过，埋设章默认记为原句所在章',
    fore.ok === true && !!planted && planted.plantedChapterId === ch4.id
  )
  const fakeFore = execTool(
    'save_foreshadow',
    { title: '假伏笔', detail: 'x', evidence: '不存在的原话' },
    writing
  )
  ok('save_foreshadow 原句对不上 → 拒', fakeFore.ok === false && !foreTitles().includes('假伏笔'))

  // ── 合并进行中恢复备份（库被换掉）：换库前算出的结果不落库，之后重新触发才追平 ──
  const beforeSwap = store.getRunningMemory(main)
  addChapter(main, '第5章', '第5章的纪要：船靠南屿。')
  let release = () => {}
  const gate = new Promise((r) => (release = r))
  let announce = () => {}
  const held = new Promise((r) => (announce = r))
  holdNext = { arrived: announce, release: gate }
  recap.scheduleStoryRecap(main)
  await held
  dbMod.closeDb() // 恢复备份的实质：关连接、换库文件、下次用到再打开
  release()
  await recap.storyRecapSettled()
  const afterSwap = store.getRunningMemory(main)
  ok(
    '合并进行中换库：换库前算出的梗概不落库',
    afterSwap.id === beforeSwap.id &&
      afterSwap.content === beforeSwap.content &&
      afterSwap.toOrder === beforeSwap.toOrder
  )
  recap.scheduleStoryRecap(main)
  await recap.storyRecapSettled()
  ok('换库稳定后再触发才追平', store.getRunningMemory(main).toOrder === 5)

  // ── ⑧ 改到子线也继承的章（在分叉点之前）：子线的前情梗概安排重建 ──
  const book2 = store.createBook({ title: '继承章改稿' })
  const main2 = book2.activeLineId
  addChapter(main2, '甲一', '甲一的纪要。')
  const x2 = addChapter(main2, '甲二', '甲二的旧纪要。')
  const x3 = addChapter(main2, '甲三', '甲三的纪要。')
  const x4 = addChapter(main2, '甲四', '甲四的纪要。')
  recap.scheduleStoryRecap(main2)
  await recap.storyRecapSettled()
  const sub = store.forkLine(book2.id, x3.id, '子线', '').id
  recap.scheduleStoryRecap(sub)
  await recap.storyRecapSettled()
  const subRun = store.getRunningMemory(sub)
  ok(
    '分叉于甲三之后：两条线各有自己的梗概（子线只盖到分叉点第 3 章）',
    !!store.getRunningMemory(main2) &&
      !!subRun &&
      subRun.toOrder === 3 &&
      subRun.lastChapterId === x3.id
  )
  // 给子线补一块旧压缩块：验证只动 running 行
  dbMod
    .getDb()
    .prepare(
      `INSERT INTO memories (id, line_id, from_order, to_order, content, created_at, kind, last_chapter_id)
       VALUES ('sub-legacy', ?, 1, 2, '子线的旧压缩块', 0, 'legacy', '')`
    )
    .run(sub)

  // 改主线的甲二（子线也继承）
  const main2Before = store.getRunningMemory(main2)
  const recapsBefore = recapCalls
  store.replaceChapterContent(x2.id, '甲二改稿后的正文。')
  recap.noteRevisedChapter(x2.id)
  ok('改到子线也继承的章：子线的 running 行当场删掉', store.getRunningMemory(sub) === null)
  await recap.storyRecapSettled()
  const x2Summary = store.getChapter(x2.id).summary
  const main2After = store.getRunningMemory(main2)
  ok(
    '原线：纪要按新正文重写，梗概增量更新（同一行、内容换新）',
    x2Summary.startsWith('改稿后的纪要第') &&
      main2After.id === main2Before.id &&
      main2After.content !== main2Before.content
  )
  ok(
    '子线：只删 running 行，旧压缩块不动；不当场重建（只调了原线那一次模型）',
    store.getRunningMemory(sub) === null &&
      store.listMemories(sub, 'legacy').some((m) => m.content === '子线的旧压缩块') &&
      recapCalls === recapsBefore + 1
  )

  // 对子线触发一次补建：整份重建，直接用原线重写好的新纪要
  const summariesBefore = summaryCalls
  recap.scheduleStoryRecap(sub)
  await recap.storyRecapSettled()
  const subRebuilt = store.getRunningMemory(sub)
  const subMerge = seen.filter((s) => s.system.includes('前情梗概维护员')).at(-1)
  ok(
    '子线：触发一次补建后梗概重建出来（仍只盖到分叉点第 3 章）',
    !!subRebuilt &&
      subRebuilt.toOrder === 3 &&
      subRebuilt.lastChapterId === x3.id &&
      subRebuilt.content.includes(`主线第${recapCalls}版`)
  )
  ok(
    '重建是整份重建（不在旧梗概上增量合并），用的是改稿后的新纪要',
    !subMerge.user.includes('现有前情梗概') &&
      !subMerge.user.includes('甲二的旧纪要') &&
      subMerge.user.includes(`第2章《甲二》：${x2Summary}`) &&
      summaryCalls === summariesBefore
  )

  // 改甲四（分叉点之后，子线不包含）：子线不受影响
  const subKept = store.getRunningMemory(sub)
  store.replaceChapterContent(x4.id, '甲四改稿后的正文。')
  recap.noteRevisedChapter(x4.id)
  await recap.storyRecapSettled()
  const subUnchanged = store.getRunningMemory(sub)
  ok(
    '改分叉点之后的章（子线不包含）：子线梗概不受影响，也不为它调模型',
    !!subUnchanged &&
      subUnchanged.id === subKept.id &&
      subUnchanged.content === subKept.content &&
      recapCalls === recapsBefore + 3
  )

  // 子线的合并正在进行时改到它继承的章：在跑的那步不写回，下一步整份重建。
  // 把原线重写纪要扣在半路：这期间子线重建得自己按新正文重写，不能并进旧纪要
  const subC1 = addChapter(sub, '子线新一', '子线新一的纪要。')
  const recapSeen = () => seen.filter((s) => s.system.includes('前情梗概维护员'))
  // 扣住桩的一次应答：桩在请求到达时调 arrived()，随后 await release；测试这边等 arrivedP、调 letGo() 放行
  const newHold = () => {
    const h = { arrived: () => {}, release: Promise.resolve(), letGo: () => {}, arrivedP: null }
    h.arrivedP = new Promise((r) => (h.arrived = r))
    h.release = new Promise((r) => (h.letGo = r))
    return h
  }
  const recapsHeld = recapCalls
  const summariesHeld = summaryCalls
  const heldMerge = newHold()
  holdNext = heldMerge
  recap.scheduleStoryRecap(sub)
  await heldMerge.arrivedP
  const heldRequest = recapSeen().at(-1)
  const heldSummary = newHold()
  holdSummaryNext = heldSummary
  store.replaceChapterContent(x2.id, '甲二第二次改稿的正文。')
  recap.noteRevisedChapter(x2.id)
  await heldSummary.arrivedP
  const heldRebuild = newHold()
  holdNext = heldRebuild
  heldMerge.letGo()
  await heldRebuild.arrivedP
  ok(
    '合并进行中改到它继承的章：在跑的那步作废不写回（此刻子线仍没有梗概行）',
    store.getRunningMemory(sub) === null
  )
  const x2Resummarized = store.getChapter(x2.id).summary
  heldSummary.letGo()
  heldRebuild.letGo()
  await recap.storyRecapSettled()
  const subAfter = store.getRunningMemory(sub)
  const rebuildRequest = recapSeen().slice(recapSeen().indexOf(heldRequest) + 1)[0]
  ok(
    '随后整份重建（不带旧梗概），盖到子线第 4 章',
    recapCalls === recapsHeld + 3 &&
      !!subAfter &&
      subAfter.toOrder === 4 &&
      subAfter.lastChapterId === subC1.id &&
      subAfter.content.includes(`主线第${recapsHeld + 2}版`) &&
      !rebuildRequest.user.includes('现有前情梗概')
  )
  ok(
    '原线还没写完纪要时，子线重建自己按新正文重写这一章（不并进旧纪要）',
    summaryCalls === summariesHeld + 2 &&
      x2Resummarized !== x2Summary &&
      rebuildRequest.user.includes(`第2章《甲二》：${x2Resummarized}`) &&
      store.getChapter(x2.id).summary !== x2Summary
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
