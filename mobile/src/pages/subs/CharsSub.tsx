import { Button, Empty, Input, Label, Textarea } from '@mobile/components/ui'
import { mobileWizardUi } from '@mobile/lib/wizardUi'
import { withSnapshot } from '@mobile/lib/querySnapshot'
import { DetailShell, EditBar, Row } from '@mobile/pages/subs/parts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { parseWikiLinks, useCharacterRegen } from '@wizard/characterTools'
import { CharacterGenPanel } from '@wizard/CharacterGenPanel'
import type { Character } from '@shared/types'

/** 新建空白人物草稿（保存时才落库） */
const DRAFT: Character = {
  id: '',
  projectId: '',
  name: '',
  role: '',
  tags: '',
  card: '',
  state: '',
  createdAt: 0,
  updatedAt: 0
}

/** 人物设定子页：AI 班底生成（预览挑选落库）+ 已入库人物列表 + 单卡编辑 */
export default function CharsSub({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: list = [], isLoading } = useQuery({
    queryKey: ['novel', 'characters', projectId],
    queryFn: withSnapshot(['novel', 'characters', projectId], () =>
      window.api.novel.characters(projectId)
    )
  })
  const [editId, setEditId] = useState<string | null>(null)
  const [draftOpen, setDraftOpen] = useState(false)
  // 生成区收起为入口；面板保持挂载（hidden）以免中断生成/丢预览卡；空库时直接展开
  const [genOpen, setGenOpen] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const editing = draftOpen ? DRAFT : (list.find((c) => c.id === editId) ?? null)
  const showGenPanel = genOpen || list.length === 0
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['novel', 'characters', projectId] })
  }
  const close = (): void => {
    setEditId(null)
    setDraftOpen(false)
  }

  if (editing)
    return (
      <CharacterEditor
        key={draftOpen ? 'draft' : editing.id}
        projectId={projectId}
        character={editing}
        onBack={close}
        onSaved={invalidate}
      />
    )

  return (
    <div className="h-full overflow-y-auto overscroll-contain p-3">
      {!showGenPanel && (
        <button
          type="button"
          onClick={() => setGenOpen(true)}
          className="mb-4 flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 px-3 py-2.5 text-sm text-amber-300/90 active:bg-zinc-900"
        >
          <span>＋</span>
          <span>AI 生成人物班底</span>
          {genBusy && <span className="text-xs text-amber-400">生成中…</span>}
          <span className="ml-auto text-[10px] text-zinc-600">已有 {list.length} 人</span>
        </button>
      )}
      <div className={showGenPanel ? '' : 'hidden'}>
        {list.length > 0 && (
          <div className="mb-1.5 flex justify-end">
            <button
              type="button"
              className="cursor-pointer text-xs text-zinc-500"
              onClick={() => setGenOpen(false)}
            >
              收起
            </button>
          </div>
        )}
        <CharacterGenPanel
          ui={mobileWizardUi}
          projectId={projectId}
          onChanged={invalidate}
          onBusyChange={setGenBusy}
        />
      </div>

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-xs font-medium text-zinc-500">已入库（{list.length}）</span>
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setDraftOpen(true)}>
            + 新增人物
          </Button>
        </div>
        {isLoading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 && !draftOpen ? (
          <Empty text="还没有入库人物——先生成或点「+ 新增人物」手写" />
        ) : (
          <div className="space-y-1.5">
            {list.map((c: Character) => (
              <Row
                key={c.id}
                title={c.name}
                sub={c.role || undefined}
                right={c.tags ? <span className="text-[11px] text-zinc-600">{c.tags}</span> : undefined}
                onClick={() => setEditId(c.id)}
              />
            ))}
          </div>
        )}
      </div>
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
    name !== character.name ||
    role !== character.role ||
    tags !== character.tags ||
    card !== character.card ||
    state !== character.state
  const regen = useCharacterRegen(projectId)
  const { data: appearances } = useQuery({
    queryKey: ['novel', 'characterAppearances', projectId],
    queryFn: withSnapshot(['novel', 'characterAppearances', projectId], () =>
      window.api.novel.characterAppearances(projectId)
    ),
    enabled: !!character.id
  })
  const app = character.id ? appearances?.[character.id] : undefined
  const links = parseWikiLinks(card)

  const save = async (): Promise<void> => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await window.api.novel.characterSave({
        id: character.id || undefined,
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

  const remove = async (): Promise<void> => {
    if (!character.id || !window.confirm(`删除人物「${name || character.name}」？`)) return
    await window.api.novel.characterDelete(character.id)
    onSaved()
    onBack()
  }

  return (
    <DetailShell
      title={name || character.name || '新人物'}
      onBack={onBack}
      dirty={dirty}
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
        <span className="flex items-center justify-between">
          人物卡
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            disabled={regen.busy || !name.trim()}
            onClick={() => regen.run(name.trim(), role || name.trim())}
          >
            {regen.busy ? '生成中…' : 'AI 重生成'}
          </Button>
        </span>
        {regen.error && <span className="mb-1 block text-xs text-red-400">{regen.error}</span>}
        {regen.busy && (
          <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-500">
            {regen.delta.slice(-600) || '生成中…'}
          </pre>
        )}
        {regen.preview && (
          <div className="rounded-md border border-amber-700/50 bg-amber-950/20 p-2">
            <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
              {regen.preview.main}
            </pre>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" className="px-2 py-1 text-xs" onClick={regen.reset}>
                放弃
              </Button>
              <Button
                className="px-2 py-1 text-xs"
                onClick={() => {
                  const p = regen.preview
                  if (!p) return
                  setCard(p.main)
                  setTags(p.tags.join(','))
                  regen.reset()
                }}
              >
                替换人物卡
              </Button>
            </div>
          </div>
        )}
        <Textarea rows={10} value={card} onChange={(e) => setCard(e.target.value)} />
      </Label>
      <Label>
        当前状态（动态）
        <Textarea rows={5} value={state} onChange={(e) => setState(e.target.value)} />
      </Label>
      <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2.5 text-xs text-zinc-400">
        <div className="mb-1 font-medium text-zinc-500">关联</div>
        <div>
          出场章节：
          {app
            ? app.chapters.length > 0
              ? `第 ${app.chapters.join('、')} 章（提及 ${app.count} 次）`
              : '已写章节中尚未出场'
            : '—'}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          世界观链接：
          {links.length > 0 ? (
            links.map((l) => (
              <span key={l} className="rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-300">
                {l}
              </span>
            ))
          ) : (
            <span className="text-zinc-600">无</span>
          )}
        </div>
      </div>
      {character.id && (
        <Button variant="danger" onClick={() => void remove()}>
          删除人物
        </Button>
      )}
    </DetailShell>
  )
}
