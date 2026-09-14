import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Character, GraphNodeKind, ProjectGraph, WorldbuildEntry } from '@shared/types'
import { PreviewPanel } from '../components/PreviewPanel'
import { RelationGraph, type GraphEdgeData, type GraphNodeData } from '../components/RelationGraph'
import { Button } from '../components/ui'
import type { Navigate } from '../lib/nav'

const KIND_LABELS: Record<GraphNodeKind, string> = {
  character: '人物',
  worldbuild: '世界观',
  outline: '大纲',
  foreshadow: '伏笔'
}

const KIND_COLORS: Record<GraphNodeKind, string> = {
  character: '#f59e0b',
  worldbuild: '#60a5fa',
  outline: '#34d399',
  foreshadow: '#c084fc'
}

const WB_TYPE_COLORS: Record<string, string> = {
  力量体系: '#f59e0b',
  地理: '#10b981',
  势力: '#ef4444',
  历史: '#8b5cf6',
  物品: '#06b6d4',
  其他: '#a1a1aa',
  人物: '#ec4899'
}

const ALL_KINDS: GraphNodeKind[] = ['character', 'worldbuild', 'outline', 'foreshadow']

interface FocusState {
  id: string
  depth: number
}

type Preview =
  | { type: 'wb'; entry: WorldbuildEntry }
  | { type: 'char'; char: Character }
  | null

