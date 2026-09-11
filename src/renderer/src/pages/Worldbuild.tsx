import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorldbuildEntry } from '@shared/types'
import { Button, Card, Input, Label, Select, Textarea } from '../components/ui'

const CATEGORIES = ['力量体系', '地理', '势力', '历史', '物品', '其他']

interface EditState {
  id?: string
  category: string
  title: string
  content: string
}

const EMPTY: EditState = { category: '力量体系', title: '', content: '' }

export default function Worldbuild({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<WorldbuildEntry[]>([])
  const [filter, setFilter] = useState('全部')
  const [edit, setEdit] = useState<EditState>(EMPTY)
  const [formOpen, setFormOpen] = useState(false)

  const load = useCallback((): void => {
    if (!projectId) return
    void window.api.novel.worldbuild(projectId).then(setEntries)
  }, [projectId])

  useEffect(() => {
    setEntries([])
    setEdit(EMPTY)
    setFormOpen(false)
    load()
  }, [load])

  const filtered = useMemo(
    () => (filter === '全部' ? entries : entries.filter((e) => e.category === filter)),
    [entries, filter]
  )

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        请先在「项目」页打开一个项目
      </div>
    )
  }

  const save = (): void => {
    if (!edit.title.trim()) return
    void window.api.novel
      .worldbuildSave({
        id: edit.id,
        projectId,
        category: edit.category,
        title: edit.title.trim(),
        content: edit.content
      })
      .then(() => {
        setEdit(EMPTY)
        setFormOpen(false)
        load()
      })
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold text-zinc-100">世界观</h1>
        <div className="ml-4 flex flex-wrap gap-1.5">
          {['全部', ...CATEGORIES].map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`cursor-pointer rounded-full px-3 py-1 text-xs transition-colors ${
                filter === c ? 'bg-amber-600 font-medium text-zinc-950' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <Button className="ml-auto" onClick={() => { setEdit(EMPTY); setFormOpen(true) }}>
          新增条目
        </Button>
      </div>

      {formOpen ? (
        <Card className="space-y-3 p-4">
          <div className="grid grid-cols-4 gap-3">
            <div>
              <Label>分类</Label>
              <Select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} className="w-full">
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <div className="col-span-3">
              <Label>标题 *</Label>
              <Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </div>
          </div>
          <Textarea
            rows={6}
            value={edit.content}
            onChange={(e) => setEdit({ ...edit, content: e.target.value })}
            placeholder="条目内容（markdown，要点式）"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button onClick={save} disabled={!edit.title.trim()}>
              保存
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-y-auto pb-2">
        {filtered.length === 0 && (
          <Card className="col-span-2 p-10 text-center text-sm text-zinc-600">
            暂无条目（M4 将支持 AI 辅助生成）
          </Card>
        )}
        {filtered.map((e) => (
          <Card key={e.id} className="group p-4">
            <div className="flex items-center gap-2">
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{e.category}</span>
              <span className="truncate text-sm font-medium text-zinc-200">{e.title}</span>
              <div className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => { setEdit({ id: e.id, category: e.category, title: e.title, content: e.content }); setFormOpen(true) }}
                >
                  编辑
                </Button>
                <Button
                  variant="danger"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => {
                    if (window.confirm(`删除「${e.title}」？`))
                      void window.api.novel.worldbuildDelete(e.id).then(load)
                  }}
                >
                  删除
                </Button>
              </div>
            </div>
            <div className="mt-2 line-clamp-6 whitespace-pre-wrap text-xs leading-5 text-zinc-400">
              {e.content}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
