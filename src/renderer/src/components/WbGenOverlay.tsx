import { useEffect, useRef, useState } from 'react'
import type { WorldbuildGenFocus, WorldbuildPreviewEntry } from '@shared/types'
import { splitHeadingHashtags } from '@shared/tags'
import { OverlayCard } from './OverlayCard'
import { Badge, Button, Input } from './ui'
import {
  commitTaskSelection,
  dismissTask,
  retryTask,
  startGen,
  useWbGenTasks,
  type WbGenTask
} from '../lib/wbGenStore'

interface GenSection {
  category: string | null
  title: string
  tags: string[]
  content: string
}

const SECTION_HEADING = /^#{1,3}\s*(?:\[([^\]]*)\]\s*)?(.+?)\s*$/

function splitSections(output: string): GenSection[] {
  const sections: GenSection[] = []
  let current: GenSection | null = null
  for (const line of output.split(/\r?\n/)) {
    const m = SECTION_HEADING.exec(line)
    if (m && (m[1] || current)) {
      if (current) sections.push(current)
      const { title, tags } = splitHeadingHashtags(m[2])
      current = { category: m[1]?.trim() || null, title, tags, content: '' }
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line
    }
  }
  if (current) sections.push(current)
  return sections
}

function isLive(t: WbGenTask): boolean {
  return t.status === 'retrieving' || t.status === 'running'
}

interface WbGenOverlayProps {
  open: boolean
  onClose: () => void
  projectId: string
  types: string[]
  focus: WorldbuildGenFocus
  onSaved: () => void
}

