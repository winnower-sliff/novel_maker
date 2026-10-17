import type { AgentToolResultEvent, EventChannels, EventContract } from '../../shared/contract'
import type { ProviderId } from '../../shared/providers'
import type {
  AgentBoard,
  AgentDonePayload,
  AgentTranscriptInput,
  ChatMessage,
  PendingConfirmInfo,
  ToolDef,
  UsageInfo
} from '../../shared/types'
import type { EventSink } from '../eventSink'
import { resolveRequestAuth } from '../settings'
import { getSkill, listSkills, stripFrontmatter } from '../skills'
import * as store from '../store'
import { activeBoard } from './boards'
import { coreWritingRules, projectCoreRules } from './instructions'
import { type LoopEmit, runLoop } from './loop'
import {
  authorizeCall,
  DELETE_TOOLS,
  EXEC_PROMPT,
  executionToolDefs,
  makePlanTools,
  PLANNING_PROMPT,
  planningToolDefs,
  writeTargetOf
} from './plan'
import { createCompactPolicy, createLoopCounters, DEFAULT_CONTEXT_WINDOW } from './policy/compact'
import { ConfirmRegistry } from './policy/confirm'
import { createContinuePolicy } from './policy/continue'
import { drainInjections } from './queue'
import { agentMaxTokens, MAX_SUBAGENTS, MAX_TURNS, type ToolExecContext } from './toolkit'
import { getToolDefs, READ_TOOLS, TOOL_MAP } from './tools'

export function getAgentToolDefs(): ToolDef[] {
  return getToolDefs()
}

const activeRuns = new Map<
  string,
  { confirms: ConfirmRegistry; toolResults: AgentToolResultEvent[] }
>()

export function getAgentPendingConfirm(requestId: string): PendingConfirmInfo | null {
  return activeRuns.get(requestId)?.confirms.peekPending() ?? null
}

/** running 期间已完成工具的轻量状态表（runtime:snapshot 周期对账用，不带 result 全文） */
export function getAgentToolResultStatuses(requestId: string) {
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
  return activeRuns.get(requestId)?.confirms.resolve(confirmId, allow, always) ?? false
}

export function cancelAgentConfirms(requestId: string): void {
  activeRuns.get(requestId)?.confirms.cancelAll()
}

