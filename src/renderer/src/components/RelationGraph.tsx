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
  type OnNodeDrag,
  type ReactFlowInstance
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
  showTagLabels?: boolean
  onNodeClick?: (id: string) => void
  onNodeDoubleClick?: (id: string) => void
  activeId?: string | null
  onActiveIdChange?: (id: string | null) => void
  centerSignal?: number
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
  count?: number
  ci?: number
  dim?: boolean
  hl?: boolean
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
const CLUSTER_CENTER_PULL_SCALE = 0.3
const CLUSTER_MIN_COUNT = 3
const CLUSTER_PRIMARY_K = 0.045
const CLUSTER_SECONDARY_K = 0.015
const CLUSTER_REPEL = REPULSION * 40
const NEUTRAL_COLOR = '#71717a'

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
  primary: number
  members: number[]
}

function runIterations(
  pts: SimPoint[],
  links: Array<[number, number]>,
  clusterCount: number,
  iterations: number,
  alpha: number
): void {
  const count = pts.length
  if (count <= 1) return
  const centerScale = clusterCount > 0 ? CLUSTER_CENTER_PULL_SCALE : 1
  const membersOf: number[][] = Array.from({ length: clusterCount }, () => [])
  pts.forEach((p, i) => {
    for (const ci of p.members) membersOf[ci].push(i)
  })
  const cx = new Array<number>(clusterCount).fill(0)
  const cy = new Array<number>(clusterCount).fill(0)
  for (let it = 0; it < iterations; it++) {
    if (clusterCount > 0) {
      for (let ci = 0; ci < clusterCount; ci++) {
        const ms = membersOf[ci]
        if (ms.length === 0) continue
        let sx = 0
        let sy = 0
        for (const i of ms) {
          sx += pts[i].x
          sy += pts[i].y
        }
        cx[ci] = sx / ms.length
        cy[ci] = sy / ms.length
      }
    }
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
    if (clusterCount > 1) {
      for (let ci = 0; ci < clusterCount; ci++) {
        const mi = membersOf[ci]
        if (mi.length === 0) continue
        for (let cj = ci + 1; cj < clusterCount; cj++) {
          const mj = membersOf[cj]
          if (mj.length === 0) continue
          let dx = cx[cj] - cx[ci]
          let dy = cy[cj] - cy[ci]
          let d2 = dx * dx + dy * dy
          if (d2 < 1) {
            dx = 1
            dy = 0
            d2 = 1
          }
          const d = Math.sqrt(d2)
          const f = (CLUSTER_REPEL / d2) * alpha
          const ux = (dx / d) * f
          const uy = (dy / d) * f
          const shareI = 1 / mi.length
          const shareJ = 1 / mj.length
          for (const i of mi) {
            fx[i] -= ux * shareI
            fy[i] -= uy * shareI
          }
          for (const j of mj) {
            fx[j] += ux * shareJ
            fy[j] += uy * shareJ
          }
        }
      }
    }
    for (let i = 0; i < count; i++) {
      const p = pts[i]
      for (const ci of p.members) {
        const dx = cx[ci] - p.x
        const dy = cy[ci] - p.y
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
        const f = (ci === p.primary ? CLUSTER_PRIMARY_K : CLUSTER_SECONDARY_K) * d * alpha
        fx[i] += (dx / d) * f
        fy[i] += (dy / d) * f
      }
      fx[i] -= p.x * CENTER_PULL * centerScale * alpha
      fy[i] -= p.y * CENTER_PULL * centerScale * alpha
      p.x += Math.max(-30, Math.min(30, fx[i] * DAMPING))
      p.y += Math.max(-30, Math.min(30, fy[i] * DAMPING))
    }
  }
}

