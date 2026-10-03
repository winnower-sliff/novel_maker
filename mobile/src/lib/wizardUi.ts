import { Badge, Button, Input, Label, Textarea } from '@mobile/components/ui'
import type { WizardUi } from '@wizard/uiTypes'

/** 手机端 WizardUi 注入：与 App 其余页面同源观感（原 WizardHost 内联定义，向导摘除后迁此共用） */
export const mobileWizardUi: WizardUi = { Badge, Button, Input, Label, Textarea }
