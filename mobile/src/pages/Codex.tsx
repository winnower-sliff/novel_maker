import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Badge, Button, Empty, Input, Label, Spinner, Textarea } from '@mobile/components/ui'
import { openWizard, useWizard } from '@wizard/wizardStore'
import type { Character, Foreshadow, OutlineItem, WorldbuildEntry } from '@shared/types'

export type Section = 'characters' | 'world' | 'outline' | 'foreshadow'

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'characters', label: '人物' },
  { key: 'world', label: '世界观' },
  { key: 'outline', label: '大纲' },
  { key: 'foreshadow', label: '伏笔' }
]

export default function Codex({
  projectId,
  jumpSection,
  onJumpConsumed
}: {
  projectId: string
  jumpSection?: Section | null
  onJumpConsumed?: () => void
}) {
  const [open, setOpen] = useState<Section | null>(null)
  const wizard = useWizard()

  useEffect(() => {
    if (!jumpSection) return
    setOpen(jumpSection)
    onJumpConsumed?.()
  }, [jumpSection, onJumpConsumed])

  if (!projectId) return <Empty text="请先在「书架」选择项目" />

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 rounded-xl border border-amber-700/40 bg-gradient-to-b from-amber-950/40 to-zinc-900/60 p-4">
        <div className="text-sm font-semibold text-amber-300">创作向导</div>
        <p className="mt-1 text-[11px] leading-4 text-zinc-400">
          从一句话想法开始：确认设定 → 生成世界观 → 生成人物 → 生成大纲。桌面与手机进度互通。
        </p>
        <div className="mt-2.5 flex items-center gap-2">
          <Button
            className="px-3.5 py-1.5 text-xs"
            onClick={() => openWizard(projectId)}
          >
            {wizard.open && wizard.projectId === projectId ? '回到向导' : '打开创作向导'}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {SECTIONS.map((sec) => {
          const expanded = open === sec.key
          return (
            <div key={sec.key} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : sec.key)}
                className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left"
              >
                <span className={`text-sm font-medium ${expanded ? 'text-amber-400' : 'text-zinc-200'}`}>
                  {sec.label}
                </span>
                <span className="text-xs text-zinc-600">{expanded ? '收起 ▲' : '展开 ▼'}</span>
              </button>
              {expanded && (
                <div className="border-t border-zinc-800 p-2.5">
                  {sec.key === 'characters' && <Characters projectId={projectId} />}
                  {sec.key === 'world' && <World projectId={projectId} />}
                  {sec.key === 'outline' && <Outline projectId={projectId} />}
                  {sec.key === 'foreshadow' && <Foreshadows projectId={projectId} />}
                </div>
              )}
            </div>
          )
        })}
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
      <Label>
        姓名
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Label>
      <Label>
        身份
        <Input value={role} onChange={(e) => setRole(e.target.value)} />
      </Label>
      <Label>
        标签（空格分隔）
        <Input value={tags} onChange={(e) => setTags(e.target.value)} />
      </Label>
      <Label>
        人物卡
        <Textarea rows={10} value={card} onChange={(e) => setCard(e.target.value)} />
      </Label>
      <Label>
        当前状态（动态）
        <Textarea rows={5} value={state} onChange={(e) => setState(e.target.value)} />
      </Label>
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
      <Label>
        标题
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Label>
      <Label>
        标签
        <Input value={tags} onChange={(e) => setTags(e.target.value)} />
      </Label>
      <Label>
        内容
        <Textarea rows={14} value={content} onChange={(e) => setContent(e.target.value)} />
      </Label>
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
      <Label>
        标题
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Label>
      <Label>
        梗概
        <Textarea rows={8} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} />
      </Label>
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
              tone={
                f.status === 'resolved' ? 'green' : f.status === 'abandoned' ? 'default' : 'amber'
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
      <Label>
        内容
        <Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
      </Label>
      <div>
        <Label>状态</Label>
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
      <Label>
        计划回收于（章节描述）
        <Input value={plannedResolve} onChange={(e) => setPlannedResolve(e.target.value)} />
      </Label>
      <div className="rounded-lg bg-zinc-900 p-2.5 text-xs text-zinc-500">
        埋设于 {item.plantedChapter || '（未记录）'}
        {item.resolvedChapter ? ` · 已回收于 ${item.resolvedChapter}` : ''}
        {item.priority ? ` · 优先级 ${item.priority}` : ''}
      </div>
    </DetailShell>
  )
}
