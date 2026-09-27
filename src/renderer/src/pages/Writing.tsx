import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChapterBrief, ContextPart } from '@shared/types'
import { Badge, Button, Card, Input, Label, Select, Textarea } from '../components/ui'
import { fmtDuration, fmtTokens } from '../lib/format'
import { runPipeline, type DonePayload } from '../lib/ipc'
import type { Navigate } from '../lib/nav'

interface ChapterDoneData {
  chapterId?: string
  wordCount?: number
  contextParts?: ContextPart[]
  contextTokens?: number
  error?: string
}

interface SummaryDoneData {
  planted?: number
  resolved?: number
  parsed?: boolean
  error?: string
}

interface CheckIssue {
  type: string
  quote: string
  issue: string
  fix: string
}

interface BatchState {
  running: boolean
  paused: boolean
  done: number
  total: number
  currentNo: number
  log: string[]
}

const STATUS_BADGE: Record<string, { label: string; tone: 'default' | 'amber' | 'green' }> = {
  draft: { label: '草稿', tone: 'default' },
  approved: { label: '已审定', tone: 'amber' },
  written: { label: '已定稿', tone: 'green' },
  polished: { label: '已润色', tone: 'green' }
}

type Busy = 'chapter' | 'summary' | 'polish' | 'check' | null

interface Props {
  projectId: string
  onNavigate: Navigate
  focusOutlineId: string | null
  onFocusConsumed: () => void
}

