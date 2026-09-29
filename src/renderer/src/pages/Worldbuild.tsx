import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import type { Character, WorldbuildEntry } from '@shared/types'
import { splitTags } from '@shared/tags'
import { AiTextarea } from '../components/AiTextarea'
import { EmptyGuide } from '../components/EmptyGuide'
import { Markdown } from '../components/Markdown'
import { OverlayCard } from '../components/OverlayCard'
import { PreviewPanel } from '../components/PreviewPanel'
import { RelationGraph, type GraphEdgeData, type GraphNodeData } from '../components/RelationGraph'
import { WbGenOverlay } from '../components/WbGenOverlay'
import { Button, Card, Input, Label, Select } from '../components/ui'
import {
  markEntrySeen,
  useNewEntryIds,
  useRevisedEntryIds,
  useWbLiveEntries,
  useWbSavedSeq,
  type WbLiveSection
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
  keys: string
  content: string
}

const EMPTY: EditState = { category: '', title: '', tags: '', keys: '', content: '' }

type Preview =
  | { type: 'entry'; entry: WorldbuildEntry }
  | { type: 'char'; char: Character }
  | null

interface EntryCardProps {
  entry: WorldbuildEntry
  highlighted: boolean
  isNew?: boolean
  isRevised?: boolean
  selection?: { selected: boolean; onToggle: () => void }
  onOpen: (entry: WorldbuildEntry) => void
  onTagClick: (tag: string) => void
  resolveLink: (name: string) => { category?: string; preview: string } | null
  onOpenLink: (name: string) => void
}

