import { useEffect, useState, type ReactNode } from 'react'
import type { Project } from '@shared/types'
import { Badge, Button, Card, Input, Label, Textarea } from '../components/ui'
import type { Navigate } from '../lib/nav'
import { openWizard } from '../lib/wizardStore'

interface Props {
  currentProjectId: string
  onSwitch: (id: string) => void
  onNavigate: Navigate
}

interface EditForm {
  id: string
  title: string
  genre: string
  targetWords: string
  styleGuide: string
}

interface Guide {
  worldbuild: number
  characters: number
  outlines: number
  written: number
}

export default function Projects({ currentProjectId, onSwitch, onNavigate }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [genre, setGenre] = useState('')
  const [targetWords, setTargetWords] = useState('')
  const [styleGuide, setStyleGuide] = useState('')
  const [editForm, setEditForm] = useState<EditForm | null>(null)
  const [guide, setGuide] = useState<Guide | null>(null)

  const load = (): void => {
    void window.api.novel.projects().then(setProjects)
  }

  useEffect(load, [])

  useEffect(() => {
    if (!currentProjectId) {
      setGuide(null)
      return
    }
    void Promise.all([
      window.api.novel.worldbuild(currentProjectId),
      window.api.novel.characters(currentProjectId),
      window.api.novel.outlines(currentProjectId),
      window.api.novel.chapterBriefs(currentProjectId)
    ]).then(([wb, cs, os, br]) => {
      setGuide({
        worldbuild: wb.length,
        characters: cs.length,
        outlines: os.length,
        written: br.filter((b) => b.hasDraft).length
      })
    })
  }, [currentProjectId])

  const create = (): void => {
    if (!title.trim()) return
    void window.api.novel
      .projectCreate({
        title: title.trim(),
        genre: genre.trim(),
        styleGuide: styleGuide.trim(),
        targetWords: parseInt(targetWords, 10) || 0
      })
      .then((p) => {
        setCreating(false)
        setTitle('')
        setGenre('')
        setTargetWords('')
        setStyleGuide('')
        load()
        onSwitch(p.id)
        openWizard(p.id)
      })
      .catch((err: unknown) => window.alert(`创建失败：${(err as Error).message}`))
  }

  const saveEdit = (): void => {
    if (!editForm || !editForm.title.trim()) return
    void window.api.novel
      .projectUpdate(editForm.id, {
        title: editForm.title.trim(),
        genre: editForm.genre.trim(),
        styleGuide: editForm.styleGuide.trim(),
        targetWords: parseInt(editForm.targetWords, 10) || 0
      })
      .then(() => {
        setEditForm(null)
        load()
      })
      .catch((err: unknown) => window.alert(`保存失败：${(err as Error).message}`))
  }

  const remove = (p: Project): void => {
    if (!window.confirm(`确认删除项目「${p.title}」？其大纲/人物/世界观/章节将一并删除。`)) return
    void window.api.novel.projectDelete(p.id).then(() => {
      if (p.id === currentProjectId) onSwitch('')
      load()
    })
  }

  const exportAll = (project: Project, format: 'txt' | 'md' | 'docx'): void => {
    void window.api.exporter
      .run({ projectId: project.id, format, scope: 'all' })
      .then((r) => window.alert(`已导出：${r.path}\n共 ${r.words} 字`))
      .catch((err: unknown) => {
        const msg = (err as Error).message
        if (msg !== '已取消导出') window.alert(`导出失败：${msg}`)
      })
  }

  const newProjectForm = (buttonLabel: string): ReactNode => (
    <Card className="space-y-4 p-4 md:p-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label>书名 *</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：凡人修仙传" />
        </div>
        <div>
          <Label>题材</Label>
          <Input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="仙侠/都市/科幻…" />
        </div>
      </div>
      <div>
        <Label>目标字数</Label>
        <Input
          type="number"
          value={targetWords}
          onChange={(e) => setTargetWords(e.target.value)}
          placeholder="例：2000000"
          className="w-full sm:w-48"
        />
      </div>
      <div>
        <Label>风格指南（会注入每次生成的 system）</Label>
        <Textarea
          rows={4}
          value={styleGuide}
          onChange={(e) => setStyleGuide(e.target.value)}
          placeholder="文风参照、叙事视角、禁忌词、爽点偏好…"
        />
      </div>
      <Button onClick={create} disabled={!title.trim()}>
        {buttonLabel}
      </Button>
    </Card>
  )

  if (!currentProjectId) {
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto p-6">
        <div className="w-full max-w-lg space-y-5">
          <div className="text-center">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="mx-auto h-10 w-10 text-amber-500"
            >
              <path d="M12 6.5C10.5 5 8.5 4.5 4.5 4.5v13c4 0 6 .5 7.5 2 1.5-1.5 3.5-2 7.5-2v-13c-4 0-6 .5-7.5 2Z" />
              <path d="M12 6.5v13" />
            </svg>
            <h1 className="mt-3 text-xl font-semibold text-zinc-100">开始创作</h1>
            <p className="mt-1 text-xs text-zinc-600">新建一本小说，或从下方打开最近的项目</p>
          </div>
          {newProjectForm('创建并打开')}
          {projects.length > 0 && (
            <Card>
              <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200">
                最近项目
              </div>
              <div className="divide-y divide-zinc-800/60">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => onSwitch(p.id)}
                    className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-zinc-800/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{p.title}</span>
                    {p.genre && <span className="shrink-0 text-xs text-zinc-600">{p.genre}</span>}
                    <span className="shrink-0 text-xs text-zinc-600">
                      {new Date(p.updatedAt).toLocaleDateString('zh-CN')}
                    </span>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    )
  }

  const renderStep = (
    key: string,
    label: string,
    doneText: string,
    todoText: string,
    done: boolean,
    target: Parameters<Navigate>[0],
    action: string
  ) => (
    <div key={key} className="flex items-start gap-2.5">
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
          done ? 'bg-emerald-600 text-zinc-950' : 'bg-zinc-700 text-zinc-400'
        }`}
      >
        {done ? '✓' : key}
      </span>
      <div className="min-w-0">
        <div className={`text-xs font-medium ${done ? 'text-zinc-300' : 'text-zinc-200'}`}>{label}</div>
        <div className="mt-0.5 text-[11px] text-zinc-500">{done ? doneText : todoText}</div>
        <Button
          variant="ghost"
          className="mt-1 px-2 py-0.5 text-[11px]"
          onClick={() => onNavigate(target)}
        >
          {action}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="mx-auto max-w-3xl space-y-4 overflow-y-auto p-3 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-zinc-100">
          项目 · {projects.find((p) => p.id === currentProjectId)?.title ?? ''}
        </h1>
        <Button onClick={() => setCreating((v) => !v)}>{creating ? '取消' : '新建项目'}</Button>
      </div>

      {creating && newProjectForm('创建并打开')}

      {editForm && (
        <Card className="space-y-4 p-4 md:p-5">
          <div className="text-sm font-medium text-zinc-200">编辑项目</div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label>书名 *</Label>
              <Input
                value={editForm.title}
                onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
              />
            </div>
            <div>
              <Label>题材</Label>
              <Input
                value={editForm.genre}
                onChange={(e) => setEditForm({ ...editForm, genre: e.target.value })}
              />
            </div>
          </div>
          <div>
            <Label>目标字数</Label>
            <Input
              type="number"
              value={editForm.targetWords}
              onChange={(e) => setEditForm({ ...editForm, targetWords: e.target.value })}
              className="w-full sm:w-48"
            />
          </div>
          <div>
            <Label>风格指南（会注入每次生成的 system）</Label>
            <Textarea
              rows={4}
              value={editForm.styleGuide}
              onChange={(e) => setEditForm({ ...editForm, styleGuide: e.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={saveEdit} disabled={!editForm.title.trim()}>
              保存
            </Button>
            <Button variant="ghost" onClick={() => setEditForm(null)}>
              取消
            </Button>
          </div>
        </Card>
      )}

      {guide && (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200">创作路线</span>
            <span className="text-xs text-zinc-600">建议按 1→4 顺序推进</span>
            <div className="ml-auto">
              <Button variant="ghost" onClick={() => openWizard(currentProjectId)}>
                创作向导
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {renderStep(
              '1',
              '世界观',
              `${guide.worldbuild} 条设定`,
              '搭建力量体系/势力/地理等基础设定',
              guide.worldbuild > 0,
              'worldbuild',
              guide.worldbuild > 0 ? '去完善' : '去建设'
            )}
            {renderStep(
              '2',
              '人物',
              `${guide.characters} 个人物卡`,
              '创建主角/反派等核心人物卡',
              guide.characters > 0,
              'characters',
              guide.characters > 0 ? '去完善' : '去创建'
            )}
            {renderStep(
              '3',
              '大纲',
              `${guide.outlines} 章`,
              'AI 生成或手动录入分卷章节',
              guide.outlines > 0,
              'outline',
              guide.outlines > 0 ? '去完善' : '去生成'
            )}
            {renderStep(
              '4',
              '写作台',
              `已写 ${guide.written} 章`,
              '逐章生成初稿→检查→润色→定稿',
              guide.written > 0,
              'writing',
              guide.written > 0 ? '去续写' : '去开写'
            )}
          </div>
        </Card>
      )}

      <div className="space-y-3">
        {projects.map((p) => (
          <Card key={p.id} className="flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-zinc-100">{p.title}</span>
                {p.id === currentProjectId && <Badge tone="amber">当前</Badge>}
              </div>
              <div className="mt-1 flex gap-x-4 text-xs text-zinc-500">
                {p.genre && <span>{p.genre}</span>}
                {p.targetWords > 0 && <span>目标 {(p.targetWords / 10000).toFixed(0)} 万字</span>}
                <span>更新于 {new Date(p.updatedAt).toLocaleDateString('zh-CN')}</span>
              </div>
            </div>
            {p.id !== currentProjectId && (
              <Button variant="ghost" onClick={() => onSwitch(p.id)}>
                打开
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() =>
                setEditForm({
                  id: p.id,
                  title: p.title,
                  genre: p.genre,
                  targetWords: p.targetWords > 0 ? String(p.targetWords) : '',
                  styleGuide: p.styleGuide
                })
              }
            >
              编辑
            </Button>
            <span className="mx-1 flex gap-1">
              {(['txt', 'md', 'docx'] as const).map((f) => (
                <Button key={f} variant="ghost" className="px-2 py-1 text-xs" onClick={() => exportAll(p, f)}>
                  {f}
                </Button>
              ))}
            </span>
            <Button variant="danger" onClick={() => remove(p)}>
              删除
            </Button>
          </Card>
        ))}
      </div>
    </div>
  )
}
