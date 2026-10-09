import { type ChangeEvent, memo, useCallback } from 'react'
import { Textarea } from './ui'

interface AiTextareaProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  /** 兼容旧签名保留；AI 改写已收敛到智能体页 */
  system?: string
  context?: string
}

const MemoTextarea = memo(Textarea)

export function AiTextarea({ value, onChange, placeholder, className = '' }: AiTextareaProps) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>): void => {
      onChange(e.target.value)
    },
    [onChange]
  )

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      <MemoTextarea
        className="min-h-48 flex-1"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
      />
    </div>
  )
}
