import type { Job } from '@shared/types'
import ReportCard from '../../components/ReportCard'
import { Markdown } from '../../components/Markdown'
import { ChapterDoneCard, RevisedCard } from './DoneCards'
import PlanCard from './PlanCard'

/**
 * 节点卡（按消息 step 分派）。interactive 判定只看「这是当前活跃 job 且在等作者」，
 * 不再绑定具体 step——未来任何等待确认的节点都自动可交互（通用选择）。
 */
export default function JobCard({
  job,
  step,
  active,
  chaptersById,
  refresh,
  refreshAll
}: {
  job: Job
  step: string
  active: Job | null
  chaptersById: Map<string, { id: string; orderNo: number; title: string; wordCount: number }>
  refresh: () => void
  refreshAll: () => void
}) {
  if (step === 'cards') {
    // 走向卡已废除（聊天驱动开章）；历史消息走通用展示
    return (
      <StaticBubble
        text={
          job.payload.direction
            ? `本章走向：${job.payload.direction.text}`
            : '本章走向备选（旧版流程）'
        }
      />
    )
  }
  if (step === 'plan') {
    // 计划模式：计划书等作者过目（interactive 时可执行/取消，历史消息只读展示）
    if (active && active.id === job.id && active.state === 'waiting_user' && job.payload.plan) {
      return <PlanCard job={job} refresh={refresh} />
    }
    return <StaticBubble text="本章计划（已处理）" />
  }
  if (step === 'chapter') return <ChapterDoneCard job={job} chaptersById={chaptersById} refresh={refreshAll} />
  if (step === 'revised') return <RevisedCard job={job} />
  if (step === 'report') {
    return job.payload.report ? (
      <div className="px-4 py-2">
        <ReportCard report={job.payload.report} />
      </div>
    ) : null
  }
  if (step === 'failed') {
    return (
      <div className="px-4 py-2">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3.5">
          <div className="mb-1 text-xs font-semibold text-red-600">卡住了</div>
          <div className="text-xs leading-relaxed break-all text-stone-500">{job.error || '未知错误'}</div>
          {active && active.id === job.id && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded-xl bg-orange-600 py-2 text-xs font-medium"
                onClick={async () => {
                  await window.api.job.retry(job.id)
                  refresh()
                }}
              >
                重试
              </button>
              <button
                type="button"
                className="flex-1 rounded-xl border border-orange-200 py-2 text-xs text-stone-500"
                onClick={refresh}
              >
                算了
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }
  if (step === 'cancelled') return <StaticBubble text={msg0(job)} />
  return <StaticBubble text={step} />
}

function msg0(job: Job): string {
  return job.error ? `已取消：${job.error}` : '已按你的要求取消'
}

export function StaticBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start px-4 py-1.5">
      <div className="rounded-2xl rounded-tl-sm border border-orange-100 bg-orange-50 px-3.5 py-2 text-sm leading-relaxed text-stone-600">
        <Markdown text={text} />
      </div>
    </div>
  )
}
