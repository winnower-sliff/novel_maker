import type { Character, PremiseDraftCharacter } from '@shared/types'
import { useEffect, useRef, useState } from 'react'
import { startPipeline } from './pipeline'
import type { WizardUi } from './uiTypes'
import { NumberField, StreamBox } from './widgets'
import { loadProjectPlan, saveProjectPlan } from './wizardPlan'

/** 人物设定页生成区（桌面/移动共用）：一键按方案清单逐个生成人物卡（save:false 仅预览），
 *  预览挑选后落库；入库后卡片自动从队列消失（库内列表可继续编辑/重生成）。 */
interface CharacterGenPanelProps {
  ui: WizardUi
  projectId: string
  /** 库内人物变化后通知调用方刷新列表/门禁 */
  onChanged?: () => void
}

type ItemStatus = 'pending' | 'running' | 'done' | 'error'

interface GenItem extends PremiseDraftCharacter {
  card: string
  tags: string[]
  status: ItemStatus
}

/** 方案清单 → 生成队列；同名已入库人物不入队（下方库内列表可编辑/重生成） */
function buildItems(chars: PremiseDraftCharacter[], existing: Character[]): GenItem[] {
  const savedNames = new Set(existing.map((c) => c.name.trim()))
  return chars
    .filter((c) => c.name.trim() && !savedNames.has(c.name.trim()))
    .map((c) => ({ ...c, card: '', tags: [], status: 'pending' as ItemStatus }))
}

