// 智能体危险操作全局确认弹层：agent 页面隐藏（用户切到其他页）时也能应答，
// 根治「切页后智能体看似暂停、实为在主进程死等确认」的问题。运行态读 agentRunStore。
import { resolveConfirm, useAgentConfirmTarget } from '../../../wizard/agentRunStore'
import { toolLabel, toolSummary } from '../lib/agentTurns'
import { Button } from './ui'

export default function AgentConfirmOverlay({ hidden }: { hidden: boolean }) {
  const target = useAgentConfirmTarget()
  if (hidden || !target) return null
  return (
    <div className="fixed right-5 bottom-12 z-40 w-80 rounded-lg border border-red-800 bg-zinc-900 p-3 shadow-2xl">
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-red-300">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
        智能体等待确认（后台运行中）
      </div>
      <div className="mb-1 truncate text-xs text-zinc-300">
        <span className="font-mono text-amber-500/90">{toolLabel(target.name)}</span> ·{' '}
        {toolSummary(target)}
      </div>
      <div className="mb-2.5 text-xs leading-5 text-red-300">
        ⚠ {target.dangerReason ?? '该操作不可恢复'}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => resolveConfirm(true, false)}>允许</Button>
        <Button variant="ghost" onClick={() => resolveConfirm(true, true)}>
          本次任务内不再询问
        </Button>
        <Button variant="danger" onClick={() => resolveConfirm(false, false)}>
          拒绝
        </Button>
      </div>
    </div>
  )
}
