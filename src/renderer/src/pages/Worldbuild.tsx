import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import type { Character, WorldbuildEntry } from '@shared/types'
import { splitHeadingHashtags, splitTags } from '@shared/tags'
import { AiTextarea } from '../components/AiTextarea'
import { Markdown } from '../components/Markdown'
import { OverlayCard } from '../components/OverlayCard'
import { RelationGraph, type GraphEdgeData, type GraphNodeData } from '../components/RelationGraph'
import { Badge, Button, Card, Input, Label, Select } from '../components/ui'
import {
  dismissTask,
  markSeen,
  retryTask,
  startGen,
  useWbGenTasks,
  type WbGenTask
} from '../lib/wbGenStore'
import { pushToast } from '../lib/toastStore'
import type { Navigate } from '../lib/nav'
import { extractLinkNames } from '../lib/wikiLink'

const GROUP_COLORS: Record<string, string> = {
  力量体系: '#f59e0b',
  地理: '#10b981',
  势力: '#ef4444',
  历史: '#8b5cf6',
  物品: '#06b6d4',
  其他: '#a1a1aa',
  人物: '#ec4899'
}

function typeColor(type: string): string {
  return GROUP_COLORS[type] ?? '#a1a1aa'
}

interface EditState {
  id?: string
  category: string
  title: string
  tags: string
  content: string
}

const EMPTY: EditState = { category: '', title: '', tags: '', content: '' }

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
  if (sections.length === 0 && output.trim()) {
    sections.push({ category: null, title: '', tags: [], content: output })
  }
  return sections
}

