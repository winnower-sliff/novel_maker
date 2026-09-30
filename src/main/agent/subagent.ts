import type { ChatMessage, ContentBlock, SubagentEvent } from '../../shared/types'
import { chatStream, pickRatelimitHeaders } from '../llm'
import * as store from '../store'
import { appendUsage } from '../usage'
import { serializeResult } from './run'
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
  return [
    `你是小说项目《${project.title}》的子智能体（${role || '通用调研'}），由主智能体委派执行只读调研/分析任务，为它的决策提供事实依据。`,
    project.genre ? `类型：${project.genre}` : '',
    project.styleGuide ? `风格指南：${project.styleGuide}` : '',
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

export async function runSubAgent(ctx: ToolExecContext & { task: string; role: string }): Promise<{
  report: string
  turns: number
}> {
  const { sink, requestId, parentId, projectId, usage, signal, model, task, role } = ctx
  const send = (ev: SubagentEvent): void => {
    if (!sink.isClosed()) sink.send('agent:subEvent', requestId, ev)
  }

  const system = buildSubSystemPrompt(projectId, role)
  const messages: ChatMessage[] = [{ role: 'user', content: task }]
  send({ type: 'start', parentId, task, role })

  let report = ''
  let turns = 0
  for (let turn = 0; turn < MAX_SUB_TURNS; turn++) {
    turns = turn + 1
    const result = await chatStream(
      {
        model,
        system,
        messages,
        tools: SUB_TOOLS.map((t) => t.def),
        maxTokens: SUB_MAX_TOKENS,
        purpose: 'agent',
        cacheSystem: ctx.promptCache
      },
      { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl },
      (text) => send({ type: 'delta', parentId, text }),
      signal
    )
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
      report = result.text
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
      const tool = SUB_TOOL_MAP.get(tu.name)
      if (!tool) {
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `错误: 未知工具 ${tu.name}`,
          is_error: true
        })
        continue
      }
      send({
        type: 'toolCall',
        parentId,
        call: { id: tu.id, name: tu.name, input: tu.input, state: 'running' }
      })
      let ok: boolean
      let out: string
      try {
        out = serializeResult(await tool.handler(tu.input, projectId))
        ok = true
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
      send({ type: 'toolResult', parentId, id: tu.id, ok, result: out })
    }
    messages.push({ role: 'user', content: resultBlocks })

    if (turn === MAX_SUB_TURNS - 1) {
      report = `${result.text}\n[达到子任务步数上限，以上为部分结论]`
    }
  }

  report = clip(report || '（子智能体未产出文本结论）', SUB_REPORT_CHARS).text
  send({ type: 'done', parentId, text: report, turns })
  return { report, turns }
}
