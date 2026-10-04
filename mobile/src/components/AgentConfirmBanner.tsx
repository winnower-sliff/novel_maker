// 智能体危险操作全局确认横幅：agent tab 隐藏（切到阅读/写作）时也能应答，
// 根治「切 tab 后智能体看似暂停、实为在主进程死等确认」的问题。运行态读 agentRunStore。
import { resolveConfirm, useAgentConfirmTarget } from '@wizard/agentRunStore'
import { toolLabel, toolSummary } from '@mobile/lib/agentTurns'

export default function AgentConfirmBanner({ hidden }: { hidden: boolean }) {
  const target = useAgentConfirmTarget()
  if (hidden || !target) return null
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-red-500/60 bg-zinc-950/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
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
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => resolveConfirm(true, false)}
          className="flex-1 cursor-pointer rounded-md bg-amber-600 py-2 text-sm font-medium text-white active:bg-amber-700"
        >
          允许
        </button>
        <button
          type="button"
          onClick={() => resolveConfirm(true, true)}
          className="flex-1 cursor-pointer rounded-md border border-zinc-700 py-2 text-sm text-zinc-300 active:text-zinc-100"
        >
          不再询问
        </button>
        <button
          type="button"
          onClick={() => resolveConfirm(false, false)}
          className="flex-1 cursor-pointer rounded-md border border-red-800 py-2 text-sm text-red-300 active:text-red-200"
        >
          拒绝
        </button>
      </div>
    </div>
  )
}
