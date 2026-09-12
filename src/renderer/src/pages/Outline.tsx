import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OutlineItem, OutlineStatus } from '@shared/types'
import { Badge, Button, Card, Input, Label, Select, Textarea } from '../components/ui'
import type { Navigate } from '../lib/nav'

const STATUS: Array<{ value: OutlineStatus; label: string; tone: 'default' | 'amber' | 'green' | 'red' }> = [
  { value: 'draft', label: '草稿', tone: 'default' },
  { value: 'approved', label: '已审定', tone: 'amber' },
  { value: 'written', label: '已写', tone: 'green' },
  { value: 'polished', label: '已润色', tone: 'green' }
]

const statusLabel = (s: string): { label: string; tone: 'default' | 'amber' | 'green' | 'red' } =>
  STATUS.find((x) => x.value === s) ?? { label: s, tone: 'default' }

interface EditState {
  id?: string
  volume: string
  chapterNo: string
  title: string
  synopsis: string
  status: OutlineStatus
}

export default function Outline({ projectId, onNavigate }: { projectId: string; onNavigate: Navigate }) {
  const [items, setItems] = useState<OutlineItem[]>([])
  const [edit, setEdit] = useState<EditState | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [idea, setIdea] = useState('')
  const [volume, setVolume] = useState('1')
  const [startNo, setStartNo] = useState('1')
  const [count, setCount] = useState('30')
  const [generating, setGenerating] = useState(false)
  const [genOutput, setGenOutput] = useState('')
  const [genNotice, setGenNotice] = useState('')
  const genRequestId = useRef<string | null>(null)

  const load = useCallback((): void => {
    if (!projectId) return
    void window.api.novel.outlines(projectId).then(setItems)
  }, [projectId])

  useEffect(() => {
    setItems([])
    setEdit(null)
    load()
  }, [load])

  useEffect(() => {
    const offDelta = window.api.llm.onDelta((id, text) => {
      if (id === genRequestId.current) setGenOutput((prev) => (prev + text).slice(-2000))
    })
    const offDone = window.api.llm.onDone((id, payload) => {
      if (id !== genRequestId.current) return
      setGenerating(false)
      const d = payload.data as { created?: number; skipped?: number; parsed?: boolean; error?: string }
      if (d?.error) setGenNotice(`解析失败：${d.error}`)
      else if (!d?.parsed) setGenNotice('输出未解析出有效 JSON，请调整创意后重试')
      else setGenNotice(`已导入 ${d.created} 章${d.skipped ? `（跳过已存在 ${d.skipped} 章）` : ''}`)
      load()
      void window.api.novel.outlines(projectId).then(setItems)
    })
    const offError = window.api.llm.onError((id, message) => {
      if (id === genRequestId.current) {
        setGenerating(false)
        setGenNotice(`出错：${message}`)
      }
    })
    return () => {
      offDelta()
      offDone()
      offError()
    }
  }, [load, projectId])

  const volumes = useMemo(() => {
    const map = new Map<number, OutlineItem[]>()
    for (const it of items) {
      const list = map.get(it.volume) ?? []
      list.push(it)
      map.set(it.volume, list)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [items])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const it of items) c[it.status] = (c[it.status] ?? 0) + 1
    return c
  }, [items])

  if (!projectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-600">
        请先选择一个项目
        <Button onClick={() => onNavigate('projects')}>去选择项目</Button>
      </div>
    )
  }

  const save = (): void => {
    if (!edit || !edit.chapterNo.trim()) return
    void window.api.novel
      .outlineSave({
        id: edit.id,
        projectId,
        volume: parseInt(edit.volume, 10) || 1,
        chapterNo: parseInt(edit.chapterNo, 10),
        title: edit.title.trim(),
        synopsis: edit.synopsis.trim(),
        status: edit.status
      })
      .then(() => {
        setEdit(null)
        load()
      })
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-zinc-100">大纲</h1>
          <span className="text-xs text-zinc-500">
            共 {items.length} 章
            {items.length > 0 &&
              `（草稿 ${counts.draft ?? 0} / 审定 ${counts.approved ?? 0} / 已写 ${counts.written ?? 0} / 已润色 ${counts.polished ?? 0}）`}
          </span>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={() => setGenOpen((v) => !v)}>
            AI 生成大纲
          </Button>
          <Button
            onClick={() =>
              setEdit({
                volume: String(items.at(-1)?.volume ?? 1),
                chapterNo: String((items.at(-1)?.chapterNo ?? 0) + 1),
                title: '',
                synopsis: '',
                status: 'draft'
              })
            }
          >
            新增章节
          </Button>
        </div>
      </div>

      {genOpen && (
        <Card className="space-y-3 p-4">
          <div>
            <Label>核心创意（题材、主角、金手指、主线冲突；已有世界观/人物会自动作为上下文）</Label>
            <Textarea
              rows={3}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="例：末法时代最后一位炼丹师重生都市，靠一手丹术搅动风云…"
              disabled={generating}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>卷号</Label>
              <Input type="number" value={volume} onChange={(e) => setVolume(e.target.value)} disabled={generating} />
            </div>
            <div>
              <Label>起始章号</Label>
              <Input type="number" value={startNo} onChange={(e) => setStartNo(e.target.value)} disabled={generating} />
            </div>
            <div>
              <Label>生成章数</Label>
              <Input type="number" value={count} onChange={(e) => setCount(e.target.value)} disabled={generating} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button
              disabled={generating || !idea.trim()}
              onClick={() => {
                setGenerating(true)
                setGenOutput('')
                setGenNotice('')
                void window.api.pipeline
                  .run('outline', {
                    projectId,
                    idea: idea.trim(),
                    volume: parseInt(volume, 10) || 1,
                    startNo: parseInt(startNo, 10) || 1,
                    count: Math.min(60, Math.max(1, parseInt(count, 10) || 30))
                  })
                  .then((id) => {
                    genRequestId.current = id
                  })
                  .catch((err: unknown) => {
                    setGenerating(false)
                    setGenNotice((err as Error).message)
                  })
              }}
            >
              {generating ? '生成中…' : '生成并导入'}
            </Button>
            {generating && (
              <Button
                variant="danger"
                onClick={() => {
                  if (genRequestId.current) void window.api.llm.abort(genRequestId.current)
                }}
              >
                中断
              </Button>
            )}
            {genNotice && <span className="text-xs text-zinc-400">{genNotice}</span>}
          </div>
          {generating && (
            <pre className="max-h-32 overflow-hidden rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-600">
              {genOutput || '等待模型输出…'}
            </pre>
          )}
        </Card>
      )}

      {edit && (
        <Card className="grid grid-cols-12 gap-3 p-4">
          <div className="col-span-2">
            <Label>卷</Label>
            <Input type="number" value={edit.volume} onChange={(e) => setEdit({ ...edit, volume: e.target.value })} />
          </div>
          <div className="col-span-2">
            <Label>章号 *</Label>
            <Input
              type="number"
              value={edit.chapterNo}
              onChange={(e) => setEdit({ ...edit, chapterNo: e.target.value })}
            />
          </div>
          <div className="col-span-4">
            <Label>章节名</Label>
            <Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          </div>
          <div className="col-span-3">
            <Label>状态</Label>
            <Select
              value={edit.status}
              onChange={(e) => setEdit({ ...edit, status: e.target.value as OutlineStatus })}
              className="w-full"
            >
              {STATUS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="col-span-12">
            <Label>梗概</Label>
            <Textarea
              rows={3}
              value={edit.synopsis}
              onChange={(e) => setEdit({ ...edit, synopsis: e.target.value })}
              placeholder="本章目标 / 关键冲突 / 结尾钩子"
            />
          </div>
          <div className="col-span-12 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEdit(null)}>
              取消
            </Button>
            <Button onClick={save} disabled={!edit.chapterNo.trim()}>
              保存
            </Button>
          </div>
        </Card>
      )}

      {volumes.length === 0 && (
        <Card className="flex flex-col items-center gap-3 p-10 text-center text-sm text-zinc-600">
          暂无大纲，可点右上角「AI 生成大纲」一键生成，或「新增章节」手动录入
        </Card>
      )}

      {volumes.map(([vol, list]) => (
        <Card key={vol}>
          <div className="border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300">
            第 {vol} 卷
            <span className="ml-2 text-xs font-normal text-zinc-600">{list.length} 章</span>
          </div>
          <div className="divide-y divide-zinc-800/60">
            {list.map((it) => {
              const s = statusLabel(it.status)
              return (
                <div key={it.id} className="group flex items-start gap-3 px-4 py-3 hover:bg-zinc-800/30">
                  <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-xs text-zinc-500">
                    {it.chapterNo}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200">{it.title || '未命名'}</span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{it.synopsis}</div>
                  </div>
                  <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      className="px-2 py-1"
                      onClick={() => onNavigate('writing', it.id)}
                    >
                      去写作
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1"
                      onClick={() =>
                        setEdit({
                          id: it.id,
                          volume: String(it.volume),
                          chapterNo: String(it.chapterNo),
                          title: it.title,
                          synopsis: it.synopsis,
                          status: it.status
                        })
                      }
                    >
                      编辑
                    </Button>
                    <Button
                      variant="danger"
                      className="px-2 py-1"
                      onClick={() => {
                        if (window.confirm(`删除第 ${it.chapterNo} 章「${it.title}」的大纲？`))
                          void window.api.novel.outlineDelete(it.id).then(load)
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      ))}
    </div>
  )
}
