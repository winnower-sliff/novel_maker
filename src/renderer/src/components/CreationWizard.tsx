import type { PremiseDraftCharacter, PremiseDraftResult, Project } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { startPipeline } from '../lib/ipc'
import type { Navigate } from '../lib/nav'
import { startGen, useWbGenTasks, useWbLiveEntries } from '../lib/wbGenStore'
import { closeWizard, useWizard } from '../lib/wizardStore'
import { OverlayCard } from './OverlayCard'
import { Badge, Button, Input, Label, Textarea } from './ui'

const STEP_LABELS = ['设定确认', '世界观', '人物', '大纲', '完成']
const STEP_LABELS_SHORT = ['设定', '世界观', '人物', '大纲', '完成']

// 向导草稿存档：随 project.wizardPlan 落库，刷新/换端后可恢复
interface WizardPlanSave {
  draftText: string
  wbBrief: string
  wbCats: string[]
  wbCount: number
  chars: PremiseDraftCharacter[]
  outlineIdea: string
  outlineCount: number
  volume: number
  startNo: number
  step: number
}

function parsePlan(raw: string | undefined): WizardPlanSave | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<WizardPlanSave> | null
    if (!v || typeof v !== 'object') return null
    return {
      draftText: v.draftText ?? '',
      wbBrief: v.wbBrief ?? '',
      wbCats: Array.isArray(v.wbCats) ? v.wbCats : [],
      wbCount: typeof v.wbCount === 'number' ? v.wbCount : 8,
      chars: Array.isArray(v.chars) ? v.chars : [],
      outlineIdea: v.outlineIdea ?? '',
      outlineCount: typeof v.outlineCount === 'number' ? v.outlineCount : 20,
      volume: typeof v.volume === 'number' ? v.volume : 1,
      startNo: typeof v.startNo === 'number' ? v.startNo : 1,
      step: typeof v.step === 'number' ? Math.min(4, Math.max(0, v.step)) : 1
    }
  } catch {
    return null
  }
}

