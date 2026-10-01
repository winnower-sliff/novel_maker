import { CreationWizard } from '@wizard/CreationWizard'
import { useToasts } from '@wizard/toastStore'
import { Badge, Button, Input, Label, Textarea } from '@mobile/components/ui'
import type { WizardUi } from '@wizard/CreationWizard'
import type { Navigate } from '@renderer/lib/nav'

// 手机端注入 mobile/ui（与 App 其他页同源观感），组件契约与 WizardUi 对齐，无需强转
const wizardUi: WizardUi = { Badge, Button, Input, Label, Textarea }

const noopNavigate: Navigate = () => {}

export function WizardHost({ onNavigate }: { onNavigate?: Navigate }) {
  return <CreationWizard onNavigate={onNavigate ?? noopNavigate} ui={wizardUi} />
}

/** 极简 Toast：读共享 toastStore，桌面 Toaster 的等价物 */
export function MobileToaster() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto max-w-full rounded-lg px-3.5 py-2 text-xs leading-5 shadow-lg ${
            t.tone === 'error' ? 'bg-red-800 text-red-50' : 'bg-zinc-800 text-zinc-100'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
