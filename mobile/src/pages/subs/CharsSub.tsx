import { Button, Empty, Input, Label, Spinner, Textarea } from '@mobile/components/ui'
import { Markdown } from '@mobile/components/Markdown'
import { mobileWizardUi } from '@mobile/lib/wizardUi'
import { withSnapshot } from '@mobile/lib/querySnapshot'
import { qk } from '@renderer/lib/queries'
import { DetailShell, Row } from '@mobile/pages/subs/parts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { parseWikiLinks, useCharacterRegen } from '@wizard/characterTools'
import { CharacterGenPanel } from '@wizard/CharacterGenPanel'
import { splitTags } from '@shared/tags'
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

interface CardFields {
  name: string
  role: string
  tags: string
  card: string
  state: string
}

const toFields = (c: Character): CardFields => ({
  name: c.name,
  role: c.role,
  tags: c.tags,
  card: c.card,
  state: c.state
})

/** 人物设定子页：AI 班底生成（预览挑选落库）+ 已入库人物列表 + 单卡编辑 */
export default function CharsSub({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: list = [], isLoading } = useQuery({
    queryKey: qk.characters(projectId),
    queryFn: withSnapshot(qk.characters(projectId), () =>
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
    void qc.invalidateQueries({ queryKey: qk.characters(projectId) })
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
  const isNew = !character.id
  const [mode, setMode] = useState<'view' | 'edit'>(isNew ? 'edit' : 'view')
  const [fields, setFields] = useState<CardFields>(() => toFields(character))
  const baseRef = useRef<CardFields>(toFields(character))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const dirty =
    fields.name !== baseRef.current.name ||
    fields.role !== baseRef.current.role ||
    fields.tags !== baseRef.current.tags ||
    fields.card !== baseRef.current.card ||
    fields.state !== baseRef.current.state
  const regen = useCharacterRegen(projectId)
  const { data: appearances } = useQuery({
    queryKey: qk.characterAppearances(projectId),
    queryFn: withSnapshot(qk.characterAppearances(projectId), () =>
      window.api.novel.characterAppearances(projectId)
    ),
    enabled: !isNew
  })
  const app = character.id ? appearances?.[character.id] : undefined
  const links = parseWikiLinks(fields.card)
  const tags = splitTags(fields.tags)
  const patch = (p: Partial<CardFields>): void => setFields((f) => ({ ...f, ...p }))

  const save = async (): Promise<void> => {
    if (!fields.name.trim() || saving) return
    setSaving(true)
    try {
      await window.api.novel.characterSave({
        id: character.id || undefined,
        projectId,
        name: fields.name,
        role: fields.role,
        tags: fields.tags,
        card: fields.card,
        state: fields.state
      })
      onSaved()
      baseRef.current = { ...fields }
      // 新建草稿没有 id，回去也没有可浏览的查看态，直接回列表
      if (isNew) onBack()
      else setMode('view')
    } finally {
      setSaving(false)
    }
  }

  const cancelEdit = (): void => {
    if (dirty && !window.confirm('放弃未保存的修改？')) return
    if (isNew) {
      onBack()
      return
    }
    setFields({ ...baseRef.current })
    regen.reset()
    setMode('view')
  }

  const leave = (): void => {
    if (mode === 'edit') {
      cancelEdit()
      return
    }
    onBack()
  }

  const remove = async (): Promise<void> => {
    if (!character.id || saving || deleting) return
    if (!window.confirm(`删除人物「${fields.name || character.name}」？`)) return
    setDeleting(true)
    try {
      await window.api.novel.characterDelete(character.id)
      onSaved()
      onBack()
    } finally {
      setDeleting(false)
    }
  }

  const relationBlock = (
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
  )

  const bar =
    mode === 'view' ? (
      <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <span className="text-xs text-zinc-600">只读浏览</span>
        <Button className="ml-auto px-5 py-1.5 text-xs" onClick={() => setMode('edit')}>
          编辑
        </Button>
      </div>
    ) : (
      <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {character.id && (
          <Button
            variant="ghost"
            className="px-2 py-1.5 text-xs text-red-400/90"
            disabled={deleting || saving}
            onClick={() => void remove()}
          >
            {deleting ? <Spinner className="h-3.5 w-3.5" /> : '删除'}
          </Button>
        )}
        <span className="text-xs text-zinc-600">{dirty ? '有未保存修改' : '已保存'}</span>
        <Button
          variant="ghost"
          className="ml-auto px-3.5 py-1.5 text-xs"
          disabled={saving}
          onClick={cancelEdit}
        >
          取消
        </Button>
        <Button
          className="px-3.5 py-1.5 text-xs"
          disabled={!dirty || saving || !fields.name.trim()}
          onClick={() => void save()}
        >
          {saving ? <Spinner className="h-3.5 w-3.5" /> : '保存'}
        </Button>
      </div>
    )

  return (
    <DetailShell
      title={fields.name || character.name || '新人物'}
      onBack={leave}
      dirty={false}
      bar={bar}
    >
      {mode === 'view' ? (
        <>
          {(fields.role || tags.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {fields.role && (
                <span className="rounded-full bg-amber-600/20 px-2.5 py-0.5 text-xs text-amber-300">
                  {fields.role}
                </span>
              )}
              {tags.map((t) => (
                <span key={t} className="rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400">
                  {t}
                </span>
              ))}
            </div>
          )}
          {fields.card.trim() ? (
            <section>
              <Label>人物卡</Label>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <Markdown text={fields.card} className="text-sm leading-6 text-zinc-200" />
              </div>
            </section>
          ) : (
            <div className="text-xs text-zinc-600">尚无人物卡，点右下角「编辑」补充</div>
          )}
          {fields.state.trim() ? (
            <section>
              <Label>当前状态（动态）</Label>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <Markdown text={fields.state} className="text-sm leading-6 text-zinc-300" />
              </div>
            </section>
          ) : (
            <div className="text-xs text-zinc-600">暂无动态状态</div>
          )}
          {relationBlock}
        </>
      ) : (
        <>
          <Label>
            姓名
            <Input value={fields.name} onChange={(e) => patch({ name: e.target.value })} />
          </Label>
          <Label>
            身份
            <Input value={fields.role} onChange={(e) => patch({ role: e.target.value })} />
          </Label>
          <Label>
            标签（逗号或、分隔）
            <Input value={fields.tags} onChange={(e) => patch({ tags: e.target.value })} />
          </Label>
          <Label>
            <span className="flex items-center justify-between">
              人物卡
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                disabled={regen.busy || !fields.name.trim()}
                onClick={() => regen.run(fields.name.trim(), fields.role || fields.name.trim())}
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
                <div className="max-h-44 overflow-y-auto">
                  <Markdown
                    text={regen.preview.main}
                    className="text-xs leading-relaxed text-zinc-300"
                  />
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={regen.reset}>
                    放弃
                  </Button>
                  <Button
                    className="px-2 py-1 text-xs"
                    onClick={() => {
                      const p = regen.preview
                      if (!p) return
                      patch({ card: p.main, tags: p.tags.join(',') })
                      regen.reset()
                    }}
                  >
                    替换人物卡
                  </Button>
                </div>
              </div>
            )}
            <Textarea
              rows={10}
              value={fields.card}
              onChange={(e) => patch({ card: e.target.value })}
            />
          </Label>
          <Label>
            当前状态（动态）
            <Textarea
              rows={5}
              value={fields.state}
              onChange={(e) => patch({ state: e.target.value })}
            />
          </Label>
          {relationBlock}
        </>
      )}
    </DetailShell>
  )
}
