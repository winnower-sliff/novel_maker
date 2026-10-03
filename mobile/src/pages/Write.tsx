import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AiBar } from '@mobile/components/AiBar'
import { useBackHandler } from '@mobile/lib/backHandler'
import { Badge, Button, Empty, Spinner } from '@mobile/components/ui'
import { fmtWords } from '@mobile/lib/format'
import { appendBatchLog, patchBatch, useWriteRunStore } from '../../../src/wizard/writeRunStore'
import type { ChapterBrief } from '@shared/types'

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  approved: '已定稿',
  written: '已写',
  polished: '已返修'
}

/** 简版自动写作：逐章 初稿→硬闸自动返修→摘要→大纲标记已写；失败即停；完成后自动对齐后续大纲。
 *  进度状态在共享 writeRunStore：进入单章编辑再返回，进度与日志不丢，生成在后台闭包继续。 */
function AutoWritePanel({
  projectId,
  briefs,
  onFinish
}: {
  projectId: string
  briefs: ChapterBrief[]
  onFinish: () => void
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const state = useWriteRunStore((s) =>
    s.batch && s.batch.projectId === projectId ? s.batch : null
  )

  const push = appendBatchLog

  const stop = (): void => {
    const { batchAbortId } = useWriteRunStore.getState()
    useWriteRunStore.setState({ batchStop: true })
    if (batchAbortId) void window.api.llm.abort(batchAbortId)
    patchBatch({ running: false })
  }

  const start = (): void => {
    if (useWriteRunStore.getState().batch?.running) return
    const iFrom = briefs.findIndex((b) => b.id === from)
    const iTo = briefs.findIndex((b) => b.id === to)
    if (iFrom < 0 || iTo < 0 || iFrom > iTo) return
    const ids = briefs.slice(iFrom, iTo + 1).map((b) => b.id)
    useWriteRunStore.setState({
      batchStop: false,
      batchAbortId: null,
      batch: {
        projectId,
        running: true,
        paused: false,
        done: 0,
        total: ids.length,
        currentNo: 0,
        log: []
      }
    })
    void (async () => {
      for (let i = 0; i < ids.length; i++) {
        if (useWriteRunStore.getState().batchStop) break
        const brief = briefs.find((b) => b.id === ids[i])
        if (!brief) continue
        patchBatch({ currentNo: brief.chapterNo })
        push(`第${brief.chapterNo}章 生成中…`)
        try {
          const myRid = await window.api.pipeline.run('chapter', { outlineId: ids[i] })
          useWriteRunStore.setState({ batchAbortId: myRid })
          const gen = await new Promise<{ data?: { wordCount?: number; lint?: { pass?: boolean; issues?: Array<{ rule: string; advice: string; quote?: string }> } } }>((resolve, reject) => {
            const offs: Array<() => void> = []
            const cleanup = (): void => offs.forEach((o) => o())
            offs.push(
              window.api.llm.onDone((rid, p) => {
                if (rid !== myRid) return
                cleanup()
                resolve(p as { data?: { wordCount?: number; lint?: { pass?: boolean; issues?: Array<{ rule: string; advice: string; quote?: string }> } } })
              }),
              window.api.llm.onError((rid, m) => {
                if (rid !== myRid) return
                cleanup()
                reject(new Error(m))
              })
            )
          })
          const d = gen.data
          patchBatch({ done: (useWriteRunStore.getState().batch?.done ?? 0) + 1 })
          push(`第${brief.chapterNo}章 初稿 ${d?.wordCount ?? 0} 字`)
          if (d?.lint && d.lint.pass === false && d.lint.issues) {
            const focus = d.lint.issues
              .map((it) => `- ${it.rule}：${it.advice}`)
              .join('\n')
            push(`第${brief.chapterNo}章 硬闸未过，自动返修…`)
            await window.api.pipeline.run('polish', { outlineId: ids[i], focus, save: true })
            push(`第${brief.chapterNo}章 返修完成`)
          }
          await window.api.pipeline
            .run('summary', { outlineId: ids[i], finalize: false })
            .then(() => push(`第${brief.chapterNo}章 摘要完成`))
            .catch((err: Error) => push(`第${brief.chapterNo}章 摘要失败：${err.message}`))
          await window.api.novel
            .outlineSave({
              id: ids[i],
              projectId,
              volume: brief.volume,
              chapterNo: brief.chapterNo,
              title: brief.title,
              synopsis: brief.synopsis,
              status: d?.lint && d.lint.pass === false ? 'polished' : 'written'
            })
            .catch(() => {})
          onFinish()
        } catch (err) {
          push(`第${brief.chapterNo}章 失败：${(err as Error).message}，已停止`)
          patchBatch({ running: false })
          return
        }
      }
      if (!useWriteRunStore.getState().batchStop) {
        push('自动对齐后续大纲…')
        try {
          const alignId = await window.api.pipeline.run('outlineAlign', { projectId })
          await new Promise<void>((resolve) => {
            const off = window.api.llm.onDone((rid) => {
              if (rid === alignId) {
                off()
                resolve()
              }
            })
          })
          push('对齐完成')
        } catch {
          push('对齐失败（可在大纲页重试）')
        }
      }
      patchBatch({ running: false })
      onFinish()
    })()
  }

  const options = briefs.map((b) => (
    <option key={b.id} value={b.id}>
      第{b.chapterNo}章 {b.title || '未命名'}
    </option>
  ))

  return (
    <div className="mx-3 mb-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="text-xs font-medium text-zinc-300">自动写作</div>
      {!state?.running && (
        <>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-2 text-xs text-zinc-300">
              <option value="">起章…</option>
              {options}
            </select>
            <select value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-2 text-xs text-zinc-300">
              <option value="">止章…</option>
              {options}
            </select>
          </div>
          <Button className="mt-2 w-full" disabled={!from || !to} onClick={start}>
            开始自动写作
          </Button>
          <div className="mt-1.5 text-[11px] leading-4 text-zinc-600">
            全自动逐章：初稿 → 硬闸自动返修 → 摘要 → 大纲标记已写，完成后自动修订后续大纲。
          </div>
        </>
      )}
      {state && (
        <div className="mt-2">
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            进度：{state.done}/{state.total}
            {state.running && state.currentNo > 0 ? ` · 第${state.currentNo}章进行中` : ''}
            <Button variant="danger" className="ml-auto px-2 py-1 text-[11px]" disabled={!state.running} onClick={stop}>
              停止
            </Button>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-amber-600 transition-all"
              style={{ width: `${state.total > 0 ? (state.done / state.total) * 100 : 0}%` }}
            />
          </div>
          {state.log.length > 0 && (
            <div className="mt-1.5 max-h-32 overflow-y-auto font-mono text-[10px] leading-4 text-zinc-500">
              {state.log.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 追加式日志，index 即身份
                <div key={i}>{l}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Write({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const autoOpen = useWriteRunStore((s) => s.batchOpen)
  const batchRunning = useWriteRunStore(
    (s) => !!(s.batch && s.batch.projectId === projectId && s.batch.running)
  )
  const { data: briefs = [], isLoading } = useQuery({
    queryKey: ['novel', 'chapterBriefs', projectId],
    queryFn: () => window.api.novel.chapterBriefs(projectId),
    enabled: !!projectId
  })

  useEffect(() => {
    setSelectedId(null)
    useWriteRunStore.setState({ batchOpen: false })
  }, [projectId])

  const selected = useMemo(
    () => briefs.find((b) => b.id === selectedId) ?? null,
    [briefs, selectedId]
  )

  if (!projectId) return <Empty text="请先在「书架」选择项目" />
  if (isLoading) return <Empty text="加载中…" />

  if (selected) {
    return (
      <ChapterEditor
        key={selected.id}
        projectId={projectId}
        brief={selected}
        onBack={() => {
          setSelectedId(null)
          void qc.invalidateQueries({ queryKey: ['novel', 'chapterBriefs', projectId] })
        }}
      />
    )
  }

  const volumes = [...new Set(briefs.map((b) => b.volume))].sort((a, b) => a - b)

  return (
    <div className="p-3">
      {briefs.length === 0 ? (
        <Empty text="该项目还没有大纲章节，请先在电脑端生成大纲" />
      ) : (
        <>
          <Button
            variant="ghost"
            className="mb-3 w-full"
            onClick={() => useWriteRunStore.setState((s) => ({ batchOpen: !s.batchOpen }))}
          >
            {autoOpen
              ? '收起自动写作'
              : batchRunning
                ? '自动写作进行中…（点开查看进度）'
                : '自动写作（连续生成多章）'}
          </Button>
          {autoOpen && (
            <AutoWritePanel
              projectId={projectId}
              briefs={briefs}
              onFinish={() =>
                void qc.invalidateQueries({ queryKey: ['novel', 'chapterBriefs', projectId] })
              }
            />
          )}
          {volumes.map((vol) => (
            <div key={vol} className="mb-4">
              <div className="mb-1.5 px-1 text-xs font-medium text-zinc-500">第 {vol} 卷</div>
              <div className="space-y-1.5">
                {briefs
                  .filter((b) => b.volume === vol)
                  .sort((a, b) => a.chapterNo - b.chapterNo)
                  .map((b) => (
                    <div
                      key={b.id}
                      role="button"
                      tabIndex={0}
                      className="flex cursor-pointer items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 active:bg-zinc-900"
                      onClick={() => setSelectedId(b.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setSelectedId(b.id)
                      }}
                    >
                      <span className="w-10 shrink-0 text-center text-sm text-zinc-500">
                        {b.chapterNo}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-zinc-200">
                          {b.title || '（未命名）'}
                        </div>
                        <div className="mt-0.5 text-[11px] text-zinc-600">
                          {b.wordCount > 0 ? fmtWords(b.wordCount) : '未写'}
                        </div>
                      </div>
                      {b.hasDraft ? (
                        <Badge className="bg-emerald-600/15 text-emerald-400">
                          {STATUS_LABEL[b.chapterStatus] ?? b.chapterStatus}
                        </Badge>
                      ) : (
                        <Badge>{STATUS_LABEL[b.status] ?? b.status}</Badge>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function ChapterEditor({
  projectId,
  brief,
  onBack
}: {
  projectId: string
  brief: ChapterBrief
  onBack: () => void
}) {
  const qc = useQueryClient()
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  const { data: chapter, isLoading } = useQuery({
    queryKey: ['novel', 'chapter', brief.id],
    queryFn: () => window.api.novel.chapter(brief.id)
  })

  useEffect(() => {
    if (chapter) {
      setContent(chapter.content)
      setDirty(false)
    }
  }, [chapter])

  const save = useCallback(async (): Promise<void> => {
    if (!chapter || !dirty) return
    setSaving(true)
    setError(null)
    try {
      await window.api.novel.saveChapter({
        outlineId: brief.id,
        projectId,
        content,
        status: chapter.status
      })
      setDirty(false)
      setSavedAt(Date.now())
      void qc.invalidateQueries({ queryKey: ['novel', 'chapter', brief.id] })
      void qc.invalidateQueries({ queryKey: ['novel', 'chapterBriefs', projectId] })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [brief.id, chapter, content, dirty, projectId, qc])

  const words = content.replace(/\s/g, '').length

  // 返回键与 UI 返回按钮同语义：有未保存改动先确认，避免静默丢稿
  const leave = useCallback((): void => {
    if (dirty && !window.confirm('有未保存的改动，确定离开？')) return
    onBack()
  }, [dirty, onBack])
  useBackHandler(leave)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2 py-2">
        <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={leave}>
          ← 返回
        </Button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-medium text-zinc-200">
            第{brief.chapterNo}章 {brief.title || ''}
          </div>
          <div className="text-[11px] text-zinc-600">
            {words} 字{dirty ? ' · 未保存' : savedAt ? ' · 已保存' : ''}
          </div>
        </div>
        <Button className="px-3 py-1.5 text-xs" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <Spinner className="h-3.5 w-3.5" /> : '保存'}
        </Button>
      </div>

      {isLoading ? (
        <Empty text="加载章节…" />
      ) : (
        <>
          <textarea
            ref={taRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              setDirty(true)
            }}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-zinc-950 px-4 py-3 text-[15px] leading-7 text-zinc-200 outline-none"
            placeholder="正文为空。可以直接输入，选中文字用 AI 改写，或将光标放在文末用 AI 续写。"
          />
          {error && (
            <div className="border-t border-red-900/50 bg-red-950/40 px-3 py-1.5 text-xs text-red-300">
              {error}
            </div>
          )}
          <AiBar value={content} onChange={(v) => { setContent(v); setDirty(true) }} textareaRef={taRef} />
        </>
      )}
    </div>
  )
}
