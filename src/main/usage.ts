import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GroupStats, UsageRecord, UsageStats, WindowStats } from '../shared/types.js'
import { dataDir, ensureDataDir } from './paths.js'

const WINDOW_MS = 5 * 60 * 60 * 1000
const MAX_RECORDS = 20000
const DAY_SLOTS = 14

function usageFile(): string {
  return join(dataDir(), 'usage_log.jsonl')
}

export function appendUsage(record: UsageRecord): void {
  ensureDataDir()
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
  return readAll().slice(-limit).reverse()
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
      const prev = map.get(key) ?? {
        key,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      }
      prev.requests += 1
      prev.inputTokens += r.inputTokens
      prev.outputTokens += r.outputTokens
      prev.cacheReadTokens += r.cacheReadTokens
      prev.cacheCreationTokens += r.cacheCreationTokens
      map.set(key, prev)
    }
    return [...map.values()].sort((a, b) => b.requests - a.requests)
  }

  const byDay = group(inWindow, (r) => dayKey(r.ts)).slice(0, DAY_SLOTS)
  return {
    window5h: { windowStart: winStart, ...sum(inWindow) },
    totals: sum(all),
    byDay,
    byModel: group(all, (r) => r.model),
    byPurpose: group(all, (r) => r.purpose)
  }
}
