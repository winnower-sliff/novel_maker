import { mobileWizardUi } from '@mobile/lib/wizardUi'
import { getSnapshot } from '@mobile/lib/readerCache'
import { snapshotKey } from '@mobile/lib/querySnapshot'
import { qk } from '@renderer/lib/queries'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { PremisePanel, type PremiseSeed } from '@wizard/PremisePanel'
import type { Character, OutlineItem, Project, WorldbuildEntry } from '@shared/types'

/** 基本设定子页：共享 PremisePanel 的手机壳（滚动容器 + 项目失效 + 快照种子先渲染） */
export default function PremiseSub({
  projectId,
  onCreated
}: {
  projectId: string | null
  onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  const [seed, setSeed] = useState<PremiseSeed | null>(null)
  const [seedReady, setSeedReady] = useState(false)

  // 快照种子：进页先读 IndexedDB（<50ms），读完才挂 PremisePanel，网络回来前面板即有旧数据
  useEffect(() => {
    let alive = true
    setSeed(null)
    setSeedReady(false)
    if (!projectId) {
      setSeedReady(true)
      return
    }
    void (async () => {
      try {
        const [projects, wb, cs, ol] = await Promise.all([
          getSnapshot(snapshotKey(qk.projects)),
          getSnapshot(snapshotKey(qk.worldbuild(projectId))),
          getSnapshot(snapshotKey(qk.characters(projectId))),
          getSnapshot(snapshotKey(qk.outlines(projectId)))
        ])
        if (!alive) return
        const project = (projects?.data as Project[] | undefined)?.find(
          (p) => p.id === projectId
        )
        if (project && wb?.data && cs?.data && ol?.data) {
          setSeed({
            project,
            worldbuild: wb.data as WorldbuildEntry[],
            characters: cs.data as Character[],
            outlines: ol.data as OutlineItem[]
          })
        }
      } catch {
        // 静默：无种子走正常网络路径
      } finally {
        if (alive) setSeedReady(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [projectId])

  if (!seedReady) return null

  return (
    <div className="h-full overflow-y-auto overscroll-contain p-3">
      <PremisePanel
        ui={mobileWizardUi}
        projectId={projectId}
        seed={seed}
        onCreated={(id) => {
          void qc.invalidateQueries({ queryKey: qk.projects })
          onCreated(id)
        }}
        onUpdated={() => void qc.invalidateQueries({ queryKey: qk.projects })}
      />
    </div>
  )
}
