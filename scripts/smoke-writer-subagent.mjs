/**
 * 写作子智能体冒烟（API 级）：主智能体只写任务简报，正文由写作子智能体分段交稿、自检退回自己改、交结构化回执。
 * 覆盖：简报过短/过长被拒、分段累计与进度、自检退回 → revise_draft → 通过、回执证据校验（对/错各一）、
 * 回执不含全文、read_last_draft、超轮带报告入书、写手没交稿 / 纯文本兜底、取消、edits 直改、brief 整章重写、startRevise 兜底。
 * 自带按身份行路由的桩（端口 3976），不占公共桩 3923；须先 npm run build（打的是 dist）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir, stopChild } from './temp-dir.mjs'

const PORT = 3975
const STUB_PORT = 3976
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(join(tmpdir(), 'nm-writer-smoke-'))
writeFileSync(
  join(dataDir, 'settings.json'),
  JSON.stringify({
    server: { port: PORT },
    provider: 'custom',
    profiles: {
      custom: { baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, defaultModel: 'stub-model' }
    },
    apiKeys: { custom: 'stub-key' }
  })
)

// ── 素材 ─────────────────────────────────────────────────────────────────────

const GOOD_BRIEF =
  '林岸天亮前回到雾津港，在潮汐灯塔下与守塔人老周碰头，想借他的船出港。盐帮的追踪者顺着退潮的滩涂摸过来，老周关灯引他们搁浅，林岸在灯室里发现一条通往海蚀洞的暗门。结尾两人从暗门登船，灯塔在身后重新亮起。基调冷硬克制，短句为主，情绪藏在动作里；要埋「暗门」伏笔，不要直接点破老周的真实身份。'
const PARAS = [
  '潮水退到最低的时候，雾津港露出一圈黑色的滩涂，像谁把海岸的骨头摆在了外面。林岸踩着礁石往灯塔走，靴子里灌满了海水，每走一步都咕咚作响。灯塔立在防波堤的尽头，灯早就熄了，塔身上爬满藤壶，远远看去像一根泡胀的断指。',
  '守塔人老周蹲在塔门口补渔网，手指粗糙得像船缆。他没抬头，只把下巴朝海面一扬：「船在后面的水湾，涨潮前能走。你要是怕，现在回头还来得及。」林岸把断刀从怀里抽出来，插在两人之间的石缝里：「我不怕盐帮，我怕的是等。」',
  '滩涂上有光闪了一下。不是渔火，是刀背反射的月光。林岸压低身子贴着堤坝的阴影，看见三条人影正踩着淤泥往灯塔方向摸，走的是盐帮夜巡才有的三角形队形。老周把渔网一收，骂了一句：「来得真快。」然后忽然吹灭了手里的油灯。',
  '塔门在身后合上，里面是一段螺旋向上的铁梯，锈得厉害，踩上去咯咯直响。林岸扶着墙壁往上爬，指尖摸到一道刻痕，和断刀刀柄上那道一模一样。老周在他身后说：「这塔是二十年前盐帮出钱修的，修塔的人后来都沉在了泊位底下。」',
  '灯室里积着厚厚的盐霜，巨大的黄铜灯座歪在一边。林岸绕着灯座走了一圈，发现底座下方有一道缝，风正从缝里往外吹，带着海腥味。他蹲下去，用断刀撬开一块松动的铁板，里面是一段向下的石阶，黑得看不见底。',
  '「暗门。」老周的声音从背后传来，听不出惊讶，「修塔的人留的，直通海蚀洞。你以为我这盏灯是为渔船点的？」林岸没有接话，他听见塔外的脚步声已经到了门口，铁梯在最下面响了一声。',
  '两个人顺着石阶往下走，海水在脚边拍打，越走越响。石阶尽头是一个不大的洞窟，一条平底小船泊在那里，船头挂着一盏风灯。林岸先跳上船，忽然想起父亲临终前反复摩挲刀柄的样子，喉咙里一阵发紧。',
  '小船穿出洞口的时候，身后的灯塔忽然重新亮了。光柱扫过海面，照见三条人影在滩涂里陷到腰部，正徒劳地往外爬。老周摇着橹，没有回头：「灯一亮，他们就得搁浅到天亮。坐稳了，前面是外海。」'
]
/** 三段交稿；含三处负向词「忽然」，写手被退回后全部去掉 */
const SEGS = [
  PARAS.slice(0, 3).join('\n\n'),
  PARAS.slice(3, 6).join('\n\n'),
  PARAS.slice(6).join('\n\n')
]
const DRAFT = SEGS.join('\n\n')
const DRAFT_FIXED = DRAFT.replace(/忽然/g, '')
const nonspace = (s) => s.replace(/\s/g, '').length
/** 回执里的证据：一句真原句、一句正文里没有的、一句太短的 */
const EV_CHAR = '断刀刀柄上那道一模一样'
const EV_FORE = '底座下方有一道缝，风正从缝里往外吹'
const RECEIPT_SUMMARY = '林岸借灯塔的暗门甩掉盐帮追踪者，随老周从海蚀洞登船出港。'

