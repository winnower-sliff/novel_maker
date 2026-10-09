import { Empty, Input, Label, Textarea } from '@mobile/components/ui'
import { DetailShell, EditBar, Row } from '@mobile/pages/subs/parts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { withSnapshot } from '@mobile/lib/querySnapshot'
import { qk } from '@renderer/lib/queries'
import type { Foreshadow, OutlineItem } from '@shared/types'
import { buildOutlineNoIndex, formatChapterRef, isDanglingRef } from '@shared/foreRef'

const FORESHADOW_STATUS = ['planted', 'resolved', 'abandoned']

/** 卷章大纲子页：卷分组章列表 + 每卷生成参数记忆（volumePlans）+ 重写已写卷（大纲+正文全卷重写）+ 伏笔台账 */
export default function OutlineSub({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: outlines = [] } = useQuery({
    queryKey: qk.outlines(projectId),
    queryFn: withSnapshot(qk.outlines(projectId), () =>
      window.api.novel.outlines(projectId)
    )
  })
  const { data: briefs = [] } = useQuery({
    queryKey: qk.chapterBriefs(projectId),
    queryFn: withSnapshot(qk.chapterBriefs(projectId), () =>
      window.api.novel.chapterBriefs(projectId)
    )
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = outlines.find((o) => o.id === editId) ?? null
  const [feditId, setFeditId] = useState<string | null>(null)
  const [openScenes, setOpenScenes] = useState<Set<string>>(new Set())
  const [collapsedVols, setCollapsedVols] = useState<Record<number, boolean>>({})
  const toggleScenes = (id: string): void => {
    setOpenScenes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }



  const sorted = [...outlines].sort((a, b) => a.volume - b.volume || a.chapterNo - b.chapterNo)
  const volumes = [...new Set(sorted.map((o) => o.volume))]

  const volWritten = (vol: number): number =>
    briefs.filter((b) => b.volume === vol && b.hasDraft).length

  if (editing)
    return (
      <OutlineEditor
        key={editing.id}
        projectId={projectId}
        item={editing}
        onBack={() => setEditId(null)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: qk.outlines(projectId) })
          void qc.invalidateQueries({ queryKey: qk.chapterBriefs(projectId) })
        }}
      />
    )

  if (feditId)
    return (
      <ForeshadowEdit key={feditId} projectId={projectId} editId={feditId} onBack={() => setFeditId(null)} />
    )

  return (
    <div className="h-full overflow-y-auto overscroll-contain p-3">
      <div className="mt-4">
        {sorted.length === 0 ? (
          <Empty text="暂无大纲章节，可到电脑端录入或让智能体生成" />
        ) : (
          volumes.map((vol) => {
            const volList = sorted.filter((o) => o.volume === vol)
            const fold = collapsedVols[vol] ?? false
            return (
              <div key={vol} className="mb-4">
                <div className="mb-1.5 flex items-center gap-2 px-1 text-xs font-medium text-zinc-500">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedVols((prev) => ({ ...prev, [vol]: !(prev[vol] ?? false) }))
                    }
                    className="flex cursor-pointer items-center gap-1.5"
                  >
                    <span className={`transition-transform ${fold ? '' : 'rotate-90'}`}>▸</span>
                    <span>第 {vol} 卷</span>
                    <span className="text-zinc-600">
                      {volList.length} 章
                      {volWritten(vol) > 0 && ` · 已写 ${volWritten(vol)}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="ml-auto cursor-pointer rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 active:bg-zinc-900"
                    onClick={() => {
                      void window.api.novel
                        .outlineInsert({
                          projectId,
                          volume: vol,
                          beforeOutlineId: volList[0]?.id
                        })
                        .then(() => {
                          // 折叠状态下插入的新章不可见，插入成功即展开本卷
                          setCollapsedVols((prev) => ({ ...prev, [vol]: false }))
                          void qc.invalidateQueries({
                            queryKey: qk.outlines(projectId)
                          })
                        })
                    }}
                  >
                    + 插入章
                  </button>
                </div>
                <div className={`space-y-1.5 ${fold ? 'hidden' : ''}`}>
                  {volList.map((o, idx) => {
                    const scenesOpen = openScenes.has(o.id)
                    return (
                      <div
                        key={o.id}
                        role="button"
                        tabIndex={0}
                        className="cursor-pointer rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 active:bg-zinc-900"
                        onClick={() => setEditId(o.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') setEditId(o.id)
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                            第{o.chapterNo}章 {o.title || '（未命名）'}
                          </span>
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (idx === 0) return
                              void window.api.novel
                                .outlineMove({ id: o.id, beforeOutlineId: volList[idx - 1].id })
                                .then(() =>
                                  void qc.invalidateQueries({
                                    queryKey: qk.outlines(projectId)
                                  })
                                )
                            }}
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                              idx === 0
                                ? 'text-zinc-700'
                                : 'cursor-pointer text-zinc-500 active:bg-zinc-800'
                            }`}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={idx >= volList.length - 1}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (idx >= volList.length - 1) return
                              void window.api.novel
                                .outlineMove({ id: o.id, afterOutlineId: volList[idx + 1].id })
                                .then(() =>
                                  void qc.invalidateQueries({
                                    queryKey: qk.outlines(projectId)
                                  })
                                )
                            }}
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
                              idx >= volList.length - 1
                                ? 'text-zinc-700'
                                : 'cursor-pointer text-zinc-500 active:bg-zinc-800'
                            }`}
                          >
                            ↓
                          </button>
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-xs leading-4 text-zinc-500">
                          {o.synopsis}
                        </div>
                        {o.scenes.length > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleScenes(o.id)
                            }}
                            className="mt-1.5 flex cursor-pointer items-center gap-1 text-[11px] text-zinc-500 active:text-zinc-300"
                          >
                            <span className={`transition-transform ${scenesOpen ? 'rotate-90' : ''}`}>
                              ▸
                            </span>
                            场景（{o.scenes.length}）
                          </button>
                        )}
                        {scenesOpen && o.scenes.length > 0 && (
                          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[11px] leading-4 text-zinc-400">
                            {o.scenes.map((s, i) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: 场景句无稳定 id，顺序即身份
                              <li key={i}>{s}</li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>

      <ForeshadowList projectId={projectId} onEdit={setFeditId} />
    </div>
  )
}

function OutlineEditor({
  projectId,
  item,
  onBack,
  onSaved
}: {
  projectId: string
  item: OutlineItem
  onBack: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(item.title)
  const [synopsis, setSynopsis] = useState(item.synopsis)
  const [scenes, setScenes] = useState(item.scenes.join('\n'))
  const [saving, setSaving] = useState(false)
  const scenesJoined = item.scenes.join('\n')
  const dirty =
    title !== item.title || synopsis !== item.synopsis || scenes !== scenesJoined

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.novel.outlineSave({
        id: item.id,
        projectId,
        volume: item.volume,
        chapterNo: item.chapterNo,
        title,
        synopsis,
        scenes: scenes.split('\n').map((s) => s.trim()).filter(Boolean)
      })
      onSaved()
      onBack()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailShell
      title={`第${item.chapterNo}章大纲`}
      onBack={onBack}
      dirty={dirty}
      bar={<EditBar dirty={dirty} saving={saving} onSave={() => void save()} />}
    >
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-zinc-900 p-2">
          <span className="text-zinc-500">卷</span> {item.volume}
        </div>
        <div className="rounded-lg bg-zinc-900 p-2">
          <span className="text-zinc-500">章节号</span> {item.chapterNo}
        </div>
        {item.role && (
          <div className="col-span-2 rounded-lg bg-zinc-900 p-2">
            <span className="text-zinc-500">功能</span> {item.role}
          </div>
        )}
        {item.suspense && (
          <div className="col-span-2 rounded-lg bg-zinc-900 p-2">
            <span className="text-zinc-500">悬念</span> {item.suspense}
          </div>
        )}
        {item.hook && (
          <div className="col-span-2 rounded-lg bg-zinc-900 p-2">
            <span className="text-zinc-500">钩子</span> {item.hook}
          </div>
        )}
      </div>
      <Label>
        标题
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Label>
      <Label>
        梗概
        <Textarea rows={8} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} />
      </Label>
      <Label>
        场景（每行一条「人物+动作/冲突」，写章时按序注入）
        <Textarea rows={4} value={scenes} onChange={(e) => setScenes(e.target.value)} />
      </Label>
      <button
        type="button"
        className="mt-2 cursor-pointer rounded-lg border border-red-900/60 px-3.5 py-2 text-sm text-red-400 active:bg-red-950/40"
        onClick={() => {
          if (!window.confirm(`删除第${item.chapterNo}章大纲？正文与摘要将一并删除，后续章号自动前移。`))
            return
          void window.api.novel.outlineDelete(item.id).then(() => {
            onSaved()
            onBack()
          })
        }}
      >
        删除本章
      </button>
    </DetailShell>
  )
}

function ForeshadowList({
  projectId,
  onEdit
}: {
  projectId: string
  onEdit: (id: string) => void
}) {
  const { data: list = [] } = useQuery({
    queryKey: qk.foreshadows(projectId),
    queryFn: withSnapshot(qk.foreshadows(projectId), () =>
      window.api.novel.foreshadows(projectId)
    )
  })
  const { data: outlines = [] } = useQuery({
    queryKey: qk.outlines(projectId),
    queryFn: withSnapshot(qk.outlines(projectId), () =>
      window.api.novel.outlines(projectId)
    )
  })
  const nosById = buildOutlineNoIndex(outlines)
  const plannedRef = (f: Foreshadow): string | null =>
    f.plannedResolve || f.plannedResolveOutlineId
      ? formatChapterRef(f.plannedResolve, f.plannedResolveOutlineId, nosById)
      : null

  return (
    <div className="mt-4">
      <div className="mb-1.5 px-1 text-xs font-medium text-zinc-500">伏笔台账（{list.length}）</div>
      {list.length === 0 ? (
        <Empty text="暂无伏笔（写章/摘要时自动登记）" />
      ) : (
        <div className="space-y-1.5">
          {list.map((f: Foreshadow) => {
            const planned = plannedRef(f)
            return (
              <Row
                key={f.id}
                title={f.content}
                sub={
                  isDanglingRef(f.plantedOutlineId, nosById)
                    ? '埋设章已删除'
                    : `埋设 ${formatChapterRef(f.plantedChapter, f.plantedOutlineId, nosById) || '?'}${
                        planned === null
                          ? isDanglingRef(f.plannedResolveOutlineId, nosById)
                            ? ' · 计划回收待重设'
                            : ''
                          : ` · 计划回收 ${planned}`
                      }`
                }
                right={
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] ${
                      f.status === 'resolved'
                        ? 'bg-emerald-600/15 text-emerald-400'
                        : f.status === 'abandoned'
                          ? 'bg-zinc-700/40 text-zinc-400'
                          : 'bg-amber-600/15 text-amber-400'
                    }`}
                  >
                    {f.status}
                  </span>
                }
                onClick={() => onEdit(f.id)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function ForeshadowEdit({
  projectId,
  editId,
  onBack
}: {
  projectId: string
  editId: string
  onBack: () => void
}) {
  const qc = useQueryClient()
  const { data: list = [] } = useQuery({
    queryKey: qk.foreshadows(projectId),
    queryFn: withSnapshot(qk.foreshadows(projectId), () =>
      window.api.novel.foreshadows(projectId)
    )
  })
  const item = list.find((f) => f.id === editId) ?? null
  if (!item) return <Empty text="伏笔不存在或已被删除" />
  return (
    <ForeshadowEditor
      key={item.id}
      projectId={projectId}
      item={item}
      onBack={onBack}
      onSaved={() => void qc.invalidateQueries({ queryKey: qk.foreshadows(projectId) })}
    />
  )
}

function ForeshadowEditor({
  projectId,
  item,
  onBack,
  onSaved
}: {
  projectId: string
  item: Foreshadow
  onBack: () => void
  onSaved: () => void
}) {
  const [content, setContent] = useState(item.content)
  const [status, setStatus] = useState(item.status)
  const [plannedId, setPlannedId] = useState(item.plannedResolveOutlineId)
  const [saving, setSaving] = useState(false)
  const { data: outlines = [] } = useQuery({
    queryKey: qk.outlines(projectId),
    queryFn: withSnapshot(qk.outlines(projectId), () =>
      window.api.novel.outlines(projectId)
    )
  })
  const dirty =
    content !== item.content || status !== item.status || plannedId !== item.plannedResolveOutlineId

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const target = outlines.find((o) => o.id === plannedId)
      await window.api.novel.foreshadowSave({
        id: item.id,
        projectId,
        content,
        status,
        plannedResolve: target ? `第${target.chapterNo}章` : '',
        plannedResolveOutlineId: plannedId
      })
      onSaved()
      onBack()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailShell
      title="伏笔"
      onBack={onBack}
      dirty={dirty}
      bar={<EditBar dirty={dirty} saving={saving} onSave={() => void save()} />}
    >
      <Label>
        内容
        <Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
      </Label>
      <div>
        <Label>状态</Label>
        <div className="flex gap-1.5">
          {FORESHADOW_STATUS.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => setStatus(s)}
              className={`cursor-pointer rounded-full px-3 py-1.5 text-xs ${
                status === s ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div>
        <Label>计划回收章节</Label>
        <select
          value={plannedId}
          onChange={(e) => setPlannedId(e.target.value)}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
        >
          <option value="">（未指定）</option>
          {outlines.map((o) => (
            <option key={o.id} value={o.id}>
              第{o.chapterNo}章 {o.title || '（未命名）'}
            </option>
          ))}
        </select>
        {item.plannedResolve && !item.plannedResolveOutlineId && (
          <p className="mt-1 text-[11px] leading-4 text-zinc-600">
            原文本「{item.plannedResolve}」未关联章节，保存选择后将被替换
          </p>
        )}
      </div>
      <div className="rounded-lg bg-zinc-900 p-2.5 text-xs text-zinc-500">
        埋设于 {item.plantedChapter || '（未记录）'}
        {item.resolvedChapter ? ` · 已回收于 ${item.resolvedChapter}` : ''}
        {item.priority ? ` · 优先级 ${item.priority}` : ''}
      </div>
    </DetailShell>
  )
}
