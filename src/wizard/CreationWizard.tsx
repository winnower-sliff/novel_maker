import type { PremiseDraftCharacter, PremiseDraftResult, Project } from '@shared/types'
import type { ComponentType, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { Navigate } from '../renderer/src/lib/nav'
import { OverlayCard } from './OverlayCard'
import { startPipeline } from './pipeline'
import { startGen, useWbGenTasks, useWbLiveEntries } from './wbGenStore'
import { closeWizard, useWizard } from './wizardStore'

/** 环境注入的 UI 基础组件：桌面传 renderer/components/ui，移动端传 mobile/components/ui */
export interface WizardUi {
  Badge: ComponentType<{
    className?: string
    tone?: 'default' | 'amber' | 'green' | 'red'
    children?: ReactNode
  }>
  Button: ComponentType<{
    className?: string
    disabled?: boolean
    variant?: 'default' | 'ghost' | 'danger'
    onClick?: () => void
    children?: ReactNode
  }>
  Input: ComponentType<InputHTMLAttributes<HTMLInputElement>>
  Label: ComponentType<{ className?: string; children?: ReactNode }>
  Textarea: ComponentType<TextareaHTMLAttributes<HTMLTextAreaElement>>
}

const STEP_LABELS = ['设定确认', '世界观', '人物', '大纲', '完成']

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

/** 扫描大纲流文本中已配平的章节对象，取标题做实时进度（坏对象/半截对象忽略） */
function scanOutlineProgress(text: string): { count: number; lastTitles: string[] } {
  const titles: string[] = []
  let depth = 0
  let inStr = false
  let esc = false
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1)) as { title?: unknown }
          if (obj && typeof obj.title === 'string') titles.push(obj.title)
        } catch {
          // 解析失败的单个对象直接跳过
        }
        start = -1
      }
    }
  }
  return { count: titles.length, lastTitles: titles.slice(-3) }
}

/** 大纲生成进度框：与世界观生成进度框同款式（不裸露原始流） */
function OutlineProgress({ text }: { text: string }) {
  const prog = scanOutlineProgress(text)
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-400">
      <div className="text-amber-300">
        {prog.count > 0 ? `生成中 · 已解析 ${prog.count} 章` : '生成中'}
      </div>
      {prog.lastTitles.length > 0 && (
        <div className="mt-1 truncate text-zinc-500">{prog.lastTitles.join(' / ')}</div>
      )}
    </div>
  )
}

function PlanSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="text-[11px] font-medium tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

