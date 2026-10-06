import type { AgentToolResultEvent, EventChannels, EventContract } from '../../shared/contract'
import type {
  AgentDonePayload,
  AgentToolResultStatus,
  AgentTranscriptInput,
  ChatMessage,
  ContentBlock,
  PendingConfirmInfo,
  ToolDef,
  UsageInfo
} from '../../shared/types'
import type { EventSink } from '../eventSink'
import { chatStream, pickRatelimitHeaders } from '../llm'
import { resolveRequestAuth } from '../settings'
import * as store from '../store'
import { appendUsage } from '../usage'
import { coreWritingRules, readProjectInstructions } from './instructions'
import {
  AGENT_MAX_TOKENS,
  clip,
  MAX_RESULT_CHARS,
  MAX_SUBAGENTS,
  MAX_TURNS,
  type ToolExecContext
} from './toolkit'
import { getToolDefs, READ_TOOLS, TOOL_MAP } from './tools'

export function getAgentToolDefs(): ToolDef[] {
  return getToolDefs()
}

/** 确认等待超时：渲染端刷新/断连后无人应答时自动拒绝，防 run 在主进程死等（对齐 runRecords TTL） */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

/** 输入 token 超过该阈值时在工具结果里软提示建议压缩（不强制，每轮至多一次） */
const COMPACT_NUDGE_TOKENS = 100_000

/** 自动续跑预算：检测到疑似中途停摆时自动注入「继续」的次数上限，防失控烧钱 */
const MAX_AUTO_CONTINUES = 2

/** 征询语特征：模型任务未完却停下等指示时的高频措辞 */
const STOP_PHRASES = [
  /是否继续/,
  /是否需要我/,
  /请确认/,
  /请指示/,
  /等你?确认/,
  /等你?指示/,
  /等待.{0,6}(指示|确认|指令|批准)/,
  /需要我(继续|接着|往下)/,
  /要我(继续|接着|往下)/,
  /可以继续吗/,
  /还要继续吗/
]

/**
 * 疑似中途停摆判定：本 run 做过实际工作（有工具调用）且收尾文本呈现
 * 压缩后停顿或征询语特征。纯问答（无工具调用）不算，绝不打扰正常对话。
 */
function looksLikePaused(text: string, toolUseCount: number, compacted: boolean): boolean {
  if (toolUseCount === 0) return false
  const t = text.trim()
  if (!t) return false
  if (compacted) return true
  if (/[?？]\s*$/.test(t)) return true
  return STOP_PHRASES.some((re) => re.test(t))
}

interface RunState {
  confirms: Map<
    string,
    PendingConfirmInfo & { resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >
  alwaysAllowed: Set<string>
  /** 已发出的工具结果全量流水：done 一次性下发 + snapshot 轻量对账，供渲染端校正刷新窗口丢失的工具卡 */
  toolResults: AgentToolResultEvent[]
}

const activeRuns = new Map<string, RunState>()

export function getAgentPendingConfirm(requestId: string): PendingConfirmInfo | null {
  const run = activeRuns.get(requestId)
  const pending = run ? [...run.confirms.values()][0] : undefined
  if (!pending) return null
  return {
    confirmId: pending.confirmId,
    toolName: pending.toolName,
    input: pending.input,
    dangerReason: pending.dangerReason
  }
}

/** running 期间已完成工具的轻量状态表（runtime:snapshot 周期对账用，不带 result 全文） */
export function getAgentToolResultStatuses(requestId: string): AgentToolResultStatus[] {
  return (
    activeRuns.get(requestId)?.toolResults.map((r) => ({ id: r.id, ok: r.ok, denied: r.denied })) ??
    []
  )
}

export function resolveAgentConfirm(
  requestId: string,
  confirmId: string,
  allow: boolean,
  always: boolean
): boolean {
  const run = activeRuns.get(requestId)
  if (!run) return false
  const pending = run.confirms.get(confirmId)
  if (!pending) return false
  clearTimeout(pending.timer)
  run.confirms.delete(confirmId)
  if (always && allow) run.alwaysAllowed.add(pending.toolName)
  pending.resolve(allow)
  return true
}

export function cancelAgentConfirms(requestId: string): void {
  const run = activeRuns.get(requestId)
  if (!run) return
  for (const pending of run.confirms.values()) {
    clearTimeout(pending.timer)
    pending.resolve(false)
  }
  run.confirms.clear()
}

/** 等待渲染端应答；超时自动拒绝（resolve false）兜底，真实应答/中断会清掉 timer */
function waitConfirm(runState: RunState, info: PendingConfirmInfo): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      runState.confirms.delete(info.confirmId)
      resolve(false)
    }, CONFIRM_TIMEOUT_MS)
    runState.confirms.set(info.confirmId, { ...info, resolve, timer })
  })
}

