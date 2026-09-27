import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChapterBrief, ContextPart, ReviewResult } from '@shared/types'
import { Badge, Button, Card, Input, Label, Select, Textarea } from '../components/ui'
import { DiffView } from '../components/DiffView'
import { fmtDuration, fmtTokens } from '../lib/format'
import { runPipeline, type DonePayload } from '../lib/ipc'
import type { Navigate } from '../lib/nav'

interface ChapterDoneData {
  chapterId?: string
  wordCount?: number
  contextParts?: ContextPart[]
  contextTokens?: number
  longMode?: boolean
  segments?: number
  lint?: LintReport
  error?: string
}

interface SummaryDoneData {
  planted?: number
  resolved?: number
  parsed?: boolean
  error?: string
}

interface StateSyncDoneData {
  updated?: Array<{ id: string; name: string }>
  parsed?: boolean
  error?: string
}

interface CheckIssue {
  type: string
  quote: string
  issue: string
  fix: string
}

interface LintIssue {
  rule: string
  level: 'major' | 'minor'
  quote: string
  advice: string
}

interface LintReport {
  issues: LintIssue[]
  score: number
  pass: boolean
  wordCount: number
  targetWords: number | null
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

type Busy = 'chapter' | 'summary' | 'polish' | 'expand' | 'check' | 'review' | 'stateSync' | null

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
  const [lintReport, setLintReport] = useState<LintReport | null>(null)
  const [reviewResult, setReviewResult] = useState<ReviewResult | null>(null)
  const [candidate, setCandidate] = useState<{ kind: 'polish' | 'expand'; text: string } | null>(null)
  const [wordTarget, setWordTarget] = useState('2700')
  const [candidateCount, setCandidateCount] = useState('0')
  const [candidateSet, setCandidateSet] = useState<{
    list: Array<{ text: string; score: number; wordCount: number; issues: number; pass: boolean }>
    winnerIndex: number
    selectedIndex: number
  } | null>(null)
  const candidateRef = useRef('')
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchFrom, setBatchFrom] = useState('')
  const [batchTo, setBatchTo] = useState('')
  const [pauseEach, setPauseEach] = useState(true)
  const [batch, setBatch] = useState<BatchState | null>(null)
  const requestIdRef = useRef<string | null>(null)
  const streamTargetRef = useRef<'editor' | 'candidate'>('editor')
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
    setLintReport(null)
    setReviewResult(null)
    setCandidate(null)
    setCandidateSet(null)
    candidateRef.current = ''
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
      if (id !== requestIdRef.current) return
      if (streamTargetRef.current === 'candidate') {
        candidateRef.current += text
        setCandidate((prev) => (prev ? { ...prev, text: prev.text + text } : null))
      } else {
        setContent((prev) => prev + text)
      }
    })
    const offDone = window.api.llm.onDone((id, payload) => {
      if (id !== requestIdRef.current) return
      setLastUsage(payload)
      const d = payload.data as ChapterDoneData & SummaryDoneData
      if (payload.action === 'chapter') {
        setBusy(null)
        setDirty(false)
        polishedRef.current = false
        const lint = (payload.data as { lint?: LintReport }).lint ?? null
        setLintReport(lint)
        const cand = (payload.data as {
          candidateMode?: boolean
          winnerIndex?: number
          candidates?: Array<{ text: string; score: number; wordCount: number; issues: number; pass: boolean }>
        })
        if (cand.candidateMode && cand.candidates && cand.candidates.length > 0) {
          const wi = cand.winnerIndex ?? 0
          setCandidateSet({ list: cand.candidates, winnerIndex: wi, selectedIndex: wi })
          setContent(cand.candidates[wi].text)
          setDirty(false)
        }
        setNotice(
          d?.error
            ? `生成完成但保存失败：${d.error}`
            : cand.candidateMode
              ? `已生成 ${cand.candidates?.length ?? 0} 个候选，最优第 ${(cand.winnerIndex ?? 0) + 1} 个（已存入编辑器，可在对比卡中切换）`
              : `初稿完成：${d?.wordCount ?? 0} 字 · 上下文约 ${fmtTokens(d?.contextTokens ?? 0)} tokens${
                  lint && !lint.pass ? ` · 硬闸 ${lint.issues.length} 项待处理` : ''
                }`
        )
        setCtxPreview(d?.contextParts ?? null)
        loadBriefs()
      } else if (payload.action === 'polish' || payload.action === 'expand') {
        setBusy(null)
        setCandidate({ kind: payload.action, text: candidateRef.current })
        setNotice(
          payload.action === 'polish'
            ? '润色稿已生成：在下方 diff 视图逐块取舍后应用（不会直接覆盖原稿）'
            : '扩写稿已生成：在下方 diff 视图逐块取舍后应用（不会直接覆盖原稿）'
        )
      }
    })
    const offError = window.api.llm.onError((id, message) => {
      if (id !== requestIdRef.current) return
      setBusy(null)
      setNotice(`出错：${message}`)
    })
    const offNotice = window.api.llm.onNotice((_id, message) => {
      setNotice(message)
    })
    return () => {
      offDelta()
      offDone()
      offError()
      offNotice()
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

  const startStream = (
    action: 'chapter' | 'polish' | 'expand',
    params?: Record<string, unknown>
  ): void => {
    if (!selectedId || busy || batch?.running) return
    if (action === 'chapter') {
      setContent('')
    } else {
      candidateRef.current = ''
      setCandidate(null)
    }
    streamTargetRef.current = action === 'chapter' ? 'editor' : 'candidate'
    setNotice('')
    setCtxPreview(null)
    setCheckResult(null)
    setLintReport(null)
    setReviewResult(null)
    if (action === 'chapter') setCandidateSet(null)
    setBusy(action)
    void window.api.pipeline
      .run(action, { outlineId: selectedId, ...params })
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
    startStream('chapter', {
      wordTarget: parseInt(wordTarget, 10) || undefined,
      candidates: parseInt(candidateCount, 10) >= 2 ? parseInt(candidateCount, 10) : undefined
    })
  }

  const polish = (): void => {
    if (!selected?.hasDraft) return
    startStream('polish')
  }

  const expand = (): void => {
    if (!selected?.hasDraft || !selectedId) return
    const current = content.replace(/\s/g, '').length
    const target = window.prompt('扩写目标字数', String(Math.max(current + 1500, 3500)))
    if (!target) return
    const n = parseInt(target, 10)
    if (!Number.isFinite(n) || n <= current) {
      setNotice('目标字数需大于当前字数')
      return
    }
    startStream('expand', { targetWords: n })
  }

  const applyCandidate = (text: string): void => {
    setContent(text)
    setDirty(true)
    if (candidate?.kind === 'polish') polishedRef.current = true
    setCandidate(null)
    candidateRef.current = ''
    setNotice('已应用修订（未保存，点「保存」落盘）')
  }

  const runLint = async (): Promise<void> => {
    if (!selectedId) return
    try {
      const r = (await window.api.lint.run(selectedId, content)) as LintReport
      setLintReport(r)
      setNotice(
        r.pass
          ? `硬闸通过（${r.wordCount} 字）`
          : `硬闸发现 ${r.issues.length} 项问题（本地零成本检查）`
      )
    } catch (err) {
      setNotice(`硬闸检查失败：${(err as Error).message}`)
    }
  }

  const review = async (): Promise<void> => {
    if (!selectedId || busy || batch?.running) return
    if (dirty) {
      setNotice('先保存草稿再评审（评审的是已保存正文）')
      return
    }
    if (!selected?.hasDraft) return
    setBusy('review')
    setNotice('七维评审中…')
    try {
      const payload = await runPipeline('review', { outlineId: selectedId })
      const d = payload.data as ReviewResult & { error?: string }
      if (d?.error) setNotice(`评审失败：${d.error}`)
      else {
        setReviewResult(d ?? null)
        const total = (d?.scores ?? []).reduce((a, s) => a + s.score, 0)
        setNotice(
          d?.parsed
            ? `评审完成：${d.verdict === 'pass' ? '通过' : d.verdict === 'polish' ? '建议打磨' : '建议重写'}${
                d.scores.length > 0 ? ` · 总分 ${total}/${d.scores.length * 10}` : ''
              }`
            : '评审完成但输出未解析为结构化结果'
        )
      }
      setLastUsage(payload)
    } catch (err) {
      setNotice(`出错：${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
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
        let msg = d?.error
          ? `定稿完成，但摘要失败：${d.error}`
          : d?.parsed
            ? `已定稿并生成摘要${d.planted ? ` · 新登记伏笔 ${d.planted} 条` : ''}${
                d.resolved ? ` · 回收伏笔 ${d.resolved} 条` : ''
              }`
            : '已定稿，但摘要解析失败（可重试）'
        if (!d?.error && d?.parsed) {
          setBusy('stateSync')
          setNotice('摘要完成，同步人物动态状态…')
          try {
            const sync = await runPipeline('stateSync', { outlineId: selectedId })
            const sd = sync.data as StateSyncDoneData
            if (sd?.parsed && sd.updated && sd.updated.length > 0) {
              msg += ` · 已同步 ${sd.updated.length} 个人物状态（${sd.updated.map((u) => u.name).join('、')}）`
            }
          } catch {
            /* 状态同步失败不阻断定稿 */
          }
        }
        setNotice(msg)
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
    const results: boolean[] = []
    let consecutiveFail = 0
    const appendLog = (line: string): void =>
      setBatch((prev) => (prev ? { ...prev, log: [...prev.log, line] } : prev))

    for (let i = 0; i < ids.length; i++) {
      if (batchStopRef.current) break
      const brief = briefs.find((b) => b.id === ids[i])
      if (!brief) continue
      setBatch((prev) => (prev ? { ...prev, currentNo: brief.chapterNo } : prev))
      appendLog(`第${brief.chapterNo}章 生成中…`)
      try {
        batchAbortRef.current = await window.api.pipeline.run('chapter', {
          outlineId: ids[i],
          wordTarget: parseInt(wordTarget, 10) || undefined,
          candidates:
            parseInt(candidateCount, 10) >= 2 ? parseInt(candidateCount, 10) : undefined
        })
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
        setBatch((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev))
        appendLog(`第${brief.chapterNo}章 初稿 ${d?.wordCount ?? 0} 字${d?.longMode ? `（长章 ${d.segments} 段）` : ''}`)

        // 硬闸判定 + 自动返修（一次）
        let passed = d?.lint?.pass !== false
        if (!passed && d?.lint) {
          const focus = d.lint.issues.map((it) => `- ${it.rule}：${it.advice}${it.quote ? `（原文：${it.quote}）` : ''}`).join('\n')
          appendLog(`第${brief.chapterNo}章 硬闸未过（${d.lint.issues.length} 项），自动返修…`)
          try {
            await runPipeline('polish', { outlineId: ids[i], focus, save: true })
            const re = (await window.api.lint.run(ids[i])) as LintReport
            passed = re.pass
            appendLog(passed ? `第${brief.chapterNo}章 返修通过` : `第${brief.chapterNo}章 返修仍未过 → 需人工`)
          } catch (err) {
            appendLog(`第${brief.chapterNo}章 返修失败：${(err as Error).message}`)
          }
        }

        try {
          await runPipeline('summary', { outlineId: ids[i], finalize: false })
          appendLog(`第${brief.chapterNo}章 ${passed ? '✓ 完成' : '⚠ 已写入（需人工）'}`)
        } catch (err) {
          appendLog(`第${brief.chapterNo}章 摘要失败：${(err as Error).message}`)
        }
        loadBriefs()

        results.push(passed)
        consecutiveFail = passed ? 0 : consecutiveFail + 1
        const window10 = results.slice(-10)
        const failIn10 = window10.filter((r) => !r).length
        if (consecutiveFail >= 3 || (window10.length >= 10 && failIn10 >= 6)) {
          appendLog(`⚠ 熔断：连续 ${consecutiveFail} 章未过（近期 ${failIn10}/${window10.length}）——暂停批量，建议先排查根因`)
          resumeRef.current = ids.slice(i + 1)
          setBatch((prev) => (prev ? { ...prev, paused: true } : prev))
          return
        }

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
                <Select
                  value={wordTarget}
                  onChange={(e) => setWordTarget(e.target.value)}
                  className="w-20 py-1 text-xs"
                  title="生成字数目标"
                >
                  <option value="2000">2千</option>
                  <option value="2700">2.7千</option>
                  <option value="3500">3.5千</option>
                  <option value="4500">4.5千</option>
                </Select>
                <Select
                  value={candidateCount}
                  onChange={(e) => setCandidateCount(e.target.value)}
                  className="w-24 py-1 text-xs"
                  title="多候选选优（成本 × N）"
                >
                  <option value="0">单稿</option>
                  <option value="2">候选×2</option>
                  <option value="3">候选×3</option>
                </Select>
                <Button onClick={generateDraft} disabled={busyAny}>
                  {busy === 'chapter' ? '生成中…' : selected.hasDraft ? '重新生成' : 'AI 初稿'}
                </Button>
                <Button variant="ghost" onClick={polish} disabled={busyAny || !selected.hasDraft}>
                  {busy === 'polish' ? '润色中…' : '润色'}
                </Button>
                <Button variant="ghost" onClick={expand} disabled={busyAny || !selected.hasDraft}>
                  {busy === 'expand' ? '扩写中…' : '扩写'}
                </Button>
                <Button variant="ghost" onClick={() => void check()} disabled={busyAny || !selected.hasDraft}>
                  {busy === 'check' ? '检查中…' : '检查'}
                </Button>
                <Button variant="ghost" onClick={() => void runLint()} disabled={busyAny || !content.trim()}>
                  硬闸
                </Button>
                <Button variant="ghost" onClick={() => void review()} disabled={busyAny || !selected.hasDraft}>
                  {busy === 'review' ? '评审中…' : '评审'}
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

            {candidate && busy === null && (
              <div className="mt-2">
                <DiffView
                  oldText={content}
                  newText={candidate.text}
                  title={candidate.kind === 'polish' ? '润色修订（逐块取舍）' : '扩写修订（逐块取舍）'}
                  onApply={applyCandidate}
                  onDiscard={() => {
                    setCandidate(null)
                    candidateRef.current = ''
                    setNotice('已放弃修订稿')
                  }}
                />
              </div>
            )}

            {candidateSet && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-900/50 bg-amber-950/20 p-2 text-xs">
                <span className="text-amber-300">候选对比（程序打分：硬闸分−字数偏差）：</span>
                {candidateSet.list.map((c, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setCandidateSet({ ...candidateSet, selectedIndex: i })
                      setContent(c.text)
                      setDirty(true)
                    }}
                    className={`cursor-pointer rounded border px-2 py-0.5 ${
                      candidateSet.selectedIndex === i
                        ? 'border-amber-600 bg-amber-900/50 text-amber-200'
                        : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                    }`}
                    title={`${c.text.slice(0, 60)}…`}
                  >
                    候选{i + 1} · {c.score}分 · {c.wordCount}字
                    {i === candidateSet.winnerIndex ? ' · 最优' : ''}
                    {!c.pass ? ` · 硬闸${c.issues}项` : ''}
                  </button>
                ))}
                <button
                  className="ml-auto cursor-pointer text-zinc-500 hover:text-zinc-300"
                  onClick={() => setCandidateSet(null)}
                >
                  关闭对比
                </button>
              </div>
            )}

            {lintReport && (
              <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-300">
                  硬闸检查（本地零成本）
                  <Badge tone={lintReport.pass ? 'green' : 'red'}>
                    {lintReport.pass ? '通过' : `${lintReport.issues.length} 项`}
                  </Badge>
                  <span className="text-zinc-500">
                    {lintReport.wordCount} 字
                    {lintReport.targetWords ? ` / 目标 ${lintReport.targetWords}` : ''}
                  </span>
                  <button
                    className="ml-auto cursor-pointer text-zinc-500 hover:text-zinc-300"
                    onClick={() => setLintReport(null)}
                  >
                    关闭
                  </button>
                </div>
                {lintReport.issues.length === 0 && (
                  <div className="text-xs text-emerald-400">接缝、穿帮词、重复段、字数均正常</div>
                )}
                {lintReport.issues.map((iss, i) => (
                  <div key={i} className="mb-1.5 border-l-2 border-zinc-700 pl-2 text-xs leading-5">
                    <span
                      className={`mr-2 rounded px-1.5 py-0.5 text-[10px] ${
                        iss.level === 'major' ? 'bg-red-900/50 text-red-300' : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {iss.rule}
                    </span>
                    <span className="text-zinc-400">{iss.advice}</span>
                    {iss.quote && <div className="text-zinc-600">原文：{iss.quote}</div>}
                  </div>
                ))}
              </div>
            )}

            {reviewResult && (
              <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-300">
                  七维评审
                  <Badge tone={reviewResult.verdict === 'pass' ? 'green' : reviewResult.verdict === 'polish' ? 'amber' : 'red'}>
                    {reviewResult.verdict === 'pass' ? '通过' : reviewResult.verdict === 'polish' ? '建议打磨' : '建议重写'}
                  </Badge>
                </div>
                {reviewResult.scores.map((s, i) => (
                  <div key={i} className="mb-1.5 border-l-2 border-zinc-700 pl-2 text-xs leading-5">
                    <span className="mr-2 inline-flex items-center gap-1.5">
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">{s.dim}</span>
                      <span
                        className={
                          s.score >= 8 ? 'text-emerald-400' : s.score >= 6 ? 'text-amber-400' : 'text-red-400'
                        }
                      >
                        {s.score}/10
                      </span>
                    </span>
                    <span className="text-zinc-400">{s.comment}</span>
                    {s.quote && <div className="text-zinc-600">原文：{s.quote}</div>}
                  </div>
                ))}
                {reviewResult.summary && (
                  <div className="mt-1 text-xs text-zinc-400">总评：{reviewResult.summary}</div>
                )}
              </div>
            )}

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
