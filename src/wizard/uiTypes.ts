import type { ComponentType, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

/**
 * 环境注入的 UI 基础组件：桌面传 renderer/components/ui，移动端传 mobile/components/ui。
 * 共享面板（PremisePanel/CharacterGenPanel 等）一律经此接口取组件，实现两端换肤。
 */
export interface WizardUi {
  Badge: ComponentType<{
    className?: string
    tone?: 'default' | 'amber' | 'green' | 'red'
    children?: ReactNode
  }>
  Button: ComponentType<{
    className?: string
    disabled?: boolean
    variant?: 'default' | 'ghost' | 'danger'
    onClick?: () => void
    children?: ReactNode
  }>
  Input: ComponentType<InputHTMLAttributes<HTMLInputElement>>
  Label: ComponentType<{ className?: string; children?: ReactNode }>
  Textarea: ComponentType<TextareaHTMLAttributes<HTMLTextAreaElement>>
}
