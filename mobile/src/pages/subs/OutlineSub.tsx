import { Empty, Input, Label, Textarea } from '@mobile/components/ui'
import { DetailShell, EditBar, Row } from '@mobile/pages/subs/parts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  deriveStartNo,
  generateRulesRefine,
  generateVolume,
  generateVolumeIdea,
  rememberVolumePlan,
  useOutlineRunActive
} from '@wizard/volumeGen'
import { NumberField, OutlineProgress } from '@wizard/widgets'
import { loadProjectPlan, type WizardPlanFull } from '@wizard/wizardPlan'
import type { Foreshadow, OutlineItem } from '@shared/types'

const FORESHADOW_STATUS = ['planted', 'resolved', 'abandoned']

/** 卷章大纲子页：卷分组章列表 + 每卷生成参数记忆（volumePlans）+ 重写已写卷（大纲+正文全卷重写）+ 伏笔台账 */
export default function OutlineSub({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: outlines = [] } = useQuery({
    queryKey: ['novel', 'outlines', projectId],
    queryFn: () => window.api.novel.outlines(projectId)
  })
  const { data: briefs = [] } = useQuery({
    queryKey: ['novel', 'chapterBriefs', projectId],
    queryFn: () => window.api.novel.chapterBriefs(projectId)
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = outlines.find((o) => o.id === editId) ?? null
  const [feditId, setFeditId] = useState<string | null>(null)

  // —— 生成区 ——
  const [plan, setPlan] = useState<WizardPlanFull | null>(null)
  const [volume, setVolume] = useState(1)
  const [count, setCount] = useState(20)
  const [idea, setIdea] = useState('')
  const [localBusy, setLocalBusy] = useState(false)
  const [ideaBusy, setIdeaBusy] = useState(false)
  const [rules, setRules] = useState('')
  const [rulesBusy, setRulesBusy] = useState(false)
  const [delta, setDelta] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  // busy = 本地生成 || 后台在途 run（切页/刷新后生成继续，重挂时恢复 busy 态防重复触发）
  const outlineActive = useOutlineRunActive(projectId)
  const busy = localBusy || outlineActive

  useEffect(() => {
    let alive = true
    void loadProjectPlan(projectId)
      .then((p) => {
        if (!alive) return
        setPlan(p)
        setCount(p?.outlineCount ?? 20)
        setIdea(p?.outlineIdea ?? '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId])

  const sorted = [...outlines].sort((a, b) => a.volume - b.volume || a.chapterNo - b.chapterNo)
  const volumes = [...new Set(sorted.map((o) => o.volume))]

  // 生成区卷选择条：库内卷号 ∪ 记忆卷号；「下一卷」= 最大卷号 + 1
  const chipVols = (() => {
    const set = new Set<number>(volumes)
    for (const k of Object.keys(plan?.volumePlans ?? {})) {
      const n = Number(k)
      if (Number.isInteger(n) && n >= 1) set.add(n)
    }
    return [...set].sort((a, b) => a - b)
  })()
  const nextVol = chipVols.length > 0 ? chipVols[chipVols.length - 1] + 1 : 1

  // 换卷时按 volumePlans 预填该卷上次生成参数；无记忆则清空（起始章号生成时全自动推导）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 预填只在卷号或存档变化时执行
  useEffect(() => {
    if (busy) return
    const memo = plan?.volumePlans?.[String(volume)]
    if (memo) {
      setIdea(memo.idea)
      setCount(memo.count)
      setRules(memo.rules ?? '')
      return
    }
    setIdea('')
    setRules('')
  }, [volume, plan])

  const volWritten = (vol: number): number =>
    briefs.filter((b) => b.volume === vol && b.hasDraft).length
  const targetWritten = briefs.some((b) => b.volume === volume && b.hasDraft)

  const generate = async (): Promise<void> => {
    if (!idea.trim() || busy || ideaBusy || rulesBusy) return
    if (
      targetWritten &&
      !window.confirm(
        `第 ${volume} 卷已有 ${volWritten(volume)} 章正文。\n重写 = 重新生成该卷大纲 + 自动覆盖重写该卷全部章节正文，原稿不会保留。\n确定继续？`
      )
    )
      return
    setLocalBusy(true)
    setError(null)
    setResult(null)
    setDelta('')
    const { done } = generateVolume({
      projectId,
      volume,
      idea: idea.trim(),
      rules: rules.trim() || undefined,
      startNo: deriveStartNo(volume, outlines),
      count: count >= 1 ? Math.floor(count) : 20,
      hasWritten: targetWritten,
      onDelta: (t) => setDelta((v) => v + t)
    })
    try {
      const r = await done
      if (!r.parsed || r.created + r.updated === 0) {
        setError('AI 输出无法解析为章节列表，请重试或调整创意描述')
        return
      }
      if (r.rewriting > 0) {
        setResult(
          `大纲已重生成（新建 ${r.created} · 更新 ${r.updated}），已开始自动重写该卷 ${r.rewriting} 章正文，进度见「写作」子页`
        )
      } else {
        setResult(
          `已导入：新建 ${r.created} 章${r.updated ? ` · 更新 ${r.updated} 章` : ''}${
            r.skipped ? ` · 跳过 ${r.skipped} 章（章节号已存在）` : ''
          }`
        )
      }
      void qc.invalidateQueries({ queryKey: ['novel', 'outlines', projectId] })
      void qc.invalidateQueries({ queryKey: ['novel', 'chapterBriefs', projectId] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLocalBusy(false)
    }
  }

  if (editing)
    return (
      <OutlineEditor
        key={editing.id}
        projectId={projectId}
        item={editing}
        onBack={() => setEditId(null)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: ['novel', 'outlines', projectId] })
          void qc.invalidateQueries({ queryKey: ['novel', 'chapterBriefs', projectId] })
        }}
      />
    )

  if (feditId)
    return (
      <ForeshadowEdit key={feditId} projectId={projectId} editId={feditId} onBack={() => setFeditId(null)} />
    )

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="space-y-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-xs text-zinc-500">选择卷</span>
          {chipVols.map((v) => {
            const w = volWritten(v)
            const active = v === volume
            return (
              <button
                key={v}
                type="button"
                disabled={busy}
                onClick={() => setVolume(v)}
                className={`rounded-full px-3 py-1.5 text-xs disabled:cursor-default disabled:opacity-50 ${
                  active ? 'bg-amber-600 font-medium text-white' : 'bg-zinc-800 text-zinc-400'
                }`}
              >
                第 {v} 卷
                {w > 0 && (
                  <span className={active ? ' text-amber-100' : ' text-zinc-500'}> · 已写{w}</span>
                )}
              </button>
            )
          })}
          <button
            type="button"
            disabled={busy}
            onClick={() => setVolume(nextVol)}
            className={`rounded-full px-3 py-1.5 text-xs disabled:cursor-default disabled:opacity-50 ${
              volume === nextVol
                ? 'bg-amber-600 font-medium text-white'
                : 'border border-dashed border-zinc-700 text-zinc-400'
            }`}
          >
            ＋ 第 {nextVol} 卷
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label>第 {volume} 卷 · 本卷创意（描述这一卷要讲的故事）</Label>
          <button
            type="button"
            onClick={() => {
              if (ideaBusy || busy || !idea.trim()) return
              setIdeaBusy(true)
              setError(null)
              setResult(null)
              setDelta('')
              const { done } = generateVolumeIdea({
                projectId,
                volume,
                idea: idea.trim(),
                rules: rules.trim() || undefined,
                onDelta: (t) => setDelta((v) => v + t)
              })
                        void done
                .then((text) => {
                  setIdea(text)
                  void rememberVolumePlan(projectId, volume, {
                    idea: text,
                    count: count >= 1 ? Math.floor(count) : 20,
                    rules: rules.trim() || undefined
                  })
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => {
                  setIdeaBusy(false)
                })
            }}
            disabled={ideaBusy || busy || !idea.trim()}
            className="shrink-0 cursor-pointer rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 active:bg-zinc-800 disabled:cursor-default disabled:opacity-40"
          >
            {ideaBusy ? '扩写中…' : 'AI 扩写成创意'}
          </button>
        </div>
        <Textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={3}
          style={{ resize: 'vertical' }}
          disabled={busy}
          placeholder="例：主角进入宗门后的第一次试炼，与同门结怨、初窥力量体系…（也可写简短要求，点「AI 扩写成创意」补全）"
        />
        {ideaBusy && (
          <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-500">
            {delta.slice(-400) || '扩写中…'}
          </pre>
        )}
        <div className="flex items-center justify-between gap-2">
          <Label>第 {volume} 卷 · 节奏与硬性要求（每行一条，原样透传、逐章严格执行）</Label>
          <button
            type="button"
            onClick={() => {
              if (rulesBusy || busy || !rules.trim()) return
              setRulesBusy(true)
              setError(null)
              setResult(null)
              setDelta('')
              const { done } = generateRulesRefine({
                projectId,
                volume,
                rules: rules.trim(),
                onDelta: (t) => setDelta((v) => v + t)
              })
                        void done
                .then((text) => {
                  setRules(text)
                  void rememberVolumePlan(projectId, volume, {
                    idea,
                    count: count >= 1 ? Math.floor(count) : 20,
                    rules: text
                  })
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => {
                  setRulesBusy(false)
                })
            }}
            disabled={rulesBusy || busy || !rules.trim()}
            className="shrink-0 cursor-pointer rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 active:bg-zinc-800 disabled:cursor-default disabled:opacity-40"
          >
            {rulesBusy ? '优化中…' : 'AI 优化规则'}
          </button>
        </div>
        <Textarea
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          rows={2}
          style={{ resize: 'vertical' }}
          disabled={busy}
          placeholder={'例：\n每 3~6 章插入一段独立的色情小故事\n每 10 章安排一个单元小故事收尾'}
        />
        {rulesBusy && (
          <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-500">
            {delta.slice(-400) || '优化中…'}
          </pre>
        )}
        <div className="max-w-36">
          <Label>章数</Label>
          <NumberField input={Input} value={count} min={1} onChange={setCount} disabled={busy} className="w-full" />
        </div>
        {localBusy && <OutlineProgress text={delta} />}
        {outlineActive && !localBusy && (
          <div className="text-xs text-amber-400">后台大纲生成中，完成后会自动导入（可离开此页）</div>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
        {result && !busy && <div className="text-xs text-emerald-400">{result}</div>}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy || ideaBusy || rulesBusy || !idea.trim()}
            className={`cursor-pointer rounded-lg px-3.5 py-2 text-sm disabled:cursor-default disabled:opacity-40 ${
              targetWritten ? 'bg-red-800/80 text-red-50' : 'bg-amber-600 text-white'
            }`}
          >
            {localBusy
              ? '生成中…'
              : outlineActive
                ? '后台生成中…'
                : targetWritten
                  ? `重写第 ${volume} 卷（大纲+正文）`
                  : `生成第 ${volume} 卷大纲`}
          </button>
          {targetWritten && (
            <span className="text-[11px] text-zinc-500">该卷已有 {volWritten(volume)} 章正文，重写将全卷覆盖</span>
          )}
        </div>
      </div>

      <div className="mt-4">
        {sorted.length === 0 ? (
          <Empty text="暂无大纲章节" />
        ) : (
          volumes.map((vol) => (
            <div key={vol} className="mb-4">
              <div className="mb-1.5 flex items-center gap-2 px-1 text-xs font-medium text-zinc-500">
                <span>第 {vol} 卷</span>
                <span className="text-zinc-600">
                  {sorted.filter((o) => o.volume === vol).length} 章
                  {volWritten(vol) > 0 && ` · 已写 ${volWritten(vol)}`}
                </span>
              </div>
              <div className="space-y-1.5">
                {sorted
                  .filter((o) => o.volume === vol)
                  .map((o) => (
                    <Row
                      key={o.id}
                      title={`第${o.chapterNo}章 ${o.title || '（未命名）'}`}
                      sub={o.synopsis}
                      onClick={() => setEditId(o.id)}
                    />
                  ))}
              </div>
            </div>
          ))
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
  const [saving, setSaving] = useState(false)
  const dirty = title !== item.title || synopsis !== item.synopsis

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.novel.outlineSave({
        id: item.id,
        projectId,
        volume: item.volume,
        chapterNo: item.chapterNo,
        title,
        synopsis
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
    queryKey: ['novel', 'foreshadows', projectId],
    queryFn: () => window.api.novel.foreshadows(projectId)
  })

  return (
    <div className="mt-4">
      <div className="mb-1.5 px-1 text-xs font-medium text-zinc-500">伏笔台账（{list.length}）</div>
      {list.length === 0 ? (
        <Empty text="暂无伏笔（写章/摘要时自动登记）" />
      ) : (
        <div className="space-y-1.5">
          {list.map((f: Foreshadow) => (
            <Row
              key={f.id}
              title={f.content}
              sub={`埋设 ${f.plantedChapter || '?'}${f.plannedResolve ? ` · 计划回收 ${f.plannedResolve}` : ''}`}
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
          ))}
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
    queryKey: ['novel', 'foreshadows', projectId],
    queryFn: () => window.api.novel.foreshadows(projectId)
  })
  const item = list.find((f) => f.id === editId) ?? null
  if (!item) return <Empty text="伏笔不存在或已被删除" />
  return (
    <ForeshadowEditor
      key={item.id}
      projectId={projectId}
      item={item}
      onBack={onBack}
      onSaved={() => void qc.invalidateQueries({ queryKey: ['novel', 'foreshadows', projectId] })}
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
  const [plannedResolve, setPlannedResolve] = useState(item.plannedResolve)
  const [saving, setSaving] = useState(false)
  const dirty =
    content !== item.content || status !== item.status || plannedResolve !== item.plannedResolve

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.novel.foreshadowSave({
        id: item.id,
        projectId,
        content,
        status,
        plannedResolve
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
      <Label>
        计划回收于（章节描述）
        <Input value={plannedResolve} onChange={(e) => setPlannedResolve(e.target.value)} />
      </Label>
      <div className="rounded-lg bg-zinc-900 p-2.5 text-xs text-zinc-500">
        埋设于 {item.plantedChapter || '（未记录）'}
        {item.resolvedChapter ? ` · 已回收于 ${item.resolvedChapter}` : ''}
        {item.priority ? ` · 优先级 ${item.priority}` : ''}
      </div>
    </DetailShell>
  )
}
