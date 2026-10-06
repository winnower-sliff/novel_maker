import { Empty, Input, Label, Textarea } from '@mobile/components/ui'
import { DetailShell, EditBar, Row } from '@mobile/pages/subs/parts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  deriveStartNo,
  generateRulesRefine,
  generateVolume,
  generateVolumeIdea,
  rememberVolumePlan,
  useOutlineRunActive
} from '@wizard/volumeGen'
import { fireCanonSync } from '@wizard/canonStore'
import { ExpandableTextarea, NumberField, OutlineProgress } from '@wizard/widgets'
import { loadProjectPlan, type WizardPlanFull, saveProjectPlan } from '@wizard/wizardPlan'
import { mobileWizardUi } from '@mobile/lib/wizardUi'
import { withSnapshot } from '@mobile/lib/querySnapshot'
import type { Foreshadow, OutlineItem } from '@shared/types'
import { buildOutlineNoIndex, formatChapterRef, isDanglingRef } from '@shared/foreRef'

const FORESHADOW_STATUS = ['planted', 'resolved', 'abandoned']

/** 卷章大纲子页：卷分组章列表 + 每卷生成参数记忆（volumePlans）+ 重写已写卷（大纲+正文全卷重写）+ 伏笔台账 */
export default function OutlineSub({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const { data: outlines = [] } = useQuery({
    queryKey: ['novel', 'outlines', projectId],
    queryFn: withSnapshot(['novel', 'outlines', projectId], () =>
      window.api.novel.outlines(projectId)
    )
  })
  const { data: briefs = [] } = useQuery({
    queryKey: ['novel', 'chapterBriefs', projectId],
    queryFn: withSnapshot(['novel', 'chapterBriefs', projectId], () =>
      window.api.novel.chapterBriefs(projectId)
    )
  })
  const [editId, setEditId] = useState<string | null>(null)
  const editing = outlines.find((o) => o.id === editId) ?? null
  const [feditId, setFeditId] = useState<string | null>(null)
  const [openScenes, setOpenScenes] = useState<Set<string>>(new Set())
  // 生成区收起为入口；卷分组折叠（会话内记忆）
  const [genOpen, setGenOpen] = useState(false)
  const [collapsedVols, setCollapsedVols] = useState<Record<number, boolean>>({})
  const toggleScenes = (id: string): void => {
    setOpenScenes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // —— 生成区 ——
  const [plan, setPlan] = useState<WizardPlanFull | null>(null)
  const [volume, setVolume] = useState(1)
  const [count, setCount] = useState(20)
  const [idea, setIdea] = useState('')
  const [localBusy, setLocalBusy] = useState(false)
  const [ideaBusy, setIdeaBusy] = useState(false)
  const [rules, setRules] = useState('')
  const [rulesBusy, setRulesBusy] = useState(false)
  // 通用规则：全书各卷适用（存 wizard_plan.outlineRules，区别于 volumePlans[].rules 的本卷规则）
  const [globalRules, setGlobalRules] = useState('')
  const [gRulesBusy, setGRulesBusy] = useState(false)
  const [delta, setDelta] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  // 已预填的 `${volume}:${memo}` 签名去重：不能拿 busy 当守卫——重挂时 snapshot 先到、
  // plan 后到，busy=true 会拦掉恢复预填，表单被锁死在顶层旧值（手机端 100 章实锤）
  const filledSig = useRef('')
  // busy = 本地生成 || 后台在途 run（切页/刷新后生成继续，重挂时恢复 busy 态防重复触发）
  const outlineRun = useOutlineRunActive(projectId)
  const outlineActive = outlineRun.active
  const busy = localBusy || outlineActive

  useEffect(() => {
    let alive = true
    void loadProjectPlan(projectId)
      .then((p) => {
        if (!alive) return
        setPlan(p)
        setCount(p?.outlineCount ?? 20)
        setIdea(p?.outlineIdea ?? '')
        setGlobalRules(p?.outlineRules ?? '')
        // 重挂回到最近操作的卷（生成启动时已写入），配合 volumePlans 预填恢复本次参数
        if (p && Number.isInteger(p.volume) && p.volume >= 1) setVolume(p.volume)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId])

  const sorted = [...outlines].sort((a, b) => a.volume - b.volume || a.chapterNo - b.chapterNo)
  const volumes = [...new Set(sorted.map((o) => o.volume))]
  const showGenForm = genOpen || sorted.length === 0

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
    const memo = plan?.volumePlans?.[String(volume)]
    const sig = `${volume}:${memo ? JSON.stringify(memo) : ''}`
    if (filledSig.current === sig) return
    filledSig.current = sig
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
    if (!idea.trim() || busy || ideaBusy || rulesBusy || gRulesBusy) return
    if (!rules.trim() && !globalRules.trim()) {
      const go = window.confirm(
        '通用规则与本卷规则都是空的，本次生成将不附加任何节奏/硬性要求。\n仍要继续吗？'
      )
      if (!go) return
    }
    if (
      targetWritten &&
      !window.confirm(
        `第 ${volume} 卷已有 ${volWritten(volume)} 章正文。\n重写 = 重新生成该卷大纲，并清除该卷全部旧正文与摘要（原稿不保留，不会自动重写）。\n确定继续？`
      )
    )
      return
    setLocalBusy(true)
    setError(null)
    setResult(null)
    setDelta('')
    // 通用规则原位编辑可能未经弹层 commit，生成启动时统一落库一次
    void saveProjectPlan(projectId, { outlineRules: globalRules })
    const { done } = generateVolume({
      projectId,
      volume,
      idea: idea.trim(),
      rules: rules.trim() || undefined,
      globalRules: globalRules.trim() || undefined,
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
      if (r.cleared > 0) {
        setResult(
          `大纲已重生成（新建 ${r.created} · 更新 ${r.updated}），已清除该卷 ${r.cleared} 章旧正文与摘要${r.foreRemoved ? `，并删除埋于本卷的旧伏笔 ${r.foreRemoved} 条` : ''}；需要重写正文时到「写作」子页主动触发`
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
    <div className="h-full overflow-y-auto overscroll-contain p-3">
      {/* 生成区：收起为入口，空库/点开时展开表单（hidden 保持挂载，参数不丢） */}
      {!showGenForm && (
        <button
          type="button"
          onClick={() => setGenOpen(true)}
          className="mb-4 flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-zinc-700 bg-zinc-900/30 px-3 py-2.5 text-sm text-amber-300/90 active:bg-zinc-900"
        >
          <span>＋</span>
          <span>生成 / 重写大纲</span>
          <span className="text-xs text-zinc-500">第 {volume} 卷</span>
          {busy && <span className="ml-auto text-xs text-amber-400">生成中…</span>}
        </button>
      )}
      <div
        className={`space-y-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 ${
          showGenForm ? '' : 'hidden'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-500">大纲生成</span>
          {sorted.length > 0 && (
            <button
              type="button"
              className="ml-auto shrink-0 cursor-pointer text-xs text-zinc-500"
              onClick={() => setGenOpen(false)}
            >
              收起
            </button>
          )}
        </div>
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
                globalRules: globalRules.trim() || undefined,
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
        <ExpandableTextarea
          ui={mobileWizardUi}
          rows={5}
          value={idea}
          onChange={setIdea}
          disabled={busy}
          placeholder="例：主角进入宗门后的第一次试炼，与同门结怨、初窥力量体系…（也可写简短要求，点「AI 扩写成创意」补全）"
          overlayTitle={`第 ${volume} 卷 · 本卷创意`}
        />
        {ideaBusy && (
          <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-500">
            {delta.slice(-400) || '扩写中…'}
          </pre>
        )}
        <div className="flex items-center justify-between gap-2">
          <Label>
            通用规则（全书各卷适用，每行一条；随大纲生成注入，逐章严格执行）
            {!globalRules.trim() && <span className="ml-1 text-amber-500">· 未填写，不生效</span>}
          </Label>
          <button
            type="button"
            onClick={() => {
              if (gRulesBusy || busy || !globalRules.trim()) return
              setGRulesBusy(true)
              setError(null)
              setResult(null)
              setDelta('')
              const { done } = generateRulesRefine({
                projectId,
                volume,
                rules: globalRules.trim(),
                onDelta: (t) => setDelta((v) => v + t)
              })
                        void done
                .then((text) => {
                  setGlobalRules(text)
                  void saveProjectPlan(projectId, { outlineRules: text })
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => {
                  setGRulesBusy(false)
                })
            }}
            disabled={gRulesBusy || busy || !globalRules.trim()}
            className="shrink-0 cursor-pointer rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 active:bg-zinc-800 disabled:cursor-default disabled:opacity-40"
          >
            {gRulesBusy ? '优化中…' : 'AI 优化规则'}
          </button>
        </div>
        <ExpandableTextarea
          ui={mobileWizardUi}
          rows={4}
          value={globalRules}
          onChange={setGlobalRules}
          onCommit={(v) => {
            void saveProjectPlan(projectId, { outlineRules: v })
          }}
          disabled={busy}
          placeholder={'例：\n每 10 章安排一个单元故事收尾\n主角每次突破都须付出明确代价'}
          overlayTitle="通用规则（全书各卷适用）"
        />
        {gRulesBusy && (
          <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-500">
            {delta.slice(-400) || '优化中…'}
          </pre>
        )}
        <div className="flex items-center justify-between gap-2">
          <Label>
            第 {volume} 卷 · 节奏与硬性要求（每行一条，原样透传、逐章严格执行）
            {!rules.trim() && <span className="ml-1 text-amber-500">· 未填写，不生效</span>}
          </Label>
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
                globalRules: globalRules.trim() || undefined,
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
        <ExpandableTextarea
          ui={mobileWizardUi}
          rows={4}
          value={rules}
          onChange={setRules}
          onCommit={(v) => {
            // 与通用规则对称：弹层完成即记忆，切卷重进不丢
            void rememberVolumePlan(projectId, volume, {
              idea,
              count: count >= 1 ? Math.floor(count) : 20,
              rules: v
            })
          }}
          disabled={busy}
          placeholder={'例：\n每 3~6 章插入一段独立的色情小故事\n每 10 章安排一个单元小故事收尾'}
          overlayTitle={`第 ${volume} 卷 · 节奏与硬性要求`}
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy || ideaBusy || rulesBusy || gRulesBusy || !idea.trim()}
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
          <button
            type="button"
            onClick={() => fireCanonSync(projectId, volume)}
            className="cursor-pointer rounded-lg border border-zinc-700 px-3.5 py-2 text-sm text-zinc-300 active:bg-zinc-900"
          >
            同步设定与人物
          </button>
        </div>
      </div>

      {/* 生成/后台进度与错误、结果常显（表单收起时也可见） */}
      {(localBusy || outlineActive) && (
        <div className="mt-4">
          <OutlineProgress
            progress={outlineRun.progress}
            text={localBusy ? delta : outlineRun.tail}
          />
        </div>
      )}
      {outlineActive && !localBusy && (
        <div className="mt-4 text-xs text-amber-400">后台大纲生成中，完成后会自动导入（可离开此页）</div>
      )}
      {error && <div className="mt-4 text-xs text-red-400">{error}</div>}
      {result && !busy && <div className="mt-4 text-xs text-emerald-400">{result}</div>}

      <div className="mt-4">
        {sorted.length === 0 ? (
          <Empty text="暂无大纲章节" />
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
                            queryKey: ['novel', 'outlines', projectId]
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
                                    queryKey: ['novel', 'outlines', projectId]
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
                                    queryKey: ['novel', 'outlines', projectId]
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
    queryKey: ['novel', 'foreshadows', projectId],
    queryFn: withSnapshot(['novel', 'foreshadows', projectId], () =>
      window.api.novel.foreshadows(projectId)
    )
  })
  const { data: outlines = [] } = useQuery({
    queryKey: ['novel', 'outlines', projectId],
    queryFn: withSnapshot(['novel', 'outlines', projectId], () =>
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
    queryKey: ['novel', 'foreshadows', projectId],
    queryFn: withSnapshot(['novel', 'foreshadows', projectId], () =>
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
  const [plannedId, setPlannedId] = useState(item.plannedResolveOutlineId)
  const [saving, setSaving] = useState(false)
  const { data: outlines = [] } = useQuery({
    queryKey: ['novel', 'outlines', projectId],
    queryFn: withSnapshot(['novel', 'outlines', projectId], () =>
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
