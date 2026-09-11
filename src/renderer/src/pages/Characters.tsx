import { useCallback, useEffect, useState } from 'react'
import type { Character } from '@shared/types'
import { Badge, Button, Card, Input, Label, Textarea } from '../components/ui'

interface EditState {
  id?: string
  name: string
  role: string
  tags: string
  card: string
}

const EMPTY: EditState = { name: '', role: '', tags: '', card: '' }

export default function Characters({ projectId }: { projectId: string }) {
  const [list, setList] = useState<Character[]>([])
  const [edit, setEdit] = useState<EditState>(EMPTY)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback((): void => {
    if (!projectId) return
    void window.api.novel.characters(projectId).then(setList)
  }, [projectId])

  useEffect(() => {
    setList([])
    setEdit(EMPTY)
    setSelectedId(null)
    load()
  }, [load])

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-600">
        请先在「项目」页打开一个项目
      </div>
    )
  }

  const save = (): void => {
    if (!edit.name.trim()) return
    void window.api.novel
      .characterSave({ id: edit.id, projectId, name: edit.name.trim(), role: edit.role, tags: edit.tags, card: edit.card })
      .then((saved) => {
        setEdit(EMPTY)
        setSelectedId(null)
        load()
      })
  }

  return (
    <div className="flex h-full gap-3 p-4">
      <Card className="flex w-64 shrink-0 flex-col">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2.5">
          <span className="text-sm font-medium text-zinc-200">人物（{list.length}）</span>
          <Button
            className="px-2 py-1 text-xs"
            onClick={() => {
              setEdit(EMPTY)
              setSelectedId(null)
            }}
          >
            + 新建
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {list.length === 0 && <div className="p-4 text-center text-xs text-zinc-600">暂无人物</div>}
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setSelectedId(c.id)
                setEdit({ id: c.id, name: c.name, role: c.role, tags: c.tags, card: c.card })
              }}
              className={`mb-1 w-full cursor-pointer rounded-md px-3 py-2 text-left transition-colors ${
                selectedId === c.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
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
        <div className="mb-4 text-sm font-medium text-zinc-200">
          {edit.id ? '编辑人物' : '新建人物'}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>姓名 *</Label>
            <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="例：韩立" />
          </div>
          <div>
            <Label>定位</Label>
            <Input value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} placeholder="主角/反派/师尊…" />
          </div>
          <div>
            <Label>标签</Label>
            <Input value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} placeholder="谨慎,苟道" />
          </div>
        </div>
        <div className="mt-3 flex-1">
          <Label>人物卡（markdown，M4 写作时自动注入相关人物）</Label>
          <Textarea
            className="h-[calc(100%-2rem)] min-h-72"
            value={edit.card}
            onChange={(e) => setEdit({ ...edit, card: e.target.value })}
            placeholder={'- 基本信息：…\n- 性格核心：…\n- 欲望与恐惧：…\n- 口癖与语言习惯：…'}
          />
        </div>
        <div className="mt-3 flex justify-end gap-2">
          {edit.id && (
            <Button
              variant="danger"
              onClick={() => {
                if (!window.confirm(`删除人物「${edit.name}」？`)) return
                void window.api.novel.characterDelete(edit.id!).then(() => {
                  setEdit(EMPTY)
                  setSelectedId(null)
                  load()
                })
              }}
            >
              删除
            </Button>
          )}
          <Button variant="ghost" onClick={() => { setEdit(EMPTY); setSelectedId(null) }}>
            清空
          </Button>
          <Button onClick={save} disabled={!edit.name.trim()}>
            保存
          </Button>
        </div>
      </Card>
    </div>
  )
}
