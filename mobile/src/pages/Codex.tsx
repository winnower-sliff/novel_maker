import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge, Button, Empty, Input, Spinner, Textarea } from '@mobile/components/ui'
import type { Character, Foreshadow, OutlineItem, WorldbuildEntry } from '@shared/types'

type Tab = 'characters' | 'world' | 'outline' | 'foreshadow'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'characters', label: '人物' },
  { key: 'world', label: '世界观' },
  { key: 'outline', label: '大纲' },
  { key: 'foreshadow', label: '伏笔' }
]

export default function Codex({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>('characters')

  if (!projectId) return <Empty text="请先在「书架」选择项目" />

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-zinc-800 bg-zinc-950/95">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 cursor-pointer py-2.5 text-sm ${
              tab === t.key
                ? 'border-b-2 border-amber-500 font-medium text-amber-400'
                : 'text-zinc-500'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'characters' && <Characters projectId={projectId} />}
        {tab === 'world' && <World projectId={projectId} />}
        {tab === 'outline' && <Outline projectId={projectId} />}
        {tab === 'foreshadow' && <Foreshadows projectId={projectId} />}
      </div>
    </div>
  )
}

function Row({
  title,
  sub,
  right,
  onClick
}: {
  title: string
  sub?: string
  right?: React.ReactNode
  onClick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 active:bg-zinc-900"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick()
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-200">{title}</div>
        {sub && <div className="mt-0.5 truncate text-[11px] text-zinc-600">{sub}</div>}
      </div>
      {right}
    </div>
  )
}

function EditBar({
  dirty,
  saving,
  onSave
}: {
  dirty: boolean
  saving: boolean
  onSave: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <span className="text-xs text-zinc-600">{dirty ? '有未保存修改' : '已保存'}</span>
      <Button className="ml-auto px-3.5 py-1.5 text-xs" disabled={!dirty || saving} onClick={onSave}>
        {saving ? <Spinner className="h-3.5 w-3.5" /> : '保存'}
      </Button>
    </div>
  )
}

function DetailShell({
  title,
  onBack,
  children,
  bar
}: {
  title: string
  onBack: () => void
  children: React.ReactNode
  bar?: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2 py-2">
        <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={onBack}>
          ← 返回
        </Button>
        <div className="min-w-0 flex-1 truncate text-center text-sm font-medium text-zinc-200">
          {title}
        </div>
        <div className="w-14" />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">{children}</div>
      {bar}
    </div>
  )
}

const label = 'mb-1 block text-xs text-zinc-500'

