import type { WizardUi } from '../../../wizard/CreationWizard'
// 组件本体已迁共享包 src/wizard/CreationWizard.tsx（桌面与移动端共用一份），
// 此处预绑定桌面 UI 基础组件，桌面调用方零改动。
import { CreationWizard as SharedCreationWizard } from '../../../wizard/CreationWizard'
import { Badge, Button, Input, Label, Textarea } from './ui'

const desktopUi = { Badge, Button, Input, Label, Textarea } as WizardUi

export function CreationWizard(props: Omit<Parameters<typeof SharedCreationWizard>[0], 'ui'>) {
  return <SharedCreationWizard {...props} ui={desktopUi} />
}
