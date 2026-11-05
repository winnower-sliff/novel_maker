/**
 * M2 冒烟 LLM stub：队列式 OpenAI 兼容 SSE 端点（端口 3922）。
 * 每次收到 /v1/chat/completions 就弹出队列里下一个预设响应，
 * 按导演循环第 1 回合的调用顺序：directions → outline → scenes → draft → recap。
 * 调用顺序被打破时返回空 JSON（冒烟立刻失败暴露问题）。
 */
import { createServer } from 'node:http'

const DRAFT = [
  '雾津港的雾在半夜最重。林岸蹲在七号泊位的缆桩后面，把断刀往怀里又拢了拢。刀身断口用麻布缠了三层，还是硌得肋骨生疼。远处盐帮的灯笼一盏一盏漂过来，光晕被雾泡开，像化在水里的蛋黄。他想，再撑半个时辰，潮水一转，去南屿的货船就该起锚了。',
  '脚步声近了。两个人，踩着木板很沉，是练过桩功的底子。林岸把呼吸压到最缓，整个人贴进缆桩的影子里。「港务官担保今夜没有外船。」其中一个说。「担保？」另一个嗤了一声，「上个月担保过的人，现在就沉在泊位底下。」灯笼的光扫过来，在离林岸三步远的地方停住。',
  '一条狗从雾里钻出来，湿鼻子几乎碰到林岸的手背。他一动不动。狗闻了闻，忽然掉头冲着码头另一头狂吠。两个人影立刻提灯奔了过去——那边传来铁器砸落的脆响，像是有人故意弄翻了什么。林岸认不出那是谁在替他引开人，但他没有时间想了。潮水开始转了。',
  '货船的跳板只放了一半。林岸贴着船舷摸上去，舱底堆着咸鱼和蔗糖，气味呛得人眼睛发酸。他把断刀塞进蔗糖筐的夹层，自己也蜷了进去。起锚的绞盘声轰隆隆碾过头顶时，他摸到刀柄内侧那道刻痕——一个被磨掉一半的「沈」字。父亲到死都没说过这个字的来历。',
  '船离岸很远之后，舱口忽然透进一线光。一个披蓑衣的老船工提着灯下来，在蔗糖筐前站定，慢悠悠地说：「小子，盐帮悬赏你的画像，今早已经送到了南屿。」林岸的手在暗处扣紧了刀柄。雾从舱口的缝隙里漫进来，货船一头扎进更深的夜色里。'
].join('\n\n')

const QUEUE = [
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
  DRAFT,
  JSON.stringify({
    summary:
      '林岸在雾津港七号泊位藏身半夜，靠码头异响引开盐帮巡逻，趁潮水转向藏进货船蔗糖筐夹层登船离港。他摸到断刀柄上被磨掉一半的「沈」字。船离岸后，蓑衣老船工下舱点破盐帮悬赏画像已送南屿。',
    stateChanges: [
      { name: '林岸', patch: { location: '南屿货船·蔗糖舱', mood: '紧绷' } }
    ],
    cardOps: [
      {
        op: 'create',
        kind: 'geography',
        title: '雾津港',
        readerText: '南方深水港，常年大雾，夜里潮水定 时辰。',
        authorText: '雾津港是盐帮走私枢纽，港务官早被买通，七号泊位专走南屿的私货船。'
      }
    ],
    foreshadowOps: [
      { op: 'plant', title: '断刀的来历', detail: '刀柄内侧刻着被磨掉一半的「沈」字，父亲至死不肯解释。' }
    ]
  })
]

const calls = []

export function stubCalls() {
  return [...calls]
}

export function startLlmStub(port = 3922) {
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
      calls.push(body)
      const text = QUEUE.length ? QUEUE.shift() : '{}'
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store'
      })
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
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}
