import type { WizardUi } from '../../../wizard/uiTypes'
import { Badge, Button, Input, Label, Textarea } from '../components/ui'

/** 桌面端 WizardUi 注入：renderer ui 的 primary/default variant 命名差异运行时安全
 *  （共享组件只传 ghost/danger/undefined，未传时 renderer 默认 primary） */
export const desktopWizardUi = { Badge, Button, Input, Label, Textarea } as WizardUi