export default function GraphPage({
  projectId,
  onNavigate,
  focusNodeId,
  onFocusConsumed
}: {
  projectId: string
  onNavigate: Navigate
  focusNodeId?: string | null
  onFocusConsumed?: () => void
}) {
  const [graph, setGraph] = useState<ProjectGraph | null>(null)
  const [entries, setEntries] = useState<WorldbuildEntry[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [preview, setPreview] = useState<Preview>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [centerSignal, setCenterSignal] = useState(0)
  const [kinds, setKinds] = useState<Set<GraphNodeKind>>(new Set(ALL_KINDS))
  const [query, setQuery] = useState('')
  const [hideIsolated, setHideIsolated] = useState(false)
  const [focus, setFocus] = useState<FocusState | null>(null)
  const [relayoutKey, setRelayoutKey] = useState(0)
  const [clusterTags, setClusterTags] = useState(false)
  const [showTagLabels, setShowTagLabels] = useState(true)
  const autoClusterRef = useRef(false)

  const load = useCallback((): void => {
    if (!projectId) return
    void window.api.graph.project(projectId).then(setGraph)
    void window.api.novel.worldbuild(projectId).then(setEntries)
    void window.api.novel.characters(projectId).then(setCharacters)
  }, [projectId])

  useEffect(() => {
    setFocus(null)
    load()
    const offAgent = window.api.agent.onDone(() => load())
    const offLlm = window.api.llm.onDone(() => load())
    return () => {
      offAgent()
      offLlm()
    }
  }, [load])

  useEffect(() => {
    if (!graph || autoClusterRef.current) return
    if (graph.nodes.some((n) => (n.tags ?? []).length > 0)) {
      autoClusterRef.current = true
      setClusterTags(true)
    }
  }, [graph])

  useEffect(() => {
    if (graph && focus && !graph.nodes.some((n) => n.id === focus.id)) setFocus(null)
  }, [graph, focus])

  const view = useMemo(() => {
    if (!graph) return { nodes: [] as ProjectGraph['nodes'], edges: [] as ProjectGraph['edges'] }
    const q = query.trim()
    let ns = graph.nodes.filter((n) => kinds.has(n.kind) && (!q || n.label.includes(q)))
    let idSet = new Set(ns.map((n) => n.id))
    let es = graph.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target))
    if (hideIsolated) {
      const linked = new Set<string>()
      for (const e of es) {
        linked.add(e.source)
        linked.add(e.target)
      }
      ns = ns.filter((n) => linked.has(n.id))
      idSet = new Set(ns.map((n) => n.id))
      es = es.filter((e) => idSet.has(e.source) && idSet.has(e.target))
    }
    if (focus) {
      const adj = new Map<string, string[]>()
      for (const e of es) {
        if (!adj.has(e.source)) adj.set(e.source, [])
        if (!adj.has(e.target)) adj.set(e.target, [])
        adj.get(e.source)?.push(e.target)
        adj.get(e.target)?.push(e.source)
      }
      const seen = new Set([focus.id])
      let frontier = [focus.id]
      for (let d = 0; d < focus.depth; d++) {
        const next: string[] = []
        for (const id of frontier) {
          for (const nb of adj.get(id) ?? []) {
            if (!seen.has(nb)) {
              seen.add(nb)
              next.push(nb)
            }
          }
        }
        frontier = next
      }
      ns = ns.filter((n) => seen.has(n.id))
      es = es.filter((e) => seen.has(e.source) && seen.has(e.target))
    }
    return { nodes: ns, edges: es }
  }, [graph, kinds, query, hideIsolated, focus])

  const rgNodes: GraphNodeData[] = useMemo(
    () =>
      view.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        group: n.kind,
        degree: n.degree,
        tags: n.tags
      })),
    [view]
  )
  const rgEdges: GraphEdgeData[] = useMemo(() => view.edges, [view])

  const nodeById = useMemo(() => {
    const map = new Map<string, ProjectGraph['nodes'][number]>()
    for (const n of graph?.nodes ?? []) map.set(n.id, n)
    return map
  }, [graph])

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

  const syncGraphHighlight = useCallback(
    (nodeId: string): void => {
      const node = graph?.nodes.find((n) => n.id === nodeId)
      if (!node) return
      if (!view.nodes.some((n) => n.id === nodeId)) {
        setKinds((prev) => {
          if (prev.has(node.kind)) return prev
          const next = new Set(prev)
          next.add(node.kind)
          return next
        })
        setQuery((q) => (q ? '' : q))
        setHideIsolated(false)
        setFocus(null)
      }
      setActiveId(nodeId)
      setCenterSignal((v) => v + 1)
    },
    [graph, view]
  )

  const openByName = useCallback(
    (name: string): void => {
      const hit = titleIndex.get(name)
      if (!hit) return
      if (hit.type === 'entry') {
        setPreview({ type: 'wb', entry: hit.entry })
        syncGraphHighlight(`wb:${hit.entry.id}`)
      } else {
        setPreview({ type: 'char', char: hit.char })
        syncGraphHighlight(`char:${hit.char.id}`)
      }
    },
    [titleIndex, syncGraphHighlight]
  )

  const handleNodeClick = useCallback(
    (id: string): void => {
      const n = nodeById.get(id)
      if (!n) return
      if (n.kind === 'character') {
        const c = characters.find((x) => x.id === n.rawId)
        if (c) setPreview({ type: 'char', char: c })
        else onNavigate('characters')
      } else if (n.kind === 'worldbuild') {
        const e = entries.find((x) => x.id === n.rawId)
        if (e) setPreview({ type: 'wb', entry: e })
        else onNavigate('worldbuild')
      } else if (n.kind === 'outline') onNavigate('writing', n.rawId)
      else onNavigate('foreshadows')
    },
    [nodeById, characters, entries, onNavigate]
  )

  const handleActiveIdChange = useCallback((id: string | null): void => {
    setActiveId(id)
    if (id === null) setPreview(null)
  }, [])

  useEffect(() => {
    if (!focusNodeId || !graph) return
    const node = graph.nodes.find((n) => n.id === focusNodeId)
    if (!node) {
      onFocusConsumed?.()
      return
    }
    if (node.kind === 'worldbuild') {
      const e = entries.find((x) => x.id === node.rawId)
      if (!e) return
      setPreview({ type: 'wb', entry: e })
    } else if (node.kind === 'character') {
      const c = characters.find((x) => x.id === node.rawId)
      if (!c) return
      setPreview({ type: 'char', char: c })
    }
    setKinds((prev) => {
      if (prev.has(node.kind)) return prev
      const next = new Set(prev)
      next.add(node.kind)
      return next
    })
    setQuery((q) => (q ? '' : q))
    setHideIsolated(false)
    setActiveId(node.id)
    setCenterSignal((v) => v + 1)
    onFocusConsumed?.()
  }, [focusNodeId, graph, entries, characters, onFocusConsumed])

  const handleNodeDoubleClick = useCallback((id: string): void => {
    setFocus((cur) => (cur?.id === id ? null : { id, depth: 1 }))
  }, [])

  const toggleKind = (k: GraphNodeKind): void => {
    setKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const focusNode = focus ? nodeById.get(focus.id) : null
  const isolatedCount = useMemo(
    () => (graph ? graph.nodes.filter((n) => n.degree === 0).length : 0),
    [graph]
  )

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        请先在左上角选择或新建项目
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {ALL_KINDS.map((k) => (
          <button
            key={k}
            onClick={() => toggleKind(k)}
            className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
              kinds.has(k)
                ? 'border-zinc-600 bg-zinc-800 text-zinc-200'
                : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: KIND_COLORS[k] }} />
            {KIND_LABELS[k]}
          </button>
        ))}
        <div className="ml-2 flex items-center gap-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索节点…"
            className="w-40 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 outline-none focus:border-amber-600"
          />
        </div>
        <button
          onClick={() => setHideIsolated((v) => !v)}
          className={`cursor-pointer rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
            hideIsolated
              ? 'border-amber-700 bg-amber-900/40 text-amber-300'
              : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          隐藏孤点
        </button>
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
        <Button variant="ghost" onClick={() => setRelayoutKey((v) => v + 1)}>
          重新布局
        </Button>
        {focus && focusNode && (
          <div className="flex items-center gap-1.5 rounded-md border border-amber-800/60 bg-amber-950/30 px-2 py-1">
            <span className="text-xs text-amber-300">
              局部：{focusNode.label.slice(0, 12)}
              {focusNode.label.length > 12 ? '…' : ''}
            </span>
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                onClick={() => setFocus({ id: focus.id, depth: d })}
                className={`cursor-pointer rounded px-1.5 py-0.5 text-xs ${
                  focus.depth === d ? 'bg-amber-700 text-zinc-950' : 'text-amber-400/80 hover:text-amber-300'
                }`}
              >
                {d}度
              </button>
            ))}
            <button
              onClick={() => setFocus(null)}
              className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:text-zinc-200"
            >
              退出
            </button>
          </div>
        )}
        <div className="ml-auto text-xs text-zinc-500">
          {view.nodes.length} 节点 · {view.edges.length} 关联
          {isolatedCount > 0 && !hideIsolated && ` · ${isolatedCount} 孤点`}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
          <RelationGraph
            key={relayoutKey}
            nodes={rgNodes}
            edges={rgEdges}
            groupColors={KIND_COLORS}
            clusterTags={clusterTags}
            showTagLabels={showTagLabels}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            activeId={activeId}
            onActiveIdChange={handleActiveIdChange}
            centerSignal={centerSignal}
          />
        </div>
        {preview?.type === 'wb' && (
          <PreviewPanel
            title={preview.entry.title}
            badge={{
              label: preview.entry.category,
              color: WB_TYPE_COLORS[preview.entry.category] ?? '#a1a1aa'
            }}
            tags={preview.entry.tags}
            text={preview.entry.content}
            wiki={{ resolve: resolveLink, onOpen: openByName }}
            onClose={() => setPreview(null)}
          />
        )}
        {preview?.type === 'char' && (
          <PreviewPanel
            title={preview.char.name}
            badge={{ label: '人物', color: KIND_COLORS.character }}
            tags={preview.char.tags}
            text={preview.char.card}
            wiki={{ resolve: resolveLink, onOpen: openByName }}
            onClose={() => setPreview(null)}
          />
        )}
      </div>

      <div className="text-[11px] text-zinc-600">
        单击节点高亮关联并右侧预览（再次单击或点空白取消）· 大纲/伏笔节点跳转对应板块 ·
        双击节点进入局部图谱 · 拖动节点看关联晃动 · 圆越大 = 被引用越多（核心条目/MOC）·
        「标签聚类」开启时高频标签（≥3 条目）的条目/人物自动聚拢并按主标签着色、灰点不属任何高频标签簇 ·
        连线来自各板块文本与章节正文中的 [[链接]]
      </div>
    </div>
  )
}
