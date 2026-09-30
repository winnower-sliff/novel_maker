import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const styles = {
    primary:
      'bg-amber-600 text-zinc-950 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-400',
    ghost: 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:text-zinc-500',
    danger: 'bg-red-900 text-red-100 hover:bg-red-800 disabled:opacity-50'
  }[variant]
  return (
    <button
      type="button"
      className={`cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  )
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 outline-none focus:border-amber-600 ${className}`}
      {...props}
    />
  )
}

export function Textarea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full resize-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm leading-relaxed text-zinc-200 placeholder-zinc-500 outline-none focus:border-amber-600 ${className}`}
      {...props}
    />
  )
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`cursor-pointer rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600 ${className}`}
      {...props}
    />
  )
}

export function Card({
  className = '',
  children,
  id
}: {
  className?: string
  children: ReactNode
  id?: string
}) {
  return (
    <div id={id} className={`rounded-lg border border-zinc-800 bg-zinc-900/50 ${className}`}>
      {children}
    </div>
  )
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-xs font-medium text-zinc-400">{children}</div>
}

export function Badge({
  children,
  tone = 'default'
}: {
  children: ReactNode
  tone?: 'default' | 'amber' | 'green' | 'red'
}) {
  const styles = {
    default: 'bg-zinc-800 text-zinc-300',
    amber: 'bg-amber-900/50 text-amber-300',
    green: 'bg-emerald-900/50 text-emerald-300',
    red: 'bg-red-900/50 text-red-300'
  }[tone]
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  )
}
