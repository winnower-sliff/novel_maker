import type {
  AgentBoard,
  AgentTranscriptInput,
  PlanResource,
  PlanStep,
  ToolDef
} from '../../shared/types'
import { activeBoard, createBoard, updateBoard } from './boards'
import type { AgentTool, ToolInput } from './toolkit'
import { clip, optStr, s, schema } from './toolkit'
import { READ_TOOLS, TOOLS } from './tools'

/**
 * 计划模式域：提案/看板三工具、写授权判定（authorizeCall）、计划期与执行期工具集筛选。
 * 工具走 execCtx 模式（需要 sessionId 与 transcript persist 落 board 事件），
 * 由 makePlanTools 工厂绑定闭包后交给 runAgent 组装进当次 run 的 toolMap。
 */

/** 删除类工具：跳过计划授权，恒走用户确认弹窗（主/子一致，绝对不放行） */
export const DELETE_TOOLS = new Set(['delete_entity', 'delete_outline'])

/**
 * 衍生白名单：写章闭环的系统规定附带操作，免 id 校验放行
 * （否则「写章→save_summary→update_character_state」链条会被授权校验打断）。
 */
export const FREE_TOOLS = new Set([
  'save_summary',
  'update_character_state',
  'refresh_volume_summary'
])

/** 写工具 → 资源 + 目标 id 提取（id 为空视为新建，按资源类型放行） */
interface WriterSpec {
  resource: PlanResource
  idOf: (input: ToolInput) => string | undefined
}

