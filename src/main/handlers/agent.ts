import type { AgentTranscriptInput } from '../../shared/types'
import { cancelAgentConfirms, resolveAgentConfirm } from '../agent'
import { activeBoard, resolveBoard, revertApproval } from '../agent/boards'
import {
  applyPreambleEdit,
  applySectionEdit,
  getInstructionsView,
  writeGlobalInstructions,
  writeProjectInstructions
} from '../agent/instructions'
import { addQueueItem, listQueue, moveQueueItem, removeQueueItem } from '../agent/queue'
import {
  appendEvent,
  deleteSession,
  getSession,
  lastSeqOf,
  listSessions,
  loadEvents,
  loadSessionFull,
  setPlanMode,
  updateTitle,
  upsertLegacySession
} from '../agentTranscript'
import type { PartialHandlerTable } from './context'
import {
  abortAgentRun,
  abortSessionRun,
  genSessionTitle,
  resumeSessionQueue,
  startAgentRun
} from './stream'

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
  'agent:sessionEvents': (_ctx, [{ sessionId, afterSeq }]) => {
    if (!getSession(sessionId)) throw new Error('会话不存在或已删除')
    return {
      sessionId,
      events: loadEvents(sessionId, afterSeq ?? 0),
      lastSeq: lastSeqOf(sessionId)
    }
  },
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
  },
  // 按节原子保存（分节/开头段），返回保存后的完整视图供 UI 直接刷新
  'agent:instructionSectionSave': (_ctx, [input]) => {
    const pid = input.projectId ?? ''
    if (input.scope === 'project' && !pid) throw new Error('缺少 projectId，无法保存本项目指令')
    if (input.kind === 'section') {
      applySectionEdit(input.scope, pid, { title: input.title, body: input.body, tag: input.tag })
    } else {
      applyPreambleEdit(input.scope, pid, input.text)
    }
    return getInstructionsView(pid)
  },
  'agent:queueList': (_ctx, [projectId]) => listQueue(projectId),
  'agent:queueAdd': (ctx, [input]) => addQueueItem(ctx.sink, input),
  'agent:queueRemove': (ctx, [id]) => removeQueueItem(ctx.sink, id),
  'agent:queueMove': (ctx, [id, dir]) => moveQueueItem(ctx.sink, id, dir),
  'agent:queueResume': (ctx, [sessionId]) => resumeSessionQueue(ctx.sink, sessionId),
  // 会话级计划模式开关（渲染端 toggle；对后续 run 生效）
  'agent:planMode': (_ctx, [sessionId, enabled]) => {
    if (!getSession(sessionId)) throw new Error('会话不存在或已删除')
    const brief = setPlanMode(sessionId, enabled)
    if (!brief) throw new Error('计划模式开关写入失败')
    const full = loadSessionFull(sessionId)
    if (!full) throw new Error('会话不存在或已删除')
    return full
  },
  // 看板裁决：approve（可带步骤编辑/附加说明）→ 立即启动轻装执行 run；reject（可附意见）→ 留史待修订重提
  'agent:planResolve': (ctx, [{ sessionId, boardId, action, feedback, steps }]) => {
    if (!getSession(sessionId)) throw new Error('会话不存在或已删除')
    const resolved = resolveBoard({
      boardId,
      action,
      ...(feedback !== undefined ? { feedback } : {}),
      ...(steps !== undefined ? { steps } : {})
    })
    if (!resolved) throw new Error('看板不存在或已裁决（不可重复裁决）')
    // board 快照 + 裁决记录进 transcript（rid 占位 plan_resolve：渲染端按 sessionId 消费，不校验 rid）
    const persist = (ev: AgentTranscriptInput): void => {
      const stored = appendEvent(sessionId, ev)
      if (stored && !ctx.sink.isClosed()) {
        ctx.sink.send('agent:transcript', 'plan_resolve', sessionId, stored)
      }
    }
    persist({ kind: 'board', board: resolved })
    persist({ kind: 'plan_resolve', boardId, action, feedback: feedback ?? '' })
    if (action === 'approve') {
      try {
        startAgentRun(ctx.sink, {
          projectId: resolved.projectId,
          sessionId,
          planExecBoardId: boardId
        })
      } catch (err) {
        // 补偿：执行 run 启动失败（会话占用/参数异常等）时把板回滚 awaiting，用户可重试批准；
        // 回滚快照再广播一次，前端卡片退回待批准态
        const reverted = revertApproval(boardId)
        if (reverted) persist({ kind: 'board', board: reverted })
        throw err
      }
    }
    return resolved
  },
  'agent:boardGet': (_ctx, [sessionId]) => activeBoard(sessionId)
} satisfies PartialHandlerTable
