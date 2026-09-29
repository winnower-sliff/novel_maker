import { useCallback, useEffect, useRef, useState } from 'react'
import type { Character } from '@shared/types'
import { AiTextarea } from '../components/AiTextarea'
import { Badge, Button, Card, Input, Label } from '../components/ui'
import { runPipeline } from '../lib/ipc'
import type { Navigate } from '../lib/nav'
import { pushToast } from '../lib/toastStore'
import { openWizard } from '../lib/wizardStore'

interface EditState {
  id?: string
  name: string
  role: string
  tags: string
  card: string
  state: string
}

const EMPTY: EditState = { name: '', role: '', tags: '', card: '', state: '' }

export default function Characters({ projectId, onNavigate }: { projectId: string; onNavigate: Navigate }) {
  const [list, setList] = useState<Character[]>([])
  const [edit, setEdit] = useState<EditState>(EMPTY)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [genBrief, setGenBrief] = useState('')
  const [genName, setGenName] = useState('')
  const [genAllowUpdate, setGenAllowUpdate] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genOutput, setGenOutput] = useState('')
  const [revisedIds, setRevisedIds] = useState<string[]>([])

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
      .characterSave({ id: edit.id, projectId, name: edit.name.trim(), role: edit.role, tags: edit.tags, card: edit.card, state: edit.state })
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
      {
        projectId,
        brief: genBrief.trim(),
        name: genName.trim(),
        allowUpdate: genAllowUpdate || undefined
      },
      (text) => setGenOutput((prev) => (prev + text).slice(-1500))
    )
      .then((payload) => {
        const d = payload.data as {
          characterId?: string
          name?: string
          revised?: Array<{ id: string; name: string }>
          error?: string
        }
        if (d?.error) window.alert(`生成完成但保存失败：${d.error}`)
        if (d?.revised && d.revised.length > 0) {
          pushToast(
            'success',
            `已同步修订 ${d.revised.length} 个人物：${d.revised.map((x) => x.name).join('、')}（列表中橙点标识）`
          )
          setRevisedIds((cur) => [...new Set([...cur, ...d.revised!.map((x) => x.id)])])
        }
        setGenerating(false)
        setGenOpen(false)
        setGenBrief('')
        setGenName('')
        load()
        if (d?.characterId) {
          setSelectedId(d.characterId)
          void window.api.novel.characters(projectId).then((cs) => {
            const c = cs.find((x) => x.id === d.characterId)
            if (c) setEdit({ id: c.id, name: c.name, role: c.role, tags: c.tags, card: c.card, state: c.state })
          })
        }
      })
      .catch((err: unknown) => {
        setGenerating(false)
        window.alert(`出错：${(err as Error).message}`)
      })
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:flex-row md:p-4">
      <Card className="flex max-h-44 shrink-0 flex-col md:max-h-none md:w-64">
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
          {list.length === 0 && (
            <div className="space-y-2.5 p-4 text-center">
              <div className="text-xs text-zinc-600">暂无人物</div>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => openWizard(projectId, 2)}
              >
                用创作向导生成
              </Button>
            </div>
          )}
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setSelectedId(c.id)
                setEdit({ id: c.id, name: c.name, role: c.role, tags: c.tags, card: c.card, state: c.state })
                setRevisedIds((cur) => cur.filter((x) => x !== c.id))
              }}
              className={`mb-1 w-full cursor-pointer rounded-md px-3 py-2 text-left transition-colors ${
                selectedId === c.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
              }`}
            >
              <div className="flex items-center gap-2">
                {revisedIds.includes(c.id) && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
                    title="AI 生成时被修订，点开后不再提示"
                  />
                )}
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
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <Label>预备名（可空，AI 会从输出推断）</Label>
                <Input value={genName} onChange={(e) => setGenName(e.target.value)} disabled={generating} />
              </div>
              <div className="md:col-span-3">
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
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={genAllowUpdate}
                  onChange={(e) => setGenAllowUpdate(e.target.checked)}
                  disabled={generating}
                  className="h-3.5 w-3.5 cursor-pointer accent-amber-600"
                />
                允许修订已有人物（AI 视新人物带来的关系变化，顺带修订已有人物卡并直接覆盖）
              </label>
            </div>
            {generating && (
              <pre className="max-h-28 overflow-hidden rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-600">
                {genOutput || '等待模型输出…'}
              </pre>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
        <div className="mt-3">
          <Label>
            动态状态（定稿章节时由摘要自动同步：物品/能力/身心状态/关系/最近事件；写作时随人物卡注入）
          </Label>
          <textarea
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs leading-5 text-zinc-200 outline-none focus:border-zinc-600"
            rows={Math.min(12, Math.max(3, Math.ceil(edit.state.length / 60)))}
            value={edit.state}
            onChange={(e) => setEdit({ ...edit, state: e.target.value })}
            placeholder={'物品：寒铁长剑（断裂）\n身心状态：左臂旧伤未愈，对宗门起疑\n关系：与云岚由盟转敌\n最近事件：第12章 黑袍人交出半张地图'}
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