function buildSystemPrompt(projectId: string): string {
  const project = store.listProjects().find((p) => p.id === projectId)
  if (!project) throw new Error('项目不存在，无法启动智能体')
  const globalInstr = coreWritingRules().trim()
  const projectInstr = projectCoreRules(projectId).trim()
  const skillIndex = listSkills()
  const alwaysSkillBodies = skillIndex
    .filter((s) => s.always)
    .map((s) => {
      const file = getSkill(s.filename)
      return file ? `── 技能：${file.name} ──\n${stripFrontmatter(file.raw)}` : ''
    })
    .filter(Boolean)
  return [
    '你是小说项目的智能体编辑助理，通过工具直接读写当前项目的资料库（人物、世界观、大纲、章节正文、伏笔）。',
    '',
    `当前项目：《${project.title}》${project.genre ? `（类型：${project.genre}）` : ''}`,
    project.styleGuide ? `风格指南：\n${project.styleGuide}` : '（未配置风格指南）',
    ...(globalInstr
      ? [
          '',
          '用户全局指令（跨项目偏好；核心节恒注入，分节细则按任务经 get_writing_rules 工具拉取）：',
          globalInstr
        ]
      : []),
    ...(projectInstr
      ? [
          '',
          '本项目用户指令（最高优先级：与全局指令、技能模板冲突时以本项目为准；分节细则同样经 get_writing_rules 拉取）：',
          projectInstr
        ]
      : []),
    ...(alwaysSkillBodies.length
      ? ['', '常驻技能（每次任务无条件适用；与用户指令冲突时以指令为准）：', ...alwaysSkillBodies]
      : []),
    ...(skillIndex.length
      ? [
          '',
          '可用技能索引（需要详细写法/模板时用 load_skill 按文件名加载全文；标注「已常驻」的技能已在上方给出全文）：',
          ...skillIndex.map(
            (s) =>
              `- ${s.filename.replace(/\.md$/, '')}${s.always ? '（已常驻）' : ''}：${s.description}`
          )
        ]
      : []),
    '',
    '工作规则：',
    '1. 修改前先用读工具核实目标（例如按名字找到准确 id），禁止凭记忆猜测 id',
    '2. 修改既有内容时，先取回原文，在原文基础上修改，不要凭空整段重写；小范围定点修改（换名/改几句/修矛盾/批量改名）优先用 edit_text 字面量替换（find 与原文逐字一致，多处时报错会列出位置），只把确实需要大改的整段/整章交给 save_chapter / save_section 全量覆盖',
    '3. 新建条目时不传 id；修改时必须传 id',
    '4. 每完成一个任务，用简短中文总结做了什么；不要输出与任务无关的内容',
    '5. 若某操作被用户拒绝，不要重试同一操作，改为说明原因并询问下一步建议',
    '6. 用户要求模糊时（如"优化一下大纲"），先读取现状再决定改法，必要时先说明你的计划',
    '7. 全局性任务（矛盾检查、一致性审校、批量统计或修改）必须覆盖全部相关条目：先看 total/hasMore/byCategory 规划分批，逐批读取直至 hasMore=false，再下结论并在结论中说明覆盖范围；结果被截断时改用 category/volume 过滤、offset/limit 分页或 detail=summary 重试，禁止基于不完整数据下最终结论',
    '8. 写入世界观词条或人物卡时遵循标签纪律：每条至少 2 个标签，优先复用现有标签，没有合适的就新建可被多条共享的上位主题标签（体系名/时代名/事件名/族群名等），禁止无标签条目或让标签留空；[[ ]] 链接有单向纪律：只允许人物卡单向链接世界观条目（用 save_character 的 relation 参数写 [[世界观条目|关系短语]]，展示为卡末尾「关联：」行），世界观条目之间可互链（优先写 [[目标|关系短语]]，关系短语写清「是什么关系」，简单提及才用裸 [[目标]]），但世界观条目严禁反向链人物名——提及人物直接写名字或纯文本描述，不加双方括号；关系化链接会被知识图谱解析成带语义的边',
    '9. 写/续写章节正文的固定闭环（顺序不可省略）：① 动笔前必调 get_chapter_context（传本章大纲 id；它已整合本章场景序列、上一章结尾与硬账、人物动态状态、伏笔台账与回收计划、卷摘要与相关世界观，无须再逐个翻查）；② 正文用 append_chapter 分段追加：每次不超过约 3000 字，写完一段就追加一次，长章绝不求一次写完；要修改已有段落用 edit_text，禁止为小改而整章重写；③ 全部写完后调 lint_chapter 自检，pass=false 就逐条按 advice 修复并重跑，通过才算完；④ 收尾必调 save_summary 落摘要与硬账（章节状态自动升「已写」）',
    '10. 找"与某主题相关的设定/人物/章节"时优先用 search_project 语义搜索，比翻页浏览高效；要找「哪些地方写了某个确切字符串」（如 [[链接名]] 的引用处、改名前的旧标题、专名出现位置）用 grep_project 精确定位；两者都空再回退 list_* 分页浏览',
    '11. 回答全书级问题（整体脉络/主题/长线走向）前先用 get_book_digest 拿全局概览，再按需深入具体卷章；不要靠翻页拼凑全局判断',
    '12. 完成写章任务后，若人物状态发生变化（伤势/物品/信息/立场），顺手用 update_character_state 更新其状态文档（旧条目可删，保持紧凑）',
    '13. 大范围调研/核对（全书矛盾检查、批量统计、跨卷一致性）若预计要翻阅大量条目，用 spawn_subagent 委派只读子智能体代劳，拿到报告后再执行写入决策；委派时 task 必须写全调查范围、判断标准与期望报告格式，一个子任务聚焦一件事，需要写入的修改由你亲自执行',
    '14. 刷新某卷卷摘要一律用 refresh_volume_summary（LLM 生成后自动落库），不要自己拼一段文字当卷摘要写；重新规划章节时用 save_outline 的 scenes 参数逐场排「人物+动作/冲突」场景序列（synopsis 只写「这章讲什么」，怎么演落在 scenes）',
    '15. 章节编号由系统按位置自动重排：引用其他章节用章节标题或大纲 id，不要在 synopsis/scenes/正文里写死「第N章」（插删章后会漂移）；需要插章用 save_outline 的插入语义（chapterNo=插到该章号之前、afterOutlineId=插到某章之后、缺省追加末尾），移动/改卷用 save_outline 修改 chapterNo 或传 afterOutlineId',
    '16. 卷创意与本卷/通用节奏规则存在大纲生成页的向导参数里：读取用 get_outline_plan，保存用 save_outline_plan（未传字段保留原值，空串清空）；为某卷起草新卷创意时写成 3-5 个自然段的软分段形态，每段以「开篇章（卷首）：」等相对位置短语开头（禁写死章号），段间渐进过渡，总长 400-600 字',
    '17. 世界观类型管理：优先复用现有类型；条目换类型用 set_worldbuild_category（目标类型不存在会自动创建）；确需新类型用 worldbuild_type 的 op=create（可同时带 before/after/first/last 之一插到语义相邻处）；删类型用 op=delete（类型下还有条目时先逐条 set_worldbuild_category 迁走再删）',
    '18. 长任务（批量改写、全书检查、跨卷校对）中收到「上下文过大」系统提示、或确认早前细节已处理完时，主动用 compact_context 把历史压成摘要再继续；摘要必须包含任务目标与范围、已完成的修改（含条目 id 与新值）、待办事项、重要发现与决定、连续性数字硬账（人数/金额/库存/伤势等当前值），宁可写长不可漏关键 id',
    '19. 任务未完成时禁止停下征询意见或等待指示：直接继续调用工具执行下一步。只有两种情况可以停下：任务真正全部完成（此时输出最终总结），或遇到必须由用户决策的分叉（此时明确列出选项与你的建议）。压缩上下文后不要回复确认性文字，直接继续干活',
    '20. 开始创作任务（写正文/大纲/卷创意/人物卡/世界观/伏笔规划/润色扩写）前，先调 get_writing_rules 拉取该任务相关的写作分节并遵守（本项目指令 > 全局规则 > 技能模板）。常用 tags：写正文 ["chapter","prose","dialogue","hooks","plot","continuity","character"]；改稿润色 ["polish","prose","dialogue","hooks","continuity"]；大纲/卷创意/对齐 ["outline","plot","fore"]；人物卡 ["character"]；世界观条目 ["worldbuild"]；伏笔登记/回收 ["fore"]；批量写作/审校 ["agent","chapter","prose","continuity"]。需要某类任务的详细写法/模板时，按上方技能索引用 load_skill 加载对应技能全文'
  ].join('\n')
}

