import { buildOutlineNoIndex, formatChapterRef, isDanglingRef } from '@shared/foreRef'
import type { Foreshadow } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Badge, Button, Card, Input, Label, Select } from '../components/ui'
import type { Navigate } from '../lib/nav'
import { qk, queries } from '../lib/queries'

export default function Foreshadows({
  projectId,
  onNavigate
}: {
  projectId: string
  onNavigate: Navigate
}) {
  const queryClient = useQueryClient()
  const { data: list = [] } = useQuery(queries.foreshadows(projectId))
  const { data: outlines = [] } = useQuery(queries.outlines(projectId))
  const [content, setContent] = useState('')
  const [planted, setPlanted] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editPlannedId, setEditPlannedId] = useState('')
  const [editPriority, setEditPriority] = useState('')

  const nosById = useMemo(() => buildOutlineNoIndex(outlines), [outlines])
  /** 「第N章」→ uid：能对上章号才落 uid，对不上仅存文本 */
  const parseToUid = (text: string): string | undefined => {
    const m = /第\s*(\d+)\s*章/.exec(text)
    if (!m) return undefined
    return outlines.find((x) => x.chapterNo === Number(m[1]))?.id
  }

  const load = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.foreshadows(projectId) })
  }

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
    const text = planted.trim()
    const uid = text ? parseToUid(text) : undefined
    void window.api.novel
      .foreshadowSave({
        projectId,
        content: content.trim(),
        plantedChapter: text,
        plantedOutlineId: uid
      })
      .then(() => {
        setContent('')
        setPlanted('')
        load()
      })
  }

  const startEdit = (f: Foreshadow): void => {
    setEditingId(f.id)
    setEditPlannedId(f.plannedResolveOutlineId)
    setEditPriority(f.priority)
  }

  const saveEdit = (f: Foreshadow): void => {
    const target = outlines.find((o) => o.id === editPlannedId)
    void window.api.novel
      .foreshadowSave({
        id: f.id,
        projectId,
        content: f.content,
        plannedResolve: target ? `第${target.chapterNo}章` : '',
        plannedResolveOutlineId: editPlannedId,
        priority: editPriority.trim()
      })
      .then(() => {
        setEditingId(null)
        load()
      })
  }

  const toggle = (f: Foreshadow): void => {
    if (f.status === 'open') {
      const where = window.prompt('回收于（如：第42章）', '') ?? ''
      const uid = where ? parseToUid(where) : undefined
      void window.api.novel
        .foreshadowSave({
          id: f.id,
          projectId,
          content: f.content,
          plantedChapter: f.plantedChapter,
          plantedOutlineId: f.plantedOutlineId,
          status: 'resolved',
          resolvedChapter: where,
          resolvedOutlineId: uid ?? ''
        })
        .then(load)
    } else {
      void window.api.novel
        .foreshadowSave({
          id: f.id,
          projectId,
          content: f.content,
          plantedChapter: f.plantedChapter,
          plantedOutlineId: f.plantedOutlineId,
          status: 'open',
          resolvedChapter: '',
          resolvedOutlineId: ''
        })
        .then(load)
    }
  }

  const renderGroup = (
    title: string,
    items: Foreshadow[],
    tone: 'amber' | 'green',
    emptyHint?: boolean
  ) => (
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
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => onNavigate('writing')}
              >
                去写作台定稿
              </Button>
            )}
          </div>
        )}
        {items.map((f) => (
          <div key={f.id} className="group px-4 py-2.5 hover:bg-zinc-800/30">
            <div className="flex items-center gap-3">
              {f.priority && (
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                    f.priority === '主线'
                      ? 'bg-red-900/50 text-red-300'
                      : f.priority === '人物'
                        ? 'bg-amber-900/50 text-amber-300'
                        : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {f.priority}
                </span>
              )}
              <span className="min-w-0 flex-1 text-sm leading-6 text-zinc-300">{f.content}</span>
              {isDanglingRef(f.plantedOutlineId, nosById) ? (
                <span
                  className="shrink-0 rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] text-red-300"
                  title={`原记录：${f.plantedChapter || '?'}（章节已删除）`}
                >
                  埋设章已删除
                </span>
              ) : (
                <span className="shrink-0 text-xs text-zinc-600">
                  {formatChapterRef(f.plantedChapter, f.plantedOutlineId, nosById) || '?'}
                </span>
              )}
              {isDanglingRef(f.plannedResolveOutlineId, nosById) ? (
                <span
                  className="shrink-0 rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] text-red-300"
                  title="计划回收章节已被删除，请重新规划"
                >
                  待重设
                </span>
              ) : (
                formatChapterRef(f.plannedResolve, f.plannedResolveOutlineId, nosById) && (
                  <span className="shrink-0 text-xs text-sky-500/80" title="计划回收点">
                    →{formatChapterRef(f.plannedResolve, f.plannedResolveOutlineId, nosById)}
                  </span>
                )
              )}
              {f.status !== 'open' &&
                (isDanglingRef(f.resolvedOutlineId, nosById) ? (
                  <span
                    className="shrink-0 rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] text-red-300"
                    title={`原记录：${f.resolvedChapter || '?'}（章节已删除）`}
                  >
                    回收章已删除
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-emerald-500">
                    → {formatChapterRef(f.resolvedChapter, f.resolvedOutlineId, nosById) || '?'}
                  </span>
                ))}
              <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {f.status === 'open' && (
                  <Button
                    variant="ghost"
                    className="px-2 py-0.5 text-xs"
                    onClick={() => startEdit(f)}
                  >
                    规划
                  </Button>
                )}
                <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => toggle(f)}>
                  {f.status === 'open' ? '回收' : '重开'}
                </Button>
                <Button
                  variant="danger"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => {
                    if (window.confirm('删除该伏笔记录？'))
                      void window.api.novel.foreshadowDelete(f.id).then(load)
                  }}
                >
                  删除
                </Button>
              </div>
            </div>
            {editingId === f.id && (
              <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-2">
                <div className="w-64">
                  <Label>计划回收章节</Label>
                  <Select
                    value={editPlannedId}
                    onChange={(e) => setEditPlannedId(e.target.value)}
                    className="py-1 text-xs"
                  >
                    <option value="">（未指定）</option>
                    {outlines.map((o) => (
                      <option key={o.id} value={o.id}>
                        第{o.chapterNo}章 {o.title || '（未命名）'}
                      </option>
                    ))}
                  </Select>
                  {f.plannedResolve && !f.plannedResolveOutlineId && (
                    <p className="mt-1 text-[10px] leading-4 text-zinc-600">
                      原文本「{f.plannedResolve}」未关联章节，保存选择后将被替换
                    </p>
                  )}
                </div>
                <div className="w-32">
                  <Label>优先级</Label>
                  <Select
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value)}
                    className="py-1 text-xs"
                  >
                    <option value="">（无）</option>
                    <option value="主线">主线</option>
                    <option value="人物">人物</option>
                    <option value="氛围">氛围</option>
                  </Select>
                </div>
                <Button className="px-2 py-1 text-xs" onClick={() => saveEdit(f)}>
                  保存
                </Button>
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => setEditingId(null)}
                >
                  取消
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  )

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-zinc-100">伏笔台账</h1>
        <span className="text-xs text-zinc-600">
          章节定稿时由 AI 摘要自动登记/回收，也可手动维护
        </span>
      </div>

      <Card className="grid grid-cols-1 items-end gap-3 p-3 sm:grid-cols-12 md:p-4">
        <div className="sm:col-span-7">
          <Label>伏笔内容</Label>
          <Input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="例：师父留下的玉佩内藏残魂"
          />
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
