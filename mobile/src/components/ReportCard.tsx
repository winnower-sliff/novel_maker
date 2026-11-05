import type { AgentReport } from '@shared/types'

const KIND_TITLE: Record<string, string> = {
  review: '章审读报告',
  audit: '全书审计',
  diagnose: '导演诊断'
}

const LEVEL_COLOR: Record<string, string> = {
  good: 'bg-emerald-900/60 text-emerald-300',
  warn: 'bg-amber-900/60 text-amber-300',
  bad: 'bg-rose-900/60 text-rose-300'
}

export default function ReportCard({ report }: { report: AgentReport }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-zinc-200">
          {KIND_TITLE[report.kind] ?? report.kind}
        </span>
        {report.kind !== 'diagnose' && (
          <span className="text-xs text-zinc-500">综合 {report.score} 分</span>
        )}
      </div>
      <div className="text-xs leading-relaxed text-zinc-300">{report.verdict}</div>
      {report.findings.length > 0 && (
        <div className="mt-3 space-y-2">
          {report.findings.map((f, i) => (
            <div key={i} className="rounded-xl bg-zinc-800/50 p-2.5">
              <div className="mb-1 flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${LEVEL_COLOR[f.level] ?? ''}`}>
                  {f.dimension}
                </span>
              </div>
              {f.quote && (
                <div className="mb-1 text-[11px] leading-relaxed text-zinc-500">「{f.quote}」</div>
              )}
              <div className="text-xs leading-relaxed text-zinc-400">{f.comment}</div>
            </div>
          ))}
        </div>
      )}
      {report.suggestions.length > 0 && (
        <div className="mt-3 border-t border-zinc-800/70 pt-2">
          <div className="mb-1 text-[11px] text-zinc-500">建议</div>
          {report.suggestions.map((s, i) => (
            <div key={i} className="text-xs leading-relaxed text-zinc-400">
              · {s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
