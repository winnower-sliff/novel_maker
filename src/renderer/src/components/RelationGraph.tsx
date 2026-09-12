import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  useStore,
  type Edge,
  type MiniMapNodeProps,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type OnNodeDrag
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

export interface GraphNodeData {
  id: string
  label: string
  group: string
  degree?: number
  tags?: string[]
}

export interface GraphEdgeData {
  source: string
  target: string
}

interface RelationGraphProps {
  nodes: GraphNodeData[]
  edges: GraphEdgeData[]
  groupColors: Record<string, string>
  clusterTags?: boolean
  onNodeClick?: (id: string) => void
  onNodeDoubleClick?: (id: string) => void
}

interface WikiNodeData extends Record<string, unknown> {
  label: string
  color: string
  radius: number
  dim: boolean
}

interface TagLabelData extends Record<string, unknown> {
  label: string
  color: string
}

const ITERATIONS = 300
const REPULSION = 80000
const SPRING_LENGTH = 130
const SPRING_K = 0.06
const DAMPING = 0.85
const DRAG_ALPHA = 0.35
const ALPHA_DECAY = 0.96
const ALPHA_STOP = 0.02
const COLLIDE_PAD = 16
const COLLIDE_STRENGTH = 0.4
const CENTER_PULL = 0.008
const TAG_K = 0.02
const TAG_CENTER_PULL_SCALE = 0.25
const MAX_TAG_ANCHORS = 12

const TAG_PALETTE = [
  '#f59e0b',
  '#10b981',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f97316',
  '#22d3ee',
  '#a78bfa',
  '#fb7185',
  '#4ade80',
  '#facc15',
  '#38bdf8'
]

export function tagColor(tag: string): string {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  return TAG_PALETTE[h % TAG_PALETTE.length]
}

interface SimPoint {
  id: string
  x: number
  y: number
  r: number
  deg: number
  anchors: number[]
}

interface SimAnchor {
  x: number
  y: number
}

function runIterations(
  pts: SimPoint[],
  links: Array<[number, number]>,
  anchors: SimAnchor[],
  iterations: number,
  alpha: number
): void {
  const count = pts.length
  if (count <= 1) return
  const centerScale = anchors.length > 0 ? TAG_CENTER_PULL_SCALE : 1
  for (let it = 0; it < iterations; it++) {
    const fx = new Array(count).fill(0)
    const fy = new Array(count).fill(0)
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let dx = pts[i].x - pts[j].x
        let dy = pts[i].y - pts[j].y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = (i % 3) - 1 || 0.5
          dy = (j % 3) - 1 || 0.5
          d2 = 1
        }
        const d = Math.sqrt(d2)
        const ux = dx / d
        const uy = dy / d
        const f = (REPULSION / d2) * alpha
        fx[i] += f * ux
        fy[i] += f * uy
        fx[j] -= f * ux
        fy[j] -= f * uy
        const minDist = pts[i].r + pts[j].r + COLLIDE_PAD
        if (d < minDist) {
          const push = (minDist - d) * COLLIDE_STRENGTH
          fx[i] += push * ux
          fy[i] += push * uy
          fx[j] -= push * ux
          fy[j] -= push * uy
        }
      }
    }
    for (const [si, ti] of links) {
      const dx = pts[ti].x - pts[si].x
      const dy = pts[ti].y - pts[si].y
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const rest = SPRING_LENGTH + pts[si].r + pts[ti].r
      const hub = 1 + Math.min(1.5, (pts[si].deg + pts[ti].deg) / 10)
      const f = SPRING_K * hub * (d - rest) * alpha
      const fxStep = (dx / d) * f
      const fyStep = (dy / d) * f
      fx[si] += fxStep
      fy[si] += fyStep
      fx[ti] -= fxStep
      fy[ti] -= fyStep
    }
    for (let i = 0; i < count; i++) {
      const aIdx = pts[i].anchors
      if (aIdx.length > 0) {
        const w = TAG_K / aIdx.length
        for (const ai of aIdx) {
          const dx = anchors[ai].x - pts[i].x
          const dy = anchors[ai].y - pts[i].y
          const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
          const f = w * d * alpha
          fx[i] += (dx / d) * f
          fy[i] += (dy / d) * f
        }
      }
      fx[i] -= pts[i].x * CENTER_PULL * centerScale * alpha
      fy[i] -= pts[i].y * CENTER_PULL * centerScale * alpha
      pts[i].x += Math.max(-30, Math.min(30, fx[i] * DAMPING))
      pts[i].y += Math.max(-30, Math.min(30, fy[i] * DAMPING))
    }
  }
}

