import type { ChatMessage, SubagentEvent } from '../../shared/types'
import * as store from '../store'
import { coreWritingRules, projectCoreRules } from './instructions'
import { runLoop } from './loop'
import { createLoopCounters } from './policy/compact'
import {
  clip,
  MAX_SUB_TURNS,
  SUB_MAX_TOKENS,
  SUB_REPORT_CHARS,
  type ToolExecContext
} from './toolkit'
import { SUB_TOOL_MAP, SUB_TOOLS } from './tools'

function buildSubSystemPrompt(projectId: string, role: string): string {
  const project = store.listProjects().find((p) => p.id === projectId)
  if (!project) throw new Error('项目不存在')
  const globalInstr = coreWritingRules().trim()
  const projectInstr = projectCoreRules(projectId).trim()
  return [
    `你是小说项目《${project.title}》的子智能体（${role || '通用调研'}），由主智能体委派执行只读调研/分析任务，为它的决策提供事实依据。`,
    project.genre ? `类型：${project.genre}` : '',
    project.styleGuide ? `风格指南：${project.styleGuide}` : '',
    globalInstr && `用户全局指令（跨项目偏好，核心节）：\n${globalInstr}`,
    projectInstr && `本项目用户指令（最高优先级，与全局指令冲突时以本项目为准）：\n${projectInstr}`,
    '',
    '规则：',
    '1. 你只有只读工具，不能也不需要写入任何内容',
    '2. 独立完成任务，不要反问；信息不足以得出确定结论时，在报告中说明不确定性与缺失信息',
    '3. 全局范围的任务必须覆盖全部相关条目：按 total/hasMore/byCategory 分批读取直至读完，禁止基于不完整数据下结论',
    '4. 找主题相关内容优先 search_project，全书级问题先 get_book_digest',
    '5. 最终报告精炼、结构化：直接给结论，每条结论附证据（条目标题/人物名/章节号或原文短引），总长控制在 1500 字以内；不写过程流水账与客套话'
  ]
    .filter(Boolean)
    .join('\n')
}

/** 子智能体与主代理共用 runLoop 骨架；差异（subEvent 包装、无确认/压缩/续跑）在组装层吸收 */
export async function runSubAgent(ctx: ToolExecContext & { task: string; role: string }): Promise<{
  report: string
  turns: number
}> {
  const { sink, requestId, parentId, usage, signal, model, task, role } = ctx
  const send = (ev: SubagentEvent): void => {
    if (!sink.isClosed()) sink.send('agent:subEvent', requestId, ev)
  }

  const system = buildSubSystemPrompt(ctx.projectId, role)
  const messages: ChatMessage[] = [{ role: 'user', content: task }]
  send({ type: 'start', parentId, task, role })

  const result = await runLoop(
    messages,
    {
      system,
      tools: SUB_TOOLS.map((t) => t.def),
      toolMap: SUB_TOOL_MAP,
      readTools: new Set(SUB_TOOLS.map((t) => t.def.name)),
      projectId: ctx.projectId,
      model,
      maxTokens: SUB_MAX_TOKENS,
      promptCache: ctx.promptCache,
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      protocol: ctx.protocol,
      maxTurns: MAX_SUB_TURNS,
      signal
    },
    {
      emit: {
        delta: (text) => send({ type: 'delta', parentId, text }),
        toolCall: (call) =>
          send({ type: 'toolCall', parentId, call: { ...call, state: 'running' } }),
        toolResult: (ev) =>
          send({ type: 'toolResult', parentId, id: ev.id, ok: ev.ok, result: ev.result })
      },
      usage,
      counters: createLoopCounters()
    }
  )

  const report = clip(
    result.hitLimit
      ? `${result.text}\n[达到子任务步数上限，以上为部分结论]`
      : result.text || '（子智能体未产出文本结论）',
    SUB_REPORT_CHARS
  ).text
  send({ type: 'done', parentId, text: report, turns: result.turns })
  return { report, turns: result.turns }
}
