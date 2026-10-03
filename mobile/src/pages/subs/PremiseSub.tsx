import { mobileWizardUi } from '@mobile/lib/wizardUi'
import { useQueryClient } from '@tanstack/react-query'
import { PremisePanel } from '@wizard/PremisePanel'

/** 基本设定子页：共享 PremisePanel 的手机壳（滚动容器 + 项目失效） */
export default function PremiseSub({
  projectId,
  onCreated
}: {
  projectId: string | null
  onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  return (
    <div className="h-full overflow-y-auto p-3">
      <PremisePanel
        ui={mobileWizardUi}
        projectId={projectId}
        onCreated={(id) => {
          void qc.invalidateQueries({ queryKey: ['novel', 'projects'] })
          onCreated(id)
        }}
        onUpdated={() => void qc.invalidateQueries({ queryKey: ['novel', 'projects'] })}
      />
    </div>
  )
}