export default function Writing({ projectId, onNavigate, focusOutlineId, onFocusConsumed }: Props) {
  const [briefs, setBriefs] = useState<ChapterBrief[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [notice, setNotice] = useState('')
  const [lastUsage, setLastUsage] = useState<DonePayload | null>(null)
  const [ctxPreview, setCtxPreview] = useState<ContextPart[] | null>(null)
  const [checkResult, setCheckResult] = useState<{ issues: CheckIssue[]; parsed: boolean } | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchFrom, setBatchFrom] = useState('')
  const [batchTo, setBatchTo] = useState('')
  const [pauseEach, setPauseEach] = useState(true)
  const [batch, setBatch] = useState<BatchState | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const polishedRef = useRef(false)
  const batchStopRef = useRef(false)
  const batchAbortRef = useRef<string | null>(null)
  const resumeRef = useRef<string[] | null>(null)

  const selected = briefs.find((b) => b.id === selectedId) ?? null

  const loadBriefs = useCallback((): void => {
    if (!projectId) return
    void window.api.novel.chapterBriefs(projectId).then(setBriefs)
  }, [projectId])

  const openChapter = useCallback((outlineId: string): void => {
    setSelectedId(outlineId)
    setCtxPreview(null)
    setNotice('')
    setCheckResult(null)
    polishedRef.current = false
    void window.api.novel.chapter(outlineId).then((c) => {
      setContent(c?.content ?? '')
      setDirty(false)
    })
  }, [])

  useEffect(() => {
    setBriefs([])
    setSelectedId(null)
    setContent('')
    setBatch(null)
    resumeRef.current = null
    polishedRef.current = false
    loadBriefs()
  }, [loadBriefs])

  useEffect(() => {
    if (!focusOutlineId || briefs.length === 0) return
    if (briefs.some((b) => b.id === focusOutlineId)) openChapter(focusOutlineId)
    onFocusConsumed()
  }, [focusOutlineId, briefs, openChapter, onFocusConsumed])

  useEffect(() => {
    const offDelta = window.api.llm.onDelta((id, text) => {
      if (id === requestIdRef.current) setContent((prev) => prev + text)
    })
    const offDone = window.api.llm.onDone((id, payload) => {
      if (id !== requestIdRef.current) return
      setLastUsage(payload)
      const d = payload.data as ChapterDoneData & SummaryDoneData
      if (payload.action === 'chapter') {
        setBusy(null)
        setDirty(false)
        polishedRef.current = false
        setNotice(
          d?.error
            ? `生成完成但保存失败：${d.error}`
            : `初稿完成：${d?.wordCount ?? 0} 字 · 上下文约 ${fmtTokens(d?.contextTokens ?? 0)} tokens`
        )
        setCtxPreview(d?.contextParts ?? null)
        loadBriefs()
      } else if (payload.action === 'polish') {
        setBusy(null)
        setDirty(true)
        polishedRef.current = true
        setNotice('润色稿已生成，审阅后点「保存草稿」应用（将覆盖原稿并标记为已润色）')
      }
    })
    const offError = window.api.llm.onError((id, message) => {
      if (id !== requestIdRef.current) return
      setBusy(null)
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
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
        请先选择一个项目
        <Button onClick={() => onNavigate('projects')}>去选择项目</Button>
      </div>
    )
  }

  const startStreamToEditor = (action: 'chapter' | 'polish'): void => {
    if (!selectedId || busy || batch?.running) return
    setContent('')
    setNotice('')
    setCtxPreview(null)
    setCheckResult(null)
    setBusy(action)
    void window.api.pipeline
      .run(action, { outlineId: selectedId })
      .then((id) => {
        requestIdRef.current = id
      })
      .catch((err: unknown) => {
        setBusy(null)
        setNotice((err as Error).message)
      })
  }

  const generateDraft = (): void => {
    if (!selectedId) return
    if (
      selected?.hasDraft &&
      !window.confirm('该章已有正文，重新生成将覆盖编辑器内容（原稿仍可放弃保存）。继续？')
    )
      return
    startStreamToEditor('chapter')
  }

  const polish = (): void => {
    if (!selected?.hasDraft) return
    if (!window.confirm('润色将生成新稿覆盖编辑器（原稿审阅前不会保存替换）。继续？')) return
    startStreamToEditor('polish')
  }

  const check = async (): Promise<void> => {
    if (!selectedId || busy || batch?.running) return
    if (dirty) {
      setNotice('先保存草稿再检查（检查的是已保存正文）')
      return
    }
    if (!selected?.hasDraft) return
    setBusy('check')
    setNotice('一致性检查中…')
    try {
      const payload = await runPipeline('check', { outlineId: selectedId })
      const d = payload.data as { issues?: CheckIssue[]; parsed?: boolean; error?: string }
      if (d?.error) setNotice(`检查失败：${d.error}`)
      else {
        setCheckResult({ issues: d?.issues ?? [], parsed: d?.parsed ?? false })
        setNotice(
          d?.parsed
            ? `检查完成：${d?.issues?.length ?? 0} 个问题`
            : '检查完成但输出未解析为问题清单'
        )
      }
      setLastUsage(payload)
    } catch (err) {
      setNotice(`出错：${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const saveDraft = (): void => {
    if (!selectedId) return
    void window.api.novel.saveChapter({ outlineId: selectedId, projectId, content }).then(() => {
      setDirty(false)
      if (polishedRef.current && selected) {
        polishedRef.current = false
        void window.api.novel
          .outlineSave({
            id: selected.id,
            projectId,
            volume: selected.volume,
            chapterNo: selected.chapterNo,
            title: selected.title,
            synopsis: selected.synopsis,
            status: 'polished'
          })
          .then(() => {
            setNotice('润色稿已保存（章节标记为已润色）')
            loadBriefs()
          })
        return
      }
      setNotice('草稿已保存')
      loadBriefs()
    })
  }

  const finalize = (): void => {
    if (!selectedId || !selected || busy || batch?.running) return
    if (content.trim().length === 0) return
    void (async () => {
      const existing = await window.api.novel.summary(selectedId)
      if (existing && !dirty) {
        await window.api.novel.outlineSave({
          id: selected.id,
          projectId,
          volume: selected.volume,
          chapterNo: selected.chapterNo,
          title: selected.title,
          synopsis: selected.synopsis,
          status: 'written'
        })
        setNotice('已定稿（摘要已存在，未重新生成）')
        loadBriefs()
        return
      }
      if (dirty && !window.confirm('有未保存的修改，定稿前将先保存当前内容。继续？')) return
      setBusy('summary')
      setNotice('定稿中：保存正文并生成摘要…')
      try {
        await window.api.novel.saveChapter({
          outlineId: selectedId,
          projectId,
          content,
          status: 'written'
        })
        const payload = await runPipeline('summary', { outlineId: selectedId, finalize: true })
        const d = payload.data as SummaryDoneData
        setLastUsage(payload)
        setNotice(
          d?.error
            ? `定稿完成，但摘要失败：${d.error}`
            : d?.parsed
              ? `已定稿并生成摘要${d.planted ? ` · 新登记伏笔 ${d.planted} 条` : ''}${
                  d.resolved ? ` · 回收伏笔 ${d.resolved} 条` : ''
                }`
              : '已定稿，但摘要解析失败（可重试）'
        )
        loadBriefs()
      } catch (err) {
        setNotice(`出错：${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    })()
  }

  const previewContext = (): void => {
    if (!selectedId) return
    void window.api.novel.contextPreview(selectedId).then((ctx) => setCtxPreview(ctx.parts))
  }

  const exportChapter = (format: 'txt' | 'md' | 'docx'): void => {
    if (!selectedId) return
    void window.api.exporter
      .run({ projectId, format, scope: 'single', outlineId: selectedId })
      .then((r) => setNotice(`已导出：${r.path}（${r.words} 字）`))
      .catch((err: unknown) => {
        const msg = (err as Error).message
        if (msg !== '已取消导出') setNotice(`导出失败：${msg}`)
      })
  }

  const runBatchList = async (ids: string[]): Promise<void> => {
    batchStopRef.current = false
    setBatch({ running: true, paused: false, done: 0, total: ids.length, currentNo: 0, log: [] })
    for (let i = 0; i < ids.length; i++) {
      if (batchStopRef.current) break
      const brief = briefs.find((b) => b.id === ids[i])
      if (!brief) continue
      setBatch((prev) =>
        prev
          ? { ...prev, currentNo: brief.chapterNo, log: [...prev.log, `第${brief.chapterNo}章 生成中…`] }
          : prev
      )
      try {
        batchAbortRef.current = await window.api.pipeline.run('chapter', { outlineId: ids[i] })
        const gen = await new Promise<DonePayload>((resolve, reject) => {
          const offs: Array<() => void> = []
          const cleanup = (): void => offs.forEach((o) => o())
          offs.push(
            window.api.llm.onDone((rid, p) => {
              if (rid === batchAbortRef.current) {
                cleanup()
                resolve(p)
              }
            }),
            window.api.llm.onError((rid, m) => {
              if (rid === batchAbortRef.current) {
                cleanup()
                reject(new Error(m))
              }
            })
          )
        })
        const d = gen.data as ChapterDoneData
        setBatch((prev) =>
          prev
            ? {
                ...prev,
                done: prev.done + 1,
                log: [...prev.log, `第${brief.chapterNo}章 初稿 ${d?.wordCount ?? 0} 字，摘要中…`]
              }
            : prev
        )
        await runPipeline('summary', { outlineId: ids[i], finalize: false })
        setBatch((prev) => (prev ? { ...prev, log: [...prev.log, `第${brief.chapterNo}章 ✓ 完成`] } : prev))
        loadBriefs()
        if (pauseEach && i < ids.length - 1 && !batchStopRef.current) {
          resumeRef.current = ids.slice(i + 1)
          setBatch((prev) => (prev ? { ...prev, paused: true } : prev))
          return
        }
      } catch (err) {
        setBatch((prev) =>
          prev
            ? { ...prev, running: false, log: [...prev.log, `第${brief.chapterNo}章 失败：${(err as Error).message}`] }
            : prev
        )
        return
      }
    }
    setBatch((prev) => (prev ? { ...prev, running: false } : prev))
  }

  const startBatch = (): void => {
    const idxFrom = briefs.findIndex((b) => b.id === batchFrom)
    const idxTo = briefs.findIndex((b) => b.id === batchTo)
    if (idxFrom < 0 || idxTo < 0 || idxFrom > idxTo) return
    const ids = briefs.slice(idxFrom, idxTo + 1).map((b) => b.id)
    setBatchOpen(false)
    void runBatchList(ids)
  }

  const stopBatch = (): void => {
    batchStopRef.current = true
    resumeRef.current = null
    if (batchAbortRef.current) void window.api.llm.abort(batchAbortRef.current)
    setBatch((prev) => (prev ? { ...prev, running: false, paused: false } : prev))
  }

  const resumeBatch = (): void => {
    const ids = resumeRef.current
    resumeRef.current = null
    if (ids && ids.length > 0) void runBatchList(ids)
  }

  const wordCount = content.replace(/\s/g, '').length
  const status = selected ? STATUS_BADGE[selected.status] : null
  const volumes = [...new Set(briefs.map((b) => b.volume))]
  const busyAny = busy !== null || (batch?.running ?? false)

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:flex-row md:p-4">
      <Card className="flex max-h-44 shrink-0 flex-col md:max-h-none md:w-60">
        <div className="border-b border-zinc-800 px-3 py-2.5 text-sm font-medium text-zinc-200">
          章节（{briefs.length}）
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {volumes.length === 0 && (
            <div className="p-4 text-center text-xs leading-5 text-zinc-600">
              暂无大纲
              <Button variant="ghost" className="mt-2 px-2 py-1 text-xs" onClick={() => onNavigate('outline')}>
                去大纲页生成
              </Button>
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
            <div className="mb-3 flex flex-wrap items-center gap-2.5">
              <div className="text-sm font-medium text-zinc-100">
                第 {selected.chapterNo} 章 · {selected.title || '未命名'}
              </div>
              {status && <Badge tone={status.tone}>{status.label}</Badge>}
              {dirty && <Badge tone="amber">未保存</Badge>}
              <span className="text-xs text-zinc-500">{wordCount} 字</span>
              <div className="ml-auto flex min-w-0 gap-2 overflow-x-auto pb-1 [&>*]:shrink-0 md:flex-wrap md:overflow-visible md:pb-0">
                <Button variant="ghost" onClick={previewContext} disabled={busyAny}>
                  上下文
                </Button>
                <Button variant="ghost" onClick={saveDraft} disabled={!dirty || busyAny}>
                  保存
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (requestIdRef.current) void window.api.llm.abort(requestIdRef.current)
                  }}
                  disabled={busy === null}
                >
                  中断
                </Button>
                <span className="mx-1 w-px bg-zinc-700" />
                <Button onClick={generateDraft} disabled={busyAny}>
                  {busy === 'chapter' ? '生成中…' : selected.hasDraft ? '重新生成' : 'AI 初稿'}
                </Button>
                <Button variant="ghost" onClick={polish} disabled={busyAny || !selected.hasDraft}>
                  {busy === 'polish' ? '润色中…' : '润色'}
                </Button>
                <Button variant="ghost" onClick={() => void check()} disabled={busyAny || !selected.hasDraft}>
                  {busy === 'check' ? '检查中…' : '检查'}
                </Button>
                <Button
                  onClick={finalize}
                  disabled={busyAny || content.trim().length === 0}
                >
                  {busy === 'summary' ? '定稿中…' : '定稿'}
                </Button>
                <span className="mx-1 w-px bg-zinc-700" />
                <Button variant="ghost" className="px-2" onClick={() => exportChapter('txt')} disabled={busyAny}>
                  txt
                </Button>
                <Button variant="ghost" className="px-2" onClick={() => exportChapter('md')} disabled={busyAny}>
                  md
                </Button>
                <Button variant="ghost" className="px-2" onClick={() => exportChapter('docx')} disabled={busyAny}>
                  docx
                </Button>
                <Button variant="ghost" onClick={() => setBatchOpen((v) => !v)} disabled={batch?.running ?? false}>
                  批量
                </Button>
              </div>
            </div>

            {batchOpen && (
              <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900 p-3">
                <div className="grid grid-cols-2 items-end gap-3 md:grid-cols-12">
                  <div className="col-span-1 md:col-span-4">
                    <Label>起章</Label>
                    <Select value={batchFrom} onChange={(e) => setBatchFrom(e.target.value)} className="w-full">
                      <option value="">选择…</option>
                      {briefs.map((b) => (
                        <option key={b.id} value={b.id}>
                          第{b.chapterNo}章 {b.title || '未命名'}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="col-span-1 md:col-span-4">
                    <Label>止章</Label>
                    <Select value={batchTo} onChange={(e) => setBatchTo(e.target.value)} className="w-full">
                      <option value="">选择…</option>
                      {briefs.map((b) => (
                        <option key={b.id} value={b.id}>
                          第{b.chapterNo}章 {b.title || '未命名'}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="col-span-1 flex items-center gap-2 pb-2 md:col-span-2">
                    <input
                      id="pause-each"
                      type="checkbox"
                      checked={pauseEach}
                      onChange={(e) => setPauseEach(e.target.checked)}
                      className="h-3.5 w-3.5 cursor-pointer accent-amber-600"
                    />
                    <label htmlFor="pause-each" className="cursor-pointer text-xs text-zinc-400">
                      逐章暂停
                    </label>
                  </div>
                  <div className="col-span-1 md:col-span-2">
                    <Button
                      className="w-full"
                      onClick={startBatch}
                      disabled={!batchFrom || !batchTo}
                    >
                      开始批量
                    </Button>
                  </div>
                </div>
                <div className="mt-2 text-xs text-zinc-600">
                  流程：逐章「生成初稿 → 自动摘要」（保证后续章节上下文连续）。逐章暂停时每章完成后停下待审。
                </div>
              </div>
            )}

            {batch && (
              <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900 p-3">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400">
                    批量进度：{batch.done}/{batch.total}
                    {batch.running && batch.currentNo > 0 ? ` · 第${batch.currentNo}章进行中` : ''}
                    {batch.paused ? ' · 已暂停待审' : ''}
                  </span>
                  <div className="ml-auto flex gap-2">
                    {batch.paused && (
                      <Button className="px-2 py-1 text-xs" onClick={resumeBatch}>
                        继续剩余章节
                      </Button>
                    )}
                    {batch.running && (
                      <Button variant="danger" className="px-2 py-1 text-xs" onClick={stopBatch}>
                        停止批量
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-amber-600 transition-all"
                    style={{ width: `${batch.total > 0 ? (batch.done / batch.total) * 100 : 0}%` }}
                  />
                </div>
                {batch.log.length > 0 && (
                  <div className="mt-2 max-h-24 overflow-y-auto font-mono text-[10px] leading-4 text-zinc-500">
                    {batch.log.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <Textarea
              className="min-h-0 flex-1 leading-8"
              value={content}
              onChange={(e) => {
                setContent(e.target.value)
                setDirty(true)
              }}
              readOnly={busy !== null}
              placeholder={busy === 'chapter' ? '正在生成初稿…' : busy === 'polish' ? '正在润色…' : '点「AI 初稿」生成本章，或直接手写'}
            />

            {checkResult && (
              <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2">
                <div className="mb-1 text-xs font-medium text-zinc-300">
                  一致性检查（{checkResult.issues.length} 个问题）
                </div>
                {checkResult.issues.length === 0 && (
                  <div className="text-xs text-emerald-400">未发现矛盾</div>
                )}
                {checkResult.issues.map((iss, i) => (
                  <div key={i} className="mb-1.5 border-l-2 border-amber-600/60 pl-2 text-xs leading-5">
                    <span className="mr-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-amber-400">
                      {iss.type}
                    </span>
                    <span className="text-zinc-300">{iss.issue}</span>
                    {iss.quote && <div className="text-zinc-600">原文：{iss.quote}</div>}
                    {iss.fix && <div className="text-zinc-500">建议：{iss.fix}</div>}
                  </div>
                ))}
              </div>
            )}

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
            <span className="text-xs">
              单章：AI 初稿 → 编辑 → 定稿（自动摘要/伏笔）；「批量」可连续生成多章
            </span>
          </div>
        )}
      </Card>
    </div>
  )
}
