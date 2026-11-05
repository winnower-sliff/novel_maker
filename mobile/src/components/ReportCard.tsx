import type { AgentReport } from '@shared/types'
import { Markdown } from './Markdown'

const KIND_TITLE: Record<string, string> = {
  review: '章审读报告',
  audit: '全书审计',
  diagnose: '导演诊断'
}

const LEVEL_COLOR: Record<string, string> = {
  good: 'bg-orange-100 text-orange-700',
  warn: 'bg-amber-200/90 text-orange-800',
  bad: 'bg-red-100 text-red-600'
}

export default function ReportCard({ report }: { report: AgentReport }) {
  return (
    <div className="rounded-2xl border border-orange-100 bg-white p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-stone-700">
          {KIND_TITLE[report.kind] ?? report.kind}
        </span>
        {report.kind !== 'diagnose' && (
          <span className="text-xs text-stone-500">综合 {report.score} 分</span>
        )}
      </div>
      <div className="text-xs leading-relaxed text-stone-600">
        <Markdown text={report.verdict} />
      </div>
      {report.findings.length > 0 && (
        <div className="mt-3 space-y-2">
          {report.findings.map((f, i) => (
            <div key={i} className="rounded-xl bg-orange-50 p-2.5">
              <div className="mb-1 flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${LEVEL_COLOR[f.level] ?? ''}`}>
                  {f.dimension}
                </span>
              </div>
              {f.quote && (
                <div className="mb-1 text-[11px] leading-relaxed text-stone-500">「{f.quote}」</div>
              )}
              <div className="text-xs leading-relaxed text-stone-500">{f.comment}</div>
            </div>
          ))}
        </div>
      )}
      {report.suggestions.length > 0 && (
        <div className="mt-3 border-t border-orange-100/70 pt-2">
          <div className="mb-1 text-[11px] text-stone-500">建议</div>
          {report.suggestions.map((s, i) => (
            <div key={i} className="text-xs leading-relaxed text-stone-500">
              · {s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
