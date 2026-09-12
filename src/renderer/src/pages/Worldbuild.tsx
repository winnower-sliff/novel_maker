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
import { splitTags } from '@shared/tags'
import { AiTextarea } from '../components/AiTextarea'
import { Markdown } from '../components/Markdown'
import { OverlayCard } from '../components/OverlayCard'
import { RelationGraph, type GraphEdgeData, type GraphNodeData } from '../components/RelationGraph'
import { WbGenOverlay } from '../components/WbGenOverlay'
import { Button, Card, Input, Label, Select } from '../components/ui'
import { markSeen, useWbGenTasks } from '../lib/wbGenStore'
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
  const [highlightIds, setHighlightIds] = useState<string[]>([])
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
  }, [genTasks])

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
            AI 生成
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
        <WbGenOverlay
          open={genOpen}
          onClose={() => setGenOpen(false)}
          projectId={projectId}
          types={types}
          focus={{ tag: tagFilter ?? undefined, type: filter !== '全部' ? filter : undefined }}
          onSaved={load}
        />
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
          {filtered.length === 0 && (
            <Card className="col-span-full p-10 text-center text-sm text-zinc-600">
              {filter === '全部' && tagFilter === null
                ? '暂无条目，点右上角「AI 生成」或「新增条目」开始建设世界观'
                : tagFilter !== null
                  ? `「#${tagFilter}」标签下暂无条目`
                  : `「${filter}」类型下暂无条目`}
            </Card>
          )}
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