export function WbGenOverlay({ open, onClose, projectId, types, focus, onSaved }: WbGenOverlayProps) {
  const tasks = useWbGenTasks(projectId)
  const task = tasks.length > 0 ? tasks[tasks.length - 1] : null

  const [mode, setMode] = useState<'form' | 'task'>('form')
  const [brief, setBrief] = useState('')
  const [countInput, setCountInput] = useState('')
  const [limitTypes, setLimitTypes] = useState<string[]>([])
  const [advOpen, setAdvOpen] = useState(false)
  const [localFocus, setLocalFocus] = useState<WorldbuildGenFocus>({})
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [retrieval, setRetrieval] = useState<{
    status: 'loading' | 'none' | 'done'
    count?: number
    titles?: string[]
  } | null>(null)
  const retrieveSeq = useRef(0)

  useEffect(() => {
    if (!open) return
    setLocalFocus(focus.tag || focus.type ? { tag: focus.tag, type: focus.type } : {})
    setRetrieval(null)
    if (task && (isLive(task) || task.status === 'done' || task.status === 'error')) {
      setMode('task')
    } else {
      setMode('form')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!task) return
    setSelected(new Set(task.result.map((_, i) => i)))
  }, [task?.id, task?.status])

  const briefForRetrieve = brief.trim() || [localFocus.tag && `#${localFocus.tag}`, localFocus.type].filter(Boolean).join(' ') || ''
  useEffect(() => {
    if (!briefForRetrieve) {
      setRetrieval(null)
      return
    }
    if (!open || mode !== 'form') return
    const seq = ++retrieveSeq.current
    setRetrieval({ status: 'loading' })
    const timer = setTimeout(() => {
      void window.api.novel
        .worldbuildRetrieve({
          projectId,
          categories: limitTypes,
          title: '',
          brief: briefForRetrieve,
          focus: localFocus
        })
        .then((r) => {
          if (seq !== retrieveSeq.current) return
          setRetrieval(
            r ? { status: 'done', count: r.count, titles: r.titles } : { status: 'none' }
          )
        })
        .catch(() => {
          if (seq === retrieveSeq.current) setRetrieval({ status: 'none' })
        })
    }, 900)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, briefForRetrieve, localFocus.tag, localFocus.type, projectId])

  const submit = (): void => {
    const text = brief.trim()
    if (!text) return
    const count = Number(countInput)
    startGen({
      projectId,
      categories: limitTypes,
      title: '',
      brief: text,
      count: Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined,
      focus: localFocus.tag || localFocus.type ? localFocus : undefined
    })
    setMode('task')
  }

  const saveSelection = (): void => {
    if (!task || task.status !== 'done' || saving) return
    const picked = task.result.filter((_, i) => selected.has(i))
    if (picked.length === 0) return
    setSaving(true)
    commitTaskSelection(task.id, picked)
      .then(() => {
        setSaving(false)
        onSaved()
        onClose()
      })
      .catch(() => setSaving(false))
  }

  const toggleSelect = (i: number): void => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const allSelected = task ? task.result.length > 0 && selected.size === task.result.length : false

  const footer = mode === 'form' ? (
    <>
      <Button variant="ghost" onClick={onClose}>
        取消
      </Button>
      <Button onClick={submit} disabled={!brief.trim()}>
        生成
      </Button>
    </>
  ) : !task ? null : isLive(task) ? (
    <span className="mr-auto text-xs text-zinc-500">生成中，可关闭窗口稍后回来挑拣</span>
  ) : task.status === 'error' ? (
    <>
      <Button variant="ghost" onClick={() => setMode('form')}>
        返回修改
      </Button>
      <Button onClick={() => retryTask(task.id)}>重试</Button>
    </>
  ) : (
    <>
      <Button
        variant="danger"
        onClick={() => {
          dismissTask(task.id)
          onClose()
        }}
      >
        放弃
      </Button>
      <Button variant="ghost" onClick={() => retryTask(task.id)}>
        重新生成
      </Button>
      <Button onClick={saveSelection} disabled={selected.size === 0 || saving}>
        {saving ? '保存中…' : `保存选中 ${selected.size} 条`}
      </Button>
    </>
  )

  if (!open) return null

  return (
    <OverlayCard open={open} onClose={onClose} title="AI 生成世界观条目" widthClass="max-w-2xl" footer={footer}>
      {mode === 'form' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-zinc-500">聚焦方向</span>
            {localFocus.tag || localFocus.type ? (
              <>
                {localFocus.tag && (
                  <button
                    onClick={() => setLocalFocus((f) => ({ ...f, tag: undefined }))}
                    className="cursor-pointer rounded-full bg-amber-600 px-2.5 py-0.5 font-medium text-zinc-950"
                    title="移除标签焦点"
                  >
                    # {localFocus.tag} ×
                  </button>
                )}
                {localFocus.type && (
                  <button
                    onClick={() => setLocalFocus((f) => ({ ...f, type: undefined }))}
                    className="cursor-pointer rounded-full bg-zinc-700 px-2.5 py-0.5 font-medium text-zinc-100"
                    title="移除类型焦点"
                  >
                    {localFocus.type} ×
                  </button>
                )}
                <span className="text-zinc-600">移除后为全局生成</span>
              </>
            ) : (
              <span className="text-zinc-400">全局（未跟随页面筛选）</span>
            )}
          </div>
          <div>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={3}
              placeholder="描述想生成的设定，例：精灵一族的起源、社会结构与禁忌，需与已有王国设定咬合"
              className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-700"
            />
          </div>
          {retrieval?.status === 'done' ? (
            <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-500">
              生成时将参考 {retrieval.count} 条相关条目
              {retrieval.titles && retrieval.titles.length > 0 && `：${retrieval.titles.slice(0, 5).join('、')}`}
              {retrieval.titles && retrieval.titles.length > 5 ? ' 等' : ''}
            </div>
          ) : retrieval?.status === 'loading' ? (
            <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-600 animate-pulse">
              正在检索相关已有条目…
            </div>
          ) : retrieval?.status === 'none' ? (
            <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-600">
              未找到强相关的已有条目，将按需求独立生成
            </div>
          ) : (
            <div className="text-xs text-zinc-600">
              生成前会自动检索相关已有条目作为自洽性参考；AI 自动打标签并优先复用已有标签与类型
            </div>
          )}
          <div>
            <button
              onClick={() => setAdvOpen((v) => !v)}
              className="cursor-pointer text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            >
              {advOpen ? '▾' : '▸'} 高级选项
            </button>
            {advOpen && (
              <div className="mt-2 space-y-2.5 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-zinc-500">限定类型</span>
                  <button
                    onClick={() => setLimitTypes([])}
                    className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                      limitTypes.length === 0
                        ? 'bg-amber-600 font-medium text-zinc-950'
                        : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    不限（AI 定）
                  </button>
                  {types.map((t) => (
                    <button
                      key={t}
                      onClick={() =>
                        setLimitTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
                      }
                      className={`cursor-pointer rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                        limitTypes.includes(t)
                          ? 'bg-amber-600 font-medium text-zinc-950'
                          : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">条目数上限</span>
                  <Input
                    type="number"
                    min={1}
                    value={countInput}
                    onChange={(e) => setCountInput(e.target.value)}
                    placeholder="AI 定"
                    className="w-24"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      ) : task ? (
        isLive(task) ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge tone="amber">
                <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                {task.status === 'retrieving' ? '检索相关条目…' : 'AI 生成中…'}
              </Badge>
              <span className="truncate text-xs text-zinc-500">
                {task.focus?.tag ? `#${task.focus.tag} · ` : ''}
                {task.focus?.type ? `${task.focus.type} · ` : ''}
                {task.brief.slice(0, 40)}
              </span>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {splitSections(task.output).map((s, i) => (
                <div
                  key={i}
                  className={`rounded bg-zinc-950/60 p-2 ${
                    i === splitSections(task.output).length - 1 ? 'ring-1 ring-amber-900/40' : ''
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    {s.category && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        {s.category}
                      </span>
                    )}
                    {s.title && <span className="text-xs font-medium text-zinc-300">{s.title}</span>}
                    {s.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full border border-amber-800/60 px-1.5 py-0.5 text-[10px] text-amber-300/90"
                      >
                        # {t}
                      </span>
                    ))}
                  </div>
                  <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-zinc-400">
                    {s.content || '…'}
                  </pre>
                </div>
              ))}
              {task.output === '' && (
                <div className="rounded bg-zinc-950/60 p-2 font-mono text-[11px] text-zinc-500">
                  {task.status === 'retrieving'
                    ? '正在从已有条目中检索相关类型与标签…'
                    : '等待模型输出…'}
                </div>
              )}
            </div>
          </div>
        ) : task.status === 'error' ? (
          <div className="space-y-2">
            <Badge tone="red">生成失败</Badge>
            <div className="text-xs leading-5 text-red-300">{task.error ?? '未知错误'}</div>
          </div>
        ) : task.result.length === 0 ? (
          <div className="space-y-2">
            <div className="text-sm text-zinc-400">未解析到任何条目，可重试或调整需求</div>
          </div>
        ) : (
          <div className="space-y-2">
            {task.stopReason === 'max_tokens' && (
              <div className="rounded-md border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
                输出因长度上限被截断，最后一个条目可能不完整，建议酌情挑选或缩小需求重新生成
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">
                共 {task.result.length} 条，已选 {selected.size} 条
              </span>
              <button
                onClick={() =>
                  setSelected(allSelected ? new Set() : new Set(task.result.map((_, i) => i)))
                }
                className="cursor-pointer text-xs text-amber-400 transition-colors hover:text-amber-300"
              >
                {allSelected ? '全不选' : '全选'}
              </button>
            </div>
            <div className="max-h-[55vh] space-y-2 overflow-y-auto">
              {task.result.map((e, i) => (
                <PreviewRow
                  key={i}
                  entry={e}
                  checked={selected.has(i)}
                  onToggle={() => toggleSelect(i)}
                />
              ))}
            </div>
          </div>
        )
      ) : null}
    </OverlayCard>
  )
}

function PreviewRow({
  entry,
  checked,
  onToggle
}: {
  entry: WorldbuildPreviewEntry
  checked: boolean
  onToggle: () => void
}) {
  return (
    <div
      className={`cursor-pointer rounded-lg border p-3 transition-colors ${
        checked ? 'border-amber-800/70 bg-zinc-950/60' : 'border-zinc-800 opacity-60'
      }`}
      onClick={onToggle}
    >
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 h-4 w-4 cursor-pointer accent-amber-600"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {entry.category}
            </span>
            {entry.isNewType && <Badge tone="amber">新类型</Badge>}
            <span className="text-sm font-medium text-zinc-200">{entry.title}</span>
            {entry.tags.map((t) => (
              <span
                key={t}
                className="rounded-full border border-amber-800/60 px-1.5 py-0.5 text-[10px] text-amber-300/90"
              >
                # {t}
              </span>
            ))}
          </div>
          <pre className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-zinc-400">
            {entry.content}
          </pre>
        </div>
      </div>
    </div>
  )
}
