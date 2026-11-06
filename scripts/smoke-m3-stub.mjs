/**
 * M3 联调 LLM stub（独立进程，端口 3923）：队列 = 开书引导 4 轮 + 写作循环 5 步。
 * 用法：node scripts/smoke-m3-stub.mjs
 * 每收到一次 /v1/chat/completions 弹出下一个预设；全部弹完后挂起（不返回）以便排查。
 */
import { createServer } from 'node:http'

const DRAFT = [
  '雾津港的雾在半夜最重。林岸蹲在七号泊位的缆桩后面，把断刀往怀里又拢了拢。刀身断口用麻布缠了三层，还是硌得肋骨生疼。远处盐帮的灯笼一盏一盏漂过来，光晕被雾泡开，像化在水里的蛋黄。',
  '脚步声近了。两个人，踩着木板很沉，是练过桩功的底子。林岸把呼吸压到最缓，整个人贴进缆桩的影子里。「港务官担保今夜没有外船。」其中一个说。「担保？」另一个嗤了一声，「上个月担保过的人，现在就沉在泊位底下。」',
  '一条狗从雾里钻出来，湿鼻子几乎碰到林岸的手背。他一动不动。狗闻了闻，忽然掉头冲着码头另一头狂吠。两个人影立刻提灯奔了过去——那边传来铁器砸落的脆响，像是有人故意弄翻了什么。',
  '货船的跳板只放了一半。林岸贴着船舷摸上去，舱底堆着咸鱼和蔗糖，气味呛得人眼睛发酸。他把断刀塞进蔗糖筐的夹层，自己也蜷了进去。起锚的绞盘声轰隆隆碾过头顶时，他摸到刀柄内侧那道刻痕——一个被磨掉一半的「沈」字。',
  '船离岸很远之后，舱口忽然透进一线光。一个披蓑衣的老船工提着灯下来，在蔗糖筐前站定，慢悠悠地说：「小子，盐帮悬赏你的画像，今早已经送到了南屿。」林岸的手在暗处扣紧了刀柄。'
].join('\n\n')

