import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { GroupStats, UsageRecord, UsageStats, WindowStats } from '../shared/types'

const WINDOW_MS = 5 * 60 * 60 * 1000
const MAX_RECORDS = 20000
const DAY_SLOTS = 14

function usageFile(): string {
  return join(app.getPath('userData'), 'usage_log.jsonl')
}

export function appendUsage(record: UsageRecord): void {
  appendFileSync(usageFile(), `${JSON.stringify(record)}\n`, 'utf-8')
}

function readAll(): UsageRecord[] {
  const file = usageFile()
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf-8').split('\n')
  return lines
    .slice(-MAX_RECORDS)
    .map((l) => {
      try {
        return JSON.parse(l) as UsageRecord
      } catch {
        return null
      }
    })
    .filter((r): r is UsageRecord => r !== null)
}

export function listUsage(limit = 200): UsageRecord[] {
  return readAll()
    .slice(-limit)
    .reverse()
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function computeStats(now = Date.now()): UsageStats {
  const all = readAll()
  const winStart = now - WINDOW_MS
  const inWindow = all.filter((r) => r.ts > winStart)

  const sum = (records: UsageRecord[]): Omit<WindowStats, 'windowStart'> => ({
    requests: records.length,
    inputTokens: records.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: records.reduce((a, r) => a + r.outputTokens, 0),
    cacheReadTokens: records.reduce((a, r) => a + r.cacheReadTokens, 0),
    cacheCreationTokens: records.reduce((a, r) => a + r.cacheCreationTokens, 0)
  })

  const group = (records: UsageRecord[], keyOf: (r: UsageRecord) => string): GroupStats[] => {
    const map = new Map<string, GroupStats>()
    for (const r of records) {
      const key = keyOf(r)
      const g = map.get(key) ?? { key, requests: 0, inputTokens: 0, outputTokens: 0 }
      g.requests += 1
      g.inputTokens += r.inputTokens
      g.outputTokens += r.outputTokens
      map.set(key, g)
    }
    return [...map.values()].sort((a, b) => b.requests - a.requests)
  }

  const byDayMap = new Map<string, GroupStats>(group(all, (r) => dayKey(r.ts)).map((g) => [g.key, g]))
  const byDay: GroupStats[] = []
  for (let i = DAY_SLOTS - 1; i >= 0; i--) {
    const key = dayKey(now - i * 24 * 60 * 60 * 1000)
    byDay.push(byDayMap.get(key) ?? { key, requests: 0, inputTokens: 0, outputTokens: 0 })
  }

  return {
    window5h: { windowStart: winStart, ...sum(inWindow) },
    totals: sum(all),
    byDay,
    byModel: group(all, (r) => r.model),
    byPurpose: group(all, (r) => r.purpose)
  }
}
