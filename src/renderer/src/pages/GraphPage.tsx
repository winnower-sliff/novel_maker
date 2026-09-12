import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphNodeKind, ProjectGraph } from '@shared/types'
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

const ALL_KINDS: GraphNodeKind[] = ['character', 'worldbuild', 'outline', 'foreshadow']

interface FocusState {
  id: string
  depth: number
}

export default function GraphPage({
  projectId,
  onNavigate
}: {
  projectId: string
  onNavigate: Navigate
}) {
  const [graph, setGraph] = useState<ProjectGraph | null>(null)
  const [kinds, setKinds] = useState<Set<GraphNodeKind>>(new Set(ALL_KINDS))
  const [query, setQuery] = useState('')
  const [hideIsolated, setHideIsolated] = useState(false)
  const [focus, setFocus] = useState<FocusState | null>(null)
  const [relayoutKey, setRelayoutKey] = useState(0)
  const [clusterTags, setClusterTags] = useState(false)
  const autoClusterRef = useRef(false)

  const load = useCallback((): void => {
    if (!projectId) return
    void window.api.graph.project(projectId).then(setGraph)
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

  const handleNodeClick = useCallback(
    (id: string): void => {
      const n = nodeById.get(id)
      if (!n) return
      if (n.kind === 'character') onNavigate('characters')
      else if (n.kind === 'worldbuild') onNavigate('worldbuild')
      else if (n.kind === 'outline') onNavigate('writing', n.rawId)
      else onNavigate('foreshadows')
    },
    [nodeById, onNavigate]
  )

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

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
        <RelationGraph
          key={relayoutKey}
          nodes={rgNodes}
          edges={rgEdges}
          groupColors={KIND_COLORS}
          clusterTags={clusterTags}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
        />
      </div>

      <div className="text-[11px] text-zinc-600">
        单击节点跳转对应板块 · 双击节点进入局部图谱 · 拖动节点看关联晃动 · 圆越大 = 被引用越多（核心条目/MOC）·
        相连的主题会自动聚成集群 · 「标签聚类」开启时同标签条目/人物按分区聚拢并按主标签着色 ·
        连线来自各板块文本与章节正文中的 [[链接]]
      </div>
    </div>
  )
}
