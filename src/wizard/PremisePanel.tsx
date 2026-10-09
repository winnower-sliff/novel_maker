import type { Character, OutlineItem, Project, WorldbuildEntry } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WizardUi } from './uiTypes'

/** 基本设定页（桌面/移动共用）：项目元表单。
 *  projectId=null 为创建模式：仅元表单，projectCreate 成功后经 onCreated 交还调用方切换。 */

/** 冷启动快照种子（mobile 传，桌面不传）：网络回来前先按快照渲染，避免空表单闪现 */
export interface PremiseSeed {
  project: Project
  worldbuild: WorldbuildEntry[]
  characters: Character[]
  outlines: OutlineItem[]
}

interface PremisePanelProps {
  ui: WizardUi
  projectId: string | null
  onCreated?: (id: string) => void
  onUpdated?: (id: string) => void
  seed?: PremiseSeed | null
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

export function PremisePanel({ ui, projectId, onCreated, onUpdated, seed }: PremisePanelProps) {
  const { Button, Input, Label, Textarea } = ui
  const [project, setProject] = useState<Project | null>(null)
  const [form, setForm] = useState<ProjectForm>(EMPTY_FORM)
  const [metaBusy, setMetaBusy] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [existing, setExisting] = useState({ wb: 0, char: 0, ol: 0 })
  // 用户是否动过表单：网络回包晚到时不得覆盖其输入（快照 seed 先渲染会放大这个窗口）
  const formTouchedRef = useRef(false)
  const editForm = (patch: Partial<ProjectForm>): void => {
    formTouchedRef.current = true
    setForm((f) => ({ ...f, ...patch }))
  }
  const metaDirty =
    project != null &&
    (form.title.trim() !== project.title ||
      form.genre.trim() !== project.genre ||
      (Number.parseInt(form.targetWords, 10) || 0) !== project.targetWords ||
      form.styleGuide.trim() !== project.styleGuide)

  const applyLibrary = useCallback(
    (
      ps: Project[],
      wb: WorldbuildEntry[],
      cs: Character[],
      ol: OutlineItem[],
      keepForm = false
    ): void => {
      const p = ps.find((x) => x.id === projectId) ?? null
      setProject(p)
      if (p) {
        if (!keepForm) {
          setForm(seedForm(p))
          formTouchedRef.current = false
        }
      } else {
        setForm(EMPTY_FORM)
        formTouchedRef.current = false
      }
      setExisting({ wb: wb.length, char: cs.length, ol: ol.length })
    },
    [projectId]
  )

  useEffect(() => {
    if (!projectId) {
      setProject(null)
      setForm(EMPTY_FORM)
      formTouchedRef.current = false
      setExisting({ wb: 0, char: 0, ol: 0 })
      return
    }
    let alive = true
    // 快照种子先渲染（mobile 传入；桌面不传无此路径），网络回来后覆盖为最新
    if (seed && seed.project.id === projectId) {
      applyLibrary([seed.project], seed.worldbuild, seed.characters, seed.outlines)
    }
    void Promise.all([
      window.api.novel.projects(),
      window.api.novel.worldbuild(projectId),
      window.api.novel.characters(projectId),
      window.api.novel.outlines(projectId)
    ])
      .then(([ps, wb, cs, ol]) => {
        if (!alive) return
        applyLibrary(ps, wb, cs, ol, formTouchedRef.current)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId, applyLibrary, seed])

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

  const hasContent = existing.wb + existing.char + existing.ol > 0

  return (
    <div className="space-y-3">
      <div className="space-y-2.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div>
            <Label>书名 *</Label>
            <Input
              value={form.title}
              onChange={(e) => editForm({ title: e.target.value })}
              placeholder="例：凡人修仙传"
            />
          </div>
          <div>
            <Label>题材</Label>
            <Input
              value={form.genre}
              onChange={(e) => editForm({ genre: e.target.value })}
              placeholder="仙侠/都市/科幻…"
            />
          </div>
        </div>
        <div>
          <Label>目标字数</Label>
          <Input
            type="number"
            value={form.targetWords}
            onChange={(e) => editForm({ targetWords: e.target.value })}
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
            onChange={(e) => editForm({ styleGuide: e.target.value })}
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

      {projectId && (
        <p className="text-xs text-zinc-500">
          {hasContent
            ? `项目已有内容：世界观 ${existing.wb} 条 · 人物 ${existing.char} 张 · 大纲 ${existing.ol} 章。`
            : '创建后可到各板块录入设定，或到智能体页让 AI 规划世界观、人物与大纲。'}
        </p>
      )}
    </div>
  )
}
