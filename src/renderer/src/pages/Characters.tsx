import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { parseCardSections } from '../../../shared/characterSections'
import { CharacterGenPanel } from '../../../wizard/CharacterGenPanel'
import { parseWikiLinks, useCharacterRegen } from '../../../wizard/characterTools'
import { AiTextarea } from '../components/AiTextarea'
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

  const load = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.characters(projectId) })
    void queryClient.invalidateQueries({
      queryKey: ['novel', 'characterAppearances', projectId]
    })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId 仅作重置信号
  useEffect(() => {
    setEdit(null)
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

  const pick = (c: (typeof list)[number]): void => {
    regen.reset()
    void window.api.novel
      .characterSections(c.id)
      .then((secs) => {
        setEdit({
          id: c.id,
          name: c.name,
          role: c.role,
          tags: c.tags,
          relation: c.relation,
          sections: secs.map((s) => ({ id: s.id, title: s.title, content: s.content })),
          state: c.state
        })
      })
      .catch((err: unknown) => pushToast('error', err instanceof Error ? err.message : String(err)))
  }

  const save = (): void => {
    if (!edit?.name.trim()) return
    void window.api.novel
      .characterSave({
        id: edit.id || undefined,
        projectId,
        name: edit.name.trim(),
        role: edit.role,
        tags: edit.tags,
        relation: edit.relation,
        sections: edit.sections
          .filter((s) => s.title.trim() || s.content.trim())
          .map((s) => ({ id: s.id, title: s.title.trim(), content: s.content })),
        state: edit.state
      })
      .then((saved) => {
        setEdit((prev) => (prev && !prev.id ? { ...prev, id: saved.id } : prev))
        load()
      })
      .catch((err: unknown) => pushToast('error', err instanceof Error ? err.message : String(err)))
  }

  const newBlank = (): void => {
    regen.reset()
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

  const setSection = (i: number, patch: Partial<SectionDraft>): void => {
    setEdit((prev) =>
      prev
        ? { ...prev, sections: prev.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }
        : prev
    )
  }

  const addSection = (): void => {
    setEdit((prev) =>
      prev ? { ...prev, sections: [...prev.sections, { title: '', content: '' }] } : prev
    )
  }

  const removeSection = (i: number): void => {
    setEdit((prev) =>
      prev ? { ...prev, sections: prev.sections.filter((_, j) => j !== i) } : prev
    )
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <Label>姓名 *</Label>
                <Input
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  placeholder="例：韩立"
                />
              </div>
              <div>
                <Label>定位</Label>
                <Input
                  value={edit.role}
                  onChange={(e) => setEdit({ ...edit, role: e.target.value })}
                  placeholder="主角/反派/师尊…"
                />
              </div>
              <div>
                <Label>标签</Label>
                <Input
                  value={edit.tags}
                  onChange={(e) => setEdit({ ...edit, tags: e.target.value })}
                  placeholder="谨慎,苟道"
                />
              </div>
            </div>
            <div className="mt-3">
              <Label>关联（[[世界观条目|关系短语]]，多个用、分隔）</Label>
              <Input
                value={edit.relation}
                onChange={(e) => setEdit({ ...edit, relation: e.target.value })}
                placeholder="[[丹塔|曾依附丹塔]]、[[云岚宗|宿敌]]"
              />
            </div>
            <div className="mt-3 flex-1">
              <div className="flex items-center justify-between">
                <Label>人物卡分节（M4 写作时自动注入相关人物；正文选中可用 AI 改写）</Label>
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
                        if (!p) return
                        const parsed = parseCardSections(p.main)
                        setEdit({
                          ...edit,
                          sections: parsed.sections,
                          relation: parsed.relation || edit.relation,
                          tags: p.tags.join(',')
                        })
                        regen.reset()
                      }}
                    >
                      替换人物卡
                    </Button>
                  </div>
                </div>
              )}
              <div className="divide-y divide-zinc-800 rounded-md border border-zinc-800">
                {edit.sections.map((s, i) => (
                  <div key={s.id ?? `new-${i}`} className="p-3">
                    <div className="mb-1.5 flex items-center gap-2">
                      <Input
                        className="h-7 w-44 text-xs"
                        value={s.title}
                        onChange={(e) => setSection(i, { title: e.target.value })}
                        placeholder="字段名，如 基本信息"
                      />
                      <span className="flex-1" />
                      <Button
                        variant="ghost"
                        className="px-1.5 py-0.5 text-xs text-red-400"
                        onClick={() => removeSection(i)}
                      >
                        删除
                      </Button>
                    </div>
                    <AiTextarea
                      className="min-h-24"
                      value={s.content}
                      onChange={(v) => setSection(i, { content: v })}
                      placeholder="该字段的正文（markdown）"
                      context={`这是人物「${edit.name || '未命名'}」（定位：${edit.role || '未填'}）人物卡「${s.title || '未命名分节'}」分节的内容：\n${s.content}`}
                    />
                  </div>
                ))}
                {edit.sections.length === 0 && (
                  <div className="p-3 text-center text-xs text-zinc-600">暂无分节</div>
                )}
              </div>
              <Button variant="ghost" className="mt-2 px-2 py-1 text-xs" onClick={addSection}>
                + 添加分节
              </Button>
            </div>
            <div className="mt-3">
              <Label>
                动态状态（定稿章节时由摘要自动同步：物品/能力/身心状态/关系/最近事件；写作时随人物卡注入）
              </Label>
              <textarea
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs leading-5 text-zinc-200 outline-none focus:border-zinc-600"
                rows={Math.min(12, Math.max(3, Math.ceil(edit.state.length / 60)))}
                value={edit.state}
                onChange={(e) => setEdit({ ...edit, state: e.target.value })}
                placeholder={
                  '物品：寒铁长剑（断裂）\n身心状态：左臂旧伤未愈，对宗门起疑\n关系：与云岚由盟转敌\n最近事件：第12章 黑袍人交出半张地图'
                }
              />
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
                }}
              >
                关闭
              </Button>
              <Button onClick={save} disabled={!edit.name.trim()}>
                保存
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