export async function runAgent(opts: {
  sink: EventSink
  requestId: string
  projectId: string
  /** 所属会话（插入指令安全点按它对账；直连/旧路径可缺省） */
  sessionId?: string
  messages: ChatMessage[]
  model: string
  signal: AbortSignal
  /** 临时指定本次会话的 provider（覆盖路由与默认，智能体页「引擎」切换用） */
  provider?: ProviderId
  /** transcript 事实源落库钩子（会话事件按发生顺序持久化；内部吞错，不影响 run） */
  persist?: (ev: AgentTranscriptInput) => void
  /**
   * 计划模式上下文：phase='plan' 计划期（写工具移出工具集+提案工具+等批准停顿豁免）；
   * phase='exec' 执行期（写授权闸门+授权内免确认+看板勾销提醒）。缺省=正常模式（38 工具全集）。
   */
  plan?: { phase: 'plan' | 'exec' }
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

  const auth = await resolveRequestAuth('agent', opts.provider)
  if (!auth.apiKey && auth.needsKey) throw new Error('未配置 API Key，请先在设置中填写')

  // 计划模式上下文：三工具绑定 sessionId+persist（board 事件落库即广播）
  const planPhase = opts.plan?.phase
  const planTools =
    planPhase && opts.sessionId
      ? makePlanTools({
          sessionId: opts.sessionId,
          projectId,
          runId: requestId,
          persist
        })
      : null

  const system =
    buildSystemPrompt(projectId) +
    (planPhase === 'plan'
      ? `\n\n${PLANNING_PROMPT}`
      : planPhase === 'exec'
        ? `\n\n${EXEC_PROMPT}`
        : '')

  // 工具集按相位筛选（计划期写工具移出=硬闸；执行期移除 propose_plan）；plan 工具并入 toolMap
  const tools =
    planPhase && planTools
      ? planPhase === 'plan'
        ? planningToolDefs(planTools.tools)
        : executionToolDefs(planTools.tools)
      : getAgentToolDefs()
  // plan 三工具并入 toolMap；执行期 propose_plan 不进（executionToolDefs 已滤，幻觉调用按未知工具拒绝）；
  // 计划期 update_board 不进（planningToolDefs 已滤，未批准不可勾销）——toolMap 与 defs 严格同步
  const toolMap = new Map(TOOL_MAP)
  if (planTools) {
    for (const t of planTools.tools) {
      if (planPhase === 'exec' && t.def.name === 'propose_plan') continue
      if (planPhase === 'plan' && t.def.name === 'update_board') continue
      toolMap.set(t.def.name, t)
    }
  }
  // plan 三工具不改项目数据，不参与 changed 标记（execCtx 工具本就不进并发批）
  const readTools =
    planPhase && planTools
      ? new Set([...READ_TOOLS, 'propose_plan', 'get_board', 'update_board'])
      : READ_TOOLS

  const confirms = new ConfirmRegistry()
  const toolResults: AgentToolResultEvent[] = []
  const runEntry = { confirms, toolResults }
  activeRuns.set(requestId, runEntry)

  /** 发工具结果事件并登记流水（done 收尾时随 payload 下发，snapshot 期间轻量对账） */
  const callInputs = new Map<string, { name: string; input: Record<string, unknown> }>()
  const nudgedSteps = new Set<string>()

  /** 执行期看板提醒：写工具成功且命中某 pending 步骤授权范围时，在结果尾部提示勾销（每步骤一次） */
  const maybeNudge = (ev: AgentToolResultEvent): void => {
    if (planPhase !== 'exec' || !ev.ok || ev.denied) return
    const call = callInputs.get(ev.id)
    if (!call) return
    const target = writeTargetOf(call.name, call.input)
    if (!target) return
    const board: AgentBoard | null = opts.sessionId ? activeBoard(opts.sessionId) : null
    if (board?.status !== 'approved') return
    for (const step of board.steps) {
      if (step.status !== 'pending' && step.status !== 'in_progress') continue
      if (!step.writeScope || step.writeScope.resource !== target.resource) continue
      if (target.id && !step.writeScope.ids.includes(target.id)) continue
      if (nudgedSteps.has(step.id)) continue
      nudgedSteps.add(step.id)
      ev.result += `\n\n[看板提醒：步骤「${step.title}」对应的写入已完成，请用 update_board 把它标记为 done（未完成则 in_progress），保持看板准确]`
    }
  }

  const emitToolResult = (ev: AgentToolResultEvent): void => {
    maybeNudge(ev)
    toolResults.push(ev)
    persist({
      kind: 'tool_result',
      id: ev.id,
      ok: ev.ok,
      result: ev.result,
      ...(ev.denied ? { denied: true } : {})
    })
    send('agent:toolResult', ev)
  }

  const counters = createLoopCounters()
  const compactPolicy = createCompactPolicy({
    counters,
    messages: opts.messages,
    contextWindow: auth.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    emitToolCall: (call) => {
      persist({ kind: 'tool_call', call })
      send('agent:toolCall', call)
    },
    emitToolResult
  })
  const continuePolicy = createContinuePolicy(counters)

  const emit: LoopEmit = {
    delta: (text) => send('agent:delta', text),
    toolCall: (call) => {
      callInputs.set(call.id, { name: call.name, input: call.input })
      persist({ kind: 'tool_call', call })
      send('agent:toolCall', call)
    },
    toolResult: emitToolResult
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
    sessionId: opts.sessionId,
    usage,
    signal,
    model: opts.model || auth.model,
    apiKey: auth.apiKey,
    baseUrl: auth.baseUrl,
    protocol: auth.protocol,
    promptCache: auth.promptCache,
    planPhase,
    // 执行期给可写子代理配看板自查工具（persist 已绑定主 run，board 变化照常广播）
    ...(planPhase === 'exec' && planTools
      ? {
          boardTools: new Map(
            [...planTools.toolMap].filter(
              ([name]) => name === 'get_board' || name === 'update_board'
            )
          )
        }
      : {})
  }

  const messages = [...opts.messages]
  const subagentBudget = { used: 0, max: MAX_SUBAGENTS }
  const started = Date.now()

  try {
    const result = await runLoop(
      messages,
      {
        system,
        tools,
        toolMap,
        readTools,
        projectId: opts.projectId,
        model: opts.model || auth.model,
        maxTokens: agentMaxTokens(auth.provider),
        promptCache: auth.promptCache,
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        protocol: auth.protocol,
        maxTurns: MAX_TURNS,
        signal
      },
      {
        emit,
        usage,
        counters,
        confirm: async (call) => {
          // 执行期：计划授权内的 danger 写入免弹窗（含覆盖正文）；删除类绝对弹窗（授权不覆盖删除）
          if (planPhase === 'exec' && !DELETE_TOOLS.has(call.name)) {
            const board = opts.sessionId ? activeBoard(opts.sessionId) : null
            if (authorizeCall(call.name, call.input, board).ok) return true
          }
          return confirms.wait({
            confirmId: call.id,
            toolName: call.name,
            input: call.input,
            dangerReason: call.dangerReason
          })
        },
        isAlwaysAllowed: (name) => confirms.isAlwaysAllowed(name),
        ...(planPhase === 'exec'
          ? {
              writeGuard: (name: string, input: Record<string, unknown>): string | null => {
                const r = authorizeCall(
                  name,
                  input,
                  opts.sessionId ? activeBoard(opts.sessionId) : null
                )
                return r.ok ? null : r.reason
              }
            }
          : {}),
        selfCompact: { toolName: 'compact_context' },
        onStreamError: (err, sig) => compactPolicy.onContextTooLong(err, sig),
        onAssistantTurn: (text, final) => {
          if (final || text.trim()) persist({ kind: 'assistant', text })
        },
        appendNudge: (blocks, inputTokens) => compactPolicy.appendNudge(blocks, inputTokens),
        onTurnEnd: async (st) => {
          const retry = st.selfCompacted
            ? false
            : compactPolicy.afterTurn(st.inputTokens, st.outputTokens, st.hadToolUses, signal)
          // 插入指令安全点：本轮工具与压缩全部落账后、下一轮模型调用前，
          // 把队列中的 inject 指令落为 user 事件并追加进 messages（正常 user 消息进历史回灌）
          if (opts.sessionId && !signal.aborted) {
            const injected = drainInjections(sink, opts.sessionId, persist)
            for (const text of injected) messages.push({ role: 'user', content: text })
          }
          return retry
        },
        onStop: (text, toolUseCount, compacted) => {
          // 计划期已提案：等批准是合法停顿，不做自动续跑（防 continuePolicy 误判「疑似停摆」）
          if (planPhase === 'plan' && planTools?.proposed()) return null
          return continuePolicy.onStop(text, toolUseCount, compacted)
        },
        subagentBudget,
        execCtxBase
      }
    )

    return {
      text: result.text,
      turns: result.turns,
      requests: result.requests,
      changed: result.changed,
      denied: result.denied,
      hitLimit: result.hitLimit,
      subagents: subagentBudget.used,
      usage,
      model: result.model,
      durationMs: Date.now() - started,
      toolResults: result.toolResults,
      autoContinues: result.autoContinues,
      autoCompacts: result.autoCompacts,
      ...(result.compacted ? { compact: { summary: result.compactSummary } } : {})
    }
  } finally {
    confirms.cancelAll()
    activeRuns.delete(requestId)
  }
}
