import { createOutlineScanMachine, feedOutlineScan } from '@shared/outlineScan'
import type { OutlineRunProgress, PremiseDraftResult } from '@shared/types'
import type { ComponentType, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { OverlayCard } from './OverlayCard'
import type { WizardUi } from './uiTypes'

/** 流式原始输出框：自动滚底 */
export function StreamBox({ text, className }: { text: string; className: string }) {
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

/** 方案卡分节容器 */
export function PlanSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="text-[11px] font-medium tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

/** 受控数字输入：内部保留原始字符串，允许清空/中间态，blur 时才 clamp 规范化——避免 Number('')=0 回填卡死 */
export function NumberField({
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

/** 扫描大纲流文本中已配平的章节对象，取标题做实时进度（坏对象/半截对象忽略）。
 * 一次性喂入整段文本的薄包装；主进程增量解析见 shared/outlineScan.ts */
export function scanOutlineProgress(text: string): { count: number; lastTitles: string[] } {
  const m = createOutlineScanMachine()
  feedOutlineScan(m, text)
  return { count: m.count, lastTitles: m.titles }
}

/** 大纲生成进度框：带结构化进度（主进程 1s 轮询）时显示 N/M 章进度条，
 * 否则退化为对本地流文本的实时解析计数 */
export function OutlineProgress({
  text,
  progress
}: {
  text?: string
  progress?: OutlineRunProgress
}) {
  const prog = progress ?? {
    ...scanOutlineProgress(text ?? ''),
    total: 0
  }
  const pct = prog.total > 0 ? Math.min(100, Math.round((prog.count / prog.total) * 100)) : null
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs text-zinc-400">
      <div className="text-amber-300">
        {pct !== null
          ? `生成中 · ${prog.count} / ${prog.total} 章（${pct}%）`
          : prog.count > 0
            ? `生成中 · 已解析 ${prog.count} 章`
            : '生成中'}
      </div>
      {pct !== null && (
        <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full bg-amber-400 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {prog.lastTitles.length > 0 && (
        <div className="mt-1 truncate text-zinc-500">{prog.lastTitles.join(' / ')}</div>
      )}
    </div>
  )
}

/**
 * 可展开文本域：原位小框常态编辑 + 右下角「展开」进 OverlayCard 大编辑区。
 * 弹层内为草稿隔离编辑（Escape/遮罩关闭丢弃修改），点「完成」才回填并触发 onCommit（用于持久化）。
 */
export function ExpandableTextarea({
  ui,
  value,
  onChange,
  onCommit,
  rows = 3,
  placeholder,
  disabled,
  overlayTitle
}: {
  /** 两端注入的 Textarea/Button；Button 只要求 ghost 用法子集（桌面 variant 联合与 WizardUi.Button 不兼容） */
  ui: {
    Textarea: WizardUi['Textarea']
    Button: ComponentType<{
      className?: string
      disabled?: boolean
      onClick?: () => void
      children?: ReactNode
    }>
  }
  value: string
  onChange: (v: string) => void
  onCommit?: (v: string) => void
  rows?: number
  placeholder?: string
  disabled?: boolean
  overlayTitle: string
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const { Textarea, Button } = ui
  return (
    <>
      <div className="relative">
        <Textarea
          rows={rows}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="pr-16"
        />
        <button
          type="button"
          onClick={() => {
            setDraft(value)
            setOpen(true)
          }}
          className="absolute right-2.5 bottom-2.5 cursor-pointer rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
        >
          展开
        </button>
      </div>
      <OverlayCard
        open={open}
        onClose={() => setOpen(false)}
        title={overlayTitle}
        footer={
          <Button
            onClick={() => {
              onChange(draft)
              onCommit?.(draft)
              setOpen(false)
            }}
          >
            完成
          </Button>
        }
      >
        <Textarea
          className="min-h-[50vh]"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
        />
      </OverlayCard>
    </>
  )
}

/** AI 起草的创作方案卡：世界观方向 / 核心人物 / 第一卷创意 三节只读展示 */ export function PlanCard({
  plan
}: {
  plan: PremiseDraftResult
}) {
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
