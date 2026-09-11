import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { Badge, Button, Card, Input, Label, Textarea } from '../components/ui'

interface Props {
  currentProjectId: string
  onSwitch: (id: string) => void
}

export default function Projects({ currentProjectId, onSwitch }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [genre, setGenre] = useState('')
  const [targetWords, setTargetWords] = useState('')
  const [styleGuide, setStyleGuide] = useState('')

  const load = (): void => {
    void window.api.novel.projects().then(setProjects)
  }

  useEffect(load, [])

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
      })
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

  return (
    <div className="mx-auto max-w-3xl space-y-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">项目</h1>
        <Button onClick={() => setCreating((v) => !v)}>{creating ? '取消' : '新建项目'}</Button>
      </div>

      {creating && (
        <Card className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-4">
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
              className="w-48"
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
            创建并打开
          </Button>
        </Card>
      )}

      {projects.length === 0 && !creating && (
        <Card className="p-10 text-center text-sm text-zinc-600">
          还没有项目，点右上角「新建项目」开始第一本书
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
