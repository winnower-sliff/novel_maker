import { useEffect, useRef, useState } from 'react'
import { startPipeline } from './pipeline'

/** 从文本提取 [[目标|别名]] / [[目标]] 链接目标（去重保序） */
export function parseWikiLinks(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/\[\[([^\][|]+)(?:\|[^\][]*)?\]\]/g)) {
    const target = m[1].trim()
    if (target && !seen.has(target)) {
      seen.add(target)
      out.push(target)
    }
  }
  return out
}

export interface RegenPreview {
  main: string
  tags: string[]
}

/** 单卡 AI 重生成（save:false 仅预览，确认后由调用方替换编辑器内容） */
export function useCharacterRegen(projectId: string) {
  const [busy, setBusy] = useState(false)
  const [delta, setDelta] = useState('')
  const [preview, setPreview] = useState<RegenPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      abortRef.current?.()
    },
    []
  )

  const run = (name: string, brief: string): void => {
    setBusy(true)
    setPreview(null)
    setError(null)
    setDelta('')
    const { done, abort } = startPipeline(
      'character',
      { projectId, name, brief, save: false },
      (t) => setDelta((v) => v + t)
    )
    abortRef.current = abort
    void done
      .then((r) => {
        const payload = r.data as { preview?: { main: string; mainTags: string[] } }
        const main = payload.preview?.main ?? ''
        if (!main.trim()) throw new Error('AI 未输出有效人物卡')
        setPreview({ main, tags: payload.preview?.mainTags ?? [] })
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        abortRef.current = null
        setBusy(false)
      })
  }

  const reset = (): void => {
    abortRef.current?.()
    abortRef.current = null
    setBusy(false)
    setPreview(null)
    setError(null)
    setDelta('')
  }

  return { busy, delta, preview, error, run, reset }
}