export function CharacterGenPanel({ ui, projectId, onChanged }: CharacterGenPanelProps) {
  const { Badge, Button, Input } = ui
  const [items, setItems] = useState<GenItem[]>([])
  const [running, setRunning] = useState(false)
  const [runIndex, setRunIndex] = useState(-1)
  const [delta, setDelta] = useState('')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)
  // 生成期间改 items 的闭包读到旧值：跑队列用 ref 镜像
  const itemsRef = useRef<GenItem[]>([])
  itemsRef.current = items
  // 「+自定义」与「AI 补充」
  const [customName, setCustomName] = useState('')
  const [customBrief, setCustomBrief] = useState('')
  const [addCount, setAddCount] = useState(3)
  const [adding, setAdding] = useState(false)
  const addAbortRef = useRef<(() => void) | null>(null)
  // 库内人物名（含不在方案清单里的），供补充名单去重
  const existingNamesRef = useRef<string[]>([])

  useEffect(() => {
    let alive = true
    void Promise.all([loadProjectPlan(projectId), window.api.novel.characters(projectId)])
      .then(([plan, existing]) => {
        if (!alive) return
        existingNamesRef.current = existing.map((c) => c.name.trim())
        const roster = plan?.chars ?? []
        setItems((prev) => {
          const next = buildItems(roster, existing)
          // 面板内已生成未保存的卡不因重挂丢失：按名保留
          return next.map((n) => {
            const old = prev.find((p) => p.name.trim() === n.name.trim())
            return old?.card ? { ...n, card: old.card, tags: old.tags, status: old.status } : n
          })
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId])

  useEffect(
    () => () => {
      abortRef.current?.()
      addAbortRef.current?.()
    },
    []
  )

  const patchItem = (name: string, patch: Partial<GenItem>): void => {
    setItems((prev) => prev.map((it) => (it.name === name ? { ...it, ...patch } : it)))
  }

  /** 生成单卡预览（save:false 不落库），确认满意由调用方走 saveOne */
  const genOne = async (item: GenItem): Promise<boolean> => {
    setRunIndex(itemsRef.current.findIndex((x) => x.name === item.name))
    setDelta('')
    setError(null)
    patchItem(item.name, { status: 'running' })
    // 批内感知：把本批已生成好卡的预览卡传给 AI，后面的人与前人咬合（关系/定位不撞车）
    const peers = itemsRef.current
      .filter((x) => x.name !== item.name && x.status === 'done' && x.card.trim())
      .map((x) => ({ name: x.name.trim(), card: x.card }))
    const { done, abort } = startPipeline(
      'character',
      { projectId, name: item.name.trim(), brief: item.brief.trim(), save: false, peers },
      (t) => setDelta((v) => v + t)
    )
    abortRef.current = abort
    try {
      const payload = (await done).data as {
        preview?: { main: string; mainTags: string[] }
      }
      const main = payload.preview?.main ?? ''
      if (!main.trim()) throw new Error('AI 未输出有效人物卡')
      patchItem(item.name, { card: main, tags: payload.preview?.mainTags ?? [], status: 'done' })
      return true
    } catch (e) {
      patchItem(item.name, { status: 'error' })
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      abortRef.current = null
      setRunIndex(-1)
    }
  }

  /** 预览卡落库（新建），成功后自动从队列消失：下方库内列表可继续编辑/重生成 */
  const saveOne = async (name: string): Promise<boolean> => {
    const it = itemsRef.current.find((x) => x.name === name)
    if (!it?.card.trim()) return false
    try {
      await window.api.novel.characterSave({
        projectId,
        name: it.name.trim(),
        role: it.brief.trim(),
        tags: it.tags.join(','),
        card: it.card
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    }
    const rest = itemsRef.current.filter((x) => x.name !== it.name)
    setItems(rest)
    syncPlan(rest)
    onChanged?.()
    return true
  }

  const runQueue = async (): Promise<void> => {
    setRunning(true)
    for (const it of itemsRef.current) {
      if (!it.brief.trim()) continue
      if (it.status === 'running') continue
      const ok = await genOne(it)
      if (!ok) break // 失败即停，可单卡重试
    }
    setRunning(false)
  }

  const stop = (): void => {
    abortRef.current?.()
    abortRef.current = null
    setRunning(false)
  }

  const saveAll = async (): Promise<void> => {
    for (const it of itemsRef.current) {
      if (it.status === 'done' && it.card.trim()) await saveOne(it.name)
    }
  }

  /** 队列名单写回方案存档（wizard_plan.chars），刷新/重挂不丢 */
  const syncPlan = (list: GenItem[]): void => {
    void saveProjectPlan(projectId, { chars: list.map(({ name, brief }) => ({ name, brief })) })
  }

  const addCustom = (): void => {
    const name = customName.trim()
    if (!name) return
    if (
      itemsRef.current.some((x) => x.name.trim() === name) ||
      existingNamesRef.current.includes(name)
    ) {
      setError('已有同名人物（在队列或库中）')
      return
    }
    const next: GenItem[] = [
      ...itemsRef.current,
      { name, brief: customBrief.trim(), card: '', tags: [], status: 'pending' }
    ]
    setItems(next)
    syncPlan(next)
    setCustomName('')
    setCustomBrief('')
    setError(null)
  }

  /** AI 补充名单（第一步只出「姓名+简述」，入队后再生成卡片） */
  const aiAdd = async (): Promise<void> => {
    setAdding(true)
    setError(null)
    const { done, abort } = startPipeline(
      'characterRoster',
      { projectId, count: addCount },
      () => {}
    )
    addAbortRef.current = abort
    try {
      const payload = (await done).data as { roster?: Array<{ name: string; brief: string }> }
      const roster = payload.roster ?? []
      if (roster.length === 0) throw new Error('AI 未输出有效名单，请重试')
      const known = new Set<string>([
        ...itemsRef.current.map((x) => x.name.trim()),
        ...existingNamesRef.current
      ])
      const fresh = roster.filter((r) => r.name.trim() && !known.has(r.name.trim()))
      if (fresh.length === 0) throw new Error('AI 补充的人物都已在队列或库中')
      const next: GenItem[] = [
        ...itemsRef.current,
        ...fresh.map((f) => ({
          name: f.name.trim(),
          brief: f.brief,
          card: '',
          tags: [],
          status: 'pending' as ItemStatus
        }))
      ]
      setItems(next)
      syncPlan(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      addAbortRef.current = null
      setAdding(false)
    }
  }

  const removeItem = (name: string): void => {
    const next = itemsRef.current.filter((x) => x.name !== name)
    setItems(next)
    syncPlan(next)
  }

  const pendingCount = items.filter((i) => i.status === 'pending').length
  const doneCount = items.filter((i) => i.status === 'done').length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void runQueue()} disabled={running || pendingCount === 0}>
          {running
            ? '生成中…'
            : pendingCount > 0
              ? `一键生成班底（${pendingCount} 人）`
              : '无待生成人物'}
        </Button>
        {running && (
          <Button variant="ghost" onClick={stop}>
            停止
          </Button>
        )}
        {doneCount > 0 && (
          <Button variant="ghost" onClick={() => void saveAll()} disabled={running}>
            保存全部（{doneCount}）
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-28">
          <NumberField
            input={Input}
            value={addCount}
            min={1}
            max={12}
            disabled={adding || running}
            className="w-full"
            onChange={setAddCount}
          />
        </div>
        <Button variant="ghost" onClick={() => void aiAdd()} disabled={adding || running}>
          {adding ? '补充中…' : 'AI 补充人物'}
        </Button>
        <div className="flex flex-1 flex-wrap items-end gap-2">
          <Input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder="人物名"
            className="w-28"
            disabled={running}
          />
          <Input
            value={customBrief}
            onChange={(e) => setCustomBrief(e.target.value)}
            placeholder="一句话定位（可空）"
            className="min-w-40 flex-1"
            disabled={running}
          />
          <Button variant="ghost" onClick={addCustom} disabled={running || !customName.trim()}>
            +自定义
          </Button>
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        初始清单来自「基本设定」的方案；可「AI
        补充人物」或「+自定义」加人，生成后先预览，确认满意再入库——入库后卡片自动从这里消失，下方列表可继续编辑。
      </p>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="space-y-2">
        {items.map((it) => {
          const isRunning = running && runIndex >= 0 && itemsRef.current[runIndex]?.name === it.name
          return (
            <div
              key={it.name}
              className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-100">{it.name}</span>
                {it.status === 'done' && <Badge tone="amber">待确认</Badge>}
                {it.status === 'error' && <Badge tone="red">失败</Badge>}
                <span className="ml-auto flex items-center gap-1.5">
                  {!running && (
                    <Button variant="ghost" className="px-1.5" onClick={() => removeItem(it.name)}>
                      ✕
                    </Button>
                  )}
                  {!running && (
                    <Button variant="ghost" onClick={() => void genOne(it)}>
                      {it.card ? '重生成' : '生成'}
                    </Button>
                  )}
                  {it.status === 'done' && (
                    <Button onClick={() => void saveOne(it.name)}>保存入库</Button>
                  )}
                </span>
              </div>
              {it.brief.trim() && <p className="text-xs text-zinc-500">{it.brief}</p>}
              {isRunning ? (
                <StreamBox text={delta} className="h-24" />
              ) : it.card ? (
                <details>
                  <summary className="cursor-pointer select-none text-xs text-zinc-500 hover:text-zinc-300">
                    查看人物卡
                  </summary>
                  <pre className="mt-1.5 overflow-y-auto max-h-56 whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs leading-relaxed text-zinc-300">
                    {it.card}
                  </pre>
                </details>
              ) : null}
            </div>
          )
        })}
        {items.length === 0 && (
          <p className="text-xs text-zinc-500">
            还没有人物名单——用「AI 补充人物」让 AI 起名，或「+自定义」手动加入。
          </p>
        )}
      </div>
    </div>
  )
}