function clusterCentroids(pts: SimPoint[], clusterCount: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (let ci = 0; ci < clusterCount; ci++) {
    let sx = 0
    let sy = 0
    let n = 0
    for (const p of pts) {
      if (p.members.includes(ci)) {
        sx += p.x
        sy += p.y
        n++
      }
    }
    out.push(n === 0 ? { x: 0, y: 0 } : { x: sx / n, y: sy / n })
  }
  return out
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
      <Handle type="target" position={Position.Left} className="center-handle" style={CENTER_HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Right} className="center-handle" style={CENTER_HANDLE_STYLE} isConnectable={false} />
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
  const fontSize = Math.min(44, 18 + Math.sqrt(data.count ?? 3) * 6)
  return (
    <div
      style={{
        transform: 'translate(-50%, -50%)',
        color: data.color,
        fontSize,
        fontWeight: 700,
        letterSpacing: '0.05em',
        whiteSpace: 'nowrap',
        opacity: data.dim ? 0.05 : data.hl ? 0.5 : 0.22,
        transition: 'opacity 0.2s',
        cursor: 'pointer',
        userSelect: 'none'
      }}
      title={data.count !== undefined ? `#${data.label} · ${data.count} 条 · 点击筛选` : '点击按此标签筛选'}
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
  showTagLabels = true,
  onNodeClick,
  onNodeDoubleClick,
  activeId = null,
  onActiveIdChange,
  centerSignal = 0
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
      .filter(([, c]) => c >= CLUSTER_MIN_COUNT)
      .sort((a, b) => b[1] - a[1])
    if (top.length === 0) return null
    const tagIdx = new Map(top.map(([t], i) => [t, i]))
    const primaries = new Map<string, number>()
    const memberLists = new Map<string, number[]>()
    const membersByCluster: Array<Set<string>> = top.map(() => new Set<string>())
    for (const n of nodes) {
      const hits: Array<{ ci: number; count: number }> = []
      const seen = new Set<number>()
      for (const t of n.tags ?? []) {
        const ci = tagIdx.get(t.trim())
        if (ci !== undefined && !seen.has(ci)) {
          seen.add(ci)
          hits.push({ ci, count: top[ci][1] })
        }
      }
      hits.sort((a, b) => b.count - a.count)
      primaries.set(n.id, hits.length > 0 ? hits[0].ci : -1)
      memberLists.set(n.id, hits.map((h) => h.ci))
      for (const h of hits) membersByCluster[h.ci].add(n.id)
    }
    return {
      tags: top.map(([t]) => t),
      counts: top.map(([, c]) => c),
      primaries,
      memberLists,
      membersByCluster
    }
  }, [clusterTags, nodes])

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node<WikiNodeData | TagLabelData>>([])
  const [tagHover, setTagHover] = useState<string | null>(null)
  const simRef = useRef<SimPoint[]>([])
  const clusterRef = useRef(cluster)
  const showTagLabelsRef = useRef(showTagLabels)
  const alphaRef = useRef(0)
  const rafRef = useRef(0)
  const nodesRef = useRef(nodes)
  const linksRef = useRef(links)
  const rfInstanceRef = useRef<ReactFlowInstance<Node<WikiNodeData | TagLabelData>> | null>(null)
  const centeredSignalRef = useRef(-1)
  const flowNodesRef = useRef(flowNodes)
  nodesRef.current = nodes
  linksRef.current = links
  clusterRef.current = cluster
  showTagLabelsRef.current = showTagLabels
  flowNodesRef.current = flowNodes

  const applySimToNodes = useCallback((): void => {
    const sim = simRef.current
    if (sim.length === 0) return
    const clusterCount = clusterRef.current?.tags.length ?? 0
    const cents = clusterCount > 0 ? clusterCentroids(sim, clusterCount) : null
    const byId = new Map(sim.map((p) => [p.id, p]))
    setFlowNodes((cur) =>
      cur.map((n) => {
        const p = byId.get(n.id)
        if (p) return { ...n, position: { x: p.x, y: p.y } }
        if (cents && n.id.startsWith('tag:')) {
          const ci = (n.data as TagLabelData).ci
          const c = ci !== undefined ? cents[ci] : undefined
          if (c) return { ...n, position: { x: c.x, y: c.y } }
        }
        return n
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
    runIterations(simRef.current, linksRef.current, clusterRef.current?.tags.length ?? 0, 1, alpha)
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
    const primaries = cluster?.primaries
    const memberLists = cluster?.memberLists
    const clusterCount = cluster?.tags.length ?? 0
    const groups = new Map<number, number[]>()
    nodes.forEach((n, i) => {
      const pi = primaries?.get(n.id) ?? -1
      if (pi >= 0) {
        const g = groups.get(pi)
        if (g) g.push(i)
        else groups.set(pi, [i])
      }
    })
    const ringR = Math.max(320, Math.min(800, 70 * Math.sqrt(nodes.length)))
    const groupList = [...groups.values()]
    const seats = new Array<[number, number] | null>(nodes.length).fill(null)
    groupList.forEach((idxs, gi) => {
      const angle = (gi / Math.max(1, groupList.length)) * Math.PI * 2 - Math.PI / 2
      const gx = Math.cos(angle) * ringR
      const gy = Math.sin(angle) * ringR
      idxs.forEach((ni, m) => {
        const r = 26 * Math.sqrt(m + 1)
        const t = m * 2.399963
        seats[ni] = [gx + Math.cos(t) * r, gy + Math.sin(t) * r]
      })
    })
    const pts: SimPoint[] = nodes.map((n, i) => {
      const deg = adjacency.get(n.id)?.size ?? 0
      const r = refRadius(refCount.get(n.id) ?? 0)
      const primary = primaries?.get(n.id) ?? -1
      const members = memberLists?.get(n.id) ?? []
      const old = keepPrev ? prevById.get(n.id) : undefined
      if (old) return { id: n.id, x: old.x, y: old.y, r, deg, primary, members }
      const s = seats[i]
      if (s) return { id: n.id, x: s[0], y: s[1], r, deg, primary, members }
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2
      const radius = 60 + ((i * 37) % 240)
      return {
        id: n.id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        r,
        deg,
        primary,
        members
      }
    })
    simRef.current = pts
    runIterations(pts, links, clusterCount, ITERATIONS, 1)
    alphaRef.current = 0
    const byId = new Map(pts.map((p) => [p.id, p]))
    const dotNodes = nodes.map((n) => {
      const primary = cluster?.primaries.get(n.id) ?? -1
      const color = cluster
        ? primary >= 0
          ? tagColor(cluster.tags[primary])
          : NEUTRAL_COLOR
        : (groupColors[n.group] ?? '#a1a1aa')
      return {
        id: n.id,
        type: 'dot' as const,
        position: byId.get(n.id) ?? { x: 0, y: 0 },
        zIndex: 1,
        data: {
          label: n.label,
          color,
          radius: refRadius(refCount.get(n.id) ?? 0),
          dim: false
        }
      }
    })
    const cents = cluster ? clusterCentroids(pts, clusterCount) : []
    const clusterTagsList = cluster?.tags ?? []
    const clusterCounts = cluster?.counts ?? []
    const tagLabelNodes = clusterTagsList.map((t, ci) => {
      const c = cents[ci] ?? { x: 0, y: 0 }
      return {
        id: `tag:${t}`,
        type: 'tagLabel' as const,
        position: { x: c.x, y: c.y },
        draggable: false,
        selectable: false,
        zIndex: 0,
        hidden: !showTagLabelsRef.current,
        data: { label: t, color: tagColor(t), count: clusterCounts[ci], ci, dim: false }
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
      cur.map((n) => (n.id.startsWith('tag:') ? { ...n, hidden: !showTagLabels } : n))
    )
  }, [showTagLabels, setFlowNodes])

  useEffect(() => {
    const hl = activeId ?? tagHover
    setFlowNodes((cur) =>
      cur.map((n) => {
        if (n.id.startsWith('tag:')) {
          const data = n.data as TagLabelData
          let dim = false
          let hlt = false
          if (hl === null) {
            dim = false
          } else if (hl === n.id) {
            hlt = true
          } else if (hl.startsWith('tag:')) {
            dim = true
          } else {
            dim = !(cluster?.memberLists.get(hl) ?? []).includes(data.ci ?? -1)
            hlt = !dim
          }
          return { ...n, data: { ...data, dim, hl: hlt } }
        }
        let dim: boolean
        if (hl === null || n.id === hl) dim = false
        else if (hl.startsWith('tag:')) {
          const ci = cluster?.tags.indexOf(hl.slice(4)) ?? -1
          dim = !(cluster?.membersByCluster[ci]?.has(n.id) ?? false)
        } else dim = !(adjacency.get(hl)?.has(n.id) ?? false)
        return { ...n, data: { ...(n.data as WikiNodeData), dim } }
      })
    )
  }, [activeId, tagHover, adjacency, cluster, setFlowNodes])

  const rfEdges = useMemo(
    () =>
      links.flatMap(([si, ti], i): Edge[] => {
        const sid = nodesRef.current[si]?.id
        const tid = nodesRef.current[ti]?.id
        if (!sid || !tid) return []
        const hl = activeId ?? tagHover
        const hot = hl !== null && !hl.startsWith('tag:') && (sid === hl || tid === hl)
        return [
          {
            id: `e${i}`,
            source: sid,
            target: tid,
            type: 'straight',
            style: hot
              ? { stroke: '#f59e0b', strokeWidth: 2 }
              : {
                  stroke: hl !== null ? 'rgba(161, 161, 170, 0.08)' : 'rgba(161, 161, 170, 0.35)',
                  strokeWidth: 1.2
                }
          }
        ]
      }),
    [links, activeId, tagHover]
  )

  useEffect(() => {
    if (!centerSignal || centerSignal === centeredSignalRef.current) return
    if (!activeId || !rfInstanceRef.current) return
    const node = flowNodesRef.current.find((n) => n.id === activeId)
    if (!node) return
    centeredSignalRef.current = centerSignal
    const r = (node.data as WikiNodeData).radius
    rfInstanceRef.current.setCenter(node.position.x + r, node.position.y + r, {
      zoom: Math.max(rfInstanceRef.current.getZoom(), 0.75),
      duration: 500
    })
  }, [centerSignal, activeId, flowNodes])

  const handleClick: NodeMouseHandler = (_e, node) => {
    if (node.id.startsWith('tag:')) {
      onNodeClick?.(node.id)
      return
    }
    const next = activeId === node.id ? null : node.id
    onActiveIdChange?.(next)
    if (next !== null) onNodeClick?.(node.id)
  }

  const handlePaneClick = useCallback((): void => {
    onActiveIdChange?.(null)
  }, [onActiveIdChange])

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
      onPaneClick={handlePaneClick}
      onNodeMouseEnter={(_e, node) => {
        if (node.id.startsWith('tag:') && activeId === null) setTagHover(node.id)
      }}
      onNodeMouseLeave={() => setTagHover(null)}
      onInit={(inst) => {
        rfInstanceRef.current = inst
      }}
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