function buildSystemPrompt(projectId: string): string {
  const project = store.listProjects().find((p) => p.id === projectId)
  if (!project) throw new Error('项目不存在，无法启动智能体')
  const globalInstr = coreWritingRules().trim()
  const projectInstr = readProjectInstructions(projectId).trim()
  return [
    '你是小说项目的智能体编辑助理，通过工具直接读写当前项目的资料库（人物、世界观、大纲、章节正文、伏笔）。',
    '',
    `当前项目：《${project.title}》${project.genre ? `（类型：${project.genre}）` : ''}`,
    project.styleGuide ? `风格指南：\n${project.styleGuide}` : '（未配置风格指南）',
    ...(globalInstr
      ? [
          '',
          '用户全局指令（核心节，所有项目生效；分节细则按任务经 get_writing_rules 工具拉取）：',
          globalInstr
        ]
      : []),
    ...(projectInstr ? ['', '本项目用户指令（优先级高于全局指令）：', projectInstr] : []),
    '',
    '工作规则：',
    '1. 修改前先用读工具核实目标（例如按名字找到准确 id），禁止凭记忆猜测 id',
    '2. 修改既有内容时，先取回原文，在原文基础上修改，不要凭空整段重写',
    '3. 新建条目时不传 id；修改时必须传 id',
    '4. 每完成一个任务，用简短中文总结做了什么；不要输出与任务无关的内容',
    '5. 若某操作被用户拒绝，不要重试同一操作，改为说明原因并询问下一步建议',
    '6. 用户要求模糊时（如"优化一下大纲"），先读取现状再决定改法，必要时先说明你的计划',
    '7. 全局性任务（矛盾检查、一致性审校、批量统计或修改）必须覆盖全部相关条目：先看 total/hasMore/byCategory 规划分批，逐批读取直至 hasMore=false，再下结论并在结论中说明覆盖范围；结果被截断时改用 category/volume 过滤、offset/limit 分页或 detail=summary 重试，禁止基于不完整数据下最终结论',
    '8. 写入世界观词条或人物卡时遵循标签纪律：每条至少 2 个标签，优先复用现有标签，没有合适的就新建可被多条共享的上位主题标签（体系名/时代名/事件名/族群名等），禁止无标签条目或让标签留空；[[ ]] 链接有单向纪律：只允许人物卡单向链接世界观条目（卡末尾「关联：」行写 [[世界观条目|关系短语]]），世界观条目之间可互链（优先写 [[目标|关系短语]]，关系短语写清「是什么关系」，简单提及才用裸 [[目标]]），但世界观条目严禁反向链人物名——提及人物直接写名字或纯文本描述，不加双方括号；关系化链接会被知识图谱解析成带语义的边',
    '9. 写章节正文前的固定序列（顺序不可省略）：① list_outlines 找到上一章大纲 id，同时取出本章大纲（标题写在 outline.title 上；scenes 场景序列是「这章怎么演」的逐场依据，正文须逐场落实）；② get_chapter_tail 回读上一章结尾，找回语气、当前悬念与情绪落点，开头自然承接、禁止复述；③ 读取本章出场人物的 get_entity(kind=character)（关注动态状态 state）；④ list_foreshadows 核对未回收伏笔（关注 plannedResolve 计划回收点与 priority 优先级，本章该埋/该收的在梗概或 foreshadowOps 里）；⑤ list_summaries 取上一章摘要，按其 ledger 硬账对齐数字（人数/金额/库存/伤势程度等不得无故跳变）；⑥ 然后才动笔',
    '10. 找"与某主题相关的设定/人物/章节"时优先用 search_project 语义搜索，比翻页浏览高效；要找「哪些地方写了某个确切字符串」（如 [[链接名]] 的引用处、改名前的旧标题、专名出现位置）用 grep_project 精确定位；两者都空再回退 list_* 分页浏览',
    '11. 回答全书级问题（整体脉络/主题/长线走向）前先用 get_book_digest 拿全局概览，再按需深入具体卷章；不要靠翻页拼凑全局判断',
    '12. 完成写章任务后，若人物状态发生变化（伤势/物品/信息/立场），顺手用 update_character_state 更新其状态文档（旧条目可删，保持紧凑）',
    '13. 大范围调研/核对（全书矛盾检查、批量统计、跨卷一致性）若预计要翻阅大量条目，用 spawn_subagent 委派只读子智能体代劳，拿到报告后再执行写入决策；委派时 task 必须写全调查范围、判断标准与期望报告格式，一个子任务聚焦一件事，需要写入的修改由你亲自执行',
    '14. 刷新某卷卷摘要一律用 refresh_volume_summary（走与自动写作相同的生成链，自动落库），不要自己拼一段文字当卷摘要写；重新规划章节时用 save_outline 的 scenes 参数逐场排「人物+动作/冲突」场景序列（synopsis 只写「这章讲什么」，怎么演落在 scenes）',
    '15. 章节编号由系统按位置自动重排：引用其他章节用章节标题或大纲 id，不要在 synopsis/scenes/正文里写死「第N章」（插删章后会漂移）；需要插章用 save_outline 的插入语义（chapterNo=插到该章号之前、afterOutlineId=插到某章之后、缺省追加末尾），移动/改卷用 save_outline 修改 chapterNo 或传 afterOutlineId',
    '16. 卷创意与本卷/通用节奏规则存在大纲生成页的向导参数里：读取用 get_outline_plan，保存用 save_outline_plan（未传字段保留原值，空串清空）；为某卷起草新卷创意时写成 3-5 个自然段的软分段形态，每段以「开篇章（卷首）：」等相对位置短语开头（禁写死章号），段间渐进过渡，总长 400-600 字',
    '17. 世界观类型管理：优先复用现有类型；条目换类型用 set_worldbuild_category（目标类型不存在会自动创建）；确需新类型用 worldbuild_type 的 op=create（可同时带 before/after/first/last 之一插到语义相邻处）；删类型用 op=delete（类型下还有条目时先逐条 set_worldbuild_category 迁走再删）',
    '18. 长任务（批量改写、全书检查、跨卷校对）中收到「上下文过大」系统提示、或确认早前细节已处理完时，主动用 compact_context 把历史压成摘要再继续；摘要必须包含任务目标与范围、已完成的修改（含条目 id 与新值）、待办事项、重要发现与决定，宁可写长不可漏关键 id',
    '19. 任务未完成时禁止停下征询意见或等待指示：直接继续调用工具执行下一步。只有两种情况可以停下：任务真正全部完成（此时输出最终总结），或遇到必须由用户决策的分叉（此时明确列出选项与你的建议）。压缩上下文后不要回复确认性文字，直接继续干活',
    '20. 开始创作任务（写正文/大纲/卷创意/人物卡/世界观/伏笔规划/润色扩写）前，先调 get_writing_rules 拉取该任务相关的写作分节并遵守。常用 tags：写正文 ["chapter","prose","dialogue","hooks","plot","continuity","character"]；改稿润色 ["polish","prose","dialogue","hooks","continuity"]；大纲/卷创意/对齐 ["outline","plot","fore"]；人物卡 ["character"]；世界观条目 ["worldbuild"]；伏笔登记/回收 ["fore"]；批量写作/审校 ["agent","chapter","prose","continuity"]'
  ].join('\n')
}