const GenCard = memo(function GenCard({ task }: { task: WbGenTask }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [task.output])

  if (task.status === 'error') {
    return (
      <Card className="border-red-800/60 p-4 ring-1 ring-red-900/50">
        <div className="flex items-center gap-2">
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {task.categories.length ? task.categories.join('、') : 'AI 定类型'}
          </span>
          <span className="truncate text-sm font-medium text-zinc-200">
            {task.title || task.brief.slice(0, 20)}
          </span>
          <span className="ml-auto shrink-0">
            <Badge tone="red">生成失败</Badge>
          </span>
        </div>
        <div className="mt-2 text-xs leading-5 text-red-300">{task.error ?? '未知错误'}</div>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => retryTask(task.id)}>
            重试
          </Button>
          <Button variant="danger" className="px-2 py-0.5 text-xs" onClick={() => dismissTask(task.id)}>
            关闭
          </Button>
        </div>
      </Card>
    )
  }

  const sections = splitSections(task.output)
  const multi = sections.length > 1 || sections[0]?.category !== null
  const statusText =
    task.status === 'retrieving'
      ? '检索相关条目…'
      : multi
        ? `已生成 ${sections.length} 个条目…`
        : 'AI 生成中…'

  return (
    <Card className="border-amber-900/40 p-4">
      <div className="flex items-center gap-2">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
          {task.categories.length ? task.categories.join('、') : 'AI 定类型'}
        </span>
        <span className="truncate text-sm font-medium text-zinc-200">
          {task.title || task.brief.slice(0, 20)}
        </span>
        <span className="ml-auto shrink-0">
          <Badge tone="amber">
            <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            {statusText}
          </Badge>
        </span>
      </div>
      <div ref={scrollRef} className="mt-2 max-h-64 space-y-2 overflow-y-auto">
        {sections.map((s, i) => (
          <div
            key={i}
            className={`rounded bg-zinc-950/60 p-2 ${
              i === sections.length - 1 ? 'ring-1 ring-amber-900/40' : ''
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
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-zinc-400">
              {s.content || '…'}
            </pre>
          </div>
        ))}
        {sections.length === 0 && (
          <div className="rounded bg-zinc-950/60 p-2 font-mono text-[11px] text-zinc-500">
            {task.status === 'retrieving'
              ? '正在从已有条目中检索相关类型与标签…'
              : '等待模型输出…'}
          </div>
        )}
      </div>
    </Card>
  )
})

interface EntryCardProps {
  entry: WorldbuildEntry
  highlighted: boolean
  onOpen: (entry: WorldbuildEntry) => void
  onTagClick: (tag: string) => void
  resolveLink: (name: string) => { category?: string; preview: string } | null
  onOpenLink: (name: string) => void
}

const EntryCard = memo(function EntryCard({
  entry,
  highlighted,
  onOpen,
  onTagClick,
  resolveLink,
  onOpenLink
}: EntryCardProps) {
  const tags = splitTags(entry.tags)
  return (
    <div
      id={`wb-${entry.id}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(entry)}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter') onOpen(entry)
      }}
      className={`cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 outline-none transition-[border-color,box-shadow] hover:border-zinc-600 focus-visible:border-amber-600 ${
        highlighted ? 'ring-2 ring-amber-500' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: `${typeColor(entry.category)}22`, color: typeColor(entry.category) }}
        >
          {entry.category}
        </span>
        <span className="truncate text-sm font-medium text-zinc-200">{entry.title}</span>
        {tags.map((t) => (
          <button
            key={t}
            onClick={(e) => {
              e.stopPropagation()
              onTagClick(t)
            }}
            className="cursor-pointer rounded-full border border-amber-800/60 px-1.5 py-0.5 text-[10px] text-amber-300/90 transition-colors hover:border-amber-600 hover:text-amber-200"
            title={`筛选标签：${t}`}
          >
            # {t}
          </button>
        ))}
      </div>
      <div className="mt-2 max-h-[7.5rem] overflow-hidden text-xs leading-5 text-zinc-400">
        <Markdown
          text={entry.content}
          wiki={{ resolve: resolveLink, onOpen: onOpenLink }}
        />
      </div>
    </div>
  )
})

export default function Worldbuild({ projectId, onNavigate }: { projectId: string; onNavigate: Navigate }) {
  const [entries, setEntries] = useState<WorldbuildEntry[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [types, setTypes] = useState<string[]>([])
  const [filter, setFilter] = useState('全部')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'graph'>('list')
  const [graphScope, setGraphScope] = useState<'wb' | 'all'>('wb')
  const [clusterTags, setClusterTags] = useState(false)
  const autoClusterRef = useRef(false)
  const [typeAdding, setTypeAdding] = useState(false)
  const [typeDraft, setTypeDraft] = useState('')
  const [charPreview, setCharPreview] = useState<Character | null>(null)
  const [edit, setEdit] = useState<EditState>(EMPTY)
  const [editOpen, setEditOpen] = useState(false)
  const [genOpen, setGenOpen] = useState(false)
  const [genBrief, setGenBrief] = useState('')
  const [genCategories, setGenCategories] = useState<string[]>([])
  const [genTitle, setGenTitle] = useState('')
  const [genCount, setGenCount] = useState('')
  const [highlightIds, setHighlightIds] = useState<string[]>([])
  const handledRef = useRef<Set<number>>(new Set())
  const editInitialRef = useRef<EditState>(EMPTY)

  const genTasks = useWbGenTasks(projectId)

  const load = useCallback((): void => {
    if (!projectId) return
    void window.api.novel.worldbuild(projectId).then(setEntries)
    void window.api.novel.characters(projectId).then(setCharacters)
    void window.api.novel.worldbuildTypes(projectId).then(setTypes)
  }, [projectId])

  useEffect(() => {
    setEntries([])
    setCharacters([])
    setTypes([])
    setFilter('全部')
    setTagFilter(null)
    autoClusterRef.current = false
    setClusterTags(false)
    setEdit(EMPTY)
    setEditOpen(false)
    load()
  }, [load])

  useEffect(() => {
    if (genTasks.length > 0) markSeen()
    if (!projectId) return
    const fresh = genTasks.filter(
      (t) => t.status === 'done' && t.entryIds.length > 0 && !handledRef.current.has(t.id)
    )
    if (fresh.length === 0) return
    fresh.forEach((t) => handledRef.current.add(t.id))
    void window.api.novel.worldbuild(projectId).then((list) => {
      setEntries(list)
      void window.api.novel.worldbuildTypes(projectId).then(setTypes)
      const ids = fresh
        .flatMap((t) => t.entryIds)
        .filter((id) => list.some((e) => e.id === id))
      if (ids.length === 0) return
      setFilter((f) =>
        f === '全部' || list.some((e) => ids.includes(e.id) && e.category === f) ? f : '全部'
      )
      setHighlightIds(ids)
      setTimeout(() => {
        ids.forEach((id) =>
          document.getElementById(`wb-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        )
      }, 60)
      setTimeout(() => setHighlightIds((cur) => cur.filter((x) => !ids.includes(x))), 4000)
    })
  }, [genTasks, projectId])

  useEffect(() => {
    if (!entries.length || autoClusterRef.current) return
    if (entries.some((e) => splitTags(e.tags).length > 0)) {
      autoClusterRef.current = true
      setClusterTags(true)
    }
  }, [entries])

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entries) {
      for (const t of splitTags(e.tags)) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [entries])

  const titleIndex = useMemo(() => {
    const map = new Map<
      string,
      { type: 'entry'; entry: WorldbuildEntry } | { type: 'char'; char: Character }
    >()
    for (const e of entries) if (!map.has(e.title)) map.set(e.title, { type: 'entry', entry: e })
    for (const c of characters) if (!map.has(c.name)) map.set(c.name, { type: 'char', char: c })
    return map
  }, [entries, characters])

  const resolveLink = useCallback(
    (name: string): { category?: string; preview: string } | null => {
      const hit = titleIndex.get(name)
      if (!hit) return null
      if (hit.type === 'entry') {
        return { category: hit.entry.category, preview: hit.entry.content }
      }
      return { category: '人物', preview: hit.char.card }
    },
    [titleIndex]
  )

  const openByName = useCallback(
    (name: string): void => {
      const hit = titleIndex.get(name)
      if (!hit) return
      if (hit.type === 'entry') {
        setEdit({
          id: hit.entry.id,
          category: hit.entry.category,
          title: hit.entry.title,
          tags: hit.entry.tags,
          content: hit.entry.content
        })
        editInitialRef.current = {
          id: hit.entry.id,
          category: hit.entry.category,
          title: hit.entry.title,
          tags: hit.entry.tags,
          content: hit.entry.content
        }
        setEditOpen(true)
      } else {
        setCharPreview(hit.char)
      }
    },
    [titleIndex]
  )

  const graph = useMemo(() => {
    const nodes: GraphNodeData[] = entries.map((e) => ({
      id: e.id,
      label: e.title,
      group: e.category,
      tags: splitTags(e.tags)
    }))
    const edges: GraphEdgeData[] = []
    for (const e of entries) {
      for (const name of extractLinkNames(e.content)) {
        const hit = titleIndex.get(name)
        if (hit && hit.type === 'entry' && hit.entry.id !== e.id) {
          edges.push({ source: e.id, target: hit.entry.id })
        }
      }
    }
    if (graphScope === 'all') {
      for (const c of characters) {
        nodes.push({ id: `char:${c.id}`, label: c.name, group: '人物', tags: splitTags(c.tags) })
        for (const name of extractLinkNames(c.card)) {
          const hit = titleIndex.get(name)
          if (hit && hit.type === 'entry') {
            edges.push({ source: `char:${c.id}`, target: hit.entry.id })
          }
        }
      }
    }
    return { nodes, edges }
  }, [entries, characters, graphScope, titleIndex])

  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (filter !== '全部' && e.category !== filter) return false
        if (tagFilter !== null && !splitTags(e.tags).includes(tagFilter)) return false
        return true
      }),
    [entries, filter, tagFilter]
  )
  const visibleTasks = useMemo(
    () =>
      genTasks.filter(
        (t) => filter === '全部' || (t.categories.length > 0 && t.categories.includes(filter))
      ),
    [genTasks, filter]
  )

  const startEdit = useCallback(
    (e: WorldbuildEntry): void => {
      const next: EditState = {
        id: e.id,
        category: e.category,
        title: e.title,
        tags: e.tags,
        content: e.content
      }
      setEdit(next)
      editInitialRef.current = next
      setEditOpen(true)
    },
    []
  )

  const openNew = useCallback((): void => {
    const next: EditState = { ...EMPTY, category: types[0] ?? '' }
    setEdit(next)
    editInitialRef.current = next
    setEditOpen(true)
  }, [types])

  const closeEdit = useCallback((): void => {
    const dirty =
      editOpen &&
      (edit.title !== editInitialRef.current.title ||
        edit.content !== editInitialRef.current.content ||
        edit.category !== editInitialRef.current.category ||
        edit.tags !== editInitialRef.current.tags)
    if (dirty && !window.confirm('有未保存的修改，确定放弃并关闭？')) return
    setEditOpen(false)
    setEdit(EMPTY)
  }, [editOpen, edit.title, edit.content, edit.category, edit.tags])

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
        请先选择一个项目
        <Button onClick={() => onNavigate('projects')}>去选择项目</Button>
      </div>
    )
  }

  const save = (): void => {
    if (!edit.title.trim()) return
    const typeSet = new Set(types)
    const tags = splitTags(edit.tags).filter((t) => !typeSet.has(t) && t !== edit.category)
    const dropped = splitTags(edit.tags).length - tags.length
    if (dropped > 0) pushToast('error', `已剔除 ${dropped} 个与类型重名的标签`)
    const category = edit.category.trim()
    const doSave = (cat: string): void => {
      void window.api.novel
        .worldbuildSave({
          id: edit.id,
          projectId,
          category: cat,
          title: edit.title.trim(),
          tags: tags.join(','),
          content: edit.content
        })
        .then(() => {
          setEditOpen(false)
          setEdit(EMPTY)
          load()
        })
    }
    if (typeSet.has(category)) {
      doSave(category)
    } else {
      void window.api.novel
        .worldbuildTypeCreate(projectId, category)
        .then((list) => {
          setTypes(list)
          pushToast('success', `已新建类型「${category}」`)
          doSave(category)
        })
        .catch((err: unknown) => {
          pushToast('error', err instanceof Error ? err.message : String(err))
          doSave('其他')
        })
    }
  }

  const removeCurrent = (): void => {
    if (!edit.id) return
    if (!window.confirm(`删除「${edit.title}」？`)) return
    void window.api.novel.worldbuildDelete(edit.id).then(() => {
      setEditOpen(false)
      setEdit(EMPTY)
      load()
    })
  }

  const submitTypeDraft = (): void => {
    const name = typeDraft.trim()
    setTypeDraft('')
    setTypeAdding(false)
    if (!name) return
    void window.api.novel
      .worldbuildTypeCreate(projectId, name)
      .then((list) => {
        setTypes(list)
        pushToast('success', `已新建类型「${name}」`)
      })
      .catch((err: unknown) => {
        pushToast('error', err instanceof Error ? err.message : String(err))
      })
  }

  const removeType = (name: string): void => {
    const count = entries.filter((e) => e.category === name).length
    const tip =
      count > 0
        ? `类型「${name}」下还有 ${count} 个条目，无法删除。要先迁移这些条目吗？（删除将取消）`
        : `删除类型「${name}」？`
    if (!window.confirm(tip)) return
    if (count > 0) return
    void window.api.novel
      .worldbuildTypeDelete(projectId, name)
      .then((list) => {
        setTypes(list)
        if (filter === name) setFilter('全部')
        pushToast('success', `已删除类型「${name}」`)
      })
      .catch((err: unknown) => {
        pushToast('error', err instanceof Error ? err.message : String(err))
      })
  }

  const submitGen = (): void => {
    const brief = genBrief.trim()
    if (!brief) return
    const count = Number(genCount)
    startGen({
      projectId,
      categories: genCategories,
      title: genTitle.trim(),
      brief,
      count: Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined
    })
    setGenOpen(false)
    setGenBrief('')
    setGenTitle('')
    setGenCount('')
  }

  const toggleGenCategory = (c: string): void => {
    setGenCategories((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]))
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold text-zinc-100">世界观</h1>
        <div className="ml-4 flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setFilter('全部')}
            className={`cursor-pointer rounded-full px-3 py-1 text-xs transition-colors ${
              filter === '全部'
                ? 'bg-amber-600 font-medium text-zinc-950'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            全部
          </button>
          {types.map((c) => (
            <span key={c} className="group/type relative inline-flex">
              <button
                onClick={() => setFilter(c)}
                className={`cursor-pointer rounded-full px-3 py-1 text-xs transition-colors ${
                  filter === c
                    ? 'font-medium text-zinc-950'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
                style={filter === c ? { background: typeColor(c) } : undefined}
                title={c}
              >
                {c}
              </button>
              <button
                onClick={() => removeType(c)}
                className="absolute -right-1 -top-1 hidden h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-[9px] leading-none text-zinc-400 hover:text-red-400 group-hover/type:flex"
                title="删除该类型"
              >
                ×
              </button>
            </span>
          ))}
          {typeAdding ? (
            <input
              autoFocus
              value={typeDraft}
              onChange={(e) => setTypeDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitTypeDraft()
                if (e.key === 'Escape') {
                  setTypeDraft('')
                  setTypeAdding(false)
                }
              }}
              onBlur={submitTypeDraft}
              placeholder="新类型名，回车确认"
              className="w-28 rounded-full border border-amber-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-200 placeholder-zinc-600 outline-none"
            />
          ) : (
            <button
              onClick={() => setTypeAdding(true)}
              className="cursor-pointer rounded-full border border-dashed border-zinc-700 px-3 py-1 text-xs text-zinc-500 transition-colors hover:border-amber-700 hover:text-amber-400"
              title="新增类型"
            >
              + 类型
            </button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {view === 'graph' && (
            <>
              <div className="flex overflow-hidden rounded-md border border-zinc-700 text-xs">
                {(
                  [
                    ['wb', '仅世界观'],
                    ['all', '含人物']
                  ] as const
                ).map(([s, label]) => (
                  <button
                    key={s}
                    onClick={() => setGraphScope(s)}
                    className={`cursor-pointer px-2.5 py-1 transition-colors ${
                      graphScope === s ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setClusterTags((v) => !v)}
                className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                  clusterTags
                    ? 'border-amber-700 bg-amber-900/40 text-amber-300'
                    : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                标签聚类
              </button>
            </>
          )}
          <div className="flex overflow-hidden rounded-md border border-zinc-700 text-xs">
            {(
              [
                ['list', '列表'],
                ['graph', '图谱']
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`cursor-pointer px-2.5 py-1 transition-colors ${
                  view === v ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Button variant="ghost" onClick={() => { setGenOpen((v) => !v) }}>
            AI 生成条目
          </Button>
          <Button onClick={openNew}>
            新增条目
          </Button>
        </div>
      </div>

      {tagCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-500">标签</span>
          {tagFilter !== null && (
            <button
              onClick={() => setTagFilter(null)}
              className="cursor-pointer rounded-full bg-amber-600 px-2.5 py-0.5 text-xs font-medium text-zinc-950"
            >
              × {tagFilter}
            </button>
          )}
          {tagCounts
            .filter((t) => t.name !== tagFilter)
            .map((t) => (
              <button
                key={t.name}
                onClick={() => setTagFilter(t.name)}
                className="cursor-pointer rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-400 transition-colors hover:border-amber-700 hover:text-amber-300"
              >
                # {t.name}
                <span className="ml-1 text-[10px] text-zinc-600">{t.count}</span>
              </button>
            ))}
        </div>
      )}

      {genOpen && (
        <Card className="space-y-2.5 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-zinc-500">类型</span>
            <button
              onClick={() => setGenCategories([])}
              className={`cursor-pointer rounded-full px-3 py-1 text-xs transition-colors ${
                genCategories.length === 0
                  ? 'bg-amber-600 font-medium text-zinc-950'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              全部（AI 定）
            </button>
            {types.map((c) => (
              <button
                key={c}
                onClick={() => toggleGenCategory(c)}
                className={`cursor-pointer rounded-full px-3 py-1 text-xs transition-colors ${
                  genCategories.includes(c)
                    ? 'bg-amber-600 font-medium text-zinc-950'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {c}
              </button>
            ))}
            <span className="ml-2 text-[11px] text-zinc-600">
              可多选；「全部」= AI 按内容定类型；AI 会自动打标签并优先复用已有标签
            </span>
          </div>
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-3">
              <Label>总主题（多条目可留空）</Label>
              <Input
                value={genTitle}
                onChange={(e) => setGenTitle(e.target.value)}
                placeholder="例：西幻种族格局"
              />
            </div>
            <div className="col-span-2">
              <Label>条目数（可选）</Label>
              <Input
                type="number"
                min={1}
                value={genCount}
                onChange={(e) => setGenCount(e.target.value)}
                placeholder="AI 定"
              />
            </div>
            <div className="col-span-7">
              <Label>生成需求 *</Label>
              <Input
                value={genBrief}
                onChange={(e) => setGenBrief(e.target.value)}
                placeholder="例：西幻三大种族的格局总览与每个种族的详细设定，种族间有贸易与战争"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={submitGen} disabled={!genBrief.trim()}>
              生成并保存
            </Button>
            <span className="text-xs text-zinc-600">
              生成前会先检索相关的已有条目作为自洽性上下文（仅注入相关内容）
            </span>
          </div>
        </Card>
      )}

      <OverlayCard
        open={editOpen}
        onClose={closeEdit}
        title={edit.id ? '编辑条目' : '新增条目'}
        footer={
          <>
            {edit.id && (
              <Button variant="danger" onClick={removeCurrent}>
                删除
              </Button>
            )}
            <Button variant="ghost" onClick={closeEdit}>
              取消
            </Button>
            <Button onClick={save} disabled={!edit.title.trim()}>
              保存
            </Button>
          </>
        }
      >
        <div className="flex h-full flex-col gap-3">
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-3">
              <Label>类型（单选）</Label>
              <Select
                value={edit.category}
                onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                className="w-full"
              >
                {types.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                {edit.category && !types.includes(edit.category) && (
                  <option value={edit.category}>{edit.category}</option>
                )}
              </Select>
            </div>
            <div className="col-span-3">
              <Label>标签（逗号分隔）</Label>
              <Input
                value={edit.tags}
                onChange={(e) => setEdit({ ...edit, tags: e.target.value })}
                placeholder="精灵,森林,魔法"
              />
            </div>
            <div className="col-span-6">
              <Label>标题 *</Label>
              <Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <Label>条目内容（markdown，要点式；选中文字可用 AI 改写；[[条目名]] 可建立链接）</Label>
            <AiTextarea
              className="min-h-72 flex-1"
              value={edit.content}
              onChange={(v: string) => setEdit({ ...edit, content: v })}
              placeholder="条目内容（markdown，要点式）"
              context={
                edit.id
                  ? `这是世界观条目「${edit.title || '未命名'}」（类型：${edit.category}）的完整内容：\n${edit.content}`
                  : undefined
              }
            />
          </div>
        </div>
      </OverlayCard>

      <OverlayCard open={charPreview !== null} onClose={() => setCharPreview(null)} title={charPreview ? `人物 · ${charPreview.name}` : ''}>
        {charPreview && (
          <div className="max-h-[60vh] overflow-y-auto text-sm leading-6 text-zinc-300">
            <Markdown text={charPreview.card} wiki={{ resolve: resolveLink, onOpen: openByName }} />
          </div>
        )}
      </OverlayCard>

      {view === 'graph' ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-800">
          <RelationGraph
            nodes={graph.nodes}
            edges={graph.edges}
            groupColors={GROUP_COLORS}
            clusterTags={clusterTags}
            onNodeClick={(id) => {
              if (id.startsWith('char:')) {
                const c = characters.find((x) => x.id === id.slice(5))
                if (c) setCharPreview(c)
              } else if (id.startsWith('tag:')) {
                setTagFilter(id.slice(4) || null)
                setView('list')
              } else {
                const e = entries.find((x) => x.id === id)
                if (e) startEdit(e)
              }
            }}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(300px,1fr))] content-start gap-3 overflow-y-auto pb-2">
          {filtered.length === 0 && visibleTasks.length === 0 && (
            <Card className="col-span-full p-10 text-center text-sm text-zinc-600">
              {filter === '全部' && tagFilter === null
                ? '暂无条目，点右上角「AI 生成条目」或「新增条目」开始建设世界观'
                : tagFilter !== null
                  ? `「#${tagFilter}」标签下暂无条目`
                  : `「${filter}」类型下暂无条目`}
            </Card>
          )}
          {visibleTasks.map((t) => (
            <GenCard key={t.id} task={t} />
          ))}
          {filtered.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              highlighted={highlightIds.includes(e.id)}
              onOpen={startEdit}
              onTagClick={(t) => setTagFilter((cur) => (cur === t ? null : t))}
              resolveLink={resolveLink}
              onOpenLink={openByName}
            />
          ))}
        </div>
      )}
    </div>
  )
}