function refRadius(refCount: number): number {
  return Math.min(46, 12 + Math.sqrt(refCount) * 9)
}

const CENTER_HANDLE_STYLE = {
  left: '50%',
  top: '50%',
  width: 0,
  height: 0,
  opacity: 0,
  pointerEvents: 'none'
} as const

const LABEL_CLAMP = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  overflowWrap: 'anywhere'
} as const

function DotNode({ data }: NodeProps<Node<WikiNodeData>>) {
  const showLabel = useStore((s) => s.transform[2] >= 0.4 || data.radius >= 30)
  const inside = data.radius >= 24
  const fontSize = Math.min(13, 9 + data.radius * 0.08)
  return (
    <div
      title={data.label}
      style={{
        position: 'relative',
        width: data.radius * 2,
        height: data.radius * 2,
        opacity: data.dim ? 0.15 : 1,
        transition: 'opacity 0.2s'
      }}
    >
      <Handle type="target" position={Position.Left} style={CENTER_HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={CENTER_HANDLE_STYLE} isConnectable={false} />
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          background: `${data.color}33`,
          border: `2px solid ${data.color}`,
          boxShadow: `0 0 ${Math.round(data.radius / 3)}px ${data.color}55`,
          cursor: 'pointer'
        }}
      />
      {showLabel &&
        (inside ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: data.radius * 0.25,
              pointerEvents: 'none'
            }}
          >
            <span
              style={{
                ...LABEL_CLAMP,
                WebkitLineClamp: data.radius >= 36 ? 3 : 2,
                maxWidth: '100%',
                maxHeight: '100%',
                textAlign: 'center',
                fontSize: `${fontSize}px`,
                lineHeight: 1.25,
                color: '#fafafa',
                textShadow: '0 1px 3px rgba(0, 0, 0, 0.9)'
              }}
            >
              {data.label}
            </span>
          </div>
        ) : (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              marginTop: 4,
              width: Math.max(64, data.radius * 2.4),
              textAlign: 'center',
              fontSize: '11px',
              lineHeight: 1.35,
              color: '#d4d4d8',
              textShadow: '0 1px 3px rgba(0, 0, 0, 0.9)',
              ...LABEL_CLAMP,
              WebkitLineClamp: 2,
              pointerEvents: 'none'
            }}
          >
            {data.label}
          </div>
        ))}
    </div>
  )
}

const nodeTypes = { dot: DotNode, tagLabel: TagLabelNode }

function TagLabelNode({ data }: NodeProps<Node<TagLabelData>>) {
  return (
    <div
      style={{
        transform: 'translate(-50%, -50%)',
        padding: '2px 10px',
        borderRadius: 999,
        border: `1px solid ${data.color}66`,
        background: 'rgba(9, 9, 11, 0.55)',
        color: data.color,
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        pointerEvents: 'none'
      }}
    >
      # {data.label}
    </div>
  )
}

function MiniMapCircle({ id, x, y, width, height, color, onClick }: MiniMapNodeProps) {
  return (
    <circle
      cx={x + width / 2}
      cy={y + height / 2}
      r={Math.max(2, width / 2)}
      fill={color}
      onClick={onClick ? (e) => onClick(e, id) : undefined}
      style={{ cursor: 'pointer' }}
    />
  )
}

