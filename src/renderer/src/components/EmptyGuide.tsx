import type { ReactNode } from 'react'
import type { Navigate } from '../lib/nav'
import { Button, Card } from './ui'

interface EmptyGuideProps {
  title: string
  desc: string
  children?: ReactNode
  onNavigate: Navigate
}

export function EmptyGuide({ title, desc, children, onNavigate }: EmptyGuideProps) {
  return (
    <Card className="flex flex-col items-center gap-2.5 p-10 text-center">
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      <div className="max-w-md text-xs leading-5 text-zinc-500">{desc}</div>
      <div className="mt-1.5 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={() => onNavigate('premise')}>去基本设定</Button>
        {children}
      </div>
    </Card>
  )
}
