import { Empty, Input, Label, Textarea } from '@mobile/components/ui'
import { mobileWizardUi } from '@mobile/lib/wizardUi'
import { DetailShell, EditBar, Row } from '@mobile/pages/subs/parts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CharacterGenPanel } from '@wizard/CharacterGenPanel'
import type { Character } from '@shared/types'

/** 人物设定子页：AI 班底生成（预览挑选落库）+ 已入库人物列表 + 单卡编辑 */
export default function CharsSub({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: list = [], isLoading } = useQuery({
    queryKey: ['novel', 'characters', projectId],
    queryFn: () => window.api.novel.characters(projectId)
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = list.find((c) => c.id === editId) ?? null
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['novel', 'characters', projectId] })
  }

  if (editing)
    return (
      <CharacterEditor
        key={editing.id}
        projectId={projectId}
        character={editing}
        onBack={() => setEditId(null)}
        onSaved={invalidate}
      />
    )

  return (
    <div className="h-full overflow-y-auto p-3">
      <CharacterGenPanel ui={mobileWizardUi} projectId={projectId} onChanged={invalidate} />

      <div className="mt-4">
        <div className="mb-1.5 px-1 text-xs font-medium text-zinc-500">
          已入库（{list.length}）
        </div>
        {isLoading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text="还没有入库人物——先在上方生成并保存" />
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
