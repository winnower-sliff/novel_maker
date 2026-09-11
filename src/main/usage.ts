import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { UsageRecord } from '../shared/types'

function usageFile(): string {
  return join(app.getPath('userData'), 'usage_log.jsonl')
}

export function appendUsage(record: UsageRecord): void {
  appendFileSync(usageFile(), `${JSON.stringify(record)}\n`, 'utf-8')
}

export function listUsage(limit = 200): UsageRecord[] {
  const file = usageFile()
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())
  return lines
    .slice(-limit)
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l) as UsageRecord
      } catch {
        return null
      }
    })
    .filter((r): r is UsageRecord => r !== null)
}
