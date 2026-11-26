import type { Job } from '@shared/types'
import { useState } from 'react'
import { Markdown } from '../../components/Markdown'
import ReportCard from '../../components/ReportCard'
import { useJobFlow } from '../../lib/queries'
import { errorText, toastError } from '../../lib/toastStore'
import { ChapterDoneCard, RevisedCard } from './DoneCards'
import PlanCard from './PlanCard'

/**
 * 节点卡（按消息 step 分派）。是否可交互只看任务自身状态（等作者/失败），
 * 不绑定具体 step，也不依赖「当前活跃任务」是否同步到位。
 */
export default function JobCard({
  job,
  step,
  chaptersById,
  refresh,
  refreshAll
}: {
  job: Job
  step: string
  chaptersById: Map<string, { id: string; orderNo: number; title: string; wordCount: number }>
  refresh: () => void
  refreshAll: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // 任务列表新→旧，首个即这本书最新的任务
  const newestId = useJobFlow(job.bookId).data?.jobs[0]?.id
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
    // 计划书等作者过目：是否可操作只看任务自身状态（节点消息可能先于任务状态到达，不能提前说「已处理」）
    if (job.state === 'waiting_user' && job.payload.plan) {
      return <PlanCard job={job} refresh={refresh} />
    }
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') {
      return <StaticBubble text="本章计划（已处理）" />
    }
    return <StaticBubble text="正在拟本章计划…" />
  }
  if (step === 'chapter')
    return <ChapterDoneCard job={job} chaptersById={chaptersById} refresh={refreshAll} />
  if (step === 'revised') return <RevisedCard job={job} />
  if (step === 'report') {
    return job.payload.report ? (
      <div className="px-4 py-2">
        <ReportCard report={job.payload.report} />
      </div>
    ) : null
  }
  if (step === 'failed') {
    if (dismissed) return <StaticBubble text="（这次失败已忽略）" />
    // 只有这本书最新的那个失败任务给重试钮：更早的失败早已时过境迁，重试会按旧指令写出不相干的章节
    const retryable = job.state === 'failed' && newestId === job.id
    return (
      <div className="px-4 py-2">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3.5">
          <div className="mb-1 text-xs font-semibold text-red-600">卡住了</div>
          <div className="text-xs leading-relaxed break-all text-stone-500">
            {errorText(job.error || '未知错误')}
          </div>
          {retryable ? (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy}
                className="flex-1 rounded-xl bg-orange-600 py-2 text-xs font-medium text-white disabled:opacity-50"
                onClick={async () => {
                  setBusy(true)
                  try {
                    await window.api.job.retry(job.id)
                    refresh()
                  } catch (e) {
                    toastError(e, '重试失败')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy ? '正在重试…' : '重试'}
              </button>
              <button
                type="button"
                disabled={busy}
                className="flex-1 rounded-xl border border-orange-200 py-2 text-xs text-stone-500 disabled:opacity-50"
                onClick={() => setDismissed(true)}
              >
                忽略
              </button>
            </div>
          ) : job.state !== 'failed' ? (
            <div className="mt-2 text-xs text-stone-500">
              {job.state === 'done' ? '后来已重试成功' : '正在重试…'}
            </div>
          ) : null}
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