// SKIP_ONBOARD=1 时跳过前 4 个 onboard 响应（已开书续写场景）
// CHAT_FIRST=1 时把两个 chat 响应挪到写作循环之前（M5 冒烟：先对话后写作）
// AGENT_MODE=1 时改用 M6 agent 队列（directions + tool_calls 链 + chat agent）
const CHAT_REPLIES = [
  // M5：chat（智能体页自由对话，纯文本）
  '断刀的「沈」字我埋的时候就留了三层：字面是铸刀匠的落款，往上追是二十年前盐帮清洗雾津港的旧案，再往上和林岸父亲的死直接相关。现在才第 2 章，别急着揭——让老船工先察觉这把刀，下一章他会主动试探林岸。',
  // M5：chat 第二轮
  '可以。你说的「船上还有第三个人」可以和蔗糖舱的印记并成一条线：那批糖是七号泊位连夜装的，收货人写的却是个死人名字。下一章走向卡里我会给一个「查收货人」的纵深选项。'
]
const QUEUE_RAW = ([
  // onboard 1：premise 选择题
  // onboard 1：premise 选择题
  JSON.stringify({
    reply: '好，从基调聊起。你想要的故事是哪种气质？',
    options: ['冷峻悬疑', '热血爽文', '慢热群像'],
    stage: 'premise',
    done: false
  }),
  // onboard 2：直接升 world 带草案
  JSON.stringify({
    reply: '冷峻悬疑，好品味。我搭了一套港口世界观：雾津港明面上是渔港，暗地里是盐帮走私枢纽。读者第一章只看到雾与灯笼，底层设定先压着。',
    options: ['就这么定', '重来一套', '我要改（选此项后在下方输入）'],
    stage: 'world',
    draft: {
      cards: [
        {
          kind: 'geography',
          title: '雾津港',
          readerText: '南方深水港，常年大雾，夜里潮水定时辰，灯笼在雾里像化开的蛋黄。',
          authorText: '雾津港是盐帮走私枢纽，港务官早被买通，七号泊位专走南屿的私货船。',
          revealPlan: '第 4-6 章逐步揭开港务官与盐帮的关系'
        },
        {
          kind: 'faction',
          title: '盐帮',
          readerText: '盘踞码头的帮派，悬赏画像是他们的招牌。',
          authorText: '盐帮背后是漕运总舵，断刀的「沈」字与其内乱有关。',
          revealPlan: '第 8 章前后'
        }
      ]
    },
    done: false
  }),
  // onboard 3：characters 草案
  JSON.stringify({
    reply: '人物上，我安排一个被追杀的前水手当主角，身世与断刀绑定；再加一个立场不明的老船工。',
    options: ['就这么定', '重来一套', '我要改（选此项后在下方输入）'],
    stage: 'characters',
    draft: {
      characters: [
        {
          name: '林岸',
          role: '主角',
          card: { 背景: '前水手，父亲留下断刀后病故', 外貌: '精瘦，手上全是缆绳勒痕', 性格: '能忍，出手狠' },
          state: { location: '雾津港七号泊位', mood: '紧绷', goal: '离开雾津港，查明断刀来历' },
          relations: [{ to: '蓑衣老船工', label: '警惕的同行者' }]
        },
        {
          name: '蓑衣老船工',
          role: '关键配角',
          card: { 背景: '南屿货船上的老船工', 性格: '慢悠悠，话里有话' },
          state: { location: '货船', mood: '平静', knows: '盐帮悬赏已送南屿' },
          relations: []
        }
      ]
    },
    done: false
  }),
  // onboard 4：title 草案
  JSON.stringify({
    reply: '三个书名，第 1 个贴故事气质，第 2 个短而狠，第 3 个偏群像感。',
    options: ['第一个', '第二个', '第三个'],
    stage: 'title',
    draft: {
      titles: [
        { title: '雾港断刀', intro: '一把断刀，一个被追杀的水手，一场从浓雾里开始的逃亡。' },
        { title: '沉舟录', intro: '所有人都以为他沉在泊位底下，他偏要活着靠岸。' },
        { title: '雾津众人', intro: '港口众生相里，藏着一把刀的秘密。' }
      ],
      styleName: '冷硬短句',
      styleNotes: '短句为主，多感官细节，对话不加说话方式修饰，情绪藏在动作里。',
      targetWords: 2000,
      redlines: ['主角林岸不能死', '不写无意义酷刑'],
      skeleton: {
        ending: '断刀「沈」字的真相与盐帮内乱相连，林岸最终在漩涡中心做出自己的选择——方向感，不是结局。',
        firstThree: ['雾夜登船逃离雾津港', '海上与老船工的博弈', '抵达南屿，悬赏画像贴满码头']
      }
    },
    done: false
  }),
  // 写作循环 1：directions
  JSON.stringify({
    cards: [
      {
        kind: 'steady',
        title: '随船南下',
        preview: '林岸藏进货船蔗糖舱，随潮水离开雾津港，在摇晃中第一次细看断刀刻痕。',
        structure: '推进主线：离开盐帮势力圈；强化「沈」字伏笔的存在感。',
        arc: '开启 3 章海上航程弧'
      },
      {
        kind: 'twist',
        title: '码头引开的人',
        preview: '替林岸引开巡逻的神秘人被盐帮按住，林岸在跳板前面临救人或登船的抉择。',
        structure: '引入新元素：身份不明的盟友；制造道德代价。',
        arc: '单章'
      },
      {
        kind: 'depth',
        title: '父亲的刀',
        preview: '藏身蔗糖舱的林岸回忆父亲临终反复摩挲刀柄的样子，拼出「沈」字被磨去的记忆碎片。',
        structure: '深化人物线：林岸与父亲的裂痕；回收「沈」字伏笔的一角。',
        arc: '闭合父亲往事的小弧'
      },
      {
        kind: 'wild',
        title: '蓑衣老船工',
        preview: '船开之后一个老船工径直找到蔗糖筐，开口就报出盐帮悬赏——他不是普通船工。',
        structure: '引入新元素：立场不明的关键配角；把追杀延伸到海上。',
        arc: '开启 2 章船上博弈弧'
      }
    ]
  }),
  // 写作循环 2：outline
  JSON.stringify({
    title: '雾夜登船',
    synopsis:
      '开篇：林岸在七号泊位缆桩后蹲守半夜，盐帮提灯巡逻逼近，一条狗几乎嗅出他的藏身处，码头另一头突然传来铁器砸落声引开巡逻。中段：潮水转向，林岸摸上只放了一半跳板的货船，藏进蔗糖筐夹层，起锚的绞盘声里他摸到刀柄内侧被磨掉一半的「沈」字。结尾：船离岸后蓑衣老船工提灯下舱，径直站在蔗糖筐前，报出盐帮的悬赏——海上的追杀才刚开始。',
    beats: [
      '林岸缆桩后藏身，盐帮灯笼逼近，狗嗅到他的手背',
      '码头异响引开巡逻，潮水转向，跳板只放一半',
      '林岸摸进舱底蔗糖筐夹层，摸到刀柄「沈」字刻痕',
      '船离岸后蓑衣老船工下舱，径直点破悬赏画像'
    ]
  }),
  // 写作循环 3：scenes
  JSON.stringify({
    scenes: [
      {
        summary: '七号泊位深夜：林岸抱断刀藏身缆桩后，盐帮两人提灯巡查逼近，一条狗嗅到他手背，码头另一头铁器砸落声骤起，巡逻被引开。',
        viewpoint: '林岸',
        pace: '慢'
      },
      {
        summary: '潮水转向的泊位：林岸趁隙冲上只放一半的跳板，贴船舷摸进舱底，把断刀塞进蔗糖筐夹层，自己在黑暗里蜷成一团。',
        viewpoint: '林岸',
        pace: '快'
      },
      {
        summary: '起锚后的舱底：绞盘声碾过头顶，林岸摸到刀柄内侧磨掉一半的「沈」字；蓑衣老船工提灯下舱，站在蔗糖筐前报出盐帮悬赏。',
        viewpoint: '林岸',
        pace: '中'
      }
    ]
  }),
  // 写作循环 4：draft
  DRAFT,
  // 写作循环 5：recap
  JSON.stringify({
    summary:
      '林岸在雾津港七号泊位藏身半夜，靠码头异响引开盐帮巡逻，趁潮水转向藏进货船蔗糖筐夹层登船离港。他摸到断刀柄上被磨掉一半的「沈」字。船离岸后，蓑衣老船工下舱点破盐帮悬赏画像已送南屿。',
    stateChanges: [{ name: '林岸', patch: { location: '南屿货船·蔗糖舱', mood: '紧绷' } }],
    cardOps: [
      {
        op: 'create',
        kind: 'geography',
        title: '雾津港七号泊位',
        readerText: '常年大雾的深水泊位，夜里潮水定时辰。',
        authorText: '七号泊位专走南屿的私货船。'
      }
    ],
    foreshadowOps: [
      { op: 'plant', title: '断刀的来历', detail: '刀柄内侧刻着被磨掉一半的「沈」字，父亲至死不肯解释。' }
    ],
    quickActions: [
      { label: '补老船工视角', instruction: '在结尾加一小段老船工视角，暗示他早就知道蔗糖筐里有人。' },
      { label: '伏笔埋深', instruction: '把「沈」字刻痕的发现写得更隐蔽，不要直接点出刻痕含义。' }
    ]
  }),
  // M4：revise（改写后的整章正文）
  [
    '雾津港的雾在半夜最重，重得像浸透了盐水的棉絮压在码头上方。林岸蹲在七号泊位的缆桩后面，断刀贴着肋骨，每一波浪头打上木桩，断口的麻布就往肉里磨一分。他没有动。远处盐帮的灯笼一盏一盏漂过来，光晕被雾泡开，像化在水里的蛋黄。',
    '脚步声近了。两个人，踩着木板很沉，是练过桩功的底子。「港务官担保今夜没有外船。」其中一个说。「担保？」另一个嗤了一声，「上个月担保过的人，现在就沉在泊位底下。」话音落进雾里，林岸数着他们的步点，把呼吸压到最缓。',
    '一条湿鼻子的狗从雾里钻出来，几乎碰到他的手背。码头另一头骤然传来铁器砸落的脆响，狗掉头狂吠，两盏灯笼立刻奔了过去。林岸贴着船舷摸上只放了一半的跳板，蜷进舱底蔗糖筐的夹层。起锚的绞盘声碾过头顶时，他摸到刀柄内侧那道被磨掉一半的「沈」字。',
    '船离岸很远之后，舱口透进一线光。蓑衣老船工提着灯下来，在蔗糖筐前站定，慢悠悠地开口：「小子，盐帮悬赏你的画像，今早已经送到了南屿。」林岸的手在暗处扣紧了刀柄——老船工的脚步，从下舱那一刻起就没有迟疑过。'
  ].join('\n\n'),
  // M4：review（七维章审读）
  JSON.stringify({
    verdict: '悬念铺设扎实，逃亡段落的紧迫感立得住；结尾老船工的亮相是全章最好的钩子。对话可以再省，部分说明性台词削弱了冷硬质感。',
    findings: [
      { dimension: '张力', level: 'good', quote: '湿鼻子几乎碰到林岸的手背', comment: '用触觉替代视觉写危机，紧张感到位。' },
      { dimension: '对话', level: 'warn', quote: '「担保过的人，现在就沉在泊位底下。」', comment: '信息给得太直白，可以留一半让读者拼。' },
      { dimension: '钩子', level: 'good', quote: '从下舱那一刻起就没有迟疑过', comment: '收尾补的这一笔让老船工的威胁感翻倍。' }
    ],
    suggestions: ['下一章让老船工先开口试探，林岸装傻', '巡逻对话里的信息砍掉一半'],
    score: 82
  }),
  // M4：audit（全书审计）
  JSON.stringify({
    verdict: '整体节奏健康，「沈」字伏笔的埋设频率合适。需要留意：连续两章都是「藏身—被察觉」的同构场景，有剧情空转的风险。',
    findings: [
      { dimension: '文风漂移', level: 'good', quote: '光晕被雾泡开，像化在水里的蛋黄', comment: '冷硬短句风格保持一致。' },
      { dimension: '剧情空转', level: 'warn', quote: '藏身蔗糖筐夹层', comment: '与上一章缆桩藏身同构，下一章应换场景形态。' },
      { dimension: '连续性', level: 'good', quote: '盐帮悬赏你的画像', comment: '与第 1 章悬赏设定呼应，无矛盾。' }
    ],
    suggestions: ['下一章切到南屿码头的新场景', '老船工的身份至少再压两章'],
    score: 78
  }),
  // M4：diagnose（问导演）
  JSON.stringify({
    verdict: '林岸的行动动机链是完整的：断刀→父亲之死→逃离雾津港。但目前「查明断刀来历」这个目标还没有第一个可执行的线索动作，连续两章都在「被动逃」，读者会开始问「他到底要做什么」。建议下一章给他一个主动选择：比如冒险向老船工试探「沈」字。',
    findings: [
      { dimension: '动机链', level: 'good', quote: '父亲留下断刀后病故', comment: '身世与目标绑定清晰。' },
      { dimension: '主动性', level: 'warn', quote: '盐帮悬赏你的画像', comment: '主角连续被动应对，缺主动决策。' }
    ],
    suggestions: ['下一章走向卡优先考虑主角主动试探的方向'],
    score: 0
  })
])
const MAIN_QUEUE = QUEUE_RAW.slice(process.env.SKIP_ONBOARD ? 4 : 0)
const QUEUE = process.env.CHAT_FIRST
  ? [...CHAT_REPLIES, ...MAIN_QUEUE]
  : [...MAIN_QUEUE, ...CHAT_REPLIES]