export const RelationGraph = memo(function RelationGraph({
  nodes,
  edges,
  groupColors,
  clusterTags = false,
  onNodeClick,
  onNodeDoubleClick
}: RelationGraphProps) {
  const { links, adjacency, refCount } = useMemo(() => {
    const index = new Map(nodes.map((n, i) => [n.id, i]))
    const linkKeys = new Set<string>()
    const links: Array<[number, number]> = []
    for (const e of edges) {
      const si = index.get(e.source)
      const ti = index.get(e.target)
      if (si === undefined || ti === undefined || si === ti) continue
      const key = si < ti ? `${si}-${ti}` : `${ti}-${si}`
      if (linkKeys.has(key)) continue
      linkKeys.add(key)
      links.push([si, ti])
    }
    const adjacency = new Map<string, Set<string>>()
    const ensure = (id: string): Set<string> => {
      let set = adjacency.get(id)
      if (!set) {
        set = new Set()
        adjacency.set(id, set)
      }
      return set
    }
    const refCount = new Map<string, number>()
    for (const e of edges) {
      ensure(e.source).add(e.target)
      ensure(e.target).add(e.source)
      refCount.set(e.target, (refCount.get(e.target) ?? 0) + 1)
    }
    return { links, adjacency, refCount }
  }, [nodes, edges])

  const cluster = useMemo(() => {
    if (!clusterTags) return null
    const counts = new Map<string, number>()
    for (const n of nodes) {
      const seen = new Set<string>()
      for (const t of n.tags ?? []) {
        const key = t.trim()
        if (!key || seen.has(key)) continue
        seen.add(key)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TAG_ANCHORS)
      .map(([name]) => name)
    if (top.length === 0) return null
    const ringR = Math.max(300, Math.min(700, 70 * Math.sqrt(nodes.length)))
    const anchors: SimAnchor[] = top.map((_, i) => {
      const angle = (i / top.length) * Math.PI * 2 - Math.PI / 2
      return { x: Math.cos(angle) * ringR, y: Math.sin(angle) * ringR }
    })
    const anchorIdx = new Map(top.map((t, i) => [t, i]))
    return { tags: top, anchors, anchorIdx }
  }, [clusterTags, nodes])

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node<WikiNodeData | TagLabelData>>([])
  const [hoverId, setHoverId] = useState<string | null>(null)
  const simRef = useRef<SimPoint[]>([])
  const clusterRef = useRef(cluster)
  const alphaRef = useRef(0)
  const rafRef = useRef(0)
  const nodesRef = useRef(nodes)
  const linksRef = useRef(links)
  nodesRef.current = nodes
  linksRef.current = links
  clusterRef.current = cluster

  const applySimToNodes = useCallback((): void => {
    const sim = simRef.current
    if (sim.length === 0) return
    const byId = new Map(sim.map((p) => [p.id, p]))
    setFlowNodes((cur) =>
      cur.map((n) => {
        const p = byId.get(n.id)
        return p ? { ...n, position: { x: p.x, y: p.y } } : n
      })
    )
  }, [setFlowNodes])

  const tick = useCallback((): void => {
    rafRef.current = 0
    const alpha = alphaRef.current
    if (alpha < ALPHA_STOP || simRef.current.length <= 1) {
      applySimToNodes()
      return
    }
    runIterations(simRef.current, linksRef.current, clusterRef.current?.anchors ?? [], 1, alpha)
    alphaRef.current = alpha * ALPHA_DECAY
    applySimToNodes()
    rafRef.current = requestAnimationFrame(tick)
  }, [applySimToNodes])

  const kick = useCallback((): void => {
    if (rafRef.current === 0) rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  useEffect(() => {
    const prev = simRef.current
    const prevById = new Map(prev.map((p) => [p.id, p]))
    const keepPrev = prev.length > 0 && !cluster
    const anchors = cluster?.anchors ?? []
    const anchorIdx = cluster?.anchorIdx
    const pts: SimPoint[] = nodes.map((n, i) => {
      const deg = adjacency.get(n.id)?.size ?? 0
      const r = refRadius(refCount.get(n.id) ?? 0)
      const myAnchors: number[] = []
      if (anchorIdx) {
        for (const t of n.tags ?? []) {
          const ai = anchorIdx.get(t.trim())
          if (ai !== undefined && !myAnchors.includes(ai)) myAnchors.push(ai)
        }
      }
      const old = keepPrev ? prevById.get(n.id) : undefined
      if (old) return { id: n.id, x: old.x, y: old.y, r, deg, anchors: myAnchors }
      if (myAnchors.length > 0) {
        const a = anchors[myAnchors[0]]
        return {
          id: n.id,
          x: a.x + ((i * 53) % 160) - 80,
          y: a.y + ((i * 91) % 160) - 80,
          r,
          deg,
          anchors: myAnchors
        }
      }
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2
      const radius = 60 + ((i * 37) % 240)
      return { id: n.id, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, r, deg, anchors: myAnchors }
    })
    simRef.current = pts
    runIterations(pts, links, anchors, ITERATIONS, 1)
    alphaRef.current = 0
    const byId = new Map(pts.map((p) => [p.id, p]))
    const dotNodes = nodes.map((n) => {
      const tags = (n.tags ?? []).map((t) => t.trim()).filter(Boolean)
      const color = cluster
        ? tags.length > 0
          ? tagColor(tags[0])
          : (groupColors[n.group] ?? '#a1a1aa')
        : (groupColors[n.group] ?? '#a1a1aa')
      return {
        id: n.id,
        type: 'dot' as const,
        position: byId.get(n.id) ?? { x: 0, y: 0 },
        data: {
          label: n.label,
          color,
          radius: refRadius(refCount.get(n.id) ?? 0),
          dim: false
        }
      }
    })
    const clusterTagsList = cluster?.tags ?? []
    const clusterAnchorIdx = cluster?.anchorIdx
    const clusterAnchors = cluster?.anchors ?? []
    const tagLabelNodes = clusterTagsList.map((t) => {
      const ai = clusterAnchorIdx?.get(t)
      const anchor = ai !== undefined ? clusterAnchors[ai] : { x: 0, y: 0 }
      return {
        id: `tag:${t}`,
        type: 'tagLabel' as const,
        position: { x: anchor.x, y: anchor.y },
        draggable: false,
        selectable: false,
        data: { label: t, color: tagColor(t) }
      }
    })
    setFlowNodes([...tagLabelNodes, ...dotNodes] as Node<WikiNodeData | TagLabelData>[])
    return () => {
      if (rafRef.current !== 0) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [nodes, links, groupColors, cluster, adjacency, refCount, setFlowNodes])

  useEffect(() => {
    setFlowNodes((cur) =>
      cur.map((n) => ({
        ...n,
        data: {
          ...n.data,
          dim: hoverId !== null && n.id !== hoverId && !(adjacency.get(hoverId)?.has(n.id) ?? false)
        }
      }))
    )
  }, [hoverId, adjacency, setFlowNodes])

  const rfEdges = useMemo(
    () =>
      links.flatMap(([si, ti], i): Edge[] => {
        const sid = nodesRef.current[si]?.id
        const tid = nodesRef.current[ti]?.id
        if (!sid || !tid) return []
        const hot = hoverId !== null && (sid === hoverId || tid === hoverId)
        return [
          {
            id: `e${i}`,
            source: sid,
            target: tid,
            type: 'straight',
            style: hot
              ? { stroke: '#f59e0b', strokeWidth: 2 }
              : {
                  stroke: hoverId !== null ? 'rgba(161, 161, 170, 0.08)' : 'rgba(161, 161, 170, 0.35)',
                  strokeWidth: 1.2
                }
          }
        ]
      }),
    [links, hoverId]
  )

  const handleClick: NodeMouseHandler = (_e, node) => onNodeClick?.(node.id)

  const handleDoubleClick: NodeMouseHandler = (_e, node) => onNodeDoubleClick?.(node.id)

  const handleDrag = useCallback<OnNodeDrag<Node<WikiNodeData | TagLabelData>>>(
    (_e, node) => {
      const p = simRef.current.find((x) => x.id === node.id)
      if (!p) return
      p.x = node.position.x
      p.y = node.position.y
      alphaRef.current = Math.max(alphaRef.current, DRAG_ALPHA)
      kick()
    },
    [kick]
  )

  const handleDragStop = useCallback<OnNodeDrag<Node<WikiNodeData | TagLabelData>>>(
    () => {
      alphaRef.current = Math.max(alphaRef.current, DRAG_ALPHA)
      kick()
    },
    [kick]
  )

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        暂无可关联的条目（条目内容中的 [[链接]] 会形成网络）
      </div>
    )
  }

  return (
    <ReactFlow
      nodes={flowNodes}
      onNodesChange={onNodesChange}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodeClick={handleClick}
      onNodeDoubleClick={handleDoubleClick}
      onNodeDrag={handleDrag}
      onNodeDragStop={handleDragStop}
      onNodeMouseEnter={(_e, node) => setHoverId(node.id)}
      onNodeMouseLeave={() => setHoverId(null)}
      fitView
      minZoom={0.15}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      className="bg-zinc-950/40"
    >
      <Background color="#27272a" gap={24} />
      <Controls
        showInteractive={false}
        className="!border !border-zinc-700 !bg-zinc-900 [&>button]:!border-zinc-700 [&>button]:!bg-zinc-900 [&>button]:!fill-zinc-300 [&>button:hover]:!bg-zinc-800"
      />
      <MiniMap
        pannable
        zoomable
        maskColor="rgba(9, 9, 11, 0.45)"
        nodeStrokeColor="transparent"
        nodeComponent={MiniMapCircle}
        style={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
        nodeColor={(n: Node) => (n.data as WikiNodeData | undefined)?.color ?? '#a1a1aa'}
      />
    </ReactFlow>
  )
})
