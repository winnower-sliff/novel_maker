import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from 'react'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger'
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const styles = {
    primary:
      'bg-amber-600 text-zinc-950 shadow-sm shadow-amber-950/40 hover:bg-amber-500 active:bg-amber-600 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:shadow-none',
    ghost:
      'border border-zinc-700/70 bg-zinc-800/60 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-700/60 hover:text-zinc-100 disabled:opacity-50',
    danger:
      'border border-red-900/60 bg-red-950/60 text-red-200 hover:border-red-800 hover:bg-red-900/70 disabled:opacity-50'
  }[variant]
  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  )
}

const fieldStyles =
  'w-full rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-100 shadow-inner shadow-black/20 transition-colors placeholder:text-zinc-600 hover:border-zinc-600 focus:border-amber-500 focus:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60'

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${fieldStyles} ${className}`} {...props} />
}

export function Textarea({
  className = '',
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={`${fieldStyles} resize-none ${className}`} {...props} />
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${fieldStyles} cursor-pointer ${className}`} {...props} />
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
    <div
      id={id}
      className={`rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-sm shadow-black/20 ${className}`}
    >
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
    default: 'border-zinc-700 bg-zinc-800/80 text-zinc-300',
    amber: 'border-amber-800/60 bg-amber-950/60 text-amber-300',
    green: 'border-emerald-800/60 bg-emerald-950/60 text-emerald-300',
    red: 'border-red-800/60 bg-red-950/60 text-red-300'
  }[tone]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles}`}
    >
      {children}
    </span>
  )
}
