import type { ContextPart, ReviewResult } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react'
import { DiffView } from '../components/DiffView'
import { Badge, Button, Card, Label, Select, Textarea } from '../components/ui'
import { fmtDuration, fmtTokens } from '../lib/format'
import { type DonePayload, runPipeline } from '../lib/ipc'
import type { Navigate } from '../lib/nav'
import { qk, queries } from '../lib/queries'
import { openWizard } from '../lib/wizardStore'
import {
  beginChapterRun,
  type CheckIssue,
  ensureWriteRunBridge,
  type LintReport,
  markRunConsumed,
  suggestBatchRange,
  useWriteRunStore,
  type WriteBusy
} from '../lib/writeRunStore'

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

const STATUS_BADGE: Record<string, { label: string; tone: 'default' | 'amber' | 'green' }> = {
  draft: { label: '草稿', tone: 'default' },
  approved: { label: '已审定', tone: 'amber' },
  written: { label: '已定稿', tone: 'green' },
  polished: { label: '已润色', tone: 'green' }
}

interface Props {
  projectId: string
  onNavigate: Navigate
  focusOutlineId: string | null
  onFocusConsumed: () => void
}

// —— 运行态 setter（模块级，稳定引用；落点 writeRunStore）——
const setBusy = (b: WriteBusy): void => {
  useWriteRunStore.setState({ busy: b })
}
const setNotice = (m: string): void => {
  useWriteRunStore.setState({ notice: m })
}
const setLastUsage = (p: DonePayload | null): void => {
  useWriteRunStore.setState({ lastUsage: p })
}
const setCtxPreview = (v: ContextPart[] | null): void => {
  useWriteRunStore.setState({ ctxPreview: v })
}
const setCheckResult = (v: { issues: CheckIssue[]; parsed: boolean } | null): void => {
  useWriteRunStore.setState({ checkResult: v })
}
const setLintReport = (v: LintReport | null): void => {
  useWriteRunStore.setState({ lintReport: v })
}
const setReviewResult = (v: ReviewResult | null): void => {
  useWriteRunStore.setState({ reviewResult: v })
}
const setCandidate = (v: { kind: 'polish' | 'expand'; text: string } | null): void => {
  useWriteRunStore.setState({ candidate: v })
}
const setCandidateSet = (
  v: {
    list: Array<{ text: string; score: number; wordCount: number; issues: number; pass: boolean }>
    winnerIndex: number
    selectedIndex: number
  } | null
): void => {
  useWriteRunStore.setState({ candidateSet: v })
}
const setBatchOpen = (v: boolean | ((prev: boolean) => boolean)): void => {
  useWriteRunStore.setState((s) => ({ batchOpen: typeof v === 'function' ? v(s.batchOpen) : v }))
}

