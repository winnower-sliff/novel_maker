import { cancelAgentConfirms, resolveAgentConfirm } from '../agent'
import {
  getInstructionsView,
  writeGlobalInstructions,
  writeProjectInstructions
} from '../agent/instructions'
import {
  deleteAgentSession,
  listAgentSessions,
  loadAgentSession,
  saveAgentSession
} from '../agentSessions'
import { chatStream, pickRatelimitHeaders } from '../llm'
import { resolveRequestAuth } from '../settings'
import { appendUsage } from '../usage'
import type { PartialHandlerTable } from './context'
import { abortAgentRun, startAgentRun } from './stream'

/** 标题清洗：剥掉首行外的内容、包裹符号与收尾标点，超长截断 */
function cleanTitle(raw: string): string | null {
  const line = raw.trim().split('\n')[0].trim()
  const stripped = line
    .replace(/^[「『"‘'《【[(（]+/, '')
    .replace(/[」』"”'》\]）)…。.！!？?]+$/, '')
  const t = stripped.trim()
  if (!t) return null
  return t.length > 16 ? t.slice(0, 16) : t
}

/** 会话自动起名：小请求生成 ≤12 字动宾式短标题；任何失败静默返回 null（回退启发式标题） */
async function genSessionTitle(userText: string, assistantText: string): Promise<string | null> {
  const u = userText.trim().slice(0, 500)
  if (!u) return null
  try {
    const auth = await resolveRequestAuth('agent')
    if (!auth.apiKey && auth.needsKey) return null
    const a = assistantText.trim().slice(0, 800)
    const result = await chatStream(
      {
        model: auth.model,
        system:
          '为写作助手会话生成标题：输出一个不超过12字的中文动宾式短语，概括本会话的核心任务目标。不要书名号、引号、句号或任何前后缀说明，只输出标题本身',
        messages: [
          {
            role: 'user',
            content: `用户请求：${u}${a ? `\n\n助手处理结果（节选）：${a}` : ''}`
          }
        ],
        maxTokens: 200,
        purpose: 'agent'
      },
      { apiKey: auth.apiKey, baseUrl: auth.baseUrl },
      () => {}
    )
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
    return cleanTitle(result.text)
  } catch {
    return null
  }
}

export const agentHandlers = {
  'agent:run': (ctx, [params]) => startAgentRun(ctx.sink, params),
  'agent:abort': (_ctx, [requestId]) => {
    abortAgentRun(requestId)
    cancelAgentConfirms(requestId)
  },
  'agent:resolve': (_ctx, [requestId, confirmId, allow, always]) =>
    resolveAgentConfirm(requestId, confirmId, allow, !!always),
  'agent:sessions': (_ctx, [projectId]) => listAgentSessions(projectId),
  'agent:sessionLoad': (_ctx, [id]) => loadAgentSession(id),
  'agent:sessionSave': (_ctx, [session]) => saveAgentSession(session),
  'agent:sessionDelete': (_ctx, [id]) => deleteAgentSession(id),
  'agent:sessionTitle': (_ctx, [userText, assistantText]) =>
    genSessionTitle(userText, assistantText),
  'agent:instructionsGet': (_ctx, [projectId]) => getInstructionsView(projectId),
  'agent:instructionsSave': (_ctx, [scope, text, projectId]) => {
    if (scope === 'global') {
      writeGlobalInstructions(text)
      return
    }
    if (!projectId) throw new Error('缺少 projectId，无法保存本项目指令')
    writeProjectInstructions(projectId, text)
  }
} satisfies PartialHandlerTable
