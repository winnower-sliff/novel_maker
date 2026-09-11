import { useEffect, useState } from 'react'
import type { UsageRecord, UsageStats } from '@shared/types'
import { Card } from '../components/ui'
import { fmtDuration, fmtTime, fmtTokens, purposeLabel } from '../lib/format'

function QuotaBar({ used, limit }: { used: number; limit: number }) {
  if (limit <= 0) return null
  const pct = Math.min(100, (used / limit) * 100)
  const tone = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-600'
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        {used} / {limit} 次（{pct.toFixed(0)}%）
      </div>
    </div>
  )
}

function GroupTable({ title, rows }: { title: string; rows: Array<{ key: string; requests: number; inputTokens: number; outputTokens: number }> }) {
  return (
    <Card className="p-4">
      <div className="mb-2 text-sm font-medium text-zinc-200">{title}</div>
      <table className="w-full text-left text-xs">
        <thead className="text-zinc-500">
          <tr>
            <th className="py-1 font-medium">名称</th>
            <th className="py-1 text-right font-medium">请求</th>
            <th className="py-1 text-right font-medium">入</th>
            <th className="py-1 text-right font-medium">出</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-2 text-zinc-600">
                暂无数据
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-zinc-800/60">
              <td className="py-1.5 font-mono text-zinc-300">{r.key}</td>
              <td className="py-1.5 text-right font-mono text-zinc-400">{r.requests}</td>
              <td className="py-1.5 text-right font-mono text-zinc-400">{fmtTokens(r.inputTokens)}</td>
              <td className="py-1.5 text-right font-mono text-zinc-400">{fmtTokens(r.outputTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

export default function Usage() {
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [quota, setQuota] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void Promise.all([window.api.usage.stats(), window.api.usage.list(200), window.api.settings.get()])
      .then(([s, r, cfg]) => {
        setStats(s)
        setRecords(r)
        setQuota(cfg.quota5hPrompts)
      })
      .finally(() => setLoading(false))
  }, [])

  const maxDayTotal = stats ? Math.max(1, ...stats.byDay.map((d) => d.inputTokens + d.outputTokens)) : 1
  const windowEndText = stats
    ? new Date(stats.window5h.windowStart + 5 * 3600_000).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="grid grid-cols-3 gap-3">
        <Card className="col-span-1 p-4">
          <div className="text-xs text-zinc-500">近 5 小时滚动窗口（{windowEndText} 到期）</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-2xl text-zinc-100">
              {stats?.window5h.requests ?? 0}
            </span>
            <span className="text-xs text-zinc-500">次请求</span>
          </div>
          <div className="mt-3">
            <QuotaBar used={stats?.window5h.requests ?? 0} limit={quota} />
            {quota <= 0 && (
              <div className="text-xs text-zinc-600">未设置 5h 限额（可在设置中配置，展示进度条）</div>
            )}
          </div>
          <div className="mt-3 flex gap-x-4 text-xs text-zinc-400">
            <span>
              入 <span className="font-mono text-zinc-200">{fmtTokens(stats?.window5h.inputTokens ?? 0)}</span>
            </span>
            <span>
              出 <span className="font-mono text-zinc-200">{fmtTokens(stats?.window5h.outputTokens ?? 0)}</span>
            </span>
          </div>
        </Card>
        <Card className="col-span-2 p-4">
          <div className="mb-2 text-xs text-zinc-500">近 14 天用量（上：输入 amber / 下：输出 sky）</div>
          <div className="flex h-24 items-end gap-1.5">
            {(stats?.byDay ?? []).map((d) => {
              const total = d.inputTokens + d.outputTokens
              const h = (total / maxDayTotal) * 100
              const inPct = total > 0 ? (d.inputTokens / total) * 100 : 0
              return (
                <div
                  key={d.key}
                  className="group relative flex h-full flex-1 flex-col justify-end"
                  title={`${d.key} · 请求 ${d.requests} · 入 ${fmtTokens(d.inputTokens)} · 出 ${fmtTokens(d.outputTokens)}`}
                >
                  <div
                    className="flex w-full flex-col overflow-hidden rounded-sm"
                    style={{ height: `${h}%` }}
                  >
                    <div className="w-full bg-amber-600/80" style={{ height: `${inPct}%` }} />
                    <div className="w-full bg-sky-600/80" style={{ height: `${100 - inPct}%` }} />
                  </div>
                  <div className="mt-1 text-center text-[9px] text-zinc-600">{d.key}</div>
                </div>
              )
            })}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <GroupTable
          title="按模型"
          rows={(stats?.byModel ?? []).map((g) => ({ ...g, key: g.key }))}
        />
        <GroupTable
          title="按用途"
          rows={(stats?.byPurpose ?? []).map((g) => ({ ...g, key: purposeLabel(g.key) }))}
        />
      </div>

      <Card className="min-h-64 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center py-8 text-sm text-zinc-600">加载中…</div>
        ) : records.length === 0 ? (
          <div className="flex h-full items-center justify-center py-8 text-sm text-zinc-600">
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
                  <td className="px-3 py-2 text-zinc-400">{purposeLabel(r.purpose)}</td>
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
