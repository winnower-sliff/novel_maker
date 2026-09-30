import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

type Variant = 'default' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  default: 'bg-amber-600 text-white active:bg-amber-700',
  ghost: 'bg-zinc-800 text-zinc-200 active:bg-zinc-700',
  danger: 'bg-red-700 text-white active:bg-red-800'
}

export function Button({
  variant = 'default',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  )
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-600 ${className}`}
      {...rest}
    />
  )
}

export function Textarea({
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-600 ${className}`}
      {...rest}
    />
  )
}

export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/60 ${className}`}>{children}</div>
  )
}

export function Badge({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 ${className}`}
    >
      {children}
    </span>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-500 ${className}`}
    />
  )
}

export function Empty({ text }: { text: string }) {
  return <div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-600">{text}</div>
}
