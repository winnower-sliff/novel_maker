import { Button, Empty, Input, Label, Spinner, Textarea } from '@mobile/components/ui'
import { Markdown } from '@mobile/components/Markdown'
import { withSnapshot } from '@mobile/lib/querySnapshot'
import { qk } from '@renderer/lib/queries'
import { DetailShell, Row } from '@mobile/pages/subs/parts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { parseWikiLinks } from '@shared/wikiLinks'
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
  relation: '',
  state: '',
  createdAt: 0,
  updatedAt: 0
}

interface SectionDraft {
  id?: string
  title: string
  content: string
}

interface CardFields {
  name: string
  role: string
  tags: string
  relation: string
  card: string
  state: string
}

const toFields = (c: Character): CardFields => ({
  name: c.name,
  role: c.role,
  tags: c.tags,
  relation: c.relation,
  card: c.card,
  state: c.state
})

/** 人物设定子页：已入库人物列表 + 单卡编辑 */
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
  const editing = draftOpen ? DRAFT : (list.find((c) => c.id === editId) ?? null)
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
          <Empty text="还没有入库人物，点「+ 新增人物」手写；或到电脑端智能体页让 AI 生成班底" />
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
  // 分节是存储事实源：view 模式只渲染合并视图 card，进入 edit 才拉分节编辑
  const [sections, setSections] = useState<SectionDraft[]>(() =>
    isNew ? [{ title: '基本信息', content: '' }] : []
  )
  const secsBaseRef = useRef<SectionDraft[] | null>(isNew ? [{ title: '基本信息', content: '' }] : null)
  const [secsLoaded, setSecsLoaded] = useState(isNew)
  const baseRef = useRef<CardFields>(toFields(character))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (mode !== 'edit' || isNew || secsLoaded) return
    let alive = true
    void window.api.novel
      .sections('character', projectId, character.id)
      .then((secs) => {
        if (!alive) return
        const drafts = secs.map((s) => ({ id: s.id, title: s.title, content: s.content }))
        setSections(drafts)
        secsBaseRef.current = drafts
        setSecsLoaded(true)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [mode, isNew, secsLoaded, projectId, character.id])

  const secsDirty =
    secsBaseRef.current !== null &&
    JSON.stringify(sections) !== JSON.stringify(secsBaseRef.current)
  const dirty =
    fields.name !== baseRef.current.name ||
    fields.role !== baseRef.current.role ||
    fields.tags !== baseRef.current.tags ||
    fields.relation !== baseRef.current.relation ||
    fields.state !== baseRef.current.state ||
    secsDirty
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
      const cleanSections = sections
        .filter((s) => s.title.trim() || s.content.trim())
        .map((s) => ({ id: s.id, title: s.title.trim(), content: s.content }))
      const saved = await window.api.novel.characterSave({
        id: character.id || undefined,
        projectId,
        name: fields.name,
        role: fields.role,
        tags: fields.tags,
        relation: fields.relation,
        sections: cleanSections,
        state: fields.state
      })
      onSaved()
      const next = toFields(saved)
      setFields(next)
      baseRef.current = next
      // 分节基线作废：下次进编辑重拉，取服务端生成的真实分节 id（clean 里新增节没有 id）
      setSections([])
      secsBaseRef.current = null
      setSecsLoaded(false)
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
    setSections(secsBaseRef.current ?? [])
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
            关联（[[世界观条目|关系短语]]，多个用、分隔）
            <Input
              value={fields.relation}
              onChange={(e) => patch({ relation: e.target.value })}
              placeholder="[[丹塔|曾依附丹塔]]"
            />
          </Label>
          <Label>
            <span>人物卡分节</span>
            {mode === 'edit' && !isNew && !secsLoaded ? (
              <div className="rounded-md border border-zinc-800 p-3 text-xs text-zinc-600">
                分节加载中…
              </div>
            ) : (
              <div className="space-y-2">
                {sections.map((s, i) => (
                  <div key={s.id ?? `new-${i}`} className="rounded-md border border-zinc-800 p-2">
                    <div className="mb-1 flex items-center gap-2">
                      <Input
                        className="h-7 flex-1 text-xs"
                        value={s.title}
                        placeholder="字段名，如 基本信息"
                        onChange={(e) =>
                          setSections((arr) =>
                            arr.map((x, j) => (j === i ? { ...x, title: e.target.value } : x))
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        className="px-1.5 py-0.5 text-xs text-red-400/90"
                        onClick={() => setSections((arr) => arr.filter((_, j) => j !== i))}
                      >
                        删
                      </Button>
                    </div>
                    <Textarea
                      rows={Math.min(12, Math.max(3, Math.ceil(s.content.length / 30)))}
                      value={s.content}
                      onChange={(e) =>
                        setSections((arr) =>
                          arr.map((x, j) => (j === i ? { ...x, content: e.target.value } : x))
                        )
                      }
                    />
                  </div>
                ))}
                <Button
                  variant="ghost"
                  className="w-full px-2 py-1 text-xs"
                  onClick={() => setSections((arr) => [...arr, { title: '', content: '' }])}
                >
                  + 添加分节
                </Button>
              </div>
            )}
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
