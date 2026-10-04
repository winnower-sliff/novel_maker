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
import type { PartialHandlerTable } from './context'
import { abortAgentRun, startAgentRun } from './stream'

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