function strId(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

const EDIT_KIND_RESOURCE: Record<string, PlanResource> = {
  character: 'character',
  worldbuild: 'worldbuild',
  chapter: 'chapter'
}

const WRITERS: Record<string, WriterSpec> = {
  save_character: { resource: 'character', idOf: (i) => strId(i.id) },
  save_section: { resource: 'character', idOf: (i) => strId(i.entityId) },
  save_worldbuild: { resource: 'worldbuild', idOf: (i) => strId(i.id) },
  set_worldbuild_category: { resource: 'worldbuild', idOf: (i) => strId(i.id) },
  save_outline: { resource: 'outline', idOf: (i) => strId(i.id) },
  save_chapter: { resource: 'chapter', idOf: (i) => strId(i.outlineId) },
  append_chapter: { resource: 'chapter', idOf: (i) => strId(i.outlineId) },
  save_foreshadow: { resource: 'foreshadow', idOf: (i) => strId(i.id) },
  update_instruction_section: { resource: 'instruction', idOf: () => undefined },
  set_agent_instructions: { resource: 'instruction', idOf: () => undefined },
  update_project: { resource: 'project', idOf: () => undefined },
  save_outline_plan: { resource: 'project', idOf: () => undefined },
  edit_text: {
    resource: 'chapter',
    idOf: (i) => strId(i.id) ?? strId(i.entityId)
  }
}

export type AuthResult = { ok: true } | { ok: false; reason: string }

/** 提取写调用的目标资源与 id（无 id=新建；非写工具返回 null）——NUDGE 勾销提醒用 */
export function writeTargetOf(
  name: string,
  input: ToolInput
): { resource: PlanResource; id?: string } | null {
  const spec = WRITERS[name]
  if (!spec) return null
  let resource = spec.resource
  if (name === 'edit_text') {
    const kind = typeof input.kind === 'string' ? input.kind : ''
    resource = EDIT_KIND_RESOURCE[kind] ?? 'chapter'
  }
  const id = spec.idOf(input)
  return { resource, ...(id ? { id } : {}) }
}

/**
 * 写授权判定（执行期 writeGuard 与 confirm 免弹窗共用的单一事实源）：
 * - 读工具/衍生白名单/不在写映射的工具有条件放行（删除类交由 confirm 恒弹窗）
 * - 修改：目标 id 必须命中某步骤 writeScope 的 ids（按资源）
 * - 新建（无 id）：该资源须出现在任一步骤的 writeScope
 */
export function authorizeCall(
  name: string,
  input: ToolInput,
  board: AgentBoard | null
): AuthResult {
  if (FREE_TOOLS.has(name) || DELETE_TOOLS.has(name)) return { ok: true }
  const spec = WRITERS[name]
  if (!spec) return { ok: true }
  let resource = spec.resource
  const targetId = spec.idOf(input)
  if (name === 'edit_text') {
    const kind = typeof input.kind === 'string' ? input.kind : ''
    resource = EDIT_KIND_RESOURCE[kind] ?? 'chapter'
  }
  if (!board) {
    return {
      ok: false,
      reason: `当前处于计划执行模式，但找不到已批准的计划看板，写操作一律拒绝。请用 get_board 查看状态`
    }
  }
  const steps = board.steps.filter((st) => st.writeScope?.resource === resource)
  if (targetId) {
    const hit = steps.some((st) => st.writeScope?.ids.includes(targetId))
    if (!hit) {
      return {
        ok: false,
        reason: `目标（${resource} ${targetId}）不在已批准计划的授权范围内。请用 get_board 查看授权清单；若这是计划遗漏的目标，停下来向用户说明，不要擅自写入`
      }
    }
    return { ok: true }
  }
  // 新建：资源出现在任一步骤授权集即放行
  if (steps.length > 0) return { ok: true }
  return {
    ok: false,
    reason: `计划中没有任何步骤授权新建 ${resource} 类条目。请用 get_board 查看授权范围；确需新建时停下来向用户说明`
  }
}

/** 计划期工具集：只读 ∪ spawn_subagent ∪ compact_context ∪ propose_plan/get_board（写工具移出=硬闸，update_board 未批准不可勾销） */
export function planningToolDefs(planTools: AgentTool[]): ToolDef[] {
  const names = new Set<string>([...READ_TOOLS, 'spawn_subagent', 'compact_context'])
  const extra = planTools.filter((t) => t.def.name === 'propose_plan' || t.def.name === 'get_board')
  return [...TOOLS.filter((t) => names.has(t.def.name)), ...extra].map((t) => t.def)
}

/** 执行期工具集：全集 ∪ get_board/update_board（propose_plan 移出，执行期不再提案） */
export function executionToolDefs(planTools: AgentTool[]): ToolDef[] {
  const extra = planTools.filter((t) => t.def.name !== 'propose_plan')
  return [...TOOLS, ...extra].map((t) => t.def)
}

/** 计划期系统提示追加段 */
export const PLANNING_PROMPT = [
  '【计划模式】本会话处于计划模式：本任务只做调研与计划，不执行任何写入。',
  '- 先用只读工具（可 spawn_subagent 委派只读调研）核实目标与范围，再调用 propose_plan 提交结构化计划',
  '- propose_plan 的 steps：title=做什么（动词开头）；note=具体改法/判断标准；resource=将写入的资源类型（project/character/worldbuild/outline/chapter/foreshadow/summary/instruction）；ids=经调研确认要修改的条目 id（新建条目不传 ids，只传 resource）',
  '- 提交计划后立即停止并等待用户批准（这是唯一合法停顿）；用户可能编辑步骤或拒绝并附意见，届时按意见重新调研修订再次提案',
  '- 已提交未裁决时不要重复提案、不要输出无关内容'
].join('\n')

/** 执行期系统提示追加段 */
export const EXEC_PROMPT = [
  '【计划执行模式】用户已批准计划，你在授权范围内执行，无需再请求确认写入。',
  '- 严格按看板步骤执行；每完成一步用 update_board 把该步骤标记为 done（进行中标 in_progress），保持看板准确',
  '- 写操作仅限各步骤授权的资源与条目 id（新建按资源类型放行）；范围外写入会被系统拒绝，若确属必要停下来向用户说明',
  '- save_summary/update_character_state/refresh_volume_summary 为写章闭环附带操作，不受 id 授权限制',
  '- 删除类操作（delete_entity/delete_outline）仍需用户逐次确认，计划授权不覆盖删除',
  '- 全部步骤完成后：用 update_board 补齐 ledger（连续性硬账：人数/金额/库存/伤势等当前值），再输出最终总结'
].join('\n')

/** 执行 run 的合成首条指令（轻装：不回灌计划期调研明细） */
export function buildExecInstruction(board: AgentBoard): string {
  const lines = [
    `计划已获批准，开始执行。任务目标：${board.goal}`,
    '',
    '步骤（按序执行，完成后用 update_board 勾销）：',
    ...board.steps.map((s, i) => {
      const scope = s.writeScope
        ? `授权：${s.writeScope.resource}${s.writeScope.ids.length > 0 ? ` ${s.writeScope.ids.join('、')}` : '（新建）'}`
        : '授权：（本步骤无写入）'
      return `${i + 1}. ${s.title}${s.note ? `——${s.note}` : ''}｜${scope}`
    })
  ]
  if (board.feedback) lines.push('', `用户批准时的附加说明：${board.feedback}`)
  if (board.ledger) lines.push('', `连续性硬账（沿用）：${board.ledger}`)
  return lines.join('\n')
}

/** 看板序列化（get_board 结果与 NUDGE 上下文用） */
export function serializeBoard(board: AgentBoard): string {
  const stepLines = board.steps.map((s, i) => {
    const scope = s.writeScope
      ? `${s.writeScope.resource}${s.writeScope.ids.length > 0 ? `:${s.writeScope.ids.join(',')}` : '（新建）'}`
      : '无写入'
    return `${i + 1}. [${s.status}] ${s.title}${s.note ? `——${s.note}` : ''}｜${scope}`
  })
  return [
    `看板 ${board.id}（${board.status}）`,
    `目标：${board.goal}`,
    ...stepLines,
    board.ledger ? `硬账：${board.ledger}` : '硬账：（未记录）',
    board.feedback ? `用户意见：${board.feedback}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 计划三工具工厂：绑定 sessionId 与 transcript persist（board 事件落库即广播）。
 * proposed 回调暴露「本 run 已提案」状态，供 onStop 豁免自动续跑。
 */
export function makePlanTools(deps: {
  sessionId: string
  projectId: string
  runId: string
  persist: (ev: AgentTranscriptInput) => void
}): { tools: AgentTool[]; toolMap: Map<string, AgentTool>; proposed: () => boolean } {
  let proposed = false

  const proposePlan: AgentTool = {
    def: {
      name: 'propose_plan',
      description:
        '提交结构化执行计划等待用户批准（计划模式专用）。先调研核实目标 id，再提交：goal=任务目标；steps=有序步骤数组。提交后立即停止输出等待批准',
      input_schema: schema(
        {
          goal: s('任务目标（一句话）'),
          steps: {
            type: 'array',
            description: '有序执行步骤（1-12 步）',
            items: {
              type: 'object',
              properties: {
                title: s('步骤标题（动词开头）'),
                note: s('具体改法/判断标准（可选）'),
                resource: s(
                  '将写入的资源类型：project/character/worldbuild/outline/chapter/foreshadow/summary/instruction（可选，纯调研步骤不传）'
                ),
                ids: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '将修改的条目 id（经调研确认；新建条目不传）（可选）'
                }
              },
              required: ['title']
            }
          }
        },
        ['goal', 'steps']
      )
    },
    danger: false,
    handler: () => {
      throw new Error('propose_plan 由运行时直接处理，不应到达 handler')
    },
    execCtx: async (input) => {
      const goal = optStr(input, 'goal')?.trim() ?? ''
      const rawSteps = Array.isArray(input.steps) ? input.steps : []
      if (!goal) throw new Error('goal 不能为空')
      if (rawSteps.length === 0) throw new Error('steps 不能为空（至少 1 步，至多 12 步）')
      if (rawSteps.length > 12) throw new Error('步骤过多（至多 12 步），请合并同类步骤')
      const pending = activeBoard(deps.sessionId)
      if (pending?.status === 'awaiting_approval') {
        throw new Error(`已有待批准计划（${pending.id}），等待用户裁决，不要重复提案`)
      }
      const steps = rawSteps.map((r) => {
        const o = (r ?? {}) as ToolInput
        const title = typeof o.title === 'string' ? o.title.trim() : ''
        if (!title) throw new Error('每个步骤的 title 不能为空')
        return {
          title,
          ...(typeof o.note === 'string' && o.note.trim() ? { note: o.note } : {}),
          ...(typeof o.resource === 'string' && o.resource ? { resource: o.resource } : {}),
          ...(Array.isArray(o.ids) ? { ids: o.ids.map(String) } : {})
        }
      })
      const board = createBoard({
        sessionId: deps.sessionId,
        projectId: deps.projectId,
        runId: deps.runId,
        goal,
        steps
      })
      deps.persist({ kind: 'board', board })
      proposed = true
      return [
        '计划已提交，等待用户批准。立即停止输出并等待裁决（这是合法停顿）：',
        '- 批准后系统会发来执行指令（含授权清单），届时按步骤执行',
        '- 拒绝时会附用户意见，届时重新调研修订再次提案',
        '在裁决前不要调用任何工具、不要输出多余内容'
      ].join('\n')
    }
  }

  const getBoard: AgentTool = {
    def: {
      name: 'get_board',
      description: '查看当前任务看板（计划状态/步骤勾销情况/授权范围/硬账台账）。执行中随时可查',
      input_schema: schema({}, [])
    },
    danger: false,
    handler: () => {
      throw new Error('get_board 由运行时直接处理，不应到达 handler')
    },
    execCtx: async () => {
      const board = activeBoard(deps.sessionId)
      if (!board) return '当前会话没有看板'
      return clip(serializeBoard(board), 4000).text
    }
  }

  const updateBoardTool: AgentTool = {
    def: {
      name: 'update_board',
      description:
        '更新任务看板（执行期专用）：勾销步骤状态（pending/in_progress/done/skipped）、维护连续性硬账 ledger、修订目标表述',
      input_schema: schema(
        {
          stepUpdates: {
            type: 'array',
            description: '步骤状态更新（可选）',
            items: {
              type: 'object',
              properties: {
                id: s('步骤 id（get_board 可查）'),
                status: s('新状态：pending/in_progress/done/skipped'),
                note: s('补充说明（可选）')
              },
              required: ['id']
            }
          },
          ledger: s('连续性硬账全文（人数/金额/库存/伤势等当前值）（可选）'),
          goal: s('修订后的目标表述（可选）')
        },
        []
      )
    },
    danger: false,
    handler: () => {
      throw new Error('update_board 由运行时直接处理，不应到达 handler')
    },
    execCtx: async (input) => {
      const board = activeBoard(deps.sessionId)
      if (!board) throw new Error('当前会话没有看板')
      if (board.status !== 'approved')
        throw new Error(`看板状态为 ${board.status}，仅批准后（approved）可更新`)
      const stepUpdates = Array.isArray(input.stepUpdates)
        ? input.stepUpdates.map((u) => {
            const o = (u ?? {}) as ToolInput
            const id = optStr(o, 'id') ?? ''
            const status = optStr(o, 'status')
            if (!id) throw new Error('stepUpdates 每项必须带 id')
            if (status && !['pending', 'in_progress', 'done', 'skipped'].includes(status)) {
              throw new Error(`非法状态 ${status}（允许 pending/in_progress/done/skipped）`)
            }
            return {
              id,
              ...(status ? { status: status as PlanStep['status'] } : {}),
              ...(optStr(o, 'note') ? { note: optStr(o, 'note') } : {})
            }
          })
        : undefined
      const next = updateBoard(board.id, {
        ...(stepUpdates ? { stepUpdates } : {}),
        ...(optStr(input, 'ledger') ? { ledger: optStr(input, 'ledger') } : {}),
        ...(optStr(input, 'goal') ? { goal: optStr(input, 'goal') } : {})
      })
      if (!next) throw new Error('看板更新失败（可能已被收尾）')
      deps.persist({ kind: 'board', board: next })
      const remain = next.steps.filter(
        (s) => s.status === 'pending' || s.status === 'in_progress'
      ).length
      // 未匹配 id = 模型幻觉/拼错步骤 id，静默忽略会让模型误以为已勾销——显式警告引导核对
      const unmatched =
        stepUpdates?.filter((u) => !next.steps.some((s) => s.id === u.id)).map((u) => u.id) ?? []
      const warn =
        unmatched.length > 0
          ? `\n警告：以下步骤 id 未匹配到任何步骤（未生效）：${unmatched.join('、')}。请调 get_board 核对真实 id 后重试。`
          : ''
      return `看板已更新（剩余未完成步骤：${remain}）${warn}\n${clip(serializeBoard(next), 3000).text}`
    }
  }

  const tools = [proposePlan, getBoard, updateBoardTool]
  return { tools, toolMap: new Map(tools.map((t) => [t.def.name, t])), proposed: () => proposed }
}
