import { useState } from 'react'
import type { Job } from '@shared/types'
import QuickActionsBar from '../../components/QuickActionsBar'
import { useUiStore } from '../../lib/uiStore'

/** 章节完成卡（正文折叠+纪要+快捷钮） */
export function ChapterDoneCard({
  job,
  chaptersById,
  refresh
}: {
  job: Job
  chaptersById: Map<string, { id: string; orderNo: number; title: string; wordCount: number }>
  refresh: () => void
}) {
  const setBookSub = useUiStore((s) => s.setBookSub)
  const [expanded, setExpanded] = useState(false)
  const ch = chaptersById.get(job.chapterId ?? '')
  const draft = job.payload.draftText ?? ''
  const recap = job.payload.recap

  return (
    <div className="px-4 py-2">
      <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-orange-700">✓ 已入书</div>
          {ch && (
            <div className="text-[11px] text-stone-500">
              第 {ch.orderNo} 章 · {ch.title} · {ch.wordCount} 字
            </div>
          )}
        </div>
        {draft && (
          <div className="mt-2.5">
            <div
              className={
                'text-xs leading-relaxed whitespace-pre-wrap text-stone-600 ' +
                (expanded ? '' : 'line-clamp-3')
              }
            >
              {draft}
            </div>
            <button
              type="button"
              className="mt-1 text-[11px] text-orange-700"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '收起' : '展开全文'}
            </button>
          </div>
        )}
      </div>
      {recap && (
        <div className="mt-2">
          <RecapCard recap={recap} />
        </div>
      )}
      {job.chapterId && (
        <div className="mt-2">
          <QuickActionsBar chapterId={job.chapterId} quickActions={recap?.quickActions} refresh={refresh} />
        </div>
      )}
      <button
        type="button"
        className="mt-2 w-full rounded-xl border border-orange-200 py-2.5 text-sm text-stone-700"
        onClick={() => setBookSub('read')}
      >
        去读读这章
      </button>
    </div>
  )
}

/** 改章完成卡 */
export function RevisedCard({ job }: { job: Job }) {
  const setBookSub = useUiStore((s) => s.setBookSub)
  const issues = job.payload.lint?.issues ?? []
  return (
    <div className="px-4 py-2">
      <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
        <div className="text-sm font-semibold text-orange-700">✓ 改好了（新版本已生效）</div>
        {job.payload.revise && (
          <div className="mt-1 text-[11px] text-stone-500">指令：{job.payload.revise.instruction}</div>
        )}
        <div className="mt-1 text-[11px] text-stone-500">
          {job.payload.draftWordCount ? `${job.payload.draftWordCount} 字 · ` : ''}
          自检 {issues.length === 0 ? '零问题' : `${issues.length} 条提示`}
        </div>
      </div>
      <button
        type="button"
        className="mt-2 w-full rounded-xl border border-orange-200 py-2.5 text-sm text-stone-700"
        onClick={() => setBookSub('read')}
      >
        去读读这章
      </button>
    </div>
  )
}

/** 本章纪要卡 */
export function RecapCard({ recap }: { recap: NonNullable<Job['payload']['recap']> }) {
  return (
    <div className="rounded-2xl border border-orange-100 bg-white p-4">
      <div className="mb-2 text-xs font-semibold text-stone-500">本章纪要</div>
      <div className="text-xs leading-relaxed text-stone-600">{recap.summary}</div>
      {recap.stateChanges.length > 0 && (
        <div className="mt-3 border-t border-orange-100/70 pt-2">
          <div className="mb-1 text-[11px] text-stone-500">人物动向</div>
          {recap.stateChanges.map((sc, i) => (
            <div key={i} className="text-xs text-stone-500">
              <span className="text-stone-600">{sc.name}</span>
              {typeof sc.patch.location === 'string' && <span> · {sc.patch.location}</span>}
              {typeof sc.patch.mood === 'string' && <span> · {sc.patch.mood}</span>}
            </div>
          ))}
        </div>
      )}
      {recap.foreshadowOps.length > 0 && (
        <div className="mt-3 border-t border-orange-100/70 pt-2">
          <div className="mb-1 text-[11px] text-stone-500">伏笔</div>
          {recap.foreshadowOps.map((f, i) => (
            <div key={i} className="text-xs text-orange-700/80">
              {f.op === 'plant' ? '埋下' : f.op === 'plan' ? '计划' : '回收'} · {f.title}
            </div>
          ))}
        </div>
      )}
      {recap.cardOps.length > 0 && (
        <div className="mt-3 border-t border-orange-100/70 pt-2">
          <div className="mb-1 text-[11px] text-stone-500">设定沉淀</div>
          {recap.cardOps.map((c, i) => (
            <div key={i} className="text-xs text-stone-500">
              {c.op === 'create' ? '新增' : c.op === 'update' ? '更新' : '删除'} · {c.title}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
