import { useCallback, useEffect, useState } from 'react'
import type { Foreshadow } from '@shared/types'
import { Badge, Button, Card, Input, Label } from '../components/ui'
import type { Navigate } from '../lib/nav'

export default function Foreshadows({ projectId, onNavigate }: { projectId: string; onNavigate: Navigate }) {
  const [list, setList] = useState<Foreshadow[]>([])
  const [content, setContent] = useState('')
  const [planted, setPlanted] = useState('')

  const load = useCallback((): void => {
    if (!projectId) return
    void window.api.novel.foreshadows(projectId).then(setList)
  }, [projectId])

  useEffect(() => {
    setList([])
    load()
  }, [load])

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
        请先选择一个项目
        <Button onClick={() => onNavigate('projects')}>去选择项目</Button>
      </div>
    )
  }

  const open = list.filter((f) => f.status === 'open')
  const resolved = list.filter((f) => f.status !== 'open')

  const add = (): void => {
    if (!content.trim()) return
    void window.api.novel
      .foreshadowSave({ projectId, content: content.trim(), plantedChapter: planted.trim() })
      .then(() => {
        setContent('')
        setPlanted('')
        load()
      })
  }

  const toggle = (f: Foreshadow): void => {
    if (f.status === 'open') {
      const where = window.prompt('回收于（如：第42章）', '') ?? ''
      void window.api.novel
        .foreshadowSave({ id: f.id, projectId, content: f.content, plantedChapter: f.plantedChapter, status: 'resolved', resolvedChapter: where })
        .then(load)
    } else {
      void window.api.novel
        .foreshadowSave({ id: f.id, projectId, content: f.content, plantedChapter: f.plantedChapter, status: 'open', resolvedChapter: '' })
        .then(load)
    }
  }

  const renderGroup = (title: string, items: Foreshadow[], tone: 'amber' | 'green', emptyHint?: boolean) => (
    <Card className="min-h-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-2.5">
        <span className="text-sm font-medium text-zinc-200">{title}</span>
        <Badge tone={tone}>{items.length}</Badge>
      </div>
      <div className="divide-y divide-zinc-800/60">
        {items.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-xs leading-5 text-zinc-600">
            {emptyHint ? '暂无未回收伏笔——写作台定稿时 AI 会自动登记，也可在上方手动添加' : '暂无'}
            {emptyHint && (
              <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => onNavigate('writing')}>
                去写作台定稿
              </Button>
            )}
          </div>
        )}
        {items.map((f) => (
          <div key={f.id} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-800/30">
            <span className="min-w-0 flex-1 text-sm leading-6 text-zinc-300">{f.content}</span>
            <span className="shrink-0 text-xs text-zinc-600">{f.plantedChapter || '?'}</span>
            {f.status !== 'open' && <span className="shrink-0 text-xs text-emerald-500">→ {f.resolvedChapter || '?'}</span>}
            <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => toggle(f)}>
                {f.status === 'open' ? '回收' : '重开'}
              </Button>
              <Button
                variant="danger"
                className="px-2 py-0.5 text-xs"
                onClick={() => {
                  if (window.confirm('删除该伏笔记录？')) void window.api.novel.foreshadowDelete(f.id).then(load)
                }}
              >
                删除
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">伏笔台账</h1>
        <span className="text-xs text-zinc-600">章节定稿时由 AI 摘要自动登记/回收，也可手动维护</span>
      </div>

      <Card className="grid grid-cols-1 items-end gap-3 p-3 sm:grid-cols-12 md:p-4">
        <div className="sm:col-span-7">
          <Label>伏笔内容</Label>
          <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder="例：师父留下的玉佩内藏残魂" />
        </div>
        <div className="sm:col-span-3">
          <Label>埋设于</Label>
          <Input value={planted} onChange={(e) => setPlanted(e.target.value)} placeholder="第3章" />
        </div>
        <div className="sm:col-span-2">
          <Button className="w-full" onClick={add} disabled={!content.trim()}>
            添加
          </Button>
        </div>
      </Card>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
        {renderGroup('未回收', open, 'amber', true)}
        {renderGroup('已回收', resolved, 'green')}
      </div>
    </div>
  )
}