function StreamBox({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLPreElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: dep 仅作重触发信号，加入会破坏语义
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return (
    <pre
      ref={ref}
      className={`overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs leading-relaxed text-zinc-400 ${className}`}
    >
      {text || '…'}
    </pre>
  )
}

interface CreationWizardProps {
  onNavigate: Navigate
}

export function CreationWizard({ onNavigate }: CreationWizardProps) {
  const { open, projectId, step: initialStep } = useWizard()
  const [project, setProject] = useState<Project | null>(null)
  const [step, setStep] = useState(0)

  const [draftBusy, setDraftBusy] = useState(false)
  const [draftDelta, setDraftDelta] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const draftAbortRef = useRef<(() => void) | null>(null)

  const [wbBrief, setWbBrief] = useState('')
  const [wbCats, setWbCats] = useState<string[]>([])
  const [wbCount, setWbCount] = useState(8)
  const [wbStarted, setWbStarted] = useState(false)
  const [wbResult, setWbResult] = useState<string | null>(null)
  const wbBeforeRef = useRef<number | null>(null)
  const [typeOptions, setTypeOptions] = useState<string[]>([])
  const wbTasks = useWbGenTasks(projectId ?? '')
  const wbLive = useWbLiveEntries(projectId ?? '')
  const wbRunning = wbTasks.length > 0
  const wbTask = wbTasks[0] ?? null

  const [chars, setChars] = useState<PremiseDraftCharacter[]>([])
  const [charIndex, setCharIndex] = useState(-1)
  const [charDelta, setCharDelta] = useState('')
  const [charError, setCharError] = useState<string | null>(null)
  const [charDoneNames, setCharDoneNames] = useState<string[]>([])
  const [charRunning, setCharRunning] = useState(false)
  const charAbortRef = useRef<(() => void) | null>(null)

  const [outlineIdea, setOutlineIdea] = useState('')
  const [outlineCount, setOutlineCount] = useState(20)
  const [volume, setVolume] = useState(1)
  const [startNo, setStartNo] = useState(1)
  const [outlineBusy, setOutlineBusy] = useState(false)
  const [outlineDelta, setOutlineDelta] = useState('')
  const [outlineError, setOutlineError] = useState<string | null>(null)
  const [outlineDone, setOutlineDone] = useState(false)
  const outlineAbortRef = useRef<(() => void) | null>(null)

  const [finalCounts, setFinalCounts] = useState<{ wb: number; char: number; ol: number } | null>(
    null
  )
  const [existing, setExisting] = useState<{ wb: number; char: number; ol: number } | null>(null)

  useEffect(() => {
    if (!open || !projectId) return
    setProject(null)
    setStep(0)
    setDraftBusy(false)
    setDraftDelta('')
    setDraftError(null)
    draftAbortRef.current = null
    setWbBrief('')
    setWbCats([])
    setWbCount(8)
    setWbStarted(false)
    setWbResult(null)
    wbBeforeRef.current = null
    setChars([])
    setCharIndex(-1)
    setCharDelta('')
    setCharError(null)
    setCharDoneNames([])
    setCharRunning(false)
    charAbortRef.current = null
    setOutlineIdea('')
    setOutlineCount(20)
    setVolume(1)
    setStartNo(1)
    setOutlineBusy(false)
    setOutlineDelta('')
    setOutlineError(null)
    setOutlineDone(false)
    outlineAbortRef.current = null
    setFinalCounts(null)
    setExisting(null)
    void Promise.all([
      window.api.novel.projects(),
      window.api.novel.worldbuild(projectId),
      window.api.novel.characters(projectId),
      window.api.novel.outlines(projectId)
    ])
      .then(([ps, wb, cs, ol]) => {
        const p = ps.find((x) => x.id === projectId) ?? null
        setProject(p)
        const counts = { wb: wb.length, char: cs.length, ol: ol.length }
        setExisting(counts)
        const saved = parsePlan(p?.wizardPlan)
        if (saved) {
          setDraftDelta(saved.draftText)
          setWbBrief(saved.wbBrief)
          setWbCats(saved.wbCats)
          setWbCount(saved.wbCount)
          setChars(saved.chars)
          setOutlineIdea(saved.outlineIdea)
          setOutlineCount(saved.outlineCount)
          setVolume(saved.volume)
          setStartNo(saved.startNo)
        }
        setStep(
          initialStep ??
            (saved
              ? saved.step
              : counts.wb === 0
                ? 0
                : counts.char === 0
                  ? 2
                  : counts.ol === 0
                    ? 3
                    : 4)
        )
      })
      .catch(() => {})
    void window.api.novel
      .worldbuildTypes(projectId)
      .then(setTypeOptions)
      .catch(() => {})
  }, [open, projectId, initialStep])

  useEffect(() => {
    if (step !== 4 || !projectId) return
    void Promise.all([
      window.api.novel.worldbuild(projectId),
      window.api.novel.characters(projectId),
      window.api.novel.outlines(projectId)
    ])
      .then(([wb, cs, ol]) => setFinalCounts({ wb: wb.length, char: cs.length, ol: ol.length }))
      .catch(() => {})
  }, [step, projectId])

  useEffect(() => {
    if (!wbStarted || wbRunning || !projectId) return
    void window.api.novel
      .worldbuild(projectId)
      .then((l) => {
        const before = wbBeforeRef.current
        if (before === null) return
        const n = l.length - before
        setWbResult(
          n > 0 ? `本次生成入库 ${n} 条世界观条目` : '本次未解析出有效条目，可调整需求后重试'
        )
      })
      .catch(() => {})
  }, [wbStarted, wbRunning, projectId])

  const abortAll = (): void => {
    draftAbortRef.current?.()
    charAbortRef.current?.()
    outlineAbortRef.current?.()
    draftAbortRef.current = null
    charAbortRef.current = null
    outlineAbortRef.current = null
  }

  // 草稿落库：关闭时保存（完成向导则清空），起草完成后立即保存。
  // patch 用于在 setState 未生效的闭包里显式传入最新值
  const savePlan = (patch: Partial<WizardPlanSave> = {}, clear = false): void => {
    if (!projectId) return
    if (clear) {
      void window.api.novel.projectUpdate(projectId, { wizardPlan: '' }).catch(() => {})
      return
    }
    const payload: WizardPlanSave = {
      draftText: patch.draftText ?? draftDelta,
      wbBrief: patch.wbBrief ?? wbBrief,
      wbCats: patch.wbCats ?? wbCats,
      wbCount: patch.wbCount ?? wbCount,
      chars: patch.chars ?? chars,
      outlineIdea: patch.outlineIdea ?? outlineIdea,
      outlineCount: patch.outlineCount ?? outlineCount,
      volume: patch.volume ?? volume,
      startNo: patch.startNo ?? startNo,
      step: patch.step ?? step
    }
    void window.api.novel
      .projectUpdate(projectId, { wizardPlan: JSON.stringify(payload) })
      .catch(() => {})
  }

  const handleClose = (): void => {
    abortAll()
    if (step >= 4) savePlan(undefined, true)
    else savePlan()
    closeWizard()
  }

  const applyPlan = (plan: PremiseDraftResult): void => {
    setWbBrief(plan.worldbuildBrief)
    setWbCats(plan.worldbuildCategories)
    setWbCount(plan.worldbuildCount)
    setChars(plan.characters)
    setOutlineIdea(plan.outlineIdea)
    setOutlineCount(plan.outlineCount)
  }

  const runDraft = async (): Promise<void> => {
    if (!projectId) return
    setDraftBusy(true)
    setDraftError(null)
    setDraftDelta('')
    let acc = ''
    const { done, abort } = startPipeline('premiseDraft', { projectId }, (t) => {
      acc += t
      setDraftDelta((v) => v + t)
    })
    draftAbortRef.current = abort
    try {
      const payload = await done
      const plan = payload.data as PremiseDraftResult
      applyPlan(plan)
      setTypeOptions((prev) => Array.from(new Set([...prev, ...plan.worldbuildCategories])))
      setStep(1)
      savePlan({
        draftText: acc,
        wbBrief: plan.worldbuildBrief,
        wbCats: plan.worldbuildCategories,
        wbCount: plan.worldbuildCount,
        chars: plan.characters,
        outlineIdea: plan.outlineIdea,
        outlineCount: plan.outlineCount,
        step: 1
      })
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e))
    } finally {
      draftAbortRef.current = null
      setDraftBusy(false)
    }
  }

  const skipDraft = (): void => {
    applyPlan({
      worldbuildBrief: '',
      worldbuildCategories: ['力量体系', '地理', '势力', '历史', '物品'],
      worldbuildCount: 8,
      characters: [{ name: '', brief: '' }],
      outlineIdea: '',
      outlineCount: 20
    })
    setStep(1)
  }

  const toggleCat = (c: string): void => {
    setWbCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
  }

  const startWorldbuild = (): void => {
    if (!projectId || !wbBrief.trim() || wbRunning) return
    const count = Number(wbCount)
    setWbResult(null)
    void window.api.novel
      .worldbuild(projectId)
      .then((l) => {
        wbBeforeRef.current = l.length
      })
      .catch(() => {})
    startGen({
      projectId,
      categories: wbCats,
      title: '',
      brief: wbBrief.trim(),
      count: Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined
    })
    setWbStarted(true)
  }

  const runCharQueue = async (from: number): Promise<void> => {
    if (!projectId) return
    setCharRunning(true)
    setCharError(null)
    for (let i = from; i < chars.length; i++) {
      const c = chars[i]
      if (!c.name.trim() || !c.brief.trim()) continue
      setCharIndex(i)
      setCharDelta('')
      const { done, abort } = startPipeline(
        'character',
        { projectId, name: c.name.trim(), brief: c.brief.trim() },
        (t) => setCharDelta((v) => v + t)
      )
      charAbortRef.current = abort
      try {
        await done
        setCharDoneNames((prev) => [...prev, c.name.trim()])
      } catch (e) {
        setCharError(e instanceof Error ? e.message : String(e))
        charAbortRef.current = null
        setCharRunning(false)
        return
      }
    }
    charAbortRef.current = null
    setCharIndex(-1)
    setCharRunning(false)
  }

  const updateChar = (i: number, patch: Partial<PremiseDraftCharacter>): void => {
    setChars((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  const addChar = (): void => {
    setChars((prev) => [...prev, { name: '', brief: '' }])
  }

  const removeChar = (i: number): void => {
    setChars((prev) => prev.filter((_, idx) => idx !== i))
  }

  const runOutline = async (): Promise<void> => {
    if (!projectId || !outlineIdea.trim()) return
    setOutlineBusy(true)
    setOutlineError(null)
    setOutlineDelta('')
    setOutlineDone(false)
    const count = Number(outlineCount)
    const { done, abort } = startPipeline(
      'outline',
      {
        projectId,
        idea: outlineIdea.trim(),
        volume: Number(volume) || 1,
        startNo: Number(startNo) || 1,
        count: Number.isFinite(count) && count >= 1 ? Math.floor(count) : 20
      },
      (t) => setOutlineDelta((v) => v + t)
    )
    outlineAbortRef.current = abort
    try {
      await done
      setOutlineDone(true)
    } catch (e) {
      setOutlineError(e instanceof Error ? e.message : String(e))
    } finally {
      outlineAbortRef.current = null
      setOutlineBusy(false)
    }
  }

  const goto = (page: Parameters<Navigate>[0]): void => {
    handleClose()
    onNavigate(page)
  }

  if (!open || !projectId) return null

  return (
    <OverlayCard
      open={open}
      onClose={handleClose}
      title="创作向导"
      widthClass="max-w-2xl"
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">
            第 {step + 1}/{STEP_LABELS.length} 步 · {STEP_LABELS[step]}
          </span>
          <Button variant="ghost" onClick={handleClose}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-1">
          {STEP_LABELS.map((label, i) => (
            <button
              type="button"
              key={label}
              disabled={i >= step}
              onClick={() => setStep(i)}
              className={`flex-1 cursor-pointer rounded px-1 py-1 text-center text-[10px] transition-colors disabled:cursor-default sm:text-xs ${
                i === step
                  ? 'bg-amber-600/20 font-medium text-amber-300'
                  : i < step
                    ? 'text-emerald-400 hover:bg-zinc-800'
                    : 'text-zinc-600'
              }`}
            >
              {i < step ? '✓ ' : `${i + 1}. `}
              <span className="hidden sm:inline">{label}</span>
              <span className="sm:hidden">{STEP_LABELS_SHORT[i]}</span>
            </button>
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm">
              <div className="font-medium text-zinc-100">{project?.title ?? '…'}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-zinc-500">
                {project?.genre && <span>题材：{project.genre}</span>}
                {project?.targetWords ? <span>目标字数：{project.targetWords}</span> : null}
              </div>
              {project?.styleGuide && (
                <div className="mt-1 line-clamp-2 text-xs text-zinc-500">
                  风格：{project.styleGuide}
                </div>
              )}
            </div>
            {(draftBusy || draftDelta) && <StreamBox text={draftDelta} className="h-28 shrink-0" />}
            {draftError && <div className="text-xs text-red-400">{draftError}</div>}
            <div className="flex items-center gap-2">
              <Button onClick={() => void runDraft()} disabled={draftBusy || !projectId}>
                {draftBusy ? '起草中…' : 'AI 起草创作方案'}
              </Button>
              <Button variant="ghost" onClick={skipDraft} disabled={draftBusy}>
                跳过，手动填写
              </Button>
            </div>
            <p className="text-xs text-zinc-500">
              {existing && existing.wb + existing.char + existing.ol > 0
                ? `检测到项目已有内容（世界观 ${existing.wb} 条 / 人物 ${existing.char} 张 / 大纲 ${existing.ol} 章），起草会衔接补全而非重复生成。`
                : 'AI 将根据书名与题材，起草世界观方向、核心人物清单与第一卷故事创意，生成后可逐项修改。'}
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label>世界观方向（将作为 AI 生成条目的需求描述）</Label>
              {existing && existing.wb > 0 && <Badge tone="green">已有 {existing.wb} 条</Badge>}
            </div>
            <Textarea
              value={wbBrief}
              onChange={(e) => setWbBrief(e.target.value)}
              rows={3}
              style={{ resize: 'vertical' }}
              disabled={wbStarted}
              placeholder="例：低魔武侠世界，内力源于血脉，朝廷与江湖门派相互制衡…"
            />
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="shrink-0 text-zinc-500">类型</span>
              {typeOptions.map((t) => (
                <button
                  type="button"
                  key={t}
                  disabled={wbStarted}
                  onClick={() => toggleCat(t)}
                  className={`cursor-pointer rounded-full px-2.5 py-0.5 transition-colors disabled:cursor-default ${
                    wbCats.includes(t)
                      ? 'bg-amber-600/20 text-amber-300'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="shrink-0 text-zinc-500">条目数</span>
              <Input
                type="number"
                min={1}
                max={12}
                value={wbCount}
                onChange={(e) => setWbCount(Number(e.target.value))}
                disabled={wbStarted}
                className="w-20"
              />
            </div>
            {wbRunning && wbTask && (
              <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-400">
                <div className="text-amber-300">
                  生成中（{wbTask.status === 'retrieving' ? '检索相关条目' : '生成'}）
                  {wbTask.committedCount > 0 && ` · 已入库 ${wbTask.committedCount} 条`}
                </div>
                {wbLive.length > 0 && (
                  <div className="mt-1 truncate text-zinc-500">
                    {wbLive
                      .slice(-3)
                      .map((s) => s.title)
                      .join(' / ')}
                  </div>
                )}
              </div>
            )}
            {wbResult && !wbRunning && <div className="text-xs text-emerald-400">{wbResult}</div>}
            <div className="flex items-center gap-2">
              <Button onClick={startWorldbuild} disabled={!wbBrief.trim() || wbRunning}>
                {wbRunning ? '生成中…' : wbStarted ? '再次生成' : '开始生成世界观'}
              </Button>
              <Button variant="ghost" onClick={() => setStep(2)}>
                {wbStarted || (existing?.wb ?? 0) > 0 ? '下一步' : '跳过这步'}
              </Button>
            </div>
            <p className="text-xs text-zinc-500">
              世界观在后台流式生成入库，可先继续后续步骤，进度见侧栏「世界观」badge。
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label>核心人物清单（逐个生成人物卡）</Label>
                {existing && existing.char > 0 && (
                  <Badge tone="green">已有 {existing.char} 张</Badge>
                )}
              </div>
              <button
                type="button"
                onClick={addChar}
                disabled={charRunning}
                className="cursor-pointer text-xs text-amber-400 hover:text-amber-300 disabled:text-zinc-600"
              >
                ＋ 添加
              </button>
            </div>
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {chars.map((c, i) => {
                const done = c.name.trim() !== '' && charDoneNames.includes(c.name.trim())
                const busy = charRunning && charIndex === i
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 追加式/一次性渲染列表，index 即身份，无重排语义
                  <div key={i} className="rounded-md border border-zinc-800 bg-zinc-900/50 p-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={c.name}
                        onChange={(e) => updateChar(i, { name: e.target.value })}
                        placeholder="姓名"
                        disabled={charRunning || done}
                        className="w-32 shrink-0"
                      />
                      {done ? (
                        <span className="text-xs text-emerald-400">已生成</span>
                      ) : busy ? (
                        <span className="text-xs text-amber-300">生成中…</span>
                      ) : null}
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => removeChar(i)}
                        disabled={charRunning || done}
                        className="cursor-pointer text-xs text-zinc-500 hover:text-red-400 disabled:cursor-default disabled:text-zinc-700"
                      >
                        移除
                      </button>
                    </div>
                    <Textarea
                      value={c.brief}
                      onChange={(e) => updateChar(i, { brief: e.target.value })}
                      rows={2}
                      disabled={charRunning || done}
                      placeholder="人物需求：定位/特质/与主线的关系"
                      className="mt-1.5"
                    />{' '}
                  </div>
                )
              })}
              {chars.length === 0 && (
                <div className="rounded-md border border-dashed border-zinc-800 p-3 text-center text-xs text-zinc-500">
                  清单为空，可「＋ 添加」或跳过这步
                </div>
              )}
            </div>
            {charRunning && <StreamBox text={charDelta} className="h-24 shrink-0" />}
            {charError && (
              <div className="flex items-center gap-2 text-xs text-red-400">
                <span className="truncate">{charError}</span>
                <Button variant="ghost" onClick={() => void runCharQueue(charIndex)}>
                  重试
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                onClick={() => void runCharQueue(0)}
                disabled={charRunning || chars.every((c) => !c.name.trim() && !c.brief.trim())}
              >
                {charRunning
                  ? `生成中（${charDoneNames.length + 1}/${chars.length}）`
                  : charDoneNames.length > 0
                    ? '重新生成全部'
                    : '开始生成'}
              </Button>
              <Button variant="ghost" onClick={() => setStep(3)} disabled={charRunning}>
                {charDoneNames.length > 0 || (existing?.char ?? 0) > 0 ? '下一步' : '跳过这步'}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label>第一卷核心创意</Label>
              {existing && existing.ol > 0 && <Badge tone="green">已有 {existing.ol} 章</Badge>}
            </div>
            <Textarea
              value={outlineIdea}
              onChange={(e) => setOutlineIdea(e.target.value)}
              rows={3}
              style={{ resize: 'vertical' }}
              disabled={outlineBusy}
              placeholder="例：主角觉醒血脉遭追杀，被迫离乡加入门派，卷入朝廷与魔教的暗斗"
            />
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-zinc-500">卷号</span>
                <Input
                  type="number"
                  min={1}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value))}
                  disabled={outlineBusy}
                  className="w-20"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-zinc-500">起始章号</span>
                <Input
                  type="number"
                  min={1}
                  value={startNo}
                  onChange={(e) => setStartNo(Number(e.target.value))}
                  disabled={outlineBusy}
                  className="w-20"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-zinc-500">章数</span>
                <Input
                  type="number"
                  min={1}
                  max={40}
                  value={outlineCount}
                  onChange={(e) => setOutlineCount(Number(e.target.value))}
                  disabled={outlineBusy}
                  className="w-20"
                />
              </div>
            </div>
            {(outlineBusy || outlineDelta) && (
              <StreamBox text={outlineDelta} className="h-32 shrink-0" />
            )}
            {outlineError && (
              <div className="flex items-center gap-2 text-xs text-red-400">
                <span className="truncate">{outlineError}</span>
                <Button variant="ghost" onClick={() => void runOutline()}>
                  重试
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                onClick={() => void runOutline()}
                disabled={outlineBusy || !outlineIdea.trim()}
              >
                {outlineDone ? '重新生成' : outlineBusy ? '生成中…' : '生成大纲并导入'}
              </Button>
              <Button variant="ghost" onClick={() => setStep(4)} disabled={outlineBusy}>
                {outlineDone || (existing?.ol ?? 0) > 0 ? '下一步' : '跳过这步'}
              </Button>
            </div>
            {outlineDone && (
              <p className="text-xs text-emerald-400">
                大纲已导入，可在大纲页继续调整或生成更多卷。
              </p>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              {[
                { label: '世界观条目', count: finalCounts?.wb },
                { label: '人物卡', count: finalCounts?.char },
                { label: '大纲章节', count: finalCounts?.ol }
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
                >
                  <div className="text-lg font-semibold text-zinc-100">{item.count ?? '…'}</div>
                  <div className="mt-0.5 text-zinc-500">{item.label}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-500">
              项目已就绪。之后可随时从项目页的「创作路线」继续完善任意板块。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  handleClose()
                  onNavigate('writing')
                }}
              >
                进入写作台
              </Button>
              {(['worldbuild', 'characters', 'outline'] as const).map((page) => (
                <Button key={page} variant="ghost" onClick={() => goto(page)}>
                  去{page === 'worldbuild' ? '世界观' : page === 'characters' ? '人物' : '大纲'}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </OverlayCard>
  )
}
