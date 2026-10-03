import type { PremiseDraftResult, Project } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { startPipeline } from './pipeline'
import type { WizardUi } from './uiTypes'
import { PlanCard, StreamBox } from './widgets'
import { backfillPlan, parsePlan, saveProjectPlan } from './wizardPlan'

/** 基本设定页（桌面/移动共用）：项目元表单 + AI 起草创作方案三态 + 方案卡。
 *  projectId=null 为创建模式：仅元表单，projectCreate 成功后经 onCreated 交还调用方切换。 */
interface PremisePanelProps {
  ui: WizardUi
  projectId: string | null
  onCreated?: (id: string) => void
  onUpdated?: (id: string) => void
  /** 起草完成状态变化（调用方算门禁用） */
  onDraftedChange?: (drafted: boolean) => void
}

const EMPTY_FORM = { title: '', genre: '', targetWords: '', styleGuide: '' }
type ProjectForm = typeof EMPTY_FORM

const SKIP_CATS = ['力量体系', '地理', '势力', '历史', '物品']

function seedForm(p: Project): ProjectForm {
  return {
    title: p.title,
    genre: p.genre,
    targetWords: p.targetWords > 0 ? String(p.targetWords) : '',
    styleGuide: p.styleGuide
  }
}

export function PremisePanel({
  ui,
  projectId,
  onCreated,
  onUpdated,
  onDraftedChange
}: PremisePanelProps) {
  const { Badge, Button, Input, Label, Textarea } = ui
  const [project, setProject] = useState<Project | null>(null)
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
  const [plan, setPlan] = useState<PremiseDraftResult | null>(null)
  const [existing, setExisting] = useState({ wb: 0, char: 0, ol: 0 })
  const draftAbortRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!projectId) {
      setProject(null)
      setForm(EMPTY_FORM)
      setDrafted(false)
      setPlan(null)
      setDraftDelta('')
      onDraftedChange?.(false)
      return
    }
    let alive = true
    void Promise.all([
      window.api.novel.projects(),
      window.api.novel.worldbuild(projectId),
      window.api.novel.characters(projectId),
      window.api.novel.outlines(projectId)
    ])
      .then(([ps, wb, cs, ol]) => {
        if (!alive) return
        const p = ps.find((x) => x.id === projectId) ?? null
        setProject(p)
        if (p) setForm(seedForm(p))
        const counts = { wb: wb.length, char: cs.length, ol: ol.length }
        setExisting(counts)
        // 库数据回填：存档字段缺失（换端/损坏）时以项目库为准
        const merged = backfillPlan(
          parsePlan(p?.wizardPlan),
          wb,
          cs.map((c) => ({ name: c.name, role: c.role }))
        )
        setDraftDelta(merged.draftText)
        setPlan({
          worldbuildBrief: merged.wbBrief,
          worldbuildCategories: merged.wbCats,
          worldbuildCount: merged.wbCount,
          characters: merged.chars,
          outlineIdea: merged.outlineIdea,
          outlineCount: merged.outlineCount
        })
        // 库里已有任何内容即视为已过设定，不强制重新起草
        const done = merged.wbBrief.trim().length > 0 || counts.wb + counts.char + counts.ol > 0
        setDrafted(done)
        onDraftedChange?.(done)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId, onDraftedChange])

  useEffect(
    () => () => {
      draftAbortRef.current?.()
    },
    []
  )

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
      .then((p) => onCreated?.(p.id))
      .catch((e: unknown) => setMetaError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMetaBusy(false))
  }

  const saveMeta = (): void => {
    if (!projectId || !form.title.trim() || metaBusy) return
    setMetaBusy(true)
    setMetaError(null)
    const payload = {
      title: form.title.trim(),
      genre: form.genre.trim(),
      styleGuide: form.styleGuide.trim(),
      targetWords: Number.parseInt(form.targetWords, 10) || 0
    }
    void window.api.novel
      .projectUpdate(projectId, payload)
      .then(() => {
        setProject((prev) => (prev ? { ...prev, ...payload } : prev))
        onUpdated?.(projectId)
      })
      .catch((e: unknown) => setMetaError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMetaBusy(false))
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
      const next = (await done).data as PremiseDraftResult
      setPlan(next)
      setDrafted(true)
      onDraftedChange?.(true)
      void saveProjectPlan(projectId, {
        draftText: acc,
        wbBrief: next.worldbuildBrief,
        wbCats: next.worldbuildCategories,
        wbCount: next.worldbuildCount,
        chars: next.characters,
        outlineIdea: next.outlineIdea,
        outlineCount: next.outlineCount
      })
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e))
    } finally {
      draftAbortRef.current = null
      setDraftBusy(false)
    }
  }

  const skipDraft = (): void => {
    if (!projectId) return
    setPlan({
      worldbuildBrief: '',
      worldbuildCategories: SKIP_CATS,
      worldbuildCount: 8,
      characters: [{ name: '', brief: '' }],
      outlineIdea: '',
      outlineCount: 20
    })
    setDrafted(true)
    onDraftedChange?.(true)
    void saveProjectPlan(projectId, {
      wbBrief: '',
      wbCats: SKIP_CATS,
      wbCount: 8,
      chars: [{ name: '', brief: '' }]
    })
  }

  const hasContent = existing.wb + existing.char + existing.ol > 0

  return (
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
          {!projectId ? (
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

      {!projectId ? (
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
          {!draftBusy && drafted && plan && (
            <>
              <PlanCard plan={plan} />
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => setDrafted(false)} disabled={draftBusy}>
                  重新起草
                </Button>
                {hasContent && (
                  <Badge tone="green">
                    已有世界观 {existing.wb} 条 · 人物 {existing.char} 张 · 大纲 {existing.ol} 章
                  </Badge>
                )}
              </div>
            </>
          )}
          {!draftBusy && !drafted && (
            <>
              {draftError && <div className="text-xs text-red-400">{draftError}</div>}
              <div className="flex items-center gap-2">
                <Button onClick={() => void runDraft()} disabled={draftBusy}>
                  AI 起草创作方案
                </Button>
                <Button variant="ghost" onClick={skipDraft} disabled={draftBusy}>
                  跳过，手动填写
                </Button>
              </div>
            </>
          )}
          <p className="text-xs text-zinc-500">
            {hasContent
              ? '检测到项目已有内容，起草会衔接补全而非重复生成。'
              : 'AI 将根据书名与题材，起草世界观方向、核心人物清单与第一卷故事创意，生成后可逐项修改。'}
          </p>
        </>
      )}
    </div>
  )
}