function BatchProgressCard({
  batch,
  onStop,
  onResume
}: {
  batch: NonNullable<ReturnType<typeof useWriteRunStore.getState>['batch']>
  onStop: () => void
  onResume: () => void
}) {
  return (
    <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-400">
          自动写作进度：{batch.done}/{batch.total}
          {batch.running && batch.currentNo > 0 ? ` · 第${batch.currentNo}章进行中` : ''}
          {batch.paused ? ' · 已暂停待审' : ''}
        </span>
        <div className="ml-auto flex gap-2">
          {batch.paused && (
            <Button className="px-2 py-1 text-xs" onClick={onResume}>
              继续剩余章节
            </Button>
          )}
          {batch.running && (
            <Button variant="danger" className="px-2 py-1 text-xs" onClick={onStop}>
              停止
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
            // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Writing({ projectId, onNavigate, focusOutlineId, onFocusConsumed }: Props) {
  const queryClient = useQueryClient()
  const { data: briefs = [] } = useQuery(queries.chapterBriefs(projectId))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  // 运行态全部在 writeRunStore：切走页面/切章后生成照跑，回来进度可回看
  const busy = useWriteRunStore((s) => s.busy)
  const notice = useWriteRunStore((s) => s.notice)
  const lastUsage = useWriteRunStore((s) => s.lastUsage)
  const candidate = useWriteRunStore((s) => s.candidate)
  const candidateSet = useWriteRunStore((s) => s.candidateSet)
  const lintReport = useWriteRunStore((s) => s.lintReport)
  const checkResult = useWriteRunStore((s) => s.checkResult)
  const reviewResult = useWriteRunStore((s) => s.reviewResult)
  const ctxPreview = useWriteRunStore((s) => s.ctxPreview)
  const run = useWriteRunStore((s) => s.run)
  const batch = useWriteRunStore((s) =>
    s.batch && s.batch.projectId === projectId ? s.batch : null
  )
  const batchOpen = useWriteRunStore((s) => s.batchOpen)
  const [wordTarget, setWordTarget] = useState('2700')
  const [candidateCount, setCandidateCount] = useState('0')
  const [batchFrom, setBatchFrom] = useState('')
  const [batchTo, setBatchTo] = useState('')
  const [pauseEach, setPauseEach] = useState(false)
  const polishedRef = useRef(false)
  // 打开批量面板时自动预填推荐范围（首个未写章 → 最后一章），批量进行中不打扰
  useEffect(() => {
    if (!batchOpen || batch?.running) return
    const range = suggestBatchRange(briefs)
    if (!range) return
    setBatchFrom(range.from)
    setBatchTo(range.to)
  }, [batchOpen, batch?.running, briefs])
  // 侧栏章节按每 20 章分段，折叠态记录「卷:段」key
  const [collapsedSegs, setCollapsedSegs] = useState<Set<string>>(new Set())

  const selected = briefs.find((b) => b.id === selectedId) ?? null

  const loadBriefs = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: qk.chapterBriefs(projectId) })
  }, [projectId, queryClient])

  // 单章初稿流式进行中：编辑器节流跟随 store 累积文本（300ms flush，
  // 避免每个 delta 触发整页 re-render；切章/完成时立即清理防止旧文本串章）
  const followTextRef = useRef('')
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearFollowTimer = useCallback((): void => {
    if (followTimerRef.current) {
      clearTimeout(followTimerRef.current)
      followTimerRef.current = null
    }
  }, [])
  useEffect(() => clearFollowTimer, [clearFollowTimer])

  const openChapter = useCallback(
    (outlineId: string): void => {
      clearFollowTimer()
      setSelectedId(outlineId)
      setCtxPreview(null)
      setNotice('')
      setCheckResult(null)
      setLintReport(null)
      setReviewResult(null)
      setCandidate(null)
      setCandidateSet(null)
      polishedRef.current = false
      void window.api.novel.chapter(outlineId).then((c) => {
        setContent(c?.content ?? '')
        setDirty(false)
      })
    },
    [clearFollowTimer]
  )

  useEffect(() => {
    clearFollowTimer()
    setSelectedId(null)
    setContent('')
    useWriteRunStore.setState({ batch: null, resumeIds: null })
    polishedRef.current = false
    // 页面刷新后 store 清空：从主进程拉回在途/刚结束的批量进度
    const pid = projectId
    void window.api.write
      .batchStatus({ projectId: pid })
      .then((snap) => {
        if (snap && (snap.running || snap.paused || snap.done > 0)) {
          useWriteRunStore.setState({ batch: snap, resumeIds: snap.resumeIds })
        }
      })
      .catch(() => {})
  }, [projectId, clearFollowTimer])

  useEffect(() => {
    if (!focusOutlineId || briefs.length === 0) return
    if (briefs.some((b) => b.id === focusOutlineId)) openChapter(focusOutlineId)
    onFocusConsumed()
  }, [focusOutlineId, briefs, openChapter, onFocusConsumed])

  // 挂全局 llm 事件桥（幂等）：事件处理不随组件卸载而消失
  useEffect(() => {
    ensureWriteRunBridge()
  }, [])

  // 单章流完成后按章消费：组件在场时回填编辑器（polish/expand 候选直接由桥写入 store 渲染）
  const runId = run?.chapterId
  const runFinished = run?.finished
  const runConsumed = run?.consumed
  const runKind = run?.kind
  const runEditorText = run?.editorText
  useEffect(() => {
    if (!runFinished || runConsumed || runId !== selectedId) return
    clearFollowTimer()
    if (runKind === 'chapter') {
      if (runEditorText) {
        setContent(runEditorText)
        setDirty(false)
      } else {
        // 刷新恢复场景兜底：流式文本随旧页面丢失，但主进程完成时已落库，从 DB 重读
        void window.api.novel.chapter(runId).then((c) => {
          if (c?.content) {
            setContent(c.content)
            setDirty(false)
          }
        })
      }
    }
    markRunConsumed()
  }, [runFinished, runConsumed, runId, runKind, runEditorText, selectedId, clearFollowTimer])

  useEffect(() => {
    if (runFinished || runKind !== 'chapter' || runId !== selectedId) return
    followTextRef.current = runEditorText ?? ''
    if (followTimerRef.current) return
    followTimerRef.current = setTimeout(() => {
      followTimerRef.current = null
      setContent(followTextRef.current)
    }, 300)
  }, [runFinished, runKind, runId, runEditorText, selectedId])

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
    setNotice('')
    setCtxPreview(null)
    setCheckResult(null)
    setLintReport(null)
    setReviewResult(null)
    if (action === 'chapter') setCandidateSet(null)
    setCandidate(null)
    setBusy(action)
    beginChapterRun(projectId, selectedId, action)
    void window.api.pipeline
      .run(action, { outlineId: selectedId, ...params })
      .then((id) => {
        useWriteRunStore.setState((s) => (s.run ? { run: { ...s.run, requestId: id } } : s))
      })
      .catch((err: unknown) => {
        useWriteRunStore.setState({ busy: null, run: null })
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

  const closeMenu = (e: SyntheticEvent): void => {
    ;(e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open')
  }

  /** 大纲对齐预览（大纲页）；批量内的自动对齐已移至主进程编排 */
  const startBatch = (): void => {
    const idxFrom = briefs.findIndex((b) => b.id === batchFrom)
    const idxTo = briefs.findIndex((b) => b.id === batchTo)
    if (idxFrom < 0 || idxTo < 0 || idxFrom > idxTo) return
    const ids = briefs.slice(idxFrom, idxTo + 1).map((b) => b.id)
    setBatchOpen(false)
    // 用返回快照立即切运行态，不依赖 write:batch 事件回推（SSE 断连时事件会丢）
    void window.api.write
      .batchStart({
        projectId,
        ids,
        wordTarget: parseInt(wordTarget, 10) || undefined,
        candidates: parseInt(candidateCount, 10) >= 2 ? parseInt(candidateCount, 10) : undefined,
        pauseEach
      })
      .then((snap) => {
        useWriteRunStore.setState({ batch: snap, resumeIds: snap.resumeIds })
      })
      .catch((err: unknown) => setNotice(`启动失败：${(err as Error).message}`))
  }

  const stopBatch = (): void => {
    void window.api.write.batchStop({ projectId }).catch(() => {})
  }

  const resumeBatch = (): void => {
    void window.api.write
      .batchStart({ projectId, resume: true })
      .then((snap) => {
        useWriteRunStore.setState({ batch: snap, resumeIds: snap.resumeIds })
      })
      .catch((err: unknown) => setNotice(`继续失败：${(err as Error).message}`))
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
            <div className="space-y-1.5 p-4 text-center text-xs leading-5 text-zinc-600">
              <div>暂无大纲，先去生成章节列表</div>
              <div className="flex flex-col items-center gap-1.5">
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => openWizard(projectId, 3)}
                >
                  用创作向导
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => onNavigate('outline')}
                >
                  去大纲页生成
                </Button>
              </div>
            </div>
          )}
          {volumes.map((vol) => {
            const inVol = briefs.filter((b) => b.volume === vol)
            // 每 20 章一段：段号 = floor((chapterNo-1)/20)
            const segs = new Map<number, typeof inVol>()
            for (const b of inVol) {
              const seg = Math.floor((b.chapterNo - 1) / 20)
              const list = segs.get(seg) ?? []
              list.push(b)
              segs.set(seg, list)
            }
            return (
              <div key={vol} className="mb-2">
                <div className="px-2 py-1 text-[10px] font-medium tracking-wider text-zinc-600">
                  第 {vol} 卷
                </div>
                {[...segs.entries()]
                  .sort((a, b) => a[0] - b[0])
                  .map(([seg, list]) => {
                    const key = `${vol}:${seg}`
                    const from = list[0].chapterNo
                    const to = list[list.length - 1].chapterNo
                    const collapsed = collapsedSegs.has(key)
                    const hasSelected = list.some((b) => b.id === selectedId)
                    return (
                      <div key={key}>
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedSegs((prev) => {
                              const next = new Set(prev)
                              if (next.has(key)) next.delete(key)
                              else next.add(key)
                              return next
                            })
                          }
                          className="flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1 text-left text-[10px] text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300"
                        >
                          <span className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}>
                            ▸
                          </span>
                          第 {from}-{to} 章
                          <span className="ml-auto font-normal text-zinc-700">{list.length}</span>
                        </button>
                        {(!collapsed || hasSelected) &&
                          list.map((b) => (
                            <button
                              type="button"
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
                    )
                  })}
              </div>
            )
          })}
        </div>
      </Card>

      <Card className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4">
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
                <Button variant="ghost" onClick={saveDraft} disabled={!dirty || busyAny}>
                  保存
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    const rid = useWriteRunStore.getState().run?.requestId
                    if (rid) void window.api.llm.abort(rid)
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
                <Button
                  variant="ghost"
                  onClick={() => setBatchOpen((v) => !v)}
                  disabled={batch?.running ?? false}
                >
                  自动写作
                </Button>
                <Button onClick={finalize} disabled={busyAny || content.trim().length === 0}>
                  {busy === 'summary' ? '定稿中…' : '定稿'}
                </Button>
                <details className="relative">
                  <summary className="inline-flex cursor-pointer list-none items-center rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
                    更多 ▾
                  </summary>
                  <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
                    {(
                      [
                        ['上下文', () => previewContext(), busyAny, null],
                        [
                          '润色',
                          polish,
                          busyAny || !selected.hasDraft,
                          busy === 'polish' ? '润色中…' : null
                        ],
                        [
                          '扩写',
                          expand,
                          busyAny || !selected.hasDraft,
                          busy === 'expand' ? '扩写中…' : null
                        ],
                        [
                          '检查',
                          () => void check(),
                          busyAny || !selected.hasDraft,
                          busy === 'check' ? '检查中…' : null
                        ],
                        ['硬闸', () => void runLint(), busyAny || !content.trim(), null],
                        [
                          '评审',
                          () => void review(),
                          busyAny || !selected.hasDraft,
                          busy === 'review' ? '评审中…' : null
                        ]
                      ] as Array<[string, () => void, boolean, string | null]>
                    ).map(([label, fn, disabled, busyLabel]) => (
                      <button
                        type="button"
                        key={label}
                        disabled={disabled}
                        onClick={(e) => {
                          closeMenu(e)
                          fn()
                        }}
                        className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
                      >
                        {busyLabel ?? label}
                      </button>
                    ))}
                    <div className="my-1 h-px bg-zinc-800" />
                    {(['txt', 'md', 'docx'] as const).map((f) => (
                      <button
                        type="button"
                        key={f}
                        disabled={busyAny}
                        onClick={(e) => {
                          closeMenu(e)
                          exportChapter(f)
                        }}
                        className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
                      >
                        导出 {f}
                      </button>
                    ))}
                  </div>
                </details>
              </div>
            </div>

            {batchOpen && (
              <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900 p-3">
                <div className="grid grid-cols-2 items-end gap-3 md:grid-cols-12">
                  <div className="col-span-1 md:col-span-4">
                    <Label>起章</Label>
                    <Select
                      value={batchFrom}
                      onChange={(e) => setBatchFrom(e.target.value)}
                      className="w-full"
                    >
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
                    <Select
                      value={batchTo}
                      onChange={(e) => setBatchTo(e.target.value)}
                      className="w-full"
                    >
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
                      开始自动写作
                    </Button>
                  </div>
                </div>
                <div className="mt-2 text-xs text-zinc-600">
                  全自动逐章：生成初稿 → 硬闸未过自动返修 → 自动摘要 → 大纲标记已写；全部完成后 AI
                  会对照已写剧情自动修订后续大纲。逐章暂停（高级）时每章完成后停下待审。
                </div>
              </div>
            )}

            {batch && <BatchProgressCard batch={batch} onStop={stopBatch} onResume={resumeBatch} />}

            <Textarea
              className="min-h-[45vh] shrink-0 leading-8 md:min-h-[55vh]"
              value={content}
              onChange={(e) => {
                setContent(e.target.value)
                setDirty(true)
              }}
              readOnly={busy !== null}
              placeholder={
                busy === 'chapter'
                  ? '正在生成初稿…'
                  : busy === 'polish'
                    ? '正在润色…'
                    : '点「AI 初稿」生成本章，或直接手写'
              }
            />

            {candidate && busy === null && (
              <div className="mt-2">
                <DiffView
                  oldText={content}
                  newText={candidate.text}
                  title={
                    candidate.kind === 'polish' ? '润色修订（逐块取舍）' : '扩写修订（逐块取舍）'
                  }
                  onApply={applyCandidate}
                  onDiscard={() => {
                    setCandidate(null)
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
                    type="button"
                    // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
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
                  type="button"
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
                    type="button"
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
                  // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
                  <div key={i} className="mb-1.5 border-l-2 border-zinc-700 pl-2 text-xs leading-5">
                    <span
                      className={`mr-2 rounded px-1.5 py-0.5 text-[10px] ${
                        iss.level === 'major'
                          ? 'bg-red-900/50 text-red-300'
                          : 'bg-zinc-800 text-zinc-400'
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
                  <Badge
                    tone={
                      reviewResult.verdict === 'pass'
                        ? 'green'
                        : reviewResult.verdict === 'polish'
                          ? 'amber'
                          : 'red'
                    }
                  >
                    {reviewResult.verdict === 'pass'
                      ? '通过'
                      : reviewResult.verdict === 'polish'
                        ? '建议打磨'
                        : '建议重写'}
                  </Badge>
                </div>
                {reviewResult.scores.map((s, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
                  <div key={i} className="mb-1.5 border-l-2 border-zinc-700 pl-2 text-xs leading-5">
                    <span className="mr-2 inline-flex items-center gap-1.5">
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                        {s.dim}
                      </span>
                      <span
                        className={
                          s.score >= 8
                            ? 'text-emerald-400'
                            : s.score >= 6
                              ? 'text-amber-400'
                              : 'text-red-400'
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
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
                    key={i}
                    className="mb-1.5 border-l-2 border-amber-600/60 pl-2 text-xs leading-5"
                  >
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
                      {p.name} · {p.detail} ·{' '}
                      <span className="font-mono">{fmtTokens(p.tokens)}t</span>
                    </span>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-600">
            {batch && (
              <div className="w-full max-w-md">
                <BatchProgressCard batch={batch} onStop={stopBatch} onResume={resumeBatch} />
              </div>
            )}
            <span>左侧选择一章开始写作</span>
            <span className="text-xs">
              单章：AI 初稿 → 编辑 →
              定稿（自动摘要/伏笔）；「自动写作」可连续生成多章并自动修订后续大纲
            </span>
          </div>
        )}
      </Card>
    </div>
  )
}