const REWRITE_PARAS = [
  '灯塔重新亮起来的时候，老周站在灯室里，手还搭在闸刀上。他透过盐霜看着滩涂里那三条人影，想起二十年前也是这样一个退潮的夜里，修塔的人被绑在塔基上，海水一寸一寸漫过他们的嘴。',
  '楼下的铁梯响了。不是林岸的脚步，林岸已经从暗门走了。老周把闸刀扳回去半格，灯光暗了一瞬，又稳稳地铺在海面上。他数着来人的脚步，一共五个，比预想的多两个。',
  '「周叔。」门口的人开口，声音年轻，「帮主让我来问，船走了没有。」老周没有转身，只是把渔网往肩上一搭：「走了。你要是想去追，先问问脚底下的淤泥答不答应。」'
]
const NEW_TEXT = REWRITE_PARAS.join('\n\n')

// ── 桩：按 system 身份行路由（后台记忆调用旁路应答；写手与主智能体各吃各的队列） ──

/** 身份行定义在 src/main/agent/writer.ts 与 src/main/director/storyRecap.ts，改了要同步这里 */
const WRITER_MARK = '你是写作子智能体'
const SIDE = [
  [
    '你是前情梗概维护员',
    JSON.stringify({
      plot: '林岸借灯塔暗门出港。',
      foreshadowsOpen: '灯塔暗门。',
      foreshadowsResolved: '',
      relations: '林岸与老周互相利用。',
      timePlace: '退潮夜，外海。'
    })
  ],
  ['你是章纪要维护员', JSON.stringify({ summary: '【改稿后】林岸借灯塔的暗门脱身。' })]
]
const queues = { main: [], writer: [] }
const seen = []
const stub = { writerCalls: 0, aborted: 0 }
let holdWriter = null // 扣住下一次写手请求：{ arrived, gate }
const call = (name, args) => ({ toolCalls: [{ name, arguments: args ?? {} }] })
const push = (lane, ...items) => queues[lane].push(...items)
const deferred = () => {
  const d = { resolve: () => {}, promise: Promise.resolve() }
  d.promise = new Promise((r) => (d.resolve = r))
  return d
}

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
    seen.push({
      system,
      messages: parsed.messages,
      maxTokens: parsed.max_tokens,
      tools: parsed.tools
    })
    let item = '{}'
    const side = SIDE.find(([mark]) => system.includes(mark))
    let replied = false
    res.on('close', () => {
      if (!replied) stub.aborted += 1
    })
    if (side) item = side[1]
    else if (system.includes(WRITER_MARK)) {
      stub.writerCalls += 1
      item = queues.writer.length ? queues.writer.shift() : '{}'
      if (holdWriter) {
        const h = holdWriter
        holdWriter = null
        h.arrived.resolve()
        await h.gate.promise
      }
    } else item = queues.main.length ? queues.main.shift() : '{}'

    replied = true
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    const send = (delta, finish) =>
      res.write(
        `data: ${JSON.stringify({
          model: 'stub-model',
          choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
          ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 300 } } : {})
        })}\n\n`
      )
    if (item.toolCalls) {
      const fn = item.toolCalls.map((t, i) => ({
        index: i,
        id: `call_${seen.length}_${i}`,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.arguments) }
      }))
      send({ role: 'assistant', tool_calls: fn })
      send({}, 'tool_calls')
    } else {
      const text = item.text ?? item
      for (let i = 0; i < text.length; i += 40) send({ content: text.slice(i, i + 40) })
      send({}, 'stop')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

// ── 断言与工具 ────────────────────────────────────────────────────────────────

let failed = 0
let passed = 0
const ok = (cond, label) => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function waitJob(jobId, pred, label, timeoutMs = 60_000) {
  const t0 = Date.now()
  for (;;) {
    const job = await invoke('job:get', jobId)
    if (job && pred(job)) return job
    if (job && (job.state === 'failed' || job.state === 'cancelled'))
      throw new Error(`${label} 失败: ${job.state} ${job.error ?? ''}`)
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} 超时`)
    await sleep(250)
  }
}

const isWriter = (s) => s.system.startsWith(WRITER_MARK)
const writerReqs = () => seen.filter(isWriter)
const mainReqs = () =>
  seen.filter((s) => !isWriter(s) && !SIDE.some(([mark]) => s.system.includes(mark)))
const resultsOf = (reqs) =>
  reqs.flatMap((r) =>
    (r.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content))
  )
const cardsOf = (jobId, rows) =>
  rows.filter((m) => m.meta?.kind === 'tool' && m.meta.jobId === jobId)

const server = spawn(process.execPath, ['dist/main/index.js'], {
  env: { ...process.env, NM_DATA_DIR: dataDir },
  stdio: 'inherit'
})
llm.listen(STUB_PORT, '127.0.0.1')

// SSE：服务起来后再连，收 job:progress（分段交稿的累计字数）
const events = []
const sseAbort = new AbortController()
let ssePump = Promise.resolve()
const listenEvents = async () => {
  // 服务端连上先写一帧「: connected」、随后才把这条连接记进广播名单：读到第一帧才算订阅挂上
  const connected = deferred()
  ssePump = (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, { signal: sseAbort.signal })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        for (;;) {
          const at = buf.indexOf('\n\n')
          if (at < 0) break
          connected.resolve()
          for (const line of buf.slice(0, at).split('\n')) {
            if (!line.startsWith('data:')) continue
            try {
              events.push(JSON.parse(line.slice(5)))
            } catch {
              /* 不是 JSON 的帧忽略 */
            }
          }
          buf = buf.slice(at + 2)
        }
      }
    } catch {
      /* 收尾时主动断开 */
    }
  })()
  await connected.promise
}

async function killAll() {
  sseAbort.abort()
  await ssePump
  await stopChild(server)
  llm.close()
  await removeTempDir(dataDir)
}

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break
    } catch {
      /* 还没起来 */
    }
    if (i >= 60) throw new Error('服务 30s 未就绪')
    await sleep(500)
  }
  ok(true, '服务就绪 /api/health')
  await listenEvents()

  const book = await invoke('book:create', { title: '写手冒烟之书', targetWords: 800 })
  const lineId = book.activeLineId
  await invoke('book:update', book.id, {
    negativeWords: ['忽然'],
    redlines: ['林岸不能死'],
    styleName: '冷硬短句',
    styleSample: '短句。短句。雾很重。'
  })
  await invoke('character:save', {
    lineId,
    name: '林岸',
    role: '主角',
    state: { location: '雾津港' }
  })
  ok(true, '建书 + 负向词 + 红线 + 文风范例 + 人物')

  // ── ① 写章主链路：简报过短 / 过长被拒 → 重提 → 写手分段交稿 → 退回 → 改对 → 回执 → 入书 ──
  const n1 = nonspace(SEGS[0])
  const n2 = n1 + nonspace(SEGS[1])
  const n3 = n2 + nonspace(SEGS[2])
  // 作者带着倾向开章（聊天里 propose_chapter）：倾向会进写手的「作者对本章的交代」
  push(
    'main',
    call('propose_chapter', { directionHint: '多写雾' }),
    call('finish', { message: '这就开写。' })
  )
  push(
    'main',
    call('get_write_context'),
    call('write_chapter_draft', { brief: '太短的简报。' }),
    call('write_chapter_draft', { brief: '长'.repeat(4100) }),
    call('write_chapter_draft', { brief: GOOD_BRIEF, title: '潮汐灯塔' }),
    call('read_last_draft', { from: 300, maxChars: 200 }),
    call('commit_chapter'),
    call('finish', { message: '第 1 章已入书。' })
  )
  push(
    'writer',
    // 写手幻觉出写类工具：子智能体只能调自己清单里的工具
    call('save_card', { kind: 'custom', title: '越权的卡', readerText: '不该落库' }),
    call('get_character', { name: '林岸' }),
    call('submit_draft', { text: SEGS[0] }),
    call('submit_draft', { text: SEGS[1] }),
    call('submit_draft', { text: SEGS[2], done: true }),
    call('revise_draft', { find: '草稿里没有的句子', replace: 'x' }),
    call('revise_draft', { find: '忽然', replace: '' }),
    call('submit_draft', { done: true }),
    call('finish', {
      summary: RECEIPT_SUMMARY,
      characters: [
        { name: '林岸', patch: { location: '海蚀洞' }, evidence: EV_CHAR },
        { name: '老周', patch: { mood: '平静' }, evidence: '正文里没有的假原句' }
      ],
      foreshadows: [
        { title: '灯塔的暗门', detail: '修塔的人留下的通道。', status: 'open', evidence: EV_FORE }
      ],
      settings: [
        {
          kind: 'geography',
          title: '潮汐灯塔',
          readerText: '退潮夜会熄灯的旧塔。',
          evidence: '太短'
        }
      ]
    })
  )
  const trigger = await invoke('job:startChat', book.id, '写下一章，多写雾')
  await waitJob(trigger.id, (j) => j.state === 'done', '开章对话')
  const jobA = await waitJob(
    (await invoke('job:list', book.id)).find((j) => j.kind === 'write').id,
    (j) => j.state === 'done',
    '写章主链路'
  )

  let detail = await invoke('book:get', book.id)
  ok(detail.chapters.length === 1, `章节入库（${detail.chapters.length} 章）`)
  const ch1 = await invoke('chapter:get', detail.chapters[0].id)
  ok(ch1.title === '潮汐灯塔' && ch1.content === DRAFT_FIXED, '正文=三段累计后去掉三处「忽然」')
  ok(ch1.summary === RECEIPT_SUMMARY, `纪要缺省用写手回执里的（${ch1.summary}）`)
  ok(ch1.meta?.brief === GOOD_BRIEF, '章的 meta 记下主智能体给的任务简报')
  ok(jobA.payload.recap?.summary === RECEIPT_SUMMARY, 'recap.summary 同样来自回执')

  const rows = await invoke('message:list', book.id)
  const cardsA = cardsOf(jobA.id, rows)
  ok(
    cardsA.map((m) => m.meta.tool).join(',') ===
      'get_write_context,write_chapter_draft,write_chapter_draft,write_chapter_draft,read_last_draft,commit_chapter,finish',
    `工具卡序列（${cardsA.map((m) => m.meta.tool).join(',')}）`
  )
  const [shortCard, longCard, goodCard] = cardsA.filter(
    (m) => m.meta.tool === 'write_chapter_draft'
  )
  ok(
    shortCard?.meta?.ok === false &&
      shortCard.meta.summary === '任务简报不合格' &&
      shortCard.content.includes('太短'),
    '简报过短被拒并说明原因'
  )
  ok(longCard?.meta?.ok === false && longCard.content.includes('超过上限'), '简报超长被拒')
  ok(
    goodCard?.meta?.ok === true &&
      goodCard.meta.summary === `派写手《潮汐灯塔》${nonspace(DRAFT_FIXED)} 字（自检通过）`,
    `派写手卡带字数与自检结论（${goodCard?.meta?.summary}）`
  )
  ok(
    !rows.some((m) => ['submit_draft', 'revise_draft', 'save_card'].includes(m.meta?.tool)),
    '写手的工具调用不落卡（对作者不可见）'
  )
  ok(
    !(await invoke('card:list', lineId)).some((c) => c.title === '越权的卡'),
    '写手幻觉出的 save_card 被拒，没有越权落库'
  )

  // 写手的提示与工具
  {
    const first = writerReqs()[0]
    const sys = String(first?.system ?? '')
    const user = String(first?.messages?.[1]?.content ?? '')
    const names = (first?.tools ?? []).map((t) => t.function?.name)
    ok(sys.startsWith(WRITER_MARK) && sys.includes('## 本章目标字数'), '写手系统提示以身份行开头')
    ok(
      sys.includes('## 剧情红线') &&
        sys.includes('林岸不能死') &&
        sys.includes('## 负向词') &&
        sys.includes('## 文风') &&
        sys.includes('## 文风范例') &&
        sys.includes('短句。短句。雾很重。'),
      '服务端自动附上红线 / 负向词 / 文风 / 文风范例'
    )
    ok(
      sys.includes('本章出场人物') &&
        sys.includes('【林岸】（主角）') &&
        sys.indexOf('## 剧情红线') < sys.indexOf('## 负向词') &&
        sys.indexOf('## 负向词') < sys.indexOf('## 文风范例') &&
        sys.indexOf('## 文风范例') < sys.indexOf('## 本章目标字数') &&
        sys.indexOf('## 本章目标字数') < sys.indexOf('## 记忆简报'),
      '记忆简报在最后（稳定内容在前），点名的人物带人设'
    )
    ok(!sys.includes('作者选定的走向'), '过时措辞「作者选定的走向」已去掉')
    ok(
      user.includes('## 任务简报') &&
        user.includes(GOOD_BRIEF) &&
        user.includes('## 作者对本章的交代\n多写雾') &&
        user.includes('## 交稿规则'),
      '首条消息=任务简报 + 作者交代 + 交稿规则'
    )
    ok(first?.maxTokens === 8000, `每轮输出预算 8000（${first?.maxTokens}）`)
    const need = [
      'get_character',
      'get_card',
      'read_chapter',
      'read_sample',
      'submit_draft',
      'revise_draft',
      'finish'
    ]
    const banned = [
      'save_card',
      'commit_chapter',
      'write_chapter_draft',
      'revise_chapter',
      'spawn_subagent'
    ]
    ok(
      need.every((t) => names.includes(t)) &&
        banned.every((t) => !names.includes(t)) &&
        names.length === 15,
      `写手工具=只读 + 交稿三件套，没有写类工具（共 ${names.length} 个）`
    )
  }

  // 写手看到的工具结果：越权被拒 → 分段累计 → 退回（列全部出现位置）→ 未命中 → 改对 → 复检通过
  {
    const res = resultsOf(writerReqs())
    ok(
      res.some((t) => t.includes('你没有 save_card 这个工具')),
      '写手调用清单外的工具被拒'
    )
    ok(
      res.some((t) => t.includes(`已累计 ${n1} 字`)) &&
        res.some((t) => t.includes(`已累计 ${n2} 字`)),
      '分段交稿按累计字数回报'
    )
    const back = res.find((t) => t.includes('自检退回（第 1/2 次）'))
    ok(
      !!back &&
        back.includes('共 3 处') &&
        back.includes('然后忽然吹灭了') &&
        back.includes('灯塔忽然重新亮了'),
      '自检退回：附问题与含负向词的全部原句'
    )
    ok(
      res.some((t) => t.includes('草稿里找不到「草稿里没有的句子」')),
      'revise_draft 未命中原句 → 失败'
    )
    ok(
      res.some((t) => t.includes('已替换 3 处')),
      'revise_draft 字面量替换命中处'
    )
    ok(
      res.some((t) => t.includes('自检通过') && t.includes('调用 finish')),
      '改完复检通过并提示交回执'
    )
  }

  // 回给主智能体的回执：带纪要与核对过的线索，不带全文
  {
    const receipt = resultsOf(mainReqs()).find((t) => t.includes('写手交稿')) ?? ''
    ok(
      receipt.includes('自检：通过') && receipt.includes(`纪要：${RECEIPT_SUMMARY}`),
      '回执带字数与纪要'
    )
    ok(
      receipt.includes(`- 林岸：location=海蚀洞｜原句：「${EV_CHAR}」`) &&
        receipt.includes(`- 灯塔的暗门（open）：修塔的人留下的通道。｜原句：「${EV_FORE}」`),
      '回执证据校验：原句在草稿里的线索保留'
    )
    ok(
      receipt.includes('已丢弃') &&
        receipt.includes('人物状态「老周」：原句对不上草稿') &&
        receipt.includes('设定「潮汐灯塔」：原句太短') &&
        !receipt.includes('假原句'),
      '回执证据校验：对不上 / 太短的线索丢弃并标出'
    )
    ok(
      !receipt.includes('正文全文：') &&
        !receipt.includes('灯室里积着厚厚的盐霜') &&
        !receipt.includes('塔门在身后合上'),
      '回执不回灌全文'
    )
    ok(
      receipt.includes(`开头：${DRAFT_FIXED.slice(0, 300)}`) &&
        receipt.includes(`结尾：…${DRAFT_FIXED.slice(-300)}`),
      '回执带开头与结尾各 300 字'
    )
  }

  // read_last_draft：按区间读全文，默认 2000 字上限 8000，翻页带 from 提示
  {
    const res = resultsOf(mainReqs()).find((t) => t.startsWith(DRAFT_FIXED.slice(300, 500))) ?? ''
    ok(res.includes('继续往后传 from:500'), 'read_last_draft 按 from / maxChars 读草稿')
  }

  // 进度：每次交稿 / 改稿按累计字数推 job:progress
  {
    const chars = events
      .filter((e) => e.channel === 'job:progress' && e.args?.[0] === jobA.id)
      .map((e) => e.args[1])
    ok(
      chars.length === 4 &&
        chars.every((p) => p.phase === 'draft') &&
        chars.map((p) => p.chars).join(',') === `${n1},${n2},${n3},${n3 - 6}`,
      `job:progress 累计字数（${chars.map((p) => p.chars).join(',')}）`
    )
  }

  // ── ② 超轮：写手一直不改、也不交回执 → 退回两次用完带着报告 → 跑满 12 轮 → 带报告入书 ──
  const callsBefore = stub.writerCalls
  push(
    'main',
    call('write_chapter_draft', { brief: GOOD_BRIEF, title: '超轮之章' }),
    call('commit_chapter', { summary: '主智能体自己补写的纪要。' }),
    call('finish', { message: '第 2 章带着瑕疵入书。' })
  )
  push(
    'writer',
    call('submit_draft', { text: DRAFT }),
    ...Array.from({ length: 11 }, () => call('submit_draft', { done: true }))
  )
  const jobB = await waitJob(
    (await invoke('job:startWrite', book.id)).id,
    (j) => j.state === 'done',
    '超轮写章'
  )
  detail = await invoke('book:get', book.id)
  const ch2 = await invoke('chapter:get', detail.chapters[1].id)
  ok(
    stub.writerCalls - callsBefore === 12 &&
      ch2.content === DRAFT &&
      ch2.summary === '主智能体自己补写的纪要。',
    `写手跑满 12 轮没有回执：带报告入书，纪要用主智能体传的（写手调用 ${stub.writerCalls - callsBefore} 次）`
  )
  const resB = resultsOf(mainReqs()).find((t) => t.includes('《超轮之章》写手交稿')) ?? ''
  ok(
    resB.includes('仍有 1 个 major') &&
      resB.includes('没有提交回执') &&
      resB.includes('纪要与沉淀线索为空'),
    '回执说明：自检仍有 major、写手没有交回执'
  )
  ok(
    resultsOf(writerReqs()).some((t) => t.includes('退回次数已用完')),
    '写手看到「退回次数已用完，带着报告入书」'
  )
  const cardB = cardsOf(jobB.id, await invoke('message:list', book.id)).find(
    (m) => m.meta.tool === 'write_chapter_draft'
  )
  ok(
    cardB?.meta?.summary === `派写手《超轮之章》${nonspace(DRAFT)} 字（自检仍有 1 个 major）`,
    `卡片如实标注（${cardB?.meta?.summary}）`
  )

  // ── ③ 写手没交稿（输出太短）→ 主智能体收到失败；直接把正文当回复吐出来 → 够长就整章收下 ──
  push(
    'main',
    call('read_last_draft'),
    call('write_chapter_draft', { brief: GOOD_BRIEF, title: '没交的章' }),
    call('finish', { message: '写手没交稿，这一章先不写。' })
  )
  push('writer', { text: '这一章我写不了。' })
  const jobC = await waitJob(
    (await invoke('job:startWrite', book.id)).id,
    (j) => j.state === 'done',
    '写手没交稿'
  )
  ok(
    resultsOf(mainReqs()).some((t) => t.includes('没有草稿')),
    '入书前 read_last_draft 说明没有草稿'
  )
  const cardsC = cardsOf(jobC.id, await invoke('message:list', book.id))
  ok(
    (await invoke('book:get', book.id)).chapters.length === 2 &&
      cardsC.some(
        (m) =>
          m.meta.tool === 'write_chapter_draft' &&
          m.meta.ok === false &&
          m.meta.summary === '写手没有交稿'
      ),
    '写手没交稿：失败卡回给主智能体，没有入书'
  )
  push(
    'main',
    call('write_chapter_draft', { brief: GOOD_BRIEF, title: '纯文本兜底' }),
    call('commit_chapter', { summary: '纯文本兜底章的纪要。' }),
    call('finish', { message: '写手直接给了正文。' })
  )
  push('writer', { text: NEW_TEXT })
  await waitJob(
    (await invoke('job:startWrite', book.id)).id,
    (j) => j.state === 'done',
    '纯文本兜底'
  )
  detail = await invoke('book:get', book.id)
  ok(
    detail.chapters.length === 3 &&
      (await invoke('chapter:get', detail.chapters[2].id)).content === NEW_TEXT,
    '写手没走交稿工具直接输出正文：够长就整章收下'
  )
  ok(
    resultsOf(mainReqs()).some((t) => t.includes('直接输出了正文')),
    '回执注明没有经过退回自检'
  )

  // ── ④ 取消：写手正写到一半被作者取消 → 任务 cancelled、不入书、队列照常释放 ──
  {
    const arrived = deferred()
    const gate = deferred()
    holdWriter = { arrived, gate }
    push('main', call('write_chapter_draft', { brief: GOOD_BRIEF, title: '被取消的章' }))
    push('writer', call('submit_draft', { text: DRAFT }))
    const jobE = await invoke('job:startWrite', book.id)
    await Promise.race([
      arrived.promise,
      sleep(30_000).then(() => {
        throw new Error('写手请求没有到达桩')
      })
    ])
    ok((await invoke('job:cancel', jobE.id)).state === 'cancelled', '取消后任务立即是 cancelled')
    gate.resolve()
    push('main', call('finish', { message: '在的。' }))
    await waitJob(
      (await invoke('job:startChat', book.id, '还在吗？')).id,
      (j) => j.state === 'done',
      '取消后的下一个任务'
    )
    ok(true, '取消后串行队列照常衔接下一个任务')
    for (let i = 0; i < 20 && stub.aborted === 0; i++) await sleep(100)
    ok(stub.aborted >= 1, `写手在途的模型请求被真正中止（aborted=${stub.aborted}）`)
    ok((await invoke('book:get', book.id)).chapters.length === 3, '取消的章没有入书')
  }

  // ── ⑤ edits 直改：主智能体读原文后直接给「原文 → 改后」 ──
  const before = ch1.content
  push(
    'main',
    call('read_chapter', { chapterId: ch1.id }),
    call('revise_chapter', {
      chapterId: ch1.id,
      instruction: '开头改口语一点',
      edits: [
        { find: '潮水退到最低的时候', replace: '潮水退到最远的时候' },
        { find: '我不怕盐帮，我怕的是等', replace: '我不怕盐帮，我怕的是再等下去' }
      ]
    }),
    call('finish', { message: '改好了。' })
  )
  await waitJob(
    (await invoke('job:startChat', book.id, '把第 1 章开头改得口语一点')).id,
    (j) => j.state === 'done',
    'edits 直改'
  )
  let now = await invoke('chapter:get', ch1.id)
  ok(
    now.content ===
      before
        .replace('潮水退到最低的时候', '潮水退到最远的时候')
        .replace('我不怕盐帮，我怕的是等', '我不怕盐帮，我怕的是再等下去'),
    'edits 直改生效（不调模型出方案）'
  )
  ok(
    resultsOf(mainReqs()).some(
      (t) => t.includes('局部修改 2/2 处') && t.includes('后台按新正文刷新')
    ),
    '改章卡：局部修改 2/2 处，纪要与梗概后台刷新'
  )
  for (
    let i = 0;
    i < 40 && !String((await invoke('chapter:get', ch1.id)).summary).startsWith('【改稿后】');
    i++
  )
    await sleep(250)
  ok(
    String((await invoke('chapter:get', ch1.id)).summary).startsWith('【改稿后】'),
    '直改后章纪要按新正文重写'
  )
  const edited = now.content
  push(
    'main',
    call('revise_chapter', {
      chapterId: ch1.id,
      instruction: 'x',
      edits: [{ find: '守塔人老周' }]
    }),
    call('revise_chapter', {
      chapterId: ch1.id,
      instruction: 'x',
      edits: [{ find: '根本不存在的原句', replace: 'y' }]
    }),
    call('finish', { message: '改不动。' })
  )
  await waitJob(
    (await invoke('job:startChat', book.id, '再改一下第 1 章')).id,
    (j) => j.state === 'done',
    'edits 拒绝'
  )
  now = await invoke('chapter:get', ch1.id)
  const refused = resultsOf(mainReqs())
  ok(
    now.content === edited && refused.some((t) => t.includes('这次没有改动任何内容')),
    '缺 replace 的 edit 整条拒掉，不当删除用'
  )
  ok(
    refused.some((t) => t.includes('修改定位失败')) && now.content === edited,
    'edits 全未命中 → 「改稿未命中原文」，正文不动'
  )

  // ── ⑥ job:startRevise 无人值守链路照旧：模型出改稿方案兜底 ──
  push('main', {
    text: JSON.stringify({
      edits: [{ find: '守塔人老周蹲在塔门口补渔网', replace: '守塔人老周蹲在塔门口织渔网' }]
    })
  })
  const rj = await waitJob(
    (await invoke('job:startRevise', ch1.id, '换个说法')).id,
    (j) => j.state === 'done',
    'startRevise 兜底'
  )
  now = await invoke('chapter:get', ch1.id)
  ok(
    String(rj.payload.reviseMode).includes('局部修改 1/1 处') &&
      now.content.includes('织渔网') &&
      !now.content.includes('补渔网'),
    'startRevise 兜底走 genRevisePlan（链路不变）'
  )

  // ── ⑦ brief 整章重写：派写作子智能体看着原章改 ──
  const REWRITE_BRIEF = '改成老周的视角：他站在灯室里目送林岸从暗门离开，盐帮的人随后赶到塔门口。'
  const writerBefore = writerReqs().length
  push(
    'main',
    call('revise_chapter', {
      chapterId: ch1.id,
      instruction: '换成老周的视角重写这一章',
      brief: REWRITE_BRIEF
    }),
    call('finish', { message: '重写好了。' })
  )
  push(
    'writer',
    call('submit_draft', { text: REWRITE_PARAS[0] }),
    call('submit_draft', { text: `${REWRITE_PARAS[1]}\n\n${REWRITE_PARAS[2]}`, done: true }),
    call('finish', { summary: '重写完成。' })
  )
  await waitJob(
    (await invoke('job:startChat', book.id, '第 1 章换成老周的视角重写')).id,
    (j) => j.state === 'done',
    'brief 整章重写'
  )
  now = await invoke('chapter:get', ch1.id)
  ok(now.content === NEW_TEXT, '整章重写后正文替换为新稿')
  const rewriteReq = writerReqs()[writerBefore]
  const rewriteUser = String(rewriteReq?.messages?.[1]?.content ?? '')
  ok(
    rewriteUser.includes('整章重写') &&
      rewriteUser.includes(REWRITE_BRIEF) &&
      rewriteUser.includes('## 原章正文'),
    '写手首条消息=修改要求 + 原章正文'
  )
  ok(String(rewriteReq?.system ?? '').includes('重写不查字数'), '重写不查字数')
  ok(
    resultsOf(mainReqs()).some((t) => t.includes('整章重写并替换')),
    '改章卡：整章重写并替换'
  )

  console.log(`\n[写作子智能体冒烟] ${passed} 通过 / ${failed} 失败`)
} catch (err) {
  console.error('\n[写作子智能体冒烟] 异常:', err.message)
  failed++
} finally {
  await killAll()
}
process.exitCode = failed ? 1 : 0