// ── M6 agent 队列（AGENT_MODE=1）：agent 工具链 → chat×3 → revise/review/diagnose ──
// 元素为 string=纯文本 delta；{tool_calls:[{name,arguments}]}=工具调用响应
// CHAT_IN_QUEUE=0 时去掉 chat 段（m4 场景：写章后直接 revise/review/diagnose）
// 走向卡已废除：startWrite 直通 agent 链（无 directions 响应）
const DRAFT_FIXED = DRAFT.replace(/忽然/g, '')
const CHAT_TAIL = [
  { tool_calls: [{ name: 'list_chapters', arguments: {} }] },
  '目前只有第 1 章。断刀「沈」字的伏笔刚埋下，建议下一章让老船工主动试探林岸，把悬赏的紧迫感顶上来。',
  '可以。蔗糖舱的印记可以并成一条线：那批糖是七号泊位连夜装的，收货人写的却是个死人名字。'
]
// PLAN_MODE=1：startWrite 前置一次 genChapterPlan（callJson utility 槽，吃 JSON plan 文本）
const PLAN_JSON = JSON.stringify({
  plan: '- **走向**：老船工试探林岸，悬赏画像的收货人浮出水面。\n- **设定改动**：无。\n- **伏笔**：无新增，断刀「沈」字保持未解。\n- **风险**：船上密闭场景注意与前章舱底气味的连续性。'
})
// SUBAGENT=1：追加一次「父→spawn_subagent→子读→子 finish→父 finish」交换（排 chat 后、revise 前）
const SUB_QUEUE = [
  { tool_calls: [{ name: 'spawn_subagent', arguments: { task: '查一下当前写到第几章，最新章的标题是什么。' } }] },
  // 子代理轮（静默，不落工具卡）：list_chapters → finish 结论
  { tool_calls: [{ name: 'list_chapters', arguments: {} }] },
  { tool_calls: [{ name: 'finish', arguments: { message: '调查结论：目前共 1 章，最新章《雾夜登船》。' } }] },
  // 父代理拿到结论直接收尾
  { tool_calls: [{ name: 'finish', arguments: { message: '调查员回报：写到第 1 章《雾夜登船》，断刀伏笔已埋。建议下一章写船上试探。' } }] }
]
// revise（独立 job kind=revise，genRevisePlan 吃 JSON plan：局部替换，一命中一未命中）
const REVISE_PLAN = JSON.stringify({
  edits: [
    { find: '光晕被雾泡开，像化在水里的蛋黄', replace: '光晕被雾泡开，像化开的盐雾' },
    { find: '这段原文根本不存在', replace: '不应出现' }
  ]
})
const REVIEW_JSON = JSON.stringify({
  verdict: '悬念铺设扎实，逃亡段落的紧迫感立得住；结尾老船工的亮相是全章最好的钩子。',
  findings: [
    { dimension: '张力', level: 'good', quote: '湿鼻子几乎碰到林岸的手背', comment: '用触觉替代视觉写危机。' },
    { dimension: '对话', level: 'warn', quote: '「担保过的人，现在就沉在泊位底下。」', comment: '信息给得太直白。' }
  ],
  suggestions: ['下一章让老船工先开口试探'],
  score: 82
})
const DIAGNOSE_JSON = JSON.stringify({
  verdict: '林岸的行动动机链完整：断刀→父亲之死→逃离雾津港。建议下一章给他一个主动选择。',
  findings: [{ dimension: '主动性', level: 'warn', quote: '盐帮悬赏你的画像', comment: '主角连续被动应对。' }],
  suggestions: ['下一章走向卡优先考虑主角主动试探的方向'],
  score: 0
})
const AGENT_QUEUE = [
  // 走向卡已废除：startWrite 直通 agent 链（无 directions 响应）
  // PLAN_MODE=1：链头多一条计划响应（genChapterPlan 的 callJson）
  ...(process.env.PLAN_MODE === '1' ? [PLAN_JSON] : []),
  { tool_calls: [{ name: 'get_write_context', arguments: {} }] },
  {
    tool_calls: [
      {
        name: 'write_chapter_draft',
        arguments: {
          title: '雾夜登船',
          synopsis:
            '林岸在七号泊位藏身半夜，靠码头异响引开盐帮巡逻，趁潮水转向藏进货船蔗糖筐夹层登船离港；船离岸后蓑衣老船工下舱点破悬赏。',
          beats: ['缆桩藏身躲巡逻', '异响引开，摸上货船', '蔗糖筐里发现「沈」字', '老船工点破悬赏']
        }
      }
    ]
  },
  DRAFT, // write_chapter_draft 拦截内 genDraft 的响应（含负向词「忽然」→触发 lint major）
  DRAFT_FIXED, // autoFixDraft 的响应（负向词已去）
  {
    tool_calls: [
      {
        name: 'commit_chapter',
        arguments: {
          summary:
            '林岸雾夜藏身七号泊位，借码头异响引开盐帮巡逻，藏进蔗糖筐随船离港；老船工下舱点破悬赏画像已送南屿。',
          quickActions: [{ label: '补老船工视角', instruction: '结尾加一小段老船工视角。' }]
        }
      }
    ]
  },
  {
    tool_calls: [
      {
        name: 'patch_character_state',
        arguments: { name: '林岸', patch: { location: '南屿货船·蔗糖舱', mood: '紧绷' } }
      }
    ]
  },
  {
    tool_calls: [
      {
        name: 'save_foreshadow',
        arguments: { title: '断刀的来历', detail: '刀柄内侧刻着被磨掉一半的「沈」字，父亲至死不肯解释。' }
      }
    ]
  },
  {
    tool_calls: [
      {
        name: 'save_card',
        arguments: {
          kind: 'geography',
          title: '雾津港七号泊位',
          readerText: '常年大雾的深水泊位，夜里潮水定时辰。',
          authorText: '七号泊位专走南屿的私货船。'
        }
      }
    ]
  },
  { tool_calls: [{ name: 'finish', arguments: { message: '第 1 章已入书，人物状态已更新。建议下一章写船上试探。' } }] },
  // chat（free agent）：一轮工具 + 两轮纯文本（CHAT_IN_QUEUE=0 时跳过，供 m4 直接 revise）
  // SUBAGENT=1 时截掉尾条纯文本（首条 chat 固定吃 2 项，防止子代理交换错位），后接父→查员交换
  ...(process.env.CHAT_IN_QUEUE === '0'
    ? []
    : process.env.SUBAGENT === '1'
      ? [CHAT_TAIL[0], CHAT_TAIL[1]]
      : CHAT_TAIL),
  // SUBAGENT=1：父派只读调查员 + 子静默执行 + 结论回父
  ...(process.env.SUBAGENT === '1' ? SUB_QUEUE : []),
  // revise（独立 job kind=revise，genRevisePlan 吃 JSON plan：一命中一未命中）
  REVISE_PLAN,
  // review（七维章审读）
  REVIEW_JSON,
  // diagnose（问导演）
  DIAGNOSE_JSON
]
let callSeq = 0
const FINAL_QUEUE = process.env.AGENT_MODE ? AGENT_QUEUE : QUEUE


