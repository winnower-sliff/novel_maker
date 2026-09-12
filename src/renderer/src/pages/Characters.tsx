import { useCallback, useEffect, useRef, useState } from 'react'
import type { Character } from '@shared/types'
import { AiTextarea } from '../components/AiTextarea'
import { Badge, Button, Card, Input, Label } from '../components/ui'
import { runPipeline } from '../lib/ipc'
import type { Navigate } from '../lib/nav'

interface EditState {
  id?: string
  name: string
  role: string
  tags: string
  card: string
}

const EMPTY: EditState = { name: '', role: '', tags: '', card: '' }

export default function Characters({ projectId, onNavigate }: { projectId: string; onNavigate: Navigate }) {
  const [list, setList] = useState<Character[]>([])
  const [edit, setEdit] = useState<EditState>(EMPTY)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [genBrief, setGenBrief] = useState('')
  const [genName, setGenName] = useState('')
  const [generating, setGenerating] = useState(false)
  const [genOutput, setGenOutput] = useState('')

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
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
        请先选择一个项目
        <Button onClick={() => onNavigate('projects')}>去选择项目</Button>
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

  const generate = (): void => {
    if (!genBrief.trim() || generating) return
    setGenerating(true)
    setGenOutput('')
    void runPipeline(
      'character',
      { projectId, brief: genBrief.trim(), name: genName.trim() },
      (text) => setGenOutput((prev) => (prev + text).slice(-1500))
    )
      .then((payload) => {
        const d = payload.data as { characterId?: string; name?: string; error?: string }
        if (d?.error) window.alert(`生成完成但保存失败：${d.error}`)
        setGenerating(false)
        setGenOpen(false)
        setGenBrief('')
        setGenName('')
        load()
        if (d?.characterId) {
          setSelectedId(d.characterId)
          void window.api.novel.characters(projectId).then((cs) => {
            const c = cs.find((x) => x.id === d.characterId)
            if (c) setEdit({ id: c.id, name: c.name, role: c.role, tags: c.tags, card: c.card })
          })
        }
      })
      .catch((err: unknown) => {
        setGenerating(false)
        window.alert(`出错：${(err as Error).message}`)
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
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-medium text-zinc-200">
            {edit.id ? '编辑人物' : '新建人物'}
          </div>
          <Button variant="ghost" onClick={() => setGenOpen((v) => !v)} disabled={generating}>
            {generating ? 'AI 生成中…' : 'AI 生成人物卡'}
          </Button>
        </div>

        {genOpen && (
          <div className="mb-4 space-y-2.5 rounded-md border border-zinc-800 bg-zinc-900 p-3">
            <div className="grid grid-cols-4 gap-3">
              <div>
                <Label>预备名（可空，AI 会从输出推断）</Label>
                <Input value={genName} onChange={(e) => setGenName(e.target.value)} disabled={generating} />
              </div>
              <div className="col-span-3">
                <Label>人物需求（定位、性格方向、与主线的关联）</Label>
                <Input
                  value={genBrief}
                  onChange={(e) => setGenBrief(e.target.value)}
                  placeholder="例：女主的师兄，表面温和实则城府极深，后期黑化成第二卷大反派"
                  disabled={generating}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={generate} disabled={!genBrief.trim() || generating}>
                生成并保存
              </Button>
              <span className="text-xs text-zinc-600">生成结果自动保存为新人物卡</span>
            </div>
            {generating && (
              <pre className="max-h-28 overflow-hidden rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-600">
                {genOutput || '等待模型输出…'}
              </pre>
            )}
          </div>
        )}

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
          <Label>人物卡（markdown，M4 写作时自动注入相关人物；选中文字可用 AI 改写）</Label>
          <AiTextarea
            className="h-full min-h-72"
            value={edit.card}
            onChange={(v) => setEdit({ ...edit, card: v })}
            placeholder={'- 基本信息：…\n- 性格核心：…\n- 欲望与恐惧：…\n- 口癖与语言习惯：…'}
            context={
              edit.id
                ? `这是人物「${edit.name || '未命名'}」（定位：${edit.role || '未填'}）的人物卡全文：\n${edit.card}`
                : undefined
            }
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
