import type { OutlineItem, OutlineStatus } from '@shared/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fireCanonSync } from '../../../wizard/canonStore'
import { type AlignRevision, applyAlignRevisions } from '../../../wizard/outlineAlign'
import {
  deriveStartNo,
  generateRulesRefine,
  generateVolume,
  generateVolumeIdea,
  rememberVolumePlan,
  useOutlineRunActive
} from '../../../wizard/volumeGen'
import { ExpandableTextarea, NumberField, OutlineProgress } from '../../../wizard/widgets'
import { loadProjectPlan, saveProjectPlan, type WizardPlanFull } from '../../../wizard/wizardPlan'
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
  const { data: briefs = [] } = useQuery(queries.chapterBriefs(projectId))
  const [edit, setEdit] = useState<EditState | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [plan, setPlan] = useState<WizardPlanFull | null>(null)
  const [idea, setIdea] = useState('')
  const [volume, setVolume] = useState(1)
  const [count, setCount] = useState(30)
  const [generating, setGenerating] = useState(false)
  // 后台在途 outline run（切页/刷新后生成继续，重挂时恢复禁用态防重复触发）
  const outlineRun = useOutlineRunActive(projectId)
  const outlineActive = outlineRun.active
  const genBusy = generating || outlineActive
  const [genOutput, setGenOutput] = useState('')
  const [ideaBusy, setIdeaBusy] = useState(false)
  const ideaAbortRef = useRef<(() => void) | null>(null)
  const [rules, setRules] = useState('')
  const [rulesBusy, setRulesBusy] = useState(false)
  const rulesAbortRef = useRef<(() => void) | null>(null)
  // 通用规则：全书各卷适用（存 wizard_plan.outlineRules，区别于 volumePlans[].rules 的本卷规则）
  const [globalRules, setGlobalRules] = useState('')
  const [gRulesBusy, setGRulesBusy] = useState(false)
  const gRulesAbortRef = useRef<(() => void) | null>(null)
  const [genNotice, setGenNotice] = useState('')
  const genAbortRef = useRef<(() => void) | null>(null)
  const [volNotice, setVolNotice] = useState('')
  const volSummaries = useMemo(() => {
    const map: Record<number, string> = {}
    for (const v of volSummaryList) map[v.volume] = v.summary
    return map
  }, [volSummaryList])
  const [openVolumeSummary, setOpenVolumeSummary] = useState<number | null>(null)
  const volSummaryRequestId = useRef<string | null>(null)
  const alignRequestId = useRef<string | null>(null)
  const [alignBusy, setAlignBusy] = useState(false)
  const [alignNotice, setAlignNotice] = useState('')
  const [alignRevisions, setAlignRevisions] = useState<AlignRevision[] | null>(null)
  const [alignSkip, setAlignSkip] = useState<Set<string>>(new Set())
  const [openScenes, setOpenScenes] = useState<Set<string>>(new Set())
  const toggleScenes = (id: string): void =>
    setOpenScenes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const startAlign = (): void => {
    setAlignBusy(true)
    setAlignNotice('AI 正在对照已写剧情检查后续大纲…')
    setAlignRevisions(null)
    setAlignSkip(new Set())
    void window.api.pipeline
      .run('outlineAlign', { projectId })
      .then((id) => {
        alignRequestId.current = id
      })
      .catch((err: unknown) => {
        setAlignBusy(false)
        setAlignNotice(`出错：${(err as Error).message}`)
      })
  }

  const applyAlign = (): void => {
    if (!alignRevisions) return
    const list = alignRevisions.filter((r) => !alignSkip.has(r.outlineId))
    void applyAlignRevisions(projectId, list).then((n) => {
      setAlignRevisions(null)
      setAlignNotice(n > 0 ? `已修订 ${n} 章大纲` : '未选择任何修订')
      load()
    })
  }

  const load = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: qk.outlines(projectId) })
    void queryClient.invalidateQueries({ queryKey: qk.volumeSummaries(projectId) })
  }, [projectId, queryClient])

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId 仅作重置信号
  useEffect(() => {
    setEdit(null)
  }, [projectId])

  useEffect(() => {
    let alive = true
    void loadProjectPlan(projectId)
      .then((p) => {
        if (!alive) return
        setPlan(p)
        setCount(p?.outlineCount ?? 30)
        setIdea(p?.outlineIdea ?? '')
        setGlobalRules(p?.outlineRules ?? '')
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId])

  // 换卷时按 volumePlans 预填该卷上次生成参数；无记忆则清空（起始章号生成时全自动推导）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 预填只在卷号或存档变化时执行
  useEffect(() => {
    if (generating) return
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

  useEffect(() => {
    const offDone = window.api.llm.onDone((id, payload) => {
      if (id === volSummaryRequestId.current) {
        const d = payload.data as {
          volume?: number
          summaryChars?: number
          parsed?: boolean
          error?: string
        }
        if (d?.error) setVolNotice(`卷摘要失败：${d.error}`)
        else if (!d?.parsed) setVolNotice('卷摘要解析失败，可重试')
        else setVolNotice(`第 ${d.volume} 卷摘要已生成（${d.summaryChars} 字）`)
        load()
        return
      }
      if (id === alignRequestId.current) {
        alignRequestId.current = null
        setAlignBusy(false)
        const d = payload.data as {
          parsed?: boolean
          revisions?: Array<{
            outlineId: string
            volume: number
            chapterNo: number
            title: string
            synopsis: string
            hook?: string
            reason?: string
          }>
          error?: string
        }
        if (d?.error) setAlignNotice(`对齐失败：${d.error}`)
        else if (!d?.parsed) setAlignNotice('对齐结果解析失败，可重试')
        else if (!d.revisions || d.revisions.length === 0)
          setAlignNotice('后续大纲与已写剧情一致，无需修订')
        else setAlignRevisions(d.revisions)
      }
    })
    const offError = window.api.llm.onError((id, message) => {
      if (id === volSummaryRequestId.current) setVolNotice(`出错：${message}`)
      if (id === alignRequestId.current) {
        alignRequestId.current = null
        setAlignBusy(false)
        setAlignNotice(`出错：${message}`)
      }
    })
    return () => {
      offDone()
      offError()
    }
  }, [load])

  const volumes = useMemo(() => {
    const map = new Map<number, OutlineItem[]>()
    for (const it of items) {
      const list = map.get(it.volume) ?? []
      list.push(it)
      map.set(it.volume, list)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [items])

  // 生成区卷选择条：库内卷号 ∪ 记忆卷号；「下一卷」= 最大卷号 + 1
  const chipVols = useMemo(() => {
    const set = new Set<number>(volumes.map(([v]) => v))
    for (const k of Object.keys(plan?.volumePlans ?? {})) {
      const n = Number(k)
      if (Number.isInteger(n) && n >= 1) set.add(n)
    }
    return [...set].sort((a, b) => a - b)
  }, [volumes, plan])
  const nextVol = chipVols.length > 0 ? chipVols[chipVols.length - 1] + 1 : 1

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

  const volumeSummary = (vol: number): void => {
    setVolNotice(`第 ${vol} 卷摘要生成中…`)
    void window.api.pipeline
      .run('volumeSummary', { projectId, volume: vol })
      .then((id) => {
        volSummaryRequestId.current = id
      })
      .catch((err: unknown) => setVolNotice((err as Error).message))
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
          <Button variant="ghost" onClick={() => setGenOpen((v) => !v)}>
            AI 生成大纲
          </Button>
          <Button
            variant="ghost"
            onClick={startAlign}
            disabled={alignBusy || items.length === 0}
            title="AI 对照已写章节的实际剧情，检查并修订后续未写章节的大纲梗概"
          >
            {alignBusy ? '对齐中…' : '对齐已写进展'}
          </Button>
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

      {alignNotice && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs text-zinc-400">
          {alignNotice}
        </div>
      )}

      {alignRevisions && alignRevisions.length > 0 && (
        <Card className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-zinc-200">
              大纲对齐建议（{alignRevisions.length} 章）
            </span>
            <span className="text-xs text-zinc-500">
              勾选要应用的修订，确认后覆盖更新对应章节梗概
            </span>
            <Button
              className="ml-auto"
              onClick={applyAlign}
              disabled={alignSkip.size === alignRevisions.length}
            >
              应用所选（{alignRevisions.length - alignSkip.size}）
            </Button>
            <Button variant="ghost" onClick={() => setAlignRevisions(null)}>
              放弃
            </Button>
          </div>
          {alignRevisions.map((r) => {
            const skip = alignSkip.has(r.outlineId)
            return (
              <div
                key={r.outlineId}
                className={`rounded-md border p-2.5 text-xs leading-5 ${
                  skip
                    ? 'border-zinc-800 bg-zinc-950/40 opacity-50'
                    : 'border-amber-900/40 bg-zinc-950'
                }`}
              >
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!skip}
                    onChange={(e) =>
                      setAlignSkip((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.delete(r.outlineId)
                        else next.add(r.outlineId)
                        return next
                      })
                    }
                    className="h-3.5 w-3.5 cursor-pointer accent-amber-600"
                  />
                  <span className="font-medium text-zinc-200">
                    第 {r.chapterNo} 章《{r.title}》
                  </span>
                  {r.reason && <span className="text-amber-400/80">{r.reason}</span>}
                </label>
                <div className="mt-1 whitespace-pre-wrap text-zinc-400">{r.synopsis}</div>
                {r.scenes && r.scenes.length > 0 && (
                  <div className="mt-1 text-xs text-zinc-500">
                    场景：
                    {r.scenes.join(' / ')}
                  </div>
                )}
                {r.hook && <div className="mt-0.5 text-zinc-500">钩子：{r.hook}</div>}
              </div>
            )
          })}
        </Card>
      )}

      {genOpen && (
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-zinc-500">选择卷</span>
            {chipVols.map((v) => {
              const w = volWritten(v)
              const active = v === volume
              return (
                <button
                  key={v}
                  type="button"
                  disabled={genBusy}
                  onClick={() => setVolume(v)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-50 ${
                    active
                      ? 'bg-amber-600 font-medium text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                  }`}
                >
                  第 {v} 卷
                  {w > 0 && (
                    <span className={active ? ' text-amber-100' : ' text-zinc-500'}>
                      {' '}
                      · 已写{w}
                    </span>
                  )}
                </button>
              )
            })}
            <button
              type="button"
              disabled={genBusy}
              onClick={() => setVolume(nextVol)}
              className={`rounded-full px-3 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-50 ${
                volume === nextVol
                  ? 'bg-amber-600 font-medium text-white'
                  : 'border border-dashed border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
              }`}
            >
              ＋ 第 {nextVol} 卷
            </button>
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label>
                第 {volume} 卷 ·
                核心创意（题材、主角、金手指、主线冲突；已有世界观/人物会自动作为上下文）
              </Label>
              <Button
                variant="ghost"
                className="shrink-0 px-2 py-1 text-xs"
                disabled={genBusy || ideaBusy || !idea.trim()}
                onClick={() => {
                  setIdeaBusy(true)
                  setGenNotice('')
                  const { done, abort } = generateVolumeIdea({
                    projectId,
                    volume,
                    idea: idea.trim(),
                    rules: rules.trim() || undefined,
                    globalRules: globalRules.trim() || undefined,
                    onDelta: (t) => setGenOutput((prev) => (prev + t).slice(-1200))
                  })
                  ideaAbortRef.current = abort
                  done
                    .then((text) => {
                      setIdea(text)
                      void rememberVolumePlan(projectId, volume, {
                        idea: text,
                        count: Math.max(1, Math.floor(count) || 30),
                        rules: rules.trim() || undefined
                      })
                    })
                    .catch((err: unknown) => {
                      setGenNotice(`出错：${(err as Error).message}`)
                    })
                    .finally(() => {
                      ideaAbortRef.current = null
                      setIdeaBusy(false)
                    })
                }}
              >
                {ideaBusy ? '扩写中…' : 'AI 扩写成创意'}
              </Button>
            </div>
            <ExpandableTextarea
              ui={{ Textarea, Button }}
              rows={5}
              value={idea}
              onChange={setIdea}
              placeholder="例：末法时代最后一位炼丹师重生都市，靠一手丹术搅动风云…（也可写简短要求，点「AI 扩写成创意」补全）"
              disabled={genBusy}
              overlayTitle={`第 ${volume} 卷 · 核心创意`}
            />
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label>通用规则（全书各卷适用，每行一条；随本卷大纲生成注入，逐章严格执行）</Label>
              <Button
                variant="ghost"
                className="shrink-0 px-2 py-1 text-xs"
                disabled={gRulesBusy || genBusy || !globalRules.trim()}
                onClick={() => {
                  setGRulesBusy(true)
                  setGenNotice('')
                  const { done, abort } = generateRulesRefine({
                    projectId,
                    volume,
                    rules: globalRules.trim(),
                    onDelta: (t) => setGenOutput((prev) => (prev + t).slice(-1200))
                  })
                  gRulesAbortRef.current = abort
                  done
                    .then((text) => {
                      setGlobalRules(text)
                      void saveProjectPlan(projectId, { outlineRules: text })
                    })
                    .catch((err: unknown) => {
                      setGenNotice(`出错：${(err as Error).message}`)
                    })
                    .finally(() => {
                      gRulesAbortRef.current = null
                      setGRulesBusy(false)
                    })
                }}
              >
                {gRulesBusy ? '优化中…' : 'AI 优化规则'}
              </Button>
            </div>
            <ExpandableTextarea
              ui={{ Textarea, Button }}
              rows={4}
              value={globalRules}
              onChange={setGlobalRules}
              onCommit={(v) => {
                void saveProjectPlan(projectId, { outlineRules: v })
              }}
              placeholder={'例：\n每 10 章安排一个单元故事收尾\n主角每次突破都须付出明确代价'}
              disabled={genBusy}
              overlayTitle="通用规则（全书各卷适用）"
            />
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label>
                第 {volume} 卷 · 节奏与硬性要求（每行一条，原样透传给大纲生成、逐章严格执行，不经 AI
                改写）
              </Label>
              <Button
                variant="ghost"
                className="shrink-0 px-2 py-1 text-xs"
                disabled={rulesBusy || genBusy || !rules.trim()}
                onClick={() => {
                  setRulesBusy(true)
                  setGenNotice('')
                  const { done, abort } = generateRulesRefine({
                    projectId,
                    volume,
                    rules: rules.trim(),
                    globalRules: globalRules.trim() || undefined,
                    onDelta: (t) => setGenOutput((prev) => (prev + t).slice(-1200))
                  })
                  rulesAbortRef.current = abort
                  done
                    .then((text) => {
                      setRules(text)
                      void rememberVolumePlan(projectId, volume, {
                        idea,
                        count: Math.max(1, Math.floor(count) || 30),
                        rules: text
                      })
                    })
                    .catch((err: unknown) => {
                      setGenNotice(`出错：${(err as Error).message}`)
                    })
                    .finally(() => {
                      rulesAbortRef.current = null
                      setRulesBusy(false)
                    })
                }}
              >
                {rulesBusy ? '优化中…' : 'AI 优化规则'}
              </Button>
            </div>
            <ExpandableTextarea
              ui={{ Textarea, Button }}
              rows={4}
              value={rules}
              onChange={setRules}
              onCommit={(v) => {
                // 与通用规则对称：弹层完成即记忆，切卷重进不丢
                void rememberVolumePlan(projectId, volume, {
                  idea,
                  count: Math.max(1, Math.floor(count) || 30),
                  rules: v
                })
              }}
              placeholder={
                '例：\n每 3~6 章插入一段独立的色情小故事\n每 10 章安排一个单元小故事收尾'
              }
              disabled={genBusy}
              overlayTitle={`第 ${volume} 卷 · 节奏与硬性要求`}
            />
          </div>
          <div className="max-w-48">
            <Label>生成章数</Label>
            <NumberField
              input={Input}
              value={count}
              min={1}
              onChange={setCount}
              disabled={genBusy}
            />
          </div>
          {targetWritten && (
            <p className="text-xs text-amber-400/90">
              第 {volume} 卷已有 {volWritten(volume)} 章正文——生成将按「全卷重写」执行：重生成大纲后
              自动覆盖重写该卷全部章节正文（原稿不保留）。
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button
              variant={targetWritten ? 'danger' : 'primary'}
              disabled={genBusy || ideaBusy || rulesBusy || gRulesBusy || !idea.trim()}
              onClick={() => {
                if (
                  targetWritten &&
                  !window.confirm(
                    `第 ${volume} 卷已有 ${volWritten(volume)} 章正文。\n重写 = 重新生成该卷大纲 + 自动覆盖重写该卷全部章节正文，原稿不会保留。\n确定继续？`
                  )
                )
                  return
                setGenerating(true)
                setGenOutput('')
                setGenNotice('')
                // 通用规则原位编辑可能未经弹层 commit，生成启动时统一落库一次
                void saveProjectPlan(projectId, { outlineRules: globalRules })
                const { done, abort } = generateVolume({
                  projectId,
                  volume,
                  idea: idea.trim(),
                  rules: rules.trim() || undefined,
                  globalRules: globalRules.trim() || undefined,
                  startNo: deriveStartNo(volume, items),
                  count: Math.max(1, Math.floor(count) || 30),
                  hasWritten: targetWritten,
                  onDelta: (t) => setGenOutput((prev) => (prev + t).slice(-2000))
                })
                genAbortRef.current = abort
                done
                  .then((r) => {
                    if (!r.parsed || r.created + r.updated === 0)
                      setGenNotice('AI 输出无法解析为章节列表，请调整创意后重试')
                    else if (r.rewriting > 0)
                      setGenNotice(
                        `大纲已重生成（新建 ${r.created} · 更新 ${r.updated}），已开始自动重写该卷 ${r.rewriting} 章正文，进度见写作页${r.foreRemoved ? `；已删除埋于本卷的旧伏笔 ${r.foreRemoved} 条` : ''}`
                      )
                    else {
                      const parts = [`已导入 ${r.created} 章`]
                      if (r.updated) parts.push(`更新 ${r.updated} 章`)
                      if (r.skipped) parts.push(`跳过已存在 ${r.skipped} 章`)
                      setGenNotice(parts.join('，'))
                    }
                    load()
                  })
                  .catch((err: unknown) => {
                    setGenNotice(`出错：${(err as Error).message}`)
                  })
                  .finally(() => {
                    genAbortRef.current = null
                    setGenerating(false)
                  })
              }}
            >
              {generating
                ? '生成中…'
                : outlineActive
                  ? '后台生成中…'
                  : targetWritten
                    ? `重写第 ${volume} 卷（大纲+正文）`
                    : `生成第 ${volume} 卷大纲`}
            </Button>
            {(generating || ideaBusy || rulesBusy || gRulesBusy) && (
              <Button
                variant="danger"
                onClick={() => {
                  genAbortRef.current?.()
                  ideaAbortRef.current?.()
                  rulesAbortRef.current?.()
                  gRulesAbortRef.current?.()
                }}
              >
                中断
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                if (projectId) fireCanonSync(projectId, volume)
              }}
            >
              同步设定与人物
            </Button>
            {outlineActive && !generating && (
              <span className="text-xs text-amber-600">
                后台大纲生成中，完成后自动导入（可离开此页）
              </span>
            )}
            {genNotice && <span className="text-xs text-zinc-400">{genNotice}</span>}
          </div>
          {generating && (
            <pre className="max-h-32 overflow-hidden rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-600">
              {genOutput || '等待模型输出…'}
            </pre>
          )}
          {outlineActive && !generating && <OutlineProgress text={outlineRun.tail} />}
        </Card>
      )}

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
          desc="AI 依据核心创意一次性生成整卷章节大纲（含定位/悬念/反转/钩子/伏笔操作元数据），也可手动录入。"
        >
          <Button variant="ghost" onClick={() => setGenOpen((v) => !v)}>
            AI 生成大纲
          </Button>
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
              {volSummaries[vol] && (
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => setOpenVolumeSummary(openVolumeSummary === vol ? null : vol)}
                >
                  {openVolumeSummary === vol ? '收起卷摘要' : '查看卷摘要'}
                </Button>
              )}
              <Button
                variant="ghost"
                className="px-2 py-0.5 text-xs"
                onClick={() => volumeSummary(vol)}
              >
                {volSummaries[vol] ? '重新生成卷摘要' : '生成卷摘要'}
              </Button>
            </div>
          </div>
          {openVolumeSummary === vol && volSummaries[vol] && (
            <div className="border-b border-zinc-800 bg-zinc-950/60 px-4 py-3 text-xs leading-6 whitespace-pre-wrap text-zinc-400">
              {volSummaries[vol]}
            </div>
          )}
          {volNotice && (
            <div className="border-b border-zinc-800 px-4 py-1.5 text-xs text-zinc-500">
              {volNotice}
            </div>
          )}
          <div className="divide-y divide-zinc-800/60">
            {list.map((it) => {
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
