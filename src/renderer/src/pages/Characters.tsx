import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { parseCardSections } from '../../../shared/characterSections'
import { splitTags } from '../../../shared/tags'
import { CharacterGenPanel } from '../../../wizard/CharacterGenPanel'
import { parseWikiLinks, useCharacterRegen } from '../../../wizard/characterTools'
import { AiTextarea } from '../components/AiTextarea'
import { Markdown } from '../components/Markdown'
import { Badge, Button, Card, Input, Label } from '../components/ui'
import { desktopWizardUi } from '../lib/desktopWizardUi'
import type { Navigate } from '../lib/nav'
import { qk, queries } from '../lib/queries'
import { pushToast } from '../lib/toastStore'

interface SectionDraft {
  id?: string
  title: string
  content: string
}

interface EditState {
  id: string
  name: string
  role: string
  tags: string
  relation: string
  sections: SectionDraft[]
  state: string
}

const toDrafts = (secs: { id: string; title: string; content: string }[]): SectionDraft[] =>
  secs.map((s) => ({ id: s.id, title: s.title, content: s.content }))

type MetaField = 'name' | 'role' | 'tags' | 'relation'

function MetaInput({
  value,
  saving,
  placeholder,
  width,
  onChange,
  onSave,
  onCancel
}: {
  value: string
  saving: boolean
  placeholder: string
  width?: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Input
        className={`h-7 text-xs ${width ?? 'w-44'}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus
      />
      <Button className="px-2 py-0.5 text-xs" disabled={saving} onClick={onSave}>
        {saving ? '保存中…' : '保存'}
      </Button>
      <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={onCancel}>
        取消
      </Button>
    </span>
  )
}

export default function Characters({
  projectId,
  onNavigate
}: {
  projectId: string
  onNavigate: Navigate
}) {
  const queryClient = useQueryClient()
  const { data: list = [] } = useQuery(queries.characters(projectId))
  const { data: appearances } = useQuery({
    queryKey: ['novel', 'characterAppearances', projectId],
    queryFn: () => window.api.novel.characterAppearances(projectId)
  })
  const [edit, setEdit] = useState<EditState | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const regen = useCharacterRegen(projectId)
  // 分节交互：默认渲染态；draft 非空表示某节处于编辑/新增态（单节切换）
  const [draft, setDraft] = useState<(SectionDraft & { isNew: boolean }) | null>(null)
  const [savingSec, setSavingSec] = useState(false)
  // 元信息逐字段 inline 编辑：metaDraft 非空表示某字段处于编辑态（同屏只开一个）
  const [metaDraft, setMetaDraft] = useState<{ field: MetaField; value: string } | null>(null)
  const [savingMeta, setSavingMeta] = useState(false)
  // 动态状态整块编辑：stateDraft 非 null 表示编辑中
  const [stateDraft, setStateDraft] = useState<string | null>(null)
  const [savingState, setSavingState] = useState(false)

  const load = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.characters(projectId) })
    void queryClient.invalidateQueries({
      queryKey: ['novel', 'characterAppearances', projectId]
    })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId 仅作重置信号
  useEffect(() => {
    setEdit(null)
    setDraft(null)
    setMetaDraft(null)
    setStateDraft(null)
    regen.reset()
  }, [projectId])

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
        请先选择一个项目
        <Button onClick={() => onNavigate('projects')}>去选择项目</Button>
      </div>
    )
  }

  const applySections = (
    id: string,
    secs: { id: string; title: string; content: string }[]
  ): void => {
    setEdit((cur) => (cur && cur.id === id ? { ...cur, sections: toDrafts(secs) } : cur))
  }

  const reloadSections = (id: string): void => {
    void window.api.novel
      .sections('character', projectId, id)
      .then((secs) => applySections(id, secs))
      .catch((err: unknown) => pushToast('error', err instanceof Error ? err.message : String(err)))
  }

  const pick = (c: (typeof list)[number]): void => {
    regen.reset()
    setDraft(null)
    setMetaDraft(null)
    setStateDraft(null)
    void window.api.novel
      .sections('character', projectId, c.id)
      .then((secs) => {
        setEdit({
          id: c.id,
          name: c.name,
          role: c.role,
          tags: c.tags,
          relation: c.relation,
          sections: toDrafts(secs),
          state: c.state
        })
      })
      .catch((err: unknown) => pushToast('error', err instanceof Error ? err.message : String(err)))
  }

  const startEditSection = (s: SectionDraft): void => {
    regen.reset()
    setDraft({ id: s.id, title: s.title, content: s.content, isNew: false })
  }

  const cancelDraft = (): void => setDraft(null)

  const saveDraft = (): void => {
    if (!edit || !draft || savingSec) return
    if (!draft.title.trim() && !draft.content.trim()) {
      pushToast('error', '标题与内容不能都为空')
      return
    }
    setSavingSec(true)
    void window.api.novel
      .sectionSave({
        kind: 'character',
        projectId,
        entityId: edit.id,
        id: draft.isNew ? undefined : draft.id,
        title: draft.title.trim(),
        content: draft.content
      })
      .then(() => {
        setDraft(null)
        reloadSections(edit.id)
        load()
      })
      .catch((err: unknown) => pushToast('error', err instanceof Error ? err.message : String(err)))
      .finally(() => setSavingSec(false))
  }

  const deleteSection = (s: SectionDraft): void => {
    if (!edit || !s.id) return
    if (!window.confirm(`删除分节「${s.title || '未命名'}」？此操作不可恢复。`)) return
    void window.api.novel
      .sectionDelete('character', projectId, edit.id, [s.id])
      .then(() => {
        reloadSections(edit.id)
        load()
      })
      .catch((err: unknown) => pushToast('error', err instanceof Error ? err.message : String(err)))
  }

  const addSection = (): void => {
    regen.reset()
    setDraft({ title: '', content: '', isNew: true })
  }

  // 元信息逐字段保存：只提交被编辑的字段（+必填 name），不触碰分节与状态
  const startMetaEdit = (field: MetaField): void => {
    if (!edit) return
    regen.reset()
    setMetaDraft({ field, value: edit[field] })
  }

  const cancelMetaEdit = (): void => setMetaDraft(null)

  const saveMetaField = (): void => {
    if (!edit || !metaDraft || savingMeta) return
    const { field, value } = metaDraft
    if (field === 'name' && !value.trim()) {
      pushToast('error', '姓名不能为空')
      return
    }
    if (!edit.name.trim() && field !== 'name') {
      pushToast('error', '请先设置姓名')
      return
    }
    setSavingMeta(true)
    const base = {
      id: edit.id,
      projectId,
      name: field === 'name' ? value.trim() : edit.name.trim()
    }
    const payload = field === 'name' ? base : { ...base, [field]: value }
    void window.api.novel
      .characterSave(payload)
      .then((saved) => {
        setMetaDraft(null)
        // 本地写回（load 不刷新本地 edit）；新建流程回写 id，避免后续保存落到无主人物
        setEdit((cur) =>
          cur
            ? {
                ...cur,
                id: saved.id || cur.id,
                ...(field === 'name' ? { name: value.trim() } : { [field]: value })
              }
            : cur
        )
        load()
        pushToast('success', '已保存')
      })
      .catch((err: unknown) => pushToast('error', err instanceof Error ? err.message : String(err)))
      .finally(() => setSavingMeta(false))
  }

  // 动态状态保存：单独提交 state，不触碰分节与元信息
  const startStateEdit = (): void => {
    if (!edit) return
    regen.reset()
    setStateDraft(edit.state)
  }

  const cancelStateEdit = (): void => setStateDraft(null)

  const saveState = (): void => {
    if (!edit || stateDraft === null || savingState) return
    if (!edit.name.trim()) {
      pushToast('error', '请先设置姓名')
      return
    }
    setSavingState(true)
    void window.api.novel
      .characterSave({ id: edit.id, projectId, name: edit.name.trim(), state: stateDraft })
      .then((saved) => {
        setStateDraft(null)
        setEdit((cur) => (cur ? { ...cur, id: saved.id || cur.id, state: stateDraft } : cur))
        load()
        pushToast('success', '状态已保存')
      })
      .catch((err: unknown) => pushToast('error', err instanceof Error ? err.message : String(err)))
      .finally(() => setSavingState(false))
  }

  const newBlank = (): void => {
    regen.reset()
    setDraft(null)
    setEdit({
      id: '',
      name: '',
      role: '',
      tags: '',
      relation: '',
      sections: [{ title: '基本信息', content: '' }],
      state: ''
    })
  }

  const app = edit?.id ? appearances?.[edit.id] : undefined
  const links = edit
    ? parseWikiLinks([...edit.sections.map((s) => s.content), edit.relation].join('\n'))
    : []

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:flex-row md:p-4">
      <Card className="flex max-h-44 shrink-0 flex-col md:max-h-none md:w-64">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2.5">
          <span className="text-sm font-medium text-zinc-200">人物（{list.length}）</span>
          <span className="flex items-center gap-1.5">
            <Button className="px-2 py-1 text-xs" onClick={newBlank}>
              + 新增
            </Button>
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setGenOpen(true)}>
              AI 生成
            </Button>
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {list.length === 0 && (
            <div className="space-y-2.5 p-4 text-center">
              <div className="text-xs text-zinc-600">暂无人物</div>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => setGenOpen(true)}
              >
                用 AI 生成班底
              </Button>
            </div>
          )}
          {list.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => pick(c)}
              className={`mb-1 w-full cursor-pointer rounded-md px-3 py-2 text-left transition-colors ${
                edit?.id === c.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-zinc-200">{c.name}</span>
                {c.role && <Badge>{c.role}</Badge>}
              </div>
              {c.tags && <div className="mt-0.5 truncate text-xs text-zinc-500">{c.tags}</div>}
            </button>
          ))}
        </div>
      </Card>

      <Card className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium text-zinc-200">AI 生成班底</div>
          <Button variant="ghost" onClick={() => setGenOpen((v) => !v)}>
            {genOpen ? '收起' : '展开'}
          </Button>
        </div>
        {genOpen && (
          <div className="mb-4 rounded-md border border-zinc-800 bg-zinc-900/50 p-3">
            <CharacterGenPanel ui={desktopWizardUi} projectId={projectId} onChanged={load} />
          </div>
        )}

        <div className="mb-3 border-t border-zinc-800 pt-3">
          <div className="text-sm font-medium text-zinc-200">
            {edit ? `编辑人物：${edit.name || '未命名'}` : '人物详情'}
          </div>
        </div>

        {!edit ? (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
            从左侧选择人物查看与编辑；还没有人物时先用上方 AI 生成班底
          </div>
        ) : (
          <>
            <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {metaDraft?.field === 'name' ? (
                  <MetaInput
                    value={metaDraft.value}
                    saving={savingMeta}
                    placeholder="例：韩立"
                    onChange={(v) => setMetaDraft({ field: 'name', value: v })}
                    onSave={saveMetaField}
                    onCancel={cancelMetaEdit}
                  />
                ) : (
                  <button
                    type="button"
                    className="group/name flex items-baseline gap-1.5 text-left"
                    onClick={() => startMetaEdit('name')}
                  >
                    <span className="text-lg font-semibold text-zinc-100">
                      {edit.name || '未命名'}
                    </span>
                    <span className="text-xs text-zinc-600 opacity-0 transition-opacity group-hover/name:opacity-100">
                      编辑
                    </span>
                  </button>
                )}
                {metaDraft?.field === 'role' ? (
                  <MetaInput
                    value={metaDraft.value}
                    saving={savingMeta}
                    placeholder="主角/反派/师尊…"
                    width="w-32"
                    onChange={(v) => setMetaDraft({ field: 'role', value: v })}
                    onSave={saveMetaField}
                    onCancel={cancelMetaEdit}
                  />
                ) : edit.role ? (
                  <button type="button" onClick={() => startMetaEdit('role')}>
                    <Badge>{edit.role}</Badge>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-xs text-zinc-600 transition-colors hover:text-zinc-400"
                    onClick={() => startMetaEdit('role')}
                  >
                    定位未设置
                  </button>
                )}
                {metaDraft?.field === 'tags' ? (
                  <MetaInput
                    value={metaDraft.value}
                    saving={savingMeta}
                    placeholder="谨慎,苟道"
                    onChange={(v) => setMetaDraft({ field: 'tags', value: v })}
                    onSave={saveMetaField}
                    onCancel={cancelMetaEdit}
                  />
                ) : (
                  <button
                    type="button"
                    className="group/tags flex flex-wrap items-center gap-1"
                    onClick={() => startMetaEdit('tags')}
                  >
                    {splitTags(edit.tags).length > 0 ? (
                      splitTags(edit.tags).map((t) => <Badge key={t}>{t}</Badge>)
                    ) : (
                      <span className="text-xs text-zinc-600">标签未设置</span>
                    )}
                    <span className="text-xs text-zinc-600 opacity-0 transition-opacity group-hover/tags:opacity-100">
                      编辑
                    </span>
                  </button>
                )}
              </div>
              <div className="mt-2 border-t border-zinc-800 pt-2">
                {metaDraft?.field === 'relation' ? (
                  <MetaInput
                    value={metaDraft.value}
                    saving={savingMeta}
                    placeholder="[[丹塔|曾依附丹塔]]、[[云岚宗|宿敌]]"
                    width="w-full max-w-xl"
                    onChange={(v) => setMetaDraft({ field: 'relation', value: v })}
                    onSave={saveMetaField}
                    onCancel={cancelMetaEdit}
                  />
                ) : (
                  <button
                    type="button"
                    className="group/rel block w-full text-left"
                    onClick={() => startMetaEdit('relation')}
                  >
                    {edit.relation.trim() ? (
                      <Markdown text={edit.relation} className="text-xs leading-5 text-zinc-400" />
                    ) : (
                      <span className="text-xs text-zinc-600">
                        关联未设置（[[世界观条目|关系短语]]，多个用、分隔）
                      </span>
                    )}
                    <span className="ml-1.5 text-xs text-zinc-600 opacity-0 transition-opacity group-hover/rel:opacity-100">
                      编辑
                    </span>
                  </button>
                )}
              </div>
            </div>
            <div className="mt-3 flex-1">
              <div className="flex items-center justify-between">
                <Label>人物卡分节（M4 写作时自动注入相关人物；默认渲染，点编辑修改）</Label>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  disabled={regen.busy || !edit.name.trim()}
                  onClick={() => regen.run(edit.name.trim(), edit.role || edit.name.trim())}
                >
                  {regen.busy ? '生成中…' : 'AI 重生成'}
                </Button>
              </div>
              {regen.error && <div className="mb-1.5 text-xs text-red-400">{regen.error}</div>}
              {regen.busy && (
                <pre className="mb-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-500">
                  {regen.delta.slice(-800) || '生成中…'}
                </pre>
              )}
              {regen.preview && (
                <div className="mb-1.5 rounded-md border border-amber-700/50 bg-amber-950/20 p-2">
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
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
                        if (!p || !edit.id) return
                        const parsed = parseCardSections(p.main)
                        // 整卡替换走 sections 全量提交（批量替换特例），成功后全部进渲染态
                        void window.api.novel
                          .characterSave({
                            id: edit.id,
                            projectId,
                            name:
                              edit.name.trim() ||
                              p.main.match(/^##\s*([^\n#]+)/)?.[1]?.trim() ||
                              edit.name,
                            role: edit.role,
                            tags: p.tags.join(','),
                            relation: parsed.relation || edit.relation,
                            sections: parsed.sections
                          })
                          .then(() => {
                            regen.reset()
                            setDraft(null)
                            setMetaDraft(null)
                            setStateDraft(null)
                            setEdit((cur) =>
                              cur
                                ? {
                                    ...cur,
                                    tags: p.tags.join(','),
                                    relation: parsed.relation || cur.relation
                                  }
                                : cur
                            )
                            reloadSections(edit.id)
                            load()
                            pushToast('success', '人物卡已替换')
                          })
                          .catch((err: unknown) =>
                            pushToast('error', err instanceof Error ? err.message : String(err))
                          )
                      }}
                    >
                      替换人物卡
                    </Button>
                  </div>
                </div>
              )}
              <div className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
                {edit.sections.map((s) =>
                  draft && !draft.isNew && draft.id === s.id ? (
                    <div key={s.id} className="bg-zinc-900/60 p-3">
                      <div className="mb-1.5 flex items-center gap-2">
                        <Input
                          className="h-7 w-44 text-xs"
                          value={draft.title}
                          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                          placeholder="字段名，如 基本信息"
                        />
                        <span className="flex-1" />
                        <Button
                          className="px-2 py-0.5 text-xs"
                          disabled={savingSec}
                          onClick={saveDraft}
                        >
                          {savingSec ? '保存中…' : '保存'}
                        </Button>
                        <Button
                          variant="ghost"
                          className="px-2 py-0.5 text-xs"
                          onClick={cancelDraft}
                        >
                          取消
                        </Button>
                      </div>
                      <AiTextarea
                        className="min-h-24"
                        value={draft.content}
                        onChange={(v) => setDraft({ ...draft, content: v })}
                        placeholder="该字段的正文（markdown）"
                        context={`这是人物「${edit.name || '未命名'}」（定位：${edit.role || '未填'}）人物卡「${draft.title || '未命名分节'}」分节的内容：\n${draft.content}`}
                      />
                    </div>
                  ) : (
                    <div key={s.id} className="group/sec p-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="text-base font-semibold text-zinc-100">
                          {s.title || '（未命名）'}
                        </span>
                        <span className="flex-1" />
                        <Button
                          variant="ghost"
                          className="px-1.5 py-0.5 text-xs opacity-60 transition-opacity hover:opacity-100 group-hover/sec:opacity-100"
                          onClick={() => startEditSection(s)}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          className="px-1.5 py-0.5 text-xs text-red-400 opacity-60 transition-opacity hover:opacity-100 group-hover/sec:opacity-100"
                          onClick={() => deleteSection(s)}
                        >
                          删除
                        </Button>
                      </div>
                      {s.content.trim() ? (
                        <Markdown text={s.content} className="text-xs leading-5 text-zinc-400" />
                      ) : (
                        <div className="text-xs text-zinc-600">（空）</div>
                      )}
                    </div>
                  )
                )}
                {draft?.isNew && (
                  <div className="bg-zinc-900/60 p-3">
                    <div className="mb-1.5 flex items-center gap-2">
                      <Input
                        className="h-7 w-44 text-xs"
                        value={draft.title}
                        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                        placeholder="字段名，如 基本信息"
                      />
                      <span className="flex-1" />
                      <Button
                        className="px-2 py-0.5 text-xs"
                        disabled={savingSec}
                        onClick={saveDraft}
                      >
                        {savingSec ? '保存中…' : '保存'}
                      </Button>
                      <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={cancelDraft}>
                        取消
                      </Button>
                    </div>
                    <AiTextarea
                      className="min-h-24"
                      value={draft.content}
                      onChange={(v) => setDraft({ ...draft, content: v })}
                      placeholder="该字段的正文（markdown）"
                      context={`这是人物「${edit.name || '未命名'}」（定位：${edit.role || '未填'}）人物卡「${draft.title || '未命名分节'}」分节的内容：\n${draft.content}`}
                    />
                  </div>
                )}
                {edit.sections.length === 0 && !draft?.isNew && (
                  <div className="p-3 text-center text-xs text-zinc-600">暂无分节</div>
                )}
              </div>
              <Button
                variant="ghost"
                className="mt-2 px-2 py-1 text-xs"
                disabled={!!draft}
                onClick={addSection}
              >
                + 添加分节
              </Button>
            </div>
            <div className="mt-3">
              <div className="flex items-center justify-between">
                <Label>
                  动态状态（定稿章节时由摘要自动同步：物品/能力/身心状态/关系/最近事件；写作时随人物卡注入）
                </Label>
                {stateDraft === null ? (
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={startStateEdit}>
                    编辑
                  </Button>
                ) : (
                  <span className="flex gap-1.5">
                    <Button
                      className="px-2 py-1 text-xs"
                      disabled={savingState}
                      onClick={saveState}
                    >
                      {savingState ? '保存中…' : '保存'}
                    </Button>
                    <Button variant="ghost" className="px-2 py-1 text-xs" onClick={cancelStateEdit}>
                      取消
                    </Button>
                  </span>
                )}
              </div>
              {stateDraft === null ? (
                edit.state.trim() ? (
                  <Markdown
                    text={edit.state}
                    className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2.5 text-xs leading-5 text-zinc-400"
                  />
                ) : (
                  <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2.5 text-xs text-zinc-600">
                    暂无动态状态
                  </div>
                )
              ) : (
                <textarea
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs leading-5 text-zinc-200 outline-none focus:border-zinc-600"
                  rows={Math.min(12, Math.max(3, Math.ceil(stateDraft.length / 60)))}
                  value={stateDraft}
                  onChange={(e) => setStateDraft(e.target.value)}
                  placeholder={
                    '物品：寒铁长剑（断裂）\n身心状态：左臂旧伤未愈，对宗门起疑\n关系：与云岚由盟转敌\n最近事件：第12章 黑袍人交出半张地图'
                  }
                />
              )}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-2">
              <div>
                <Label>出场章节</Label>
                <div className="text-xs text-zinc-400">
                  {app
                    ? app.chapters.length > 0
                      ? `第 ${app.chapters.join('、')} 章（提及 ${app.count} 次）`
                      : '已写章节中尚未出场'
                    : '—'}
                </div>
              </div>
              <div>
                <Label>世界观链接（[[条目]]）</Label>
                <div className="flex flex-wrap gap-1">
                  {links.length > 0 ? (
                    links.map((l) => (
                      <Badge key={l} tone="amber">
                        {l}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-zinc-600">无</span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              {edit.id && (
                <Button
                  variant="danger"
                  onClick={() => {
                    if (!window.confirm(`删除人物「${edit.name}」？`)) return
                    void window.api.novel.characterDelete(edit.id).then(() => {
                      setEdit(null)
                      setDraft(null)
                      setMetaDraft(null)
                      setStateDraft(null)
                      load()
                    })
                  }}
                >
                  删除
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  regen.reset()
                  setEdit(null)
                  setDraft(null)
                  setMetaDraft(null)
                  setStateDraft(null)
                }}
              >
                关闭
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
