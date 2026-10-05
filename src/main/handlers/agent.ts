import { cancelAgentConfirms, resolveAgentConfirm } from '../agent'
import {
  getInstructionsView,
  writeGlobalInstructions,
  writeProjectInstructions
} from '../agent/instructions'
import {
  deleteSession,
  lastSeqOf,
  listSessions,
  loadEvents,
  loadSessionFull,
  updateTitle,
  upsertLegacySession
} from '../agentTranscript'
import type { PartialHandlerTable } from './context'
import { abortAgentRun, abortSessionRun, genSessionTitle, startAgentRun } from './stream'

export const agentHandlers = {
  'agent:run': (ctx, [params]) => startAgentRun(ctx.sink, params),
  'agent:abort': (_ctx, [requestId]) => {
    abortAgentRun(requestId)
    cancelAgentConfirms(requestId)
  },
  'agent:resolve': (_ctx, [requestId, confirmId, allow, always]) =>
    resolveAgentConfirm(requestId, confirmId, allow, !!always),
  'agent:sessions': (_ctx, [projectId]) => listSessions(projectId),
  'agent:sessionLoad': (_ctx, [id]) => loadSessionFull(id),
  // 旧客户端过渡：turns 仅在会话无事件时导入一次（transcript 事实源在服务端，新客户端不再调用）
  'agent:sessionSave': (_ctx, [session]) => upsertLegacySession(session),
  'agent:sessionDelete': (_ctx, [id]) => {
    abortSessionRun(id)
    deleteSession(id)
  },
  'agent:sessionRename': (_ctx, [id, title]) => updateTitle(id, title),
  'agent:sessionEvents': (_ctx, [{ sessionId, afterSeq }]) => ({
    sessionId,
    events: loadEvents(sessionId, afterSeq ?? 0),
    lastSeq: lastSeqOf(sessionId)
  }),
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
