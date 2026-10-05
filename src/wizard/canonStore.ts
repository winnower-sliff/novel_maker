// canonSync 挂起预览：大纲生成导入成功后自动触发设定同步，
// 人物卡主进程已直接落库；世界观新增/修订建议挂起在此，
// 由全局 CanonPreviewPanel（两端 App 根部挂载）弹出确认，跨页面存活。
import type { CanonSyncResult, CanonWorldUpdate, WorldbuildPreviewEntry } from '@shared/types'
import { create } from 'zustand'
import { qk } from '../renderer/src/lib/queries'
import { queryClient } from '../renderer/src/lib/queryClient'
import { startPipeline } from './pipeline'
import { pushToast } from './toastStore'

export interface CanonPending {
  projectId: string
  volume: number
  worldNew: WorldbuildPreviewEntry[]
  worldUpdates: CanonWorldUpdate[]
  /** 新增默认全勾；修订默认全不勾（防覆盖人工精修） */
  newChecked: boolean[]
  updateChecked: boolean[]
  saving: boolean
  error: string | null
}

interface CanonStore {
  pending: CanonPending | null
}

const useCanonStoreBase = create<CanonStore>()(() => ({ pending: null }))

function invalidate(projectId: string): void {
  void queryClient.invalidateQueries({ queryKey: qk.worldbuild(projectId) })
  void queryClient.invalidateQueries({ queryKey: qk.characters(projectId) })
  void queryClient.invalidateQueries({ queryKey: qk.worldbuildTypes(projectId) })
}

/** 主进程 canonSync 结果入库挂起：有世界观建议才弹预览；纯人物只 toast（已自动落库）。
 *  同项目同卷已有挂起时跳过（fire 的 promise 路径与 runtimeSync 迁移路径可能先后到达） */
export function ingestCanonSync(
  projectId: string,
  volume: number,
  data: CanonSyncResult | undefined
): void {
  if (!data) return
  const cur = useCanonStoreBase.getState().pending
  if (cur && cur.projectId === projectId && cur.volume === volume) return
  const chars = data.savedCharacters
  const charNote = chars?.name
    ? `已自动入库人物：${chars.name}${chars.revised.length > 0 ? `（并修订 ${chars.revised.map((r) => r.name).join('、')}）` : ''}`
    : ''
  const worldCount = (data.worldNew?.length ?? 0) + (data.worldUpdates?.length ?? 0)
  if (worldCount === 0) {
    if (charNote) pushToast('success', `第 ${volume} 卷设定同步完成，${charNote}`)
    invalidate(projectId)
    return
  }
  useCanonStoreBase.setState({
    pending: {
      projectId,
      volume,
      worldNew: data.worldNew ?? [],
      worldUpdates: data.worldUpdates ?? [],
      newChecked: (data.worldNew ?? []).map(() => true),
      updateChecked: (data.worldUpdates ?? []).map(() => false),
      saving: false,
      error: null
    }
  })
  pushToast(
    'success',
    `第 ${volume} 卷设定同步完成：${data.worldNew?.length ?? 0} 条新增 / ${data.worldUpdates?.length ?? 0} 条修订待确认${charNote ? `；${charNote}` : ''}`
  )
  invalidate(projectId)
}

/** 大纲导入成功后触发设定同步（后台运行，不阻塞大纲主流程；失败可见，可在大纲页手动重试） */
export function fireCanonSync(projectId: string, volume: number): void {
  const { done } = startPipeline('canonSync', { projectId, volume })
  void done
    .then((r) => {
      ingestCanonSync(projectId, volume, r.data as CanonSyncResult)
    })
    .catch((e: unknown) => {
      pushToast(
        'error',
        `第 ${volume} 卷设定同步失败：${e instanceof Error ? e.message : String(e)}（可在大纲页手动重试）`
      )
    })
}

export const useCanonStore = useCanonStoreBase

export function toggleCanonNew(index: number): void {
  useCanonStoreBase.setState((s) =>
    s.pending
      ? {
          pending: {
            ...s.pending,
            newChecked: s.pending.newChecked.map((v, i) => (i === index ? !v : v))
          }
        }
      : s
  )
}

export function toggleCanonUpdate(index: number): void {
  useCanonStoreBase.setState((s) =>
    s.pending
      ? {
          pending: {
            ...s.pending,
            updateChecked: s.pending.updateChecked.map((v, i) => (i === index ? !v : v))
          }
        }
      : s
  )
}

export function dismissCanon(): void {
  useCanonStoreBase.setState({ pending: null })
}

/** 确认落库：勾选的新增走 worldbuildSaveBatch，勾选的修订按 id 覆盖 */
export async function confirmCanon(): Promise<void> {
  const p = useCanonStoreBase.getState().pending
  if (!p || p.saving) return
  useCanonStoreBase.setState({ pending: { ...p, saving: true, error: null } })
  try {
    const picks = p.worldNew.filter((_, i) => p.newChecked[i])
    if (picks.length > 0) await window.api.novel.worldbuildSaveBatch(p.projectId, picks)
    const updates = p.worldUpdates.filter((_, i) => p.updateChecked[i])
    for (const u of updates) {
      await window.api.novel.worldbuildSave({
        id: u.id,
        projectId: p.projectId,
        category: u.category,
        title: u.title,
        tags: u.tags.join(','),
        content: u.content,
        relation: u.relation
      })
    }
    pushToast('success', `已入库 ${picks.length} 条新设定、修订 ${updates.length} 条`)
    invalidate(p.projectId)
    useCanonStoreBase.setState({ pending: null })
  } catch (e) {
    useCanonStoreBase.setState({
      pending: { ...p, saving: false, error: e instanceof Error ? e.message : String(e) }
    })
  }
}
