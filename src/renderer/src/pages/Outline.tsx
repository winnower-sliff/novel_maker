import type { OutlineItem, OutlineStatus } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyGuide } from '../components/EmptyGuide'
import { Badge, Button, Card, Input, Label, Select, Textarea } from '../components/ui'
import type { Navigate } from '../lib/nav'
import { qk, queries } from '../lib/queries'

const STATUS: Array<{
  value: OutlineStatus
  label: string
  tone: 'default' | 'amber' | 'green' | 'red'
}> = [
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
  role: string
  suspense: string
  twist: string
  hook: string
  foreshadowOps: string
  status: OutlineStatus
}

const emptyEdit = (): EditState => ({
  volume: '1',
  chapterNo: '1',
  title: '',
  synopsis: '',
  role: '',
  suspense: '',
  twist: '0',
  hook: '',
  foreshadowOps: '',
  status: 'draft'
})

export default function Outline({
  projectId,
  onNavigate
}: {
  projectId: string
  onNavigate: Navigate
}) {
  const queryClient = useQueryClient()
  const { data: items = [] } = useQuery(queries.outlines(projectId))
  const { data: volSummaryList = [] } = useQuery(queries.volumeSummaries(projectId))
  const [edit, setEdit] = useState<EditState | null>(null)
  const volSummaries = useMemo(() => {
    const map: Record<number, string> = {}
    for (const v of volSummaryList) map[v.volume] = v.summary
    return map
  }, [volSummaryList])
  const [openVolumeSummary, setOpenVolumeSummary] = useState<number | null>(null)
  const [openScenes, setOpenScenes] = useState<Set<string>>(new Set())
  const toggleScenes = (id: string): void =>
    setOpenScenes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const load = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: qk.outlines(projectId) })
    void queryClient.invalidateQueries({ queryKey: qk.volumeSummaries(projectId) })
  }, [projectId, queryClient])

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId 仅作重置信号
  useEffect(() => {
    setEdit(null)
  }, [projectId])

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
    if (!edit?.chapterNo.trim()) return
    void window.api.novel
      .outlineSave({
        id: edit.id,
        projectId,
        volume: parseInt(edit.volume, 10) || 1,
        chapterNo: parseInt(edit.chapterNo, 10),
        title: edit.title.trim(),
        synopsis: edit.synopsis.trim(),
        role: edit.role.trim() || undefined,
        suspense: edit.suspense.trim() || undefined,
        twist: parseInt(edit.twist, 10) || 0,
        hook: edit.hook.trim() || undefined,
        foreshadowOps: edit.foreshadowOps.trim() || undefined,
        status: edit.status
      })
      .then(() => {
        setEdit(null)
        load()
      })
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-zinc-100">大纲</h1>
          <span className="text-xs text-zinc-500">
            共 {items.length} 章
            {items.length > 0 &&
              `（草稿 ${counts.draft ?? 0} / 审定 ${counts.approved ?? 0} / 已写 ${counts.written ?? 0} / 已润色 ${counts.polished ?? 0}）`}
          </span>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            onClick={() =>
              setEdit({
                ...emptyEdit(),
                volume: String(items.at(-1)?.volume ?? 1),
                chapterNo: String((items.at(-1)?.chapterNo ?? 0) + 1)
              })
            }
          >
            新增章节
          </Button>
        </div>
      </div>

      {edit && (
        <Card className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-12 md:p-4">
          <div className="col-span-1 sm:col-span-2">
            <Label>卷</Label>
            <Input
              type="number"
              value={edit.volume}
              onChange={(e) => setEdit({ ...edit, volume: e.target.value })}
            />
          </div>
          <div className="col-span-1 sm:col-span-2">
            <Label>章号 *</Label>
            <Input
              type="number"
              value={edit.chapterNo}
              onChange={(e) => setEdit({ ...edit, chapterNo: e.target.value })}
            />
            <p className="mt-1 text-[10px] leading-4 text-zinc-600">
              改卷/章号即移动：章号按全书位置自动重排，其余章节顺延
            </p>
          </div>
          <div className="col-span-2 sm:col-span-4">
            <Label>章节名</Label>
            <Input
              value={edit.title}
              onChange={(e) => setEdit({ ...edit, title: e.target.value })}
            />
          </div>
          <div className="col-span-2 sm:col-span-3">
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
          <div className="col-span-2 sm:col-span-12">
            <Label>梗概</Label>
            <Textarea
              rows={3}
              value={edit.synopsis}
              onChange={(e) => setEdit({ ...edit, synopsis: e.target.value })}
              placeholder="本章目标 / 关键冲突 / 结尾钩子"
            />
          </div>
          <div className="col-span-1 sm:col-span-3">
            <Label>章节定位</Label>
            <Select
              value={edit.role}
              onChange={(e) => setEdit({ ...edit, role: e.target.value })}
              className="w-full"
            >
              <option value="">（未设置）</option>
              <option value="情节推进">情节推进</option>
              <option value="人物深化">人物深化</option>
              <option value="氛围营造">氛围营造</option>
              <option value="过渡衔接">过渡衔接</option>
              <option value="高潮转折">高潮转折</option>
            </Select>
          </div>
          <div className="col-span-1 sm:col-span-3">
            <Label>悬念密度</Label>
            <Select
              value={edit.suspense}
              onChange={(e) => setEdit({ ...edit, suspense: e.target.value })}
              className="w-full"
            >
              <option value="">（未设置）</option>
              <option value="紧凑">紧凑</option>
              <option value="渐进">渐进</option>
              <option value="爆发">爆发</option>
            </Select>
          </div>
          <div className="col-span-1 sm:col-span-2">
            <Label>认知颠覆</Label>
            <Select
              value={edit.twist}
              onChange={(e) => setEdit({ ...edit, twist: e.target.value })}
              className="w-full"
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={String(n)}>
                  {n === 0 ? '（未设置）' : '★'.repeat(n)}
                </option>
              ))}
            </Select>
          </div>
          <div className="col-span-2 sm:col-span-4">
            <Label>结尾钩子</Label>
            <Input
              value={edit.hook}
              onChange={(e) => setEdit({ ...edit, hook: e.target.value })}
              placeholder="用什么悬念收尾"
            />
          </div>
          <div className="col-span-2 sm:col-span-12">
            <Label>伏笔操作</Label>
            <Input
              value={edit.foreshadowOps}
              onChange={(e) => setEdit({ ...edit, foreshadowOps: e.target.value })}
              placeholder="如：埋设(玉佩秘密)→强化(黑袍人再现)→回收(断剑重铸)"
            />
          </div>
          <div className="col-span-2 flex justify-end gap-2 sm:col-span-12">
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
        <EmptyGuide
          onNavigate={onNavigate}
          title="还没有大纲"
          desc="手动录入章节大纲（含定位/悬念/反转/钩子/伏笔操作元数据）；也可到智能体页让 AI 规划后由其保存。"
        >
          <Button
            variant="ghost"
            onClick={() =>
              setEdit({
                ...emptyEdit(),
                volume: String(items.at(-1)?.volume ?? 1),
                chapterNo: String((items.at(-1)?.chapterNo ?? 0) + 1)
              })
            }
          >
            新增章节
          </Button>
        </EmptyGuide>
      )}

      {volumes.map(([vol, list]) => (
        <Card key={vol}>
          <div className="flex items-center border-b border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300">
            <span>
              第 {vol} 卷
              <span className="ml-2 text-xs font-normal text-zinc-600">{list.length} 章</span>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                className="px-2 py-0.5 text-xs"
                title="在本卷最前插入一个空章，后续章号自动顺延"
                onClick={() => {
                  // 空卷（仅计划）时锚定相邻卷：后卷首章之前 / 前卷末章之后，避免落到全书末尾
                  const first = list[0]
                  const nextVolFirst = items.find((o) => o.volume > vol)
                  const anchor = first
                    ? { beforeOutlineId: first.id }
                    : nextVolFirst
                      ? { beforeOutlineId: nextVolFirst.id }
                      : { afterOutlineId: items.filter((o) => o.volume < vol).at(-1)?.id }
                  void window.api.novel
                    .outlineInsert({ projectId, volume: vol, ...anchor })
                    .then(load)
                }}
              >
                插入章
              </Button>
              {volSummaries[vol] && (
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => setOpenVolumeSummary(openVolumeSummary === vol ? null : vol)}
                >
                  {openVolumeSummary === vol ? '收起卷摘要' : '查看卷摘要'}
                </Button>
              )}
            </div>
          </div>
          {openVolumeSummary === vol && volSummaries[vol] && (
            <div className="border-b border-zinc-800 bg-zinc-950/60 px-4 py-3 text-xs leading-6 whitespace-pre-wrap text-zinc-400">
              {volSummaries[vol]}
            </div>
          )}
          <div className="divide-y divide-zinc-800/60">
            {list.map((it, idx) => {
              const s = statusLabel(it.status)
              const chips: Array<[string, string]> = []
              if (it.role) chips.push(['定位', it.role])
              if (it.suspense) chips.push(['悬念', it.suspense])
              if (it.twist > 0) chips.push(['颠覆', '★'.repeat(Math.min(5, it.twist))])
              if (it.hook) chips.push(['钩子', it.hook])
              if (it.foreshadowOps) chips.push(['伏笔', it.foreshadowOps])
              return (
                <div
                  key={it.id}
                  className="group flex items-start gap-3 px-4 py-3 hover:bg-zinc-800/30"
                >
                  <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-xs text-zinc-500">
                    {it.chapterNo}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200">
                        {it.title || '未命名'}
                      </span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">
                      {it.synopsis}
                    </div>
                    {it.scenes.length > 0 && (
                      <div className="mt-1">
                        <button
                          type="button"
                          onClick={() => toggleScenes(it.id)}
                          className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300"
                        >
                          {openScenes.has(it.id) ? '▾' : '▸'} 场景（{it.scenes.length}）
                        </button>
                        {openScenes.has(it.id) && (
                          <ol className="mt-0.5 list-decimal space-y-0.5 pl-5 text-[11px] leading-5 text-zinc-500">
                            {it.scenes.map((sc, i) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: 静态序号列表，顺序即身份
                              <li key={i}>{sc}</li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )}
                    {chips.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-zinc-500">
                        {chips.map(([k, v]) => (
                          <span
                            key={k}
                            className="max-w-full truncate rounded bg-zinc-800/80 px-1.5 py-0.5"
                          >
                            <span className="text-zinc-600">{k}</span> {v}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      className="px-2 py-1"
                      disabled={idx === 0}
                      title="上移（同卷内换位）"
                      onClick={() => {
                        if (idx === 0) return
                        void window.api.novel
                          .outlineMove({ id: it.id, beforeOutlineId: list[idx - 1].id })
                          .then(load)
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1"
                      disabled={idx === list.length - 1}
                      title="下移（同卷内换位）"
                      onClick={() => {
                        if (idx >= list.length - 1) return
                        void window.api.novel
                          .outlineMove({ id: it.id, afterOutlineId: list[idx + 1].id })
                          .then(load)
                      }}
                    >
                      ↓
                    </Button>
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
                          role: it.role,
                          suspense: it.suspense,
                          twist: String(it.twist),
                          hook: it.hook,
                          foreshadowOps: it.foreshadowOps,
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
