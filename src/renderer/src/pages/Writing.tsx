import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChapterBrief, ContextPart } from '@shared/types'
import { Badge, Button, Card, Textarea } from '../components/ui'
import { fmtDuration, fmtTokens } from '../lib/format'
import type { DonePayload } from '../lib/ipc'

interface ChapterDoneData {
  chapterId?: string
  wordCount?: number
  contextParts?: ContextPart[]
  contextTokens?: number
  error?: string
}

interface SummaryDoneData {
  planted: number
  resolved: number
  parsed: boolean
}

const STATUS_BADGE: Record<string, { label: string; tone: 'default' | 'amber' | 'green' }> = {
  draft: { label: '草稿', tone: 'default' },
  approved: { label: '已审定', tone: 'amber' },
  written: { label: '已定稿', tone: 'green' },
  polished: { label: '已润色', tone: 'green' }
}

export default function Writing({ projectId }: { projectId: string }) {
  const [briefs, setBriefs] = useState<ChapterBrief[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busyAction, setBusyAction] = useState<'chapter' | 'summary' | null>(null)
  const [notice, setNotice] = useState('')
  const [lastUsage, setLastUsage] = useState<DonePayload | null>(null)
  const [ctxPreview, setCtxPreview] = useState<ContextPart[] | null>(null)
  const requestIdRef = useRef<string | null>(null)

  const selected = briefs.find((b) => b.id === selectedId) ?? null

  const loadBriefs = useCallback((): void => {
    if (!projectId) return
    void window.api.novel.chapterBriefs(projectId).then(setBriefs)
  }, [projectId])

  const openChapter = useCallback((outlineId: string): void => {
    setSelectedId(outlineId)
    setCtxPreview(null)
    setNotice('')
    void window.api.novel.chapter(outlineId).then((c) => {
      setContent(c?.content ?? '')
      setDirty(false)
    })
  }, [])

  useEffect(() => {
    setBriefs([])
    setSelectedId(null)
    setContent('')
    loadBriefs()
  }, [loadBriefs])

  useEffect(() => {
    const offDelta = window.api.llm.onDelta((id, text) => {
      if (id === requestIdRef.current) setContent((prev) => prev + text)
    })
    const offDone = window.api.llm.onDone((id, payload) => {
      if (id !== requestIdRef.current) return
      setLastUsage(payload)
      if (payload.action === 'chapter') {
        const d = payload.data as ChapterDoneData
        setBusyAction(null)
        setDirty(false)
        setNotice(
          d?.error
            ? `生成完成但保存失败：${d.error}`
            : `初稿完成：${d?.wordCount ?? 0} 字 · 上下文约 ${fmtTokens(d?.contextTokens ?? 0)} tokens`
        )
        setCtxPreview(d?.contextParts ?? null)
        loadBriefs()
      } else if (payload.action === 'summary') {
        const d = payload.data as SummaryDoneData
        setBusyAction(null)
        setNotice(
          d?.parsed
            ? `已定稿并生成摘要${d.planted ? ` · 新登记伏笔 ${d.planted} 条` : ''}${
                d.resolved ? ` · 回收伏笔 ${d.resolved} 条` : ''
              }`
            : '已定稿，但摘要解析失败（可重试）'
        )
        loadBriefs()
      }
    })
    const offError = window.api.llm.onError((id, message) => {
      if (id !== requestIdRef.current) return
      setBusyAction(null)
      setNotice(`出错：${message}`)
    })
    return () => {
      offDelta()
      offDone()
      offError()
    }
  }, [loadBriefs])

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        请先在「项目」页打开一个项目
      </div>
    )
  }

  const generateDraft = (): void => {
    if (!selectedId || busyAction) return
    if (selected?.hasDraft && !window.confirm('该章已有正文，重新生成将覆盖编辑器内容（原稿仍可放弃保存）。继续？'))
      return
    setContent('')
    setNotice('')
    setCtxPreview(null)
    setBusyAction('chapter')
    void window.api.pipeline
      .run('chapter', { outlineId: selectedId })
      .then((id) => {
        requestIdRef.current = id
      })
      .catch((err: unknown) => {
        setBusyAction(null)
        setNotice((err as Error).message)
      })
  }

  const saveDraft = (): void => {
    if (!selectedId) return
    void window.api.novel
      .saveChapter({ outlineId: selectedId, projectId, content })
      .then(() => {
        setDirty(false)
        setNotice('草稿已保存')
        loadBriefs()
      })
  }

  const finalize = (): void => {
    if (!selectedId || busyAction) return
    if (dirty && !window.confirm('有未保存的修改，定稿前将先保存当前内容。继续？')) return
    setBusyAction('summary')
    setNotice('定稿中：保存正文并生成摘要…')
    void window.api.novel
      .saveChapter({ outlineId: selectedId, projectId, content, status: 'written' })
      .then(() => window.api.pipeline.run('summary', { outlineId: selectedId }))
      .then((id) => {
        requestIdRef.current = id
      })
      .catch((err: unknown) => {
        setBusyAction(null)
        setNotice((err as Error).message)
      })
  }

  const previewContext = (): void => {
    if (!selectedId) return
    void window.api.novel
      .contextPreview(selectedId)
      .then((ctx) => setCtxPreview(ctx.parts))
  }

  const wordCount = content.replace(/\s/g, '').length
  const status = selected ? STATUS_BADGE[selected.status] : null
  const volumes = [...new Set(briefs.map((b) => b.volume))]

  return (
    <div className="flex h-full gap-3 p-4">
      <Card className="flex w-60 shrink-0 flex-col">
        <div className="border-b border-zinc-800 px-3 py-2.5 text-sm font-medium text-zinc-200">
          章节（{briefs.length}）
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {volumes.length === 0 && (
            <div className="p-4 text-center text-xs leading-5 text-zinc-600">
              暂无大纲，请先到「大纲」页生成或录入
            </div>
          )}
          {volumes.map((vol) => (
            <div key={vol} className="mb-2">
              <div className="px-2 py-1 text-[10px] font-medium tracking-wider text-zinc-600">
                第 {vol} 卷
              </div>
              {briefs
                .filter((b) => b.volume === vol)
                .map((b) => (
                  <button
                    key={b.id}
                    onClick={() => openChapter(b.id)}
                    className={`mb-0.5 flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                      selectedId === b.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
                    }`}
                  >
                    <span className="w-7 shrink-0 text-right font-mono text-xs text-zinc-500">
                      {b.chapterNo}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        selectedId === b.id ? 'text-zinc-100' : 'text-zinc-300'
                      }`}
                    >
                      {b.title || '未命名'}
                    </span>
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        b.hasDraft ? 'bg-emerald-500' : 'bg-zinc-700'
                      }`}
                      title={b.hasDraft ? `${b.wordCount} 字` : '未写'}
                    />
                  </button>
                ))}
            </div>
          ))}
        </div>
      </Card>

      <Card className="flex min-w-0 flex-1 flex-col p-4">
        {selected ? (
          <>
            <div className="mb-3 flex items-center gap-3">
              <div className="text-sm font-medium text-zinc-100">
                第 {selected.chapterNo} 章 · {selected.title || '未命名'}
              </div>
              {status && <Badge tone={status.tone}>{status.label}</Badge>}
              {dirty && <Badge tone="amber">未保存</Badge>}
              <span className="text-xs text-zinc-500">{wordCount} 字</span>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={previewContext} disabled={busyAction !== null}>
                  上下文预览
                </Button>
                <Button variant="ghost" onClick={saveDraft} disabled={!dirty || busyAction !== null}>
                  保存草稿
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (requestIdRef.current) void window.api.llm.abort(requestIdRef.current)
                  }}
                  disabled={busyAction === null}
                >
                  中断
                </Button>
                <Button onClick={generateDraft} disabled={busyAction !== null}>
                  {busyAction === 'chapter' ? '生成中…' : selected.hasDraft ? '重新生成' : 'AI 初稿'}
                </Button>
                <Button
                  onClick={finalize}
                  disabled={busyAction !== null || content.trim().length === 0}
                >
                  {busyAction === 'summary' ? '定稿中…' : '定稿'}
                </Button>
              </div>
            </div>

            <Textarea
              className="min-h-0 flex-1 leading-8"
              value={content}
              onChange={(e) => {
                setContent(e.target.value)
                setDirty(true)
              }}
              readOnly={busyAction !== null}
              placeholder={busyAction === 'chapter' ? '正在生成初稿…' : '点「AI 初稿」生成本章，或直接手写'}
            />

            {(notice || lastUsage) && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                {notice && <span className="text-zinc-300">{notice}</span>}
                {lastUsage && (
                  <>
                    <span>
                      本次入 {fmtTokens(lastUsage.usage.inputTokens)} / 出{' '}
                      {fmtTokens(lastUsage.usage.outputTokens)}
                    </span>
                    {lastUsage.usage.cacheReadTokens > 0 && (
                      <span className="text-emerald-400">
                        缓存读 {fmtTokens(lastUsage.usage.cacheReadTokens)}
                      </span>
                    )}
                    <span>
                      {lastUsage.model} · {fmtDuration(lastUsage.durationMs)}
                    </span>
                  </>
                )}
              </div>
            )}

            {ctxPreview && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                  本次上下文构成
                </summary>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {ctxPreview.map((p) => (
                    <span
                      key={p.name}
                      className="rounded bg-zinc-800/80 px-2 py-1 text-[11px] text-zinc-400"
                    >
                      {p.name} · {p.detail} · <span className="font-mono">{fmtTokens(p.tokens)}t</span>
                    </span>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-600">
            <span>左侧选择一章开始写作</span>
            <span className="text-xs">生成流程：AI 初稿 → 人工编辑 → 保存草稿 → 定稿（自动生成摘要、登记伏笔）</span>
          </div>
        )}
      </Card>
    </div>
  )
}