/** 受控数字输入：内部保留原始字符串，允许清空/中间态，blur 时才 clamp 规范化——避免 Number('')=0 回填卡死 */
function NumberField({
  input: Input,
  value,
  min = 1,
  max,
  disabled,
  className,
  onChange
}: {
  input: WizardUi['Input']
  value: number
  min?: number
  max?: number
  disabled?: boolean
  className?: string
  onChange: (n: number) => void
}) {
  const [raw, setRaw] = useState(String(value))
  useEffect(() => {
    // 输入中的中间态（'12.'、'0100'）数值与 value 相等时不打断；仅存档恢复/applyPlan 类外部变更才重写
    setRaw((prev) => (Number(prev) === value ? prev : String(value)))
  }, [value])
  const clamp = (n: number): number => {
    if (!Number.isFinite(n)) return min
    const low = Math.max(min, n)
    return max === undefined ? low : Math.min(max, low)
  }
  return (
    <Input
      type="number"
      min={min}
      max={max}
      value={raw}
      disabled={disabled}
      className={className}
      onChange={(e) => {
        setRaw(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(clamp(n))
      }}
      onBlur={() => {
        const n = clamp(Number(raw))
        setRaw(String(n))
        onChange(n)
      }}
    />
  )
}

function PlanCard({ plan }: { plan: PremiseDraftResult }) {
  const charList = plan.characters.filter((c) => c.name.trim())
  return (
    <div className="space-y-2">
      <PlanSection
        label={`世界观方向 · ${plan.worldbuildCategories.join(' / ')} · 约 ${plan.worldbuildCount} 条`}
      >
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
          {plan.worldbuildBrief || '（未生成，可跳到下一步手动填写）'}
        </p>
      </PlanSection>
      <PlanSection label={`核心人物 · ${charList.length} 名`}>
        {charList.length > 0 ? (
          <ul className="space-y-1.5">
            {charList.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 只读展示列表，库中可存在同名人物卡，index 才是稳定身份
              <li key={`${c.name}-${i}`} className="text-xs leading-relaxed">
                <span className="font-medium text-zinc-100">{c.name}</span>
                {c.brief.trim() && <span className="text-zinc-400">　{c.brief}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-500">（未生成）</p>
        )}
      </PlanSection>
      <PlanSection label={`第一卷创意 · 预计 ${plan.outlineCount} 章`}>
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
          {plan.outlineIdea || '（未生成，可跳到下一步手动填写）'}
        </p>
      </PlanSection>
    </div>
  )
}

interface CreationWizardProps {
  onNavigate: Navigate
  ui: WizardUi
  /** 移动端注入：向导打开时注册 Android 返回键处理器，关闭时回调 null 注销；桌面不传则无返回键接管 */
  onBackHandler?: (handler: (() => void) | null) => void
  /** 创建/修改项目元数据后回调：created 时调用方应切换当前项目（桌面 onSwitch / 手机 setBookId） */
  onChanged?: (id: string, kind: 'created' | 'updated') => void
}

const EMPTY_FORM = { title: '', genre: '', targetWords: '', styleGuide: '' }
type ProjectForm = typeof EMPTY_FORM

function seedForm(p: Project): ProjectForm {
  return {
    title: p.title,
    genre: p.genre,
    targetWords: p.targetWords > 0 ? String(p.targetWords) : '',
    styleGuide: p.styleGuide
  }
}

export function CreationWizard({ onNavigate, ui, onBackHandler, onChanged }: CreationWizardProps) {
  const { Badge, Button, Input, Label, Textarea } = ui
  const { open, projectId, initialStep, step, setStep } = useWizard()
  const [project, setProject] = useState<Project | null>(null)
  // 创建模式：projectId=null 打开，projectCreate 成功后本地绑定新 id，后续步骤原样复用
  const [createdId, setCreatedId] = useState<string | null>(null)
  const effectiveId = projectId ?? createdId
  const needCreate = !effectiveId

  const [form, setForm] = useState<ProjectForm>(EMPTY_FORM)
  const [metaBusy, setMetaBusy] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)
  const metaDirty =
    project != null &&
    (form.title.trim() !== project.title ||
      form.genre.trim() !== project.genre ||
      (Number.parseInt(form.targetWords, 10) || 0) !== project.targetWords ||
      form.styleGuide.trim() !== project.styleGuide)

  const [draftBusy, setDraftBusy] = useState(false)
  const [draftDelta, setDraftDelta] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const [drafted, setDrafted] = useState(false)
  const draftAbortRef = useRef<(() => void) | null>(null)

  const [wbBrief, setWbBrief] = useState('')
  const [wbCats, setWbCats] = useState<string[]>([])
  const [wbCount, setWbCount] = useState(8)
  const [wbStarted, setWbStarted] = useState(false)
  const [wbResult, setWbResult] = useState<string | null>(null)
  const wbBeforeRef = useRef<number | null>(null)
  const [typeOptions, setTypeOptions] = useState<string[]>([])
  const wbTasks = useWbGenTasks(effectiveId ?? '')
  const wbLive = useWbLiveEntries(effectiveId ?? '')
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
  const [outlineResult, setOutlineResult] = useState<string | null>(null)
  const outlineAbortRef = useRef<(() => void) | null>(null)
  // 上次恢复/保存的存档：savePlan 合并基线，防当前空 state 覆盖好档
  const savedPlanRef = useRef<WizardPlanSave | null>(null)

  const [finalCounts, setFinalCounts] = useState<{ wb: number; char: number; ol: number } | null>(
    null
  )
  const [existing, setExisting] = useState<{ wb: number; char: number; ol: number } | null>(null)

  // 仅在打开瞬间重置创建态；effectiveId null→id（创建成功）不得清掉 createdId
  useEffect(() => {
    if (open) setCreatedId(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    setProject(null)
    setStep(0)
    setForm(EMPTY_FORM)
    setMetaBusy(false)
    setMetaError(null)
    setDraftBusy(false)
    setDraftDelta('')
    setDraftError(null)
    setDrafted(false)
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
    setOutlineResult(null)
    outlineAbortRef.current = null
    setFinalCounts(null)
    setExisting(null)
    savedPlanRef.current = null
    if (!effectiveId) return
    void Promise.all([
      window.api.novel.projects(),
      window.api.novel.worldbuild(effectiveId),
      window.api.novel.characters(effectiveId),
      window.api.novel.outlines(effectiveId)
    ])
      .then(([ps, wb, cs, ol]) => {
        const p = ps.find((x) => x.id === effectiveId) ?? null
        setProject(p)
        if (p) setForm(seedForm(p))
        const counts = { wb: wb.length, char: cs.length, ol: ol.length }
        setExisting(counts)
        const saved = parsePlan(p?.wizardPlan)
        // 库数据回填：存档字段缺失（换端/存档损坏）时以项目库为准，已生成的进度不丢
        const merged: WizardPlanSave = saved ?? {
          draftText: '',
          wbBrief: '',
          wbCats: [],
          wbCount: 8,
          chars: [],
          outlineIdea: '',
          outlineCount: 20,
          volume: 1,
          startNo: 1,
          step: 0
        }
        if (merged.wbCats.length === 0 && wb.length > 0)
          merged.wbCats = Array.from(new Set(wb.map((w) => w.category)))
        if (!merged.chars.some((c) => c.name.trim()) && cs.length > 0)
          merged.chars = cs.map((c) => ({ name: c.name, brief: c.role }))
        savedPlanRef.current = merged
        setDraftDelta(merged.draftText)
        // 库里已有任何内容即视为过设定页，不强制重新起草
        setDrafted(merged.wbBrief.trim().length > 0 || counts.wb + counts.char + counts.ol > 0)
        setWbBrief(merged.wbBrief)
        setWbCats(merged.wbCats)
        setWbCount(merged.wbCount)
        setChars(merged.chars)
        setOutlineIdea(merged.outlineIdea)
        setOutlineCount(merged.outlineCount)
        setVolume(merged.volume)
        setStartNo(merged.startNo)
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
      .worldbuildTypes(effectiveId)
      .then(setTypeOptions)
      .catch(() => {})
  }, [open, effectiveId, initialStep, setStep])

  useEffect(() => {
    if (step !== 4 || !effectiveId) return
    void Promise.all([
      window.api.novel.worldbuild(effectiveId),
      window.api.novel.characters(effectiveId),
      window.api.novel.outlines(effectiveId)
    ])
      .then(([wb, cs, ol]) => setFinalCounts({ wb: wb.length, char: cs.length, ol: ol.length }))
      .catch(() => {})
  }, [step, effectiveId])

  useEffect(() => {
    if (!wbStarted || wbRunning || !effectiveId) return
    void window.api.novel
      .worldbuild(effectiveId)
      .then((l) => {
        const before = wbBeforeRef.current
        if (before === null) return
        const n = l.length - before
        setWbResult(
          n > 0 ? `本次生成入库 ${n} 条世界观条目` : '本次未解析出有效条目，可调整需求后重试'
        )
      })
      .catch(() => {})
  }, [wbStarted, wbRunning, effectiveId])

  const abortAll = (): void => {
    draftAbortRef.current?.()
    charAbortRef.current?.()
    outlineAbortRef.current?.()
    draftAbortRef.current = null
    charAbortRef.current = null
    outlineAbortRef.current = null
  }

  // 草稿落库：关闭时保存（完成向导则清空），起草完成后立即保存。
  // patch 用于在 setState 未生效的闭包里显式传入最新值；
  // 内容字段空时回落上次存档，避免空 state（恢复失败/未起草）把好档覆盖成空
  const savePlan = (patch: Partial<WizardPlanSave> = {}, clear = false): void => {
    if (!effectiveId) return
    if (clear) {
      void window.api.novel.projectUpdate(effectiveId, { wizardPlan: '' }).catch(() => {})
      return
    }
    const last = savedPlanRef.current
    const payload: WizardPlanSave = {
      draftText: patch.draftText ?? (draftDelta || last?.draftText || ''),
      wbBrief: patch.wbBrief ?? (wbBrief || last?.wbBrief || ''),
      wbCats: patch.wbCats ?? (wbCats.length > 0 ? wbCats : (last?.wbCats ?? [])),
      wbCount: patch.wbCount ?? wbCount,
      chars: patch.chars ?? (chars.some((c) => c.name.trim()) ? chars : (last?.chars ?? [])),
      outlineIdea: patch.outlineIdea ?? (outlineIdea || last?.outlineIdea || ''),
      outlineCount: patch.outlineCount ?? outlineCount,
      volume: patch.volume ?? volume,
      startNo: patch.startNo ?? startNo,
      step: patch.step ?? step
    }
    void window.api.novel
      .projectUpdate(effectiveId, { wizardPlan: JSON.stringify(payload) })
      .then(() => {
        savedPlanRef.current = payload
      })
      .catch(() => {})
  }

  /** 创建模式提交：成功后本地绑定新 id（effectiveId 生效），并向调用方通知切换当前项目 */
  const createProject = (): void => {
    const t = form.title.trim()
    if (!t || metaBusy) return
    setMetaBusy(true)
    setMetaError(null)
    void window.api.novel
      .projectCreate({
        title: t,
        genre: form.genre.trim(),
        styleGuide: form.styleGuide.trim(),
        targetWords: Number.parseInt(form.targetWords, 10) || 0
      })
      .then((p) => {
        setCreatedId(p.id)
        onChanged?.(p.id, 'created')
      })
      .catch((e: unknown) => setMetaError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMetaBusy(false))
  }

  /** 已有项目：step0 表单显式保存元数据修改（非自动保存，防误改） */
  const saveMeta = (): void => {
    if (!effectiveId || !form.title.trim() || metaBusy) return
    setMetaBusy(true)
    setMetaError(null)
    const payload = {
      title: form.title.trim(),
      genre: form.genre.trim(),
      styleGuide: form.styleGuide.trim(),
      targetWords: Number.parseInt(form.targetWords, 10) || 0
    }
    void window.api.novel
      .projectUpdate(effectiveId, payload)
      .then(() => {
        setProject((prev) => (prev ? { ...prev, ...payload } : prev))
        onChanged?.(effectiveId, 'updated')
      })
      .catch((e: unknown) => setMetaError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMetaBusy(false))
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
    if (!effectiveId) return
    setDraftBusy(true)
    setDraftError(null)
    setDraftDelta('')
    let acc = ''
    const { done, abort } = startPipeline('premiseDraft', { projectId: effectiveId }, (t) => {
      acc += t
      setDraftDelta((v) => v + t)
    })
    draftAbortRef.current = abort
    try {
      const payload = await done
      const plan = payload.data as PremiseDraftResult
      applyPlan(plan)
      setTypeOptions((prev) => Array.from(new Set([...prev, ...plan.worldbuildCategories])))
      setDrafted(true)
      savePlan({
        draftText: acc,
        wbBrief: plan.worldbuildBrief,
        wbCats: plan.worldbuildCategories,
        wbCount: plan.worldbuildCount,
        chars: plan.characters,
        outlineIdea: plan.outlineIdea,
        outlineCount: plan.outlineCount,
        step: 0
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
    setDrafted(true)
    setStep(1)
    savePlan({ step: 1, wbBrief: '', chars: [{ name: '', brief: '' }] })
  }

  const toggleCat = (c: string): void => {
    setWbCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
  }

  const startWorldbuild = (): void => {
    if (!effectiveId || !wbBrief.trim() || wbRunning) return
    const count = Number(wbCount)
    setWbResult(null)
    void window.api.novel
      .worldbuild(effectiveId)
      .then((l) => {
        wbBeforeRef.current = l.length
      })
      .catch(() => {})
    startGen({
      projectId: effectiveId,
      categories: wbCats,
      title: '',
      brief: wbBrief.trim(),
      count: Number.isFinite(count) && count >= 1 ? Math.floor(count) : undefined
    })
    setWbStarted(true)
  }

  const runCharQueue = async (from: number): Promise<void> => {
    if (!effectiveId) return
    setCharRunning(true)
    setCharError(null)
    for (let i = from; i < chars.length; i++) {
      const c = chars[i]
      if (!c.name.trim() || !c.brief.trim()) continue
      setCharIndex(i)
      setCharDelta('')
      const { done, abort } = startPipeline(
        'character',
        { projectId: effectiveId, name: c.name.trim(), brief: c.brief.trim() },
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
    if (!effectiveId || !outlineIdea.trim()) return
    setOutlineBusy(true)
    setOutlineError(null)
    setOutlineDelta('')
    setOutlineDone(false)
    setOutlineResult(null)
    const count = Number(outlineCount)
    const { done, abort } = startPipeline(
      'outline',
      {
        projectId: effectiveId,
        idea: outlineIdea.trim(),
        volume: Number(volume) || 1,
        startNo: Number(startNo) || 1,
        count: Number.isFinite(count) && count >= 1 ? Math.floor(count) : 20,
        allowUpdate: true
      },
      (t) => setOutlineDelta((v) => v + t)
    )
    outlineAbortRef.current = abort
    try {
      const r = (await done).data as {
        created: number
        updated: number
        skipped: number
        parsed: boolean
      }
      if (!r.parsed) {
        setOutlineError('AI 输出无法解析为章节列表，请重试或调整创意描述')
      } else if (r.created + r.updated === 0) {
        setOutlineError('AI 未输出有效章节，请重试或调整创意描述')
      } else {
        setOutlineResult(
          `已导入：新建 ${r.created} 章${r.updated ? ` · 更新 ${r.updated} 章` : ''}${
            r.skipped ? ` · 跳过 ${r.skipped} 章（章节号已存在）` : ''
          }`
        )
        setOutlineDone(true)
      }
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

  // footer 统一导航：前台阻塞型生成（人物队列/大纲/起草）中锁定，后台型（世界观）允许离开
  const navLocked = draftBusy || charRunning || outlineBusy
  const nextLabel =
    step === 4
      ? '进入写作台'
      : step === 0 && needCreate
        ? '先创建项目'
        : step === 0 && !drafted
          ? '先起草或跳过'
          : '下一步'
  const nextDisabled = navLocked || (step === 0 && !drafted)
  const goNext = (): void => {
    if (nextDisabled) return
    if (step === 4) {
      handleClose()
      onNavigate('writing')
      return
    }
    const n = step + 1
    setStep(n)
    savePlan({ step: n })
  }
  const goPrev = (): void => {
    if (step <= 0 || navLocked) return
    setStep(step - 1)
    savePlan({ step: step - 1 })
  }

  // Android 返回键：step>0 且未锁定 → 上一步；否则等价关闭（中止生成+存草稿）
  const backImplRef = useRef<() => void>(() => {})
  useEffect(() => {
    backImplRef.current = () => {
      if (step > 0 && !navLocked) setStep(step - 1)
      else handleClose()
    }
  })
  useEffect(() => {
    if (!onBackHandler) return
    if (!open) {
      onBackHandler(null)
      return
    }
    onBackHandler(() => backImplRef.current())
    return () => onBackHandler(null)
  }, [open, onBackHandler])

  if (!open) return null

  return (
    <OverlayCard
      open={open}
      onClose={handleClose}
      title="创作向导"
      widthClass="max-w-3xl"
      fullscreenOnMobile
      footer={
        <div className="flex flex-1 items-center justify-between gap-2">
          <span className="text-xs text-zinc-500">
            第 {step + 1}/{STEP_LABELS.length} 步 · {STEP_LABELS[step]}
          </span>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="ghost" onClick={goPrev} disabled={navLocked}>
                上一步
              </Button>
            )}
            <Button onClick={goNext} disabled={nextDisabled}>
              {nextLabel}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center px-1">
          {STEP_LABELS.map((label, i) => (
            <Fragment key={label}>
              {i > 0 && (
                <div
                  className={`mx-1 h-px flex-1 transition-colors sm:mx-2 ${
                    i <= step ? 'bg-amber-500/40' : 'bg-zinc-700'
                  }`}
                />
              )}
              <button
                type="button"
                disabled={i >= step || draftBusy}
                onClick={() => setStep(i)}
                className="flex shrink-0 items-center gap-1.5 disabled:cursor-default"
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] transition-colors sm:h-7 sm:w-7 sm:text-xs ${
                    i === step
                      ? 'border-amber-500 bg-amber-600/20 font-semibold text-amber-300'
                      : i < step
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                        : 'border-zinc-700 text-zinc-600'
                  }`}
                >
                  {i < step ? '✓' : i + 1}
                </span>
                <span
                  className={`hidden text-xs transition-colors sm:inline ${
                    i === step
                      ? 'font-medium text-amber-300'
                      : i < step
                        ? 'text-zinc-400'
                        : 'text-zinc-600'
                  }`}
                >
                  {label}
                </span>
              </button>
            </Fragment>
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <div className="space-y-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <div>
                  <Label>书名 *</Label>
                  <Input
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="例：凡人修仙传"
                  />
                </div>
                <div>
                  <Label>题材</Label>
                  <Input
                    value={form.genre}
                    onChange={(e) => setForm({ ...form, genre: e.target.value })}
                    placeholder="仙侠/都市/科幻…"
                  />
                </div>
              </div>
              <div>
                <Label>目标字数</Label>
                <Input
                  type="number"
                  value={form.targetWords}
                  onChange={(e) => setForm({ ...form, targetWords: e.target.value })}
                  placeholder="例：2000000"
                  className="w-full sm:w-40"
                />
              </div>
              <div>
                <Label>风格指南（会注入每次生成的 system）</Label>
                <Textarea
                  rows={3}
                  style={{ resize: 'vertical' }}
                  value={form.styleGuide}
                  onChange={(e) => setForm({ ...form, styleGuide: e.target.value })}
                  placeholder="文风参照、叙事视角、禁忌词、爽点偏好…"
                />
              </div>
              <div className="flex items-center gap-2">
                {needCreate ? (
                  <Button onClick={createProject} disabled={!form.title.trim() || metaBusy}>
                    {metaBusy ? '创建中…' : '创建项目'}
                  </Button>
                ) : metaDirty ? (
                  <Button onClick={saveMeta} disabled={!form.title.trim() || metaBusy}>
                    {metaBusy ? '保存中…' : '保存修改'}
                  </Button>
                ) : null}
                {metaError && <span className="text-xs text-red-400">{metaError}</span>}
              </div>
            </div>
            {needCreate ? (
              <p className="text-xs text-zinc-500">
                填写基本信息创建项目后，即可用 AI 起草创作方案，或跳过手动填写后续设定。
              </p>
            ) : (
              <>
                {draftBusy && (
                  <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-3 text-xs text-amber-200">
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                      AI 正在起草创作方案（世界观方向 / 核心人物 / 第一卷创意）…
                    </div>
                    {draftDelta && (
                      <details className="mt-2">
                        <summary className="cursor-pointer select-none text-amber-300/70 hover:text-amber-200">
                          查看原始输出
                        </summary>
                        <StreamBox text={draftDelta} className="mt-1.5 h-28" />
                      </details>
                    )}
                  </div>
                )}
                {!draftBusy && drafted && (
                  <>
                    <PlanCard
                      plan={{
                        worldbuildBrief: wbBrief,
                        worldbuildCategories: wbCats,
                        worldbuildCount: wbCount,
                        characters: chars,
                        outlineIdea,
                        outlineCount
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" onClick={() => setDrafted(false)}>
                        重新起草
                      </Button>
                    </div>
                  </>
                )}
                {!draftBusy && !drafted && (
                  <>
                    {draftError && <div className="text-xs text-red-400">{draftError}</div>}
                    <div className="flex items-center gap-2">
                      <Button onClick={() => void runDraft()} disabled={draftBusy || needCreate}>
                        AI 起草创作方案
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={skipDraft}
                        disabled={draftBusy || needCreate}
                      >
                        跳过，手动填写
                      </Button>
                    </div>
                  </>
                )}
                <p className="text-xs text-zinc-500">
                  {existing && existing.wb + existing.char + existing.ol > 0
                    ? `检测到项目已有内容（世界观 ${existing.wb} 条 / 人物 ${existing.char} 张 / 大纲 ${existing.ol} 章），起草会衔接补全而非重复生成。`
                    : 'AI 将根据书名与题材，起草世界观方向、核心人物清单与第一卷故事创意，生成后可逐项修改。'}
                </p>
              </>
            )}
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
              <NumberField
                input={Input}
                value={wbCount}
                min={1}
                max={12}
                onChange={setWbCount}
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
            <div className="space-y-2 sm:max-h-72 sm:overflow-y-auto sm:pr-1">
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
            {charRunning && <StreamBox text={charDelta} className="h-20 shrink-0 sm:h-24" />}
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
                <NumberField
                  input={Input}
                  value={volume}
                  min={1}
                  onChange={setVolume}
                  disabled={outlineBusy}
                  className="w-20"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-zinc-500">起始章号</span>
                <NumberField
                  input={Input}
                  value={startNo}
                  min={1}
                  onChange={setStartNo}
                  disabled={outlineBusy}
                  className="w-20"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-zinc-500">章数</span>
                <NumberField
                  input={Input}
                  value={outlineCount}
                  min={1}
                  onChange={setOutlineCount}
                  disabled={outlineBusy}
                  className="w-20"
                />
              </div>
            </div>
            {outlineBusy && <OutlineProgress text={outlineDelta} />}
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
            </div>
            {outlineResult && <p className="text-xs text-emerald-400">{outlineResult}</p>}
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