export function serializeResult(data: unknown): string {
  let text: string
  if (typeof data === 'string') text = data
  else text = JSON.stringify(data, null, 0)
  const c = clip(text, MAX_RESULT_CHARS)
  return c.truncated
    ? `${c.text}\n[结果过大被截断：请改用 category/volume 过滤、offset/limit 分页、detail=summary 或按 id 逐条读取后重试，勿基于截断数据下全局结论]`
    : c.text
}

export async function runAgent(opts: {
  sink: EventSink
  requestId: string
  projectId: string
  messages: ChatMessage[]
  model: string
  signal: AbortSignal
  /** transcript 事实源落库钩子（会话事件按发生顺序持久化；内部吞错，不影响 run） */
  persist?: (ev: AgentTranscriptInput) => void
}): Promise<AgentDonePayload> {
  const { sink, requestId, projectId, signal } = opts
  const persist = opts.persist ?? (() => {})
  const send = <C extends EventChannels>(
    channel: C,
    ...rest: EventContract[C] extends [unknown, ...infer R] ? R : never
  ): void => {
    if (!sink.isClosed())
      sink.send(channel, ...([requestId, ...rest] as unknown as EventContract[C]))
  }

  const auth = await resolveRequestAuth('agent')
  if (!auth.apiKey && auth.needsKey) throw new Error('未配置 API Key，请先在设置中填写')
  const system = buildSystemPrompt(projectId)

  const runState: RunState = { confirms: new Map(), alwaysAllowed: new Set(), toolResults: [] }
  activeRuns.set(requestId, runState)

  /** 发工具结果事件并登记流水（done 收尾时随 payload 下发，snapshot 期间轻量对账） */
  const emitToolResult = (ev: AgentToolResultEvent): void => {
    runState.toolResults.push(ev)
    persist({
      kind: 'tool_result',
      id: ev.id,
      ok: ev.ok,
      result: ev.result,
      ...(ev.denied ? { denied: true } : {})
    })
    send('agent:toolResult', ev)
  }

  const usage: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  }

  const execCtxBase: Omit<ToolExecContext, 'parentId'> = {
    sink,
    requestId,
    projectId,
    usage,
    signal,
    model: opts.model || auth.model,
    apiKey: auth.apiKey,
    baseUrl: auth.baseUrl,
    promptCache: auth.promptCache
  }
  let subagentCount = 0
  let pendingCompact: string | null = null
  let compacted = false
  let compactSummary = ''
  let toolUseCount = 0
  let autoContinues = 0

  const messages = [...opts.messages]
  const tools = getAgentToolDefs()
  let requests = 0
  let turnCount = 0
  let changed = false
  let denied = false
  let finalText = ''
  let lastModel = opts.model
  let hitLimit = false
  const started = Date.now()
  /** 当前 chatStream 已流出但尚未按轮落库的文本（中断/异常时在 finally 兜底持久化） */
  let pendingTurnText = ''

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      turnCount = turn + 1
      const result = await chatStream(
        {
          model: opts.model || auth.model,
          system,
          messages,
          tools,
          maxTokens: AGENT_MAX_TOKENS,
          purpose: 'agent',
          cacheSystem: auth.promptCache
        },
        { apiKey: auth.apiKey, baseUrl: auth.baseUrl },
        (text) => {
          pendingTurnText += text
          send('agent:delta', text)
        },
        signal
      )
      requests++
      // transcript 按轮合并落库（空文本也落：纯工具轮的结构需要 assistant 占位）
      persist({ kind: 'assistant', text: result.text })
      pendingTurnText = ''
      lastModel = result.model
      usage.inputTokens += result.usage.inputTokens
      usage.outputTokens += result.usage.outputTokens
      usage.cacheReadTokens += result.usage.cacheReadTokens
      usage.cacheCreationTokens += result.usage.cacheCreationTokens
      appendUsage({
        ts: Date.now(),
        model: result.model,
        purpose: 'agent',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        durationMs: result.durationMs,
        ratelimit: pickRatelimitHeaders(result.headers)
      })

      if (result.toolUses.length === 0) {
        finalText = result.text
        // 自动续跑：任务疑似中途停摆（压缩后停顿/征询语）时注入合成消息继续，
        // 预算用尽即止；被中断（signal.aborted）不续，尊重用户停止意图
        if (
          !signal.aborted &&
          autoContinues < MAX_AUTO_CONTINUES &&
          looksLikePaused(finalText, toolUseCount, compacted)
        ) {
          autoContinues++
          messages.push({
            role: 'user',
            content: [
              '（系统自动续跑）检测到你可能在中途停下。请直接继续调用工具完成任务，无需征询意见；',
              '若确已全部完成，直接输出最终总结后停止；若存在必须由用户决策的分叉，列出选项后停止。',
              ...(autoContinues >= MAX_AUTO_CONTINUES
                ? [
                    '注意：自动续跑机会已用完，若本轮结束任务仍未完成，请明确交代已完成什么、还剩什么、为何停止。'
                  ]
                : [])
            ].join('')
          })
          continue
        }
        break
      }

      const assistantBlocks: ContentBlock[] = []
      if (result.text) assistantBlocks.push({ type: 'text', text: result.text })
      for (const tu of result.toolUses) {
        assistantBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
      }
      messages.push({ role: 'assistant', content: assistantBlocks })

      const resultBlocks: ContentBlock[] = []
      for (const tu of result.toolUses) {
        toolUseCount++
        if (tu.name === 'compact_context') {
          const summary = typeof tu.input?.summary === 'string' ? tu.input.summary.trim() : ''
          persist({
            kind: 'tool_call',
            call: { id: tu.id, name: tu.name, input: tu.input, state: 'running' }
          })
          send('agent:toolCall', { id: tu.id, name: tu.name, input: tu.input, state: 'running' })
          if (!summary) {
            resultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: '错误: summary 不能为空（把任务目标、已完成修改含 id、待办写进摘要再压缩）',
              is_error: true
            })
            emitToolResult({ id: tu.id, ok: false, result: 'summary 不能为空' })
            continue
          }
          pendingCompact = summary
          const msg =
            '已压缩：此前全部对话历史已替换为该摘要。不要输出确认性文字，直接继续调用工具执行下一步工作'
          resultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: msg })
          emitToolResult({ id: tu.id, ok: true, result: msg })
          continue
        }
        const tool = TOOL_MAP.get(tu.name)
        if (!tool) {
          resultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: `错误: 未知工具 ${tu.name}`,
            is_error: true
          })
          emitToolResult({ id: tu.id, ok: false, result: `未知工具 ${tu.name}` })
          continue
        }

        let dangerReason: string | null = null
        if (tool.danger) dangerReason = '删除操作不可恢复'
        if (tool.dangerCheck) {
          try {
            dangerReason = tool.dangerCheck(tu.input, projectId) ?? dangerReason
          } catch {
            /* 参数不合法时交给 handler 报错 */
          }
        }

        if (dangerReason && !runState.alwaysAllowed.has(tu.name)) {
          persist({
            kind: 'tool_call',
            call: {
              id: tu.id,
              name: tu.name,
              input: tu.input,
              state: 'confirming',
              dangerReason
            }
          })
          send('agent:toolCall', {
            id: tu.id,
            name: tu.name,
            input: tu.input,
            state: 'confirming',
            dangerReason
          })
          const allowed = await waitConfirm(runState, {
            confirmId: tu.id,
            toolName: tu.name,
            input: tu.input,
            dangerReason: dangerReason ?? undefined
          })
          if (!allowed) {
            denied = true
            const msg = '用户拒绝了该操作'
            resultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: msg,
              is_error: true
            })
            emitToolResult({ id: tu.id, ok: false, result: msg, denied: true })
            continue
          }
        } else {
          persist({
            kind: 'tool_call',
            call: { id: tu.id, name: tu.name, input: tu.input, state: 'running' }
          })
          send('agent:toolCall', { id: tu.id, name: tu.name, input: tu.input, state: 'running' })
        }

        let ok: boolean
        let out: string
        try {
          if (tool.execCtx) {
            if (subagentCount >= MAX_SUBAGENTS) {
              throw new Error('已达到本次任务的子智能体委派上限，请自行完成剩余工作并总结')
            }
            subagentCount++
            out = serializeResult(await tool.execCtx(tu.input, { ...execCtxBase, parentId: tu.id }))
            ok = true
          } else {
            out = serializeResult(await tool.handler(tu.input, projectId))
            ok = true
          }
          if (!READ_TOOLS.has(tu.name) && tu.name !== 'spawn_subagent') changed = true
        } catch (err) {
          out = `错误: ${(err as Error)?.message ?? String(err)}`
          ok = false
        }
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: out,
          is_error: ok ? undefined : true
        })
        emitToolResult({ id: tu.id, ok, result: out })
      }
      if (result.usage.inputTokens > COMPACT_NUDGE_TOKENS && resultBlocks.length > 0) {
        const last = resultBlocks[resultBlocks.length - 1]
        if (last.type === 'tool_result')
          last.content += `\n[系统提示：本次请求输入约 ${result.usage.inputTokens} tokens，上下文偏大。若早前细节已不再需要，建议调用 compact_context 压缩历史（先把任务目标、已完成修改含 id、待办事项写进摘要），压缩后直接继续调用工具，不要停下来等待确认]`
      }
      messages.push({ role: 'user', content: resultBlocks })

      if (pendingCompact !== null) {
        // 压缩必须在本轮 tool_use/tool_result 全部落账后整体替换，保证配对约束不被破坏
        messages.length = 0
        messages.push({
          role: 'user',
          content: `【上下文压缩】以下摘要替代了此前全部对话历史：\n${pendingCompact}`
        })
        compacted = true
        compactSummary = pendingCompact
        pendingCompact = null
      }

      if (turn === MAX_TURNS - 1) hitLimit = true
    }
  } finally {
    if (pendingTurnText.trim()) persist({ kind: 'assistant', text: pendingTurnText })
    cancelAgentConfirms(requestId)
    activeRuns.delete(requestId)
  }

  return {
    text: finalText,
    turns: turnCount,
    requests,
    changed,
    denied,
    hitLimit,
    subagents: subagentCount,
    usage,
    model: lastModel,
    durationMs: Date.now() - started,
    toolResults: runState.toolResults,
    autoContinues,
    ...(compacted ? { compact: { summary: compactSummary } } : {})
  }
}