let served = 0
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    served += 1
    const item = FINAL_QUEUE.length ? FINAL_QUEUE.shift() : '{}'
    const text = typeof item === 'string' ? item : ''
    console.log(
      `[stub] call #${served} (剩余 ${FINAL_QUEUE.length}) ${typeof item === 'object' ? `tool_calls→${item.tool_calls.map((t) => t.name).join(',')}` : 'text'}`
    )
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    if (typeof item === 'object' && item.tool_calls) {
      // 工具调用响应：一次性给完整 tool_calls（llmOpenai 按 index 累积）
      callSeq += 1
      const fn = item.tool_calls.map((t, i) => ({
        index: i,
        id: `call_${callSeq}_${i}`,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) }
      }))
      res.write(
        `data: ${JSON.stringify({
          model: 'stub-model',
          choices: [{ delta: { role: 'assistant', tool_calls: fn } }]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          model: 'stub-model',
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 100, completion_tokens: 300 }
        })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const chunkSize = 40
    for (let i = 0; i < text.length; i += chunkSize) {
      res.write(
        `data: ${JSON.stringify({
          model: 'stub-model',
          choices: [{ delta: { content: text.slice(i, i + chunkSize) } }]
        })}\n\n`
      )
    }
    res.write(
      `data: ${JSON.stringify({
        model: 'stub-model',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 300 }
      })}\n\n`
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
server.listen(3923, '127.0.0.1', () => console.log('[stub] M3 联调 stub 就绪 :3923'))
