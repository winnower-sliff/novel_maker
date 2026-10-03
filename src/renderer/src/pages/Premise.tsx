import { useQueryClient } from '@tanstack/react-query'
import { PremisePanel } from '../../../wizard/PremisePanel'
import { desktopWizardUi } from '../lib/desktopWizardUi'
import { qk } from '../lib/queries'

/** 基本设定页（桌面）：项目元表单 + AI 起草创作方案；projectId=null 为新建模式 */
export default function PremisePage({
  projectId,
  onCreated
}: {
  projectId: string | null
  onCreated: (id: string) => void
}) {
  const qc = useQueryClient()
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl">
        <PremisePanel
          ui={desktopWizardUi}
          projectId={projectId}
          onCreated={(id) => {
            void qc.invalidateQueries({ queryKey: qk.projects })
            onCreated(id)
          }}
          onUpdated={() => void qc.invalidateQueries({ queryKey: qk.projects })}
          onDraftedChange={() => {}}
        />
      </div>
    </div>
  )
}