function Characters({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: list = [], isLoading } = useQuery({
    queryKey: ['novel', 'characters', projectId],
    queryFn: () => window.api.novel.characters(projectId)
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = list.find((c) => c.id === editId) ?? null

  if (isLoading) return <Empty text="加载中…" />
  if (list.length === 0) return <Empty text="暂无人物" />

  if (editing) return <CharacterEditor key={editing.id} projectId={projectId} character={editing} onBack={() => setEditId(null)} onSaved={() => void qc.invalidateQueries({ queryKey: ['novel', 'characters', projectId] })} />

  return (
    <div className="space-y-1.5">
      {list.map((c: Character) => (
        <Row
          key={c.id}
          title={c.name}
          sub={c.role || undefined}
          right={c.tags ? <Badge>{c.tags}</Badge> : undefined}
          onClick={() => setEditId(c.id)}
        />
      ))}
    </div>
  )
}

function CharacterEditor({
  projectId,
  character,
  onBack,
  onSaved
}: {
  projectId: string
  character: Character
  onBack: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(character.name)
  const [role, setRole] = useState(character.role)
  const [tags, setTags] = useState(character.tags)
  const [card, setCard] = useState(character.card)
  const [state, setState] = useState(character.state)
  const [saving, setSaving] = useState(false)
  const dirty =
    name !== character.name || role !== character.role || tags !== character.tags ||
    card !== character.card || state !== character.state

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.novel.characterSave({
        id: character.id,
        projectId,
        name,
        role,
        tags,
        card,
        state
      })
      onSaved()
      onBack()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailShell
      title={character.name}
      onBack={onBack}
      bar={<EditBar dirty={dirty} saving={saving} onSave={() => void save()} />}
    >
      <div>
        <span className={label}>姓名</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <span className={label}>身份</span>
        <Input value={role} onChange={(e) => setRole(e.target.value)} />
      </div>
      <div>
        <span className={label}>标签（空格分隔）</span>
        <Input value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
      <div>
        <span className={label}>人物卡</span>
        <Textarea rows={10} value={card} onChange={(e) => setCard(e.target.value)} />
      </div>
      <div>
        <span className={label}>当前状态（动态）</span>
        <Textarea rows={5} value={state} onChange={(e) => setState(e.target.value)} />
      </div>
    </DetailShell>
  )
}

function World({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: list = [], isLoading } = useQuery({
    queryKey: ['novel', 'worldbuild', projectId],
    queryFn: () => window.api.novel.worldbuild(projectId)
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = list.find((w) => w.id === editId) ?? null

  if (isLoading) return <Empty text="加载中…" />
  if (list.length === 0) return <Empty text="暂无世界观条目" />

  if (editing)
    return (
      <WorldEditor
        key={editing.id}
        projectId={projectId}
        entry={editing}
        onBack={() => setEditId(null)}
        onSaved={() => void qc.invalidateQueries({ queryKey: ['novel', 'worldbuild', projectId] })}
      />
    )

  const groups = [...new Set(list.map((w) => w.category))]
  return (
    <div className="space-y-4">
      {groups.map((cat) => (
        <div key={cat}>
          <div className="mb-1.5 px-1 text-xs font-medium text-zinc-500">{cat}</div>
          <div className="space-y-1.5">
            {list
              .filter((w) => w.category === cat)
              .map((w) => (
                <Row
                  key={w.id}
                  title={w.title}
                  sub={w.tags || undefined}
                  onClick={() => setEditId(w.id)}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function WorldEditor({
  projectId,
  entry,
  onBack,
  onSaved
}: {
  projectId: string
  entry: WorldbuildEntry
  onBack: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(entry.title)
  const [tags, setTags] = useState(entry.tags)
  const [content, setContent] = useState(entry.content)
  const [saving, setSaving] = useState(false)
  const dirty = title !== entry.title || tags !== entry.tags || content !== entry.content

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.novel.worldbuildSave({
        id: entry.id,
        projectId,
        category: entry.category,
        title,
        tags,
        content
      })
      onSaved()
      onBack()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailShell
      title={entry.title}
      onBack={onBack}
      bar={<EditBar dirty={dirty} saving={saving} onSave={() => void save()} />}
    >
      <div>
        <span className={label}>标题</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <span className={label}>标签</span>
        <Input value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
      <div>
        <span className={label}>内容</span>
        <Textarea rows={14} value={content} onChange={(e) => setContent(e.target.value)} />
      </div>
    </DetailShell>
  )
}

function Outline({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: list = [], isLoading } = useQuery({
    queryKey: ['novel', 'outlines', projectId],
    queryFn: () => window.api.novel.outlines(projectId)
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = list.find((o) => o.id === editId) ?? null

  if (isLoading) return <Empty text="加载中…" />
  if (list.length === 0) return <Empty text="暂无大纲" />

  if (editing)
    return (
      <OutlineEditor
        key={editing.id}
        projectId={projectId}
        item={editing}
        onBack={() => setEditId(null)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: ['novel', 'outlines', projectId] })
          void qc.invalidateQueries({ queryKey: ['novel', 'chapterBriefs', projectId] })
        }}
      />
    )

  return (
    <div className="space-y-1.5">
      {[...list]
        .sort((a, b) => a.volume - b.volume || a.chapterNo - b.chapterNo)
        .map((o) => (
          <Row
            key={o.id}
            title={`第${o.chapterNo}章 ${o.title || '（未命名）'}`}
            sub={o.synopsis}
            onClick={() => setEditId(o.id)}
          />
        ))}
    </div>
  )
}

function OutlineEditor({
  projectId,
  item,
  onBack,
  onSaved
}: {
  projectId: string
  item: OutlineItem
  onBack: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(item.title)
  const [synopsis, setSynopsis] = useState(item.synopsis)
  const [saving, setSaving] = useState(false)
  const dirty = title !== item.title || synopsis !== item.synopsis

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.novel.outlineSave({
        id: item.id,
        projectId,
        volume: item.volume,
        chapterNo: item.chapterNo,
        title,
        synopsis
      })
      onSaved()
      onBack()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailShell
      title={`第${item.chapterNo}章大纲`}
      onBack={onBack}
      bar={<EditBar dirty={dirty} saving={saving} onSave={() => void save()} />}
    >
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-zinc-900 p-2">
          <span className="text-zinc-500">卷</span> {item.volume}
        </div>
        <div className="rounded-lg bg-zinc-900 p-2">
          <span className="text-zinc-500">章节号</span> {item.chapterNo}
        </div>
        {item.role && (
          <div className="col-span-2 rounded-lg bg-zinc-900 p-2">
            <span className="text-zinc-500">功能</span> {item.role}
          </div>
        )}
        {item.suspense && (
          <div className="col-span-2 rounded-lg bg-zinc-900 p-2">
            <span className="text-zinc-500">悬念</span> {item.suspense}
          </div>
        )}
        {item.hook && (
          <div className="col-span-2 rounded-lg bg-zinc-900 p-2">
            <span className="text-zinc-500">钩子</span> {item.hook}
          </div>
        )}
      </div>
      <div>
        <span className={label}>标题</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <span className={label}>梗概</span>
        <Textarea rows={8} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} />
      </div>
    </DetailShell>
  )
}

const FORESHADOW_STATUS = ['planted', 'resolved', 'abandoned']

function Foreshadows({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: list = [], isLoading } = useQuery({
    queryKey: ['novel', 'foreshadows', projectId],
    queryFn: () => window.api.novel.foreshadows(projectId)
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = list.find((f) => f.id === editId) ?? null

  if (isLoading) return <Empty text="加载中…" />
  if (list.length === 0) return <Empty text="暂无伏笔" />

  if (editing)
    return (
      <ForeshadowEditor
        key={editing.id}
        projectId={projectId}
        item={editing}
        onBack={() => setEditId(null)}
        onSaved={() => void qc.invalidateQueries({ queryKey: ['novel', 'foreshadows', projectId] })}
      />
    )

  return (
    <div className="space-y-1.5">
      {list.map((f: Foreshadow) => (
        <Row
          key={f.id}
          title={f.content}
          sub={`埋设 ${f.plantedChapter || '?'}${f.plannedResolve ? ` · 计划回收 ${f.plannedResolve}` : ''}`}
          right={
            <Badge
              className={
                f.status === 'resolved'
                  ? 'bg-emerald-600/15 text-emerald-400'
                  : f.status === 'abandoned'
                    ? 'bg-zinc-700 text-zinc-400'
                    : 'bg-amber-600/15 text-amber-400'
              }
            >
              {f.status}
            </Badge>
          }
          onClick={() => setEditId(f.id)}
        />
      ))}
    </div>
  )
}

function ForeshadowEditor({
  projectId,
  item,
  onBack,
  onSaved
}: {
  projectId: string
  item: Foreshadow
  onBack: () => void
  onSaved: () => void
}) {
  const [content, setContent] = useState(item.content)
  const [status, setStatus] = useState(item.status)
  const [plannedResolve, setPlannedResolve] = useState(item.plannedResolve)
  const [saving, setSaving] = useState(false)
  const dirty =
    content !== item.content || status !== item.status || plannedResolve !== item.plannedResolve

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.novel.foreshadowSave({
        id: item.id,
        projectId,
        content,
        status,
        plannedResolve
      })
      onSaved()
      onBack()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailShell
      title="伏笔"
      onBack={onBack}
      bar={<EditBar dirty={dirty} saving={saving} onSave={() => void save()} />}
    >
      <div>
        <span className={label}>内容</span>
        <Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
      </div>
      <div>
        <span className={label}>状态</span>
        <div className="flex gap-1.5">
          {FORESHADOW_STATUS.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => setStatus(s)}
              className={`cursor-pointer rounded-full px-3 py-1.5 text-xs ${
                status === s ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className={label}>计划回收于（章节描述）</span>
        <Input value={plannedResolve} onChange={(e) => setPlannedResolve(e.target.value)} />
      </div>
      <div className="rounded-lg bg-zinc-900 p-2.5 text-xs text-zinc-500">
        埋设于 {item.plantedChapter || '（未记录）'}
        {item.resolvedChapter ? ` · 已回收于 ${item.resolvedChapter}` : ''}
        {item.priority ? ` · 优先级 ${item.priority}` : ''}
      </div>
    </DetailShell>
  )
}