const EntryCard = memo(function EntryCard({
  entry,
  highlighted,
  isNew,
  isRevised,
  selection,
  onOpen,
  onTagClick,
  resolveLink,
  onOpenLink
}: EntryCardProps) {
  const tags = splitTags(entry.tags)
  const activate = (): void => {
    if (selection) selection.onToggle()
    else onOpen(entry)
  }
  return (
    <div
      id={`wb-${entry.id}`}
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter') activate()
      }}
      className={`relative cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 outline-none transition-[border-color,box-shadow] hover:border-zinc-600 focus-visible:border-amber-600 ${
        selection?.selected ? 'border-amber-600 bg-amber-950/20' : ''
      } ${highlighted ? 'ring-2 ring-amber-500' : ''}`}
    >
      {isNew && (
        <span
          className="absolute right-3 top-3 h-2 w-2 rounded-full bg-emerald-400"
          title="新生成，打开后不再提示"
        />
      )}
      {!isNew && isRevised && (
        <span
          className="absolute right-3 top-3 h-2 w-2 rounded-full bg-amber-500"
          title="AI 生成时被修订，打开后不再提示"
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5 pr-6">
        {selection && (
          <span
            className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold ${
              selection.selected
                ? 'border-amber-600 bg-amber-600 text-zinc-950'
                : 'border-zinc-600 text-transparent'
            }`}
          >
            ✓
          </span>
        )}
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

function LiveCard({ section }: { section: WbLiveSection }) {
  return (
    <div className="relative cursor-default rounded-lg border border-dashed border-amber-800/50 bg-zinc-900/50 p-4">
      <span
        className={`absolute right-3 top-3 h-2 w-2 rounded-full ${
          section.active ? 'animate-pulse bg-amber-400' : 'bg-amber-500/70'
        }`}
        title="生成中"
      />
      <div className="flex flex-wrap items-center gap-1.5 pr-6">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
          {section.category ?? '生成中'}
        </span>
        <span className="truncate text-sm font-medium text-zinc-200">
          {section.title || '…'}
        </span>
        {section.tags.map((t) => (
          <span
            key={t}
            className="rounded-full border border-amber-800/60 px-1.5 py-0.5 text-[10px] text-amber-300/90"
          >
            # {t}
          </span>
        ))}
      </div>
      <pre className="mt-2 max-h-[7.5rem] overflow-hidden whitespace-pre-wrap font-mono text-[11px] leading-4 text-zinc-400">
        {section.content || '…'}
      </pre>
    </div>
  )
}

const TAG_PREVIEW_LIMIT = 20

export default function Worldbuild({ projectId, onNavigate }: { projectId: string; onNavigate: Navigate }) {
  const [entries, setEntries] = useState<WorldbuildEntry[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [types, setTypes] = useState<string[]>([])
  const [filter, setFilter] = useState('全部')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [tagExpanded, setTagExpanded] = useState(false)
  const [view, setView] = useState<'list' | 'graph'>('list')
  const [graphScope, setGraphScope] = useState<'wb' | 'all'>('wb')
  const [clusterTags, setClusterTags] = useState(false)
  const [showTagLabels, setShowTagLabels] = useState(true)
  const [density, setDensity] = useState(1)
  const autoClusterRef = useRef(false)
  const [typeAdding, setTypeAdding] = useState(false)
  const [typeDraft, setTypeDraft] = useState('')
  const [preview, setPreview] = useState<Preview>(null)
  const [graphActiveId, setGraphActiveId] = useState<string | null>(null)
  const [centerSignal, setCenterSignal] = useState(0)
  const [edit, setEdit] = useState<EditState>(EMPTY)
  const [editOpen, setEditOpen] = useState(false)
  const [genOpen, setGenOpen] = useState(false)
  const [highlightIds, setHighlightIds] = useState<string[]>([])
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [actionOpen, setActionOpen] = useState(false)
  const actionMenuRef = useRef<HTMLDivElement>(null)
  const editInitialRef = useRef<EditState>(EMPTY)

  const liveEntries = useWbLiveEntries(projectId)
  const newEntryIdList = useNewEntryIds(projectId)
  const revisedEntryIdList = useRevisedEntryIds(projectId)
  const savedSeq = useWbSavedSeq()

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
    setTagExpanded(false)
    autoClusterRef.current = false
    setClusterTags(false)
    setShowTagLabels(true)
    setEdit(EMPTY)
    setEditOpen(false)
    setPreview(null)
    setGraphActiveId(null)
    setSelectMode(false)
    setSelectedIds(new Set())
    setActionOpen(false)
    load()
  }, [load])

  useEffect(() => {
    if (savedSeq > 0) load()
  }, [savedSeq, load])

  useEffect(() => {
    if (!actionOpen) return
    const onPointerDown = (ev: MouseEvent): void => {
      if (!actionMenuRef.current?.contains(ev.target as Node)) setActionOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [actionOpen])

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

  const collapsedTagSet = useMemo(
    () =>
      new Set(
        tagCounts
          .filter((t) => t.count >= 2)
          .slice(0, TAG_PREVIEW_LIMIT)
          .map((t) => t.name)
      ),
    [tagCounts]
  )

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

  const openPreview = useCallback((entry: WorldbuildEntry): void => {
    markEntrySeen(entry.id)
    setPreview({ type: 'entry', entry })
    setGraphActiveId(entry.id)
    setCenterSignal((v) => v + 1)
  }, [])

  const openCharPreview = useCallback(
    (char: Character): void => {
      setPreview({ type: 'char', char })
      if (graphScope === 'all') {
        setGraphActiveId(`char:${char.id}`)
        setCenterSignal((v) => v + 1)
      } else {
        setGraphActiveId(null)
      }
    },
    [graphScope]
  )

  const openByName = useCallback(
    (name: string): void => {
      const hit = titleIndex.get(name)
      if (!hit) return
      if (hit.type === 'entry') openPreview(hit.entry)
      else openCharPreview(hit.char)
    },
    [titleIndex, openPreview, openCharPreview]
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

  const grouped = useMemo(() => {
    if (filter !== '全部') return null
    const byCat = new Map<string, WorldbuildEntry[]>()
    for (const e of filtered) {
      const list = byCat.get(e.category)
      if (list) list.push(e)
      else byCat.set(e.category, [e])
    }
    const order = [...types]
    for (const c of byCat.keys()) if (!order.includes(c)) order.push(c)
    return order
      .map((category) => ({ category, items: byCat.get(category) ?? [] }))
      .filter((g) => g.items.length > 0)
  }, [filter, filtered, types])

  const startEdit = useCallback((e: WorldbuildEntry): void => {
    const next: EditState = {
      id: e.id,
      category: e.category,
      title: e.title,
      tags: e.tags,
      keys: e.keys,
      content: e.content
    }
    setEdit(next)
    editInitialRef.current = next
    setEditOpen(true)
  }, [])

  const editFromPreview = useCallback(
    (entry: WorldbuildEntry): void => {
      setPreview(null)
      startEdit(entry)
    },
    [startEdit]
  )

  const openNew = useCallback((): void => {
    const next: EditState = { ...EMPTY, category: types[0] ?? '' }
    setEdit(next)
    editInitialRef.current = next
    setEditOpen(true)
  }, [types])

  const editDirty =
    editOpen &&
    (edit.title !== editInitialRef.current.title ||
      edit.content !== editInitialRef.current.content ||
      edit.category !== editInitialRef.current.category ||
      edit.tags !== editInitialRef.current.tags ||
      edit.keys !== editInitialRef.current.keys)

  const closeEdit = useCallback((): void => {
    if (editDirty && !window.confirm('有未保存的修改，确定放弃并关闭？')) return
    setEditOpen(false)
    setEdit(EMPTY)
  }, [editDirty])

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
        请先选择一个项目
        <Button onClick={() => onNavigate('projects')}>去选择项目</Button>
      </div>
    )
  }

  const toggleSelect = (id: string): void => {
    setSelectedIds((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((e) => selectedIds.has(e.id))

  const toggleSelectAll = (): void => {
    setSelectedIds((cur) => {
      const next = new Set(cur)
      if (allFilteredSelected) filtered.forEach((e) => next.delete(e.id))
      else filtered.forEach((e) => next.add(e.id))
      return next
    })
  }

  const exitSelect = (): void => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const removeSelected = (): void => {
    if (selectedIds.size === 0) return
    if (!window.confirm(`确定删除选中的 ${selectedIds.size} 个条目？此操作不可恢复。`)) return
    const ids = [...selectedIds]
    void window.api.novel
      .worldbuildDeleteBatch(projectId, ids)
      .then((n) => {
        pushToast('success', `已删除 ${n} 个条目`)
        exitSelect()
        load()
      })
      .catch((err: unknown) => {
        pushToast('error', err instanceof Error ? err.message : String(err))
      })
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
          keys: splitTags(edit.keys).join(','),
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

  const saveOnEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    save()
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

  const entryGrid = (
    <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(240px,1fr))] content-start gap-3 overflow-y-auto pb-2">
      {filtered.length === 0 && liveEntries.length === 0 && (
        filter === '全部' && tagFilter === null && entries.length === 0 ? (
          <div className="col-span-full">
            <EmptyGuide
              projectId={projectId}
              wizardStep={1}
              title="还没有世界观条目"
              desc="力量体系、势力、地理等基础设定是大纲与写作的上文依据，建议最先建设。向导会按题材起草方向并批量生成条目。"
            >
              <Button variant="ghost" onClick={() => setGenOpen(true)}>
                AI 生成…
              </Button>
              <Button variant="ghost" onClick={() => setEdit(EMPTY)}>
                新增条目
              </Button>
            </EmptyGuide>
          </div>
        ) : (
          <Card className="col-span-full p-10 text-center text-sm text-zinc-600">
            {tagFilter !== null
              ? `「#${tagFilter}」标签下暂无条目`
              : `「${filter}」类型下暂无条目`}
          </Card>
        )
      )}
      {liveEntries.map((s, i) => (
        <LiveCard key={`live-${s.taskId}-${i}`} section={s} />
      ))}
      {grouped
        ? grouped.map((g) => (
            <Fragment key={g.category}>
              <div className="col-span-full mt-1 flex items-center gap-2 first:mt-0">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: typeColor(g.category) }}
                />
                <span className="text-xs font-medium" style={{ color: typeColor(g.category) }}>
                  {g.category}
                </span>
                <span className="text-[10px] text-zinc-600">{g.items.length}</span>
                <span className="h-px flex-1 bg-zinc-800" />
              </div>
              {g.items.map((e) => (
                <EntryCard
                  key={e.id}
                  entry={e}
                  highlighted={highlightIds.includes(e.id)}
                  isNew={newEntryIdList.includes(e.id)}
                  isRevised={revisedEntryIdList.includes(e.id)}
                  selection={
                    selectMode
                      ? { selected: selectedIds.has(e.id), onToggle: () => toggleSelect(e.id) }
                      : undefined
                  }
                  onOpen={openPreview}
                  onTagClick={(t) => setTagFilter((cur) => (cur === t ? null : t))}
                  resolveLink={resolveLink}
                  onOpenLink={openByName}
                />
              ))}
            </Fragment>
          ))
        : filtered.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              highlighted={highlightIds.includes(e.id)}
              isNew={newEntryIdList.includes(e.id)}
              isRevised={revisedEntryIdList.includes(e.id)}
              selection={
                selectMode
                  ? { selected: selectedIds.has(e.id), onToggle: () => toggleSelect(e.id) }
                  : undefined
              }
              onOpen={openPreview}
              onTagClick={(t) => setTagFilter((cur) => (cur === t ? null : t))}
              resolveLink={resolveLink}
              onOpenLink={openByName}
            />
          ))}
    </div>
  )

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:p-4">
      <div className="flex items-center gap-2">
        <h1 className="shrink-0 text-lg font-semibold text-zinc-100">世界观</h1>
        <div className="ml-2 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-color:#3f3f46_transparent] [scrollbar-width:thin]">
          <button
            onClick={() => setFilter('全部')}
            className={`shrink-0 cursor-pointer rounded-full px-3 py-1 text-xs transition-colors ${
              filter === '全部'
                ? 'bg-amber-600 font-medium text-zinc-950'
                : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            全部
          </button>
          {types.map((c) => (
            <span key={c} className="group/type relative inline-flex shrink-0">
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
                className="absolute -right-1 -top-1 hidden h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-zinc-600 bg-zinc-900 text-[9px] leading-none text-zinc-400 hover:text-red-400 group-hover/type:flex max-md:flex max-md:h-6 max-md:w-6 max-md:text-[11px]"
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
              className="w-28 shrink-0 rounded-full border border-amber-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-200 placeholder-zinc-600 outline-none"
            />
          ) : (
            <button
              onClick={() => setTypeAdding(true)}
              className="shrink-0 cursor-pointer rounded-full border border-dashed border-zinc-700 px-3 py-1 text-xs text-zinc-500 transition-colors hover:border-amber-700 hover:text-amber-400"
              title="新增类型"
            >
              + 类型
            </button>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
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
              {clusterTags && (
                <button
                  onClick={() => setShowTagLabels((v) => !v)}
                  className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                    showTagLabels
                      ? 'border-amber-700 bg-amber-900/40 text-amber-300'
                      : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                  }`}
                  title="显示/隐藏跟随簇的 #tag 分区标签"
                >
                  分区标签
                </button>
              )}
              <label
                className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400"
                title="调节节点间距疏密，实时重排"
              >
                疏密
                <input
                  type="range"
                  min={0.4}
                  max={1.6}
                  step={0.1}
                  value={density}
                  onChange={(e) => setDensity(+e.target.value)}
                  className="w-24 accent-amber-600"
                />
              </label>
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
          {view === 'list' &&
            (selectMode ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleSelectAll}
                  className="cursor-pointer rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  {allFilteredSelected ? '取消全选' : '全选当前筛选'}
                </button>
                <span className="text-xs text-zinc-500">已选 {selectedIds.size}</span>
                <Button variant="danger" onClick={removeSelected} disabled={selectedIds.size === 0}>
                  删除选中 {selectedIds.size}
                </Button>
                <Button variant="ghost" onClick={exitSelect}>
                  退出
                </Button>
              </div>
            ) : (
              <div className="relative" ref={actionMenuRef}>
                <Button onClick={() => setActionOpen((v) => !v)}>
                  条目
                  <span className={`ml-1 text-[10px] transition-transform ${actionOpen ? 'rotate-180' : ''}`}>▾</span>
                </Button>
                {actionOpen && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl shadow-black/40">
                    <button
                      onClick={() => {
                        setActionOpen(false)
                        setGenOpen(true)
                      }}
                      className="block w-full cursor-pointer px-3 py-1.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                    >
                      AI 生成…
                    </button>
                    <button
                      onClick={() => {
                        setActionOpen(false)
                        setSelectMode(true)
                        setSelectedIds(new Set())
                      }}
                      disabled={entries.length === 0}
                      className="block w-full cursor-pointer px-3 py-1.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
                    >
                      批量删除…
                    </button>
                    <div className="my-1 border-t border-zinc-800" />
                    <button
                      onClick={() => {
                        setActionOpen(false)
                        openNew()
                      }}
                      className="block w-full cursor-pointer px-3 py-1.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
                    >
                      手动新增
                    </button>
                  </div>
                )}
              </div>
            ))}
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
            .filter(
              (t) =>
                t.name !== tagFilter && (tagExpanded || collapsedTagSet.has(t.name))
            )
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
          {!tagExpanded && tagCounts.length > collapsedTagSet.size && (
            <button
              onClick={() => setTagExpanded(true)}
              className="cursor-pointer rounded-full border border-dashed border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-500 transition-colors hover:border-amber-700 hover:text-amber-400"
              title="展开全部标签（含仅单条目使用的）"
            >
              +{tagCounts.length - collapsedTagSet.size} 更多
            </button>
          )}
          {tagExpanded && (
            <button
              onClick={() => setTagExpanded(false)}
              className="cursor-pointer rounded-full border border-dashed border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-500 transition-colors hover:border-amber-700 hover:text-amber-400"
            >
              收起
            </button>
          )}
        </div>
      )}

      {genOpen && (
        <WbGenOverlay
          open={genOpen}
          onClose={() => setGenOpen(false)}
          projectId={projectId}
          types={types}
          initialTypes={filter !== '全部' ? [filter] : []}
          initialTags={tagFilter ? [tagFilter] : []}
          tagOptions={tagCounts}
        />
      )}

      <OverlayCard
        open={editOpen}
        onClose={closeEdit}
        title={edit.id ? '编辑条目' : '新增条目'}
        footer={
          <>
            {editDirty && (
              <span className="mr-auto text-xs text-amber-400">● 未保存（回车即存）</span>
            )}
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-12">
            <div className="col-span-1 sm:col-span-3">
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
            <div className="col-span-1 sm:col-span-3">
              <Label>标签（逗号分隔）</Label>
              <Input
                value={edit.tags}
                onChange={(e) => setEdit({ ...edit, tags: e.target.value })}
                onKeyDown={saveOnEnter}
                placeholder="精灵,森林,魔法"
              />
            </div>
            <div className="col-span-2 sm:col-span-6">
              <Label>检索别名（逗号分隔，同一概念的其他叫法，写作时按名命中）</Label>
              <Input
                value={edit.keys}
                onChange={(e) => setEdit({ ...edit, keys: e.target.value })}
                onKeyDown={saveOnEnter}
                placeholder="青云宗,青云,青宗"
              />
            </div>
            <div className="col-span-2 sm:col-span-6">
              <Label>标题 *</Label>
              <Input
                value={edit.title}
                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                onKeyDown={saveOnEnter}
              />
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

      {view === 'graph' || preview !== null ? (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {view === 'graph' ? (
              <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-800">
                <RelationGraph
                  nodes={graph.nodes}
                  edges={graph.edges}
                  groupColors={GROUP_COLORS}
                  clusterTags={clusterTags}
                  showTagLabels={showTagLabels}
                  density={density}
                  activeId={graphActiveId}
                  centerSignal={centerSignal}
                  onActiveIdChange={(id) => {
                    setGraphActiveId(id)
                    if (id === null) setPreview(null)
                  }}
                  onNodeClick={(id) => {
                    if (id.startsWith('char:')) {
                      const c = characters.find((x) => x.id === id.slice(5))
                      if (c) openCharPreview(c)
                    } else if (id.startsWith('tag:')) {
                      setTagFilter(id.slice(4) || null)
                      setView('list')
                    } else {
                      const e = entries.find((x) => x.id === id)
                      if (e) openPreview(e)
                    }
                  }}
                />
              </div>
            ) : (
              entryGrid
            )}
          </div>
          {preview?.type === 'entry' && (
            <PreviewPanel
              title={preview.entry.title}
              badge={{ label: preview.entry.category, color: typeColor(preview.entry.category) }}
              tags={preview.entry.tags}
              text={preview.entry.content}
              wiki={{ resolve: resolveLink, onOpen: openByName }}
              onClose={() => setPreview(null)}
              footer={
                <>
                  <Button
                    variant="ghost"
                    onClick={() => onNavigate('graph', undefined, `wb:${preview.entry.id}`)}
                  >
                    去图谱
                  </Button>
                  <Button onClick={() => editFromPreview(preview.entry)}>编辑</Button>
                </>
              }
            />
          )}
          {preview?.type === 'char' && (
            <PreviewPanel
              title={preview.char.name}
              badge={{ label: '人物', color: typeColor('人物') }}
              tags={preview.char.tags}
              text={preview.char.card}
              wiki={{ resolve: resolveLink, onOpen: openByName }}
              onClose={() => setPreview(null)}
              footer={
                <Button
                  variant="ghost"
                  onClick={() => onNavigate('graph', undefined, `char:${preview.char.id}`)}
                >
                  去图谱
                </Button>
              }
            />
          )}
        </div>
      ) : (
        entryGrid
      )}
    </div>
  )
}
