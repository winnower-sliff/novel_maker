import { useEffect, useState } from 'react'
import type { UsageRecord } from '@shared/types'
import { Card } from '../components/ui'
import { fmtDuration, fmtTime, fmtTokens } from '../lib/format'

export default function Usage() {
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void window.api.usage
      .list(200)
      .then(setRecords)
      .finally(() => setLoading(false))
  }, [])

  const sum = (key: keyof UsageRecord): number =>
    records.reduce((acc, r) => acc + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0)

  const stats = [
    { label: '请求数', value: String(records.length) },
    { label: '输入 tokens', value: fmtTokens(sum('inputTokens')) },
    { label: '输出 tokens', value: fmtTokens(sum('outputTokens')) },
    { label: '缓存读', value: fmtTokens(sum('cacheReadTokens')) },
    { label: '缓存写', value: fmtTokens(sum('cacheCreationTokens')) }
  ]

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="grid grid-cols-5 gap-3">
        {stats.map((s) => (
          <Card key={s.label} className="p-3">
            <div className="text-xs text-zinc-500">{s.label}</div>
            <div className="mt-1 font-mono text-lg text-zinc-100">{s.value}</div>
          </Card>
        ))}
      </div>
      <Card className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-600">加载中…</div>
        ) : records.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-600">
            暂无记录，去「试写」发一条消息
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">模型</th>
                <th className="px-3 py-2 font-medium">用途</th>
                <th className="px-3 py-2 text-right font-medium">输入</th>
                <th className="px-3 py-2 text-right font-medium">输出</th>
                <th className="px-3 py-2 text-right font-medium">缓存读</th>
                <th className="px-3 py-2 text-right font-medium">缓存写</th>
                <th className="px-3 py-2 text-right font-medium">耗时</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={i} className="border-t border-zinc-800/60 hover:bg-zinc-800/30">
                  <td className="px-3 py-2 font-mono text-zinc-400">{fmtTime(r.ts)}</td>
                  <td className="px-3 py-2 font-mono text-zinc-300">{r.model}</td>
                  <td className="px-3 py-2 text-zinc-400">{r.purpose}</td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">{fmtTokens(r.inputTokens)}</td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-300">{fmtTokens(r.outputTokens)}</td>
                  <td className="px-3 py-2 text-right font-mono text-emerald-400">
                    {r.cacheReadTokens ? fmtTokens(r.cacheReadTokens) : '-'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-amber-400">
                    {r.cacheCreationTokens ? fmtTokens(r.cacheCreationTokens) : '-'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-zinc-400">{fmtDuration(r.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
