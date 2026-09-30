import type { ReactNode } from 'react'
import { openWizard } from '../lib/wizardStore'
import { Button, Card } from './ui'

interface EmptyGuideProps {
  projectId: string
  wizardStep: number
  title: string
  desc: string
  children?: ReactNode
}

export function EmptyGuide({ projectId, wizardStep, title, desc, children }: EmptyGuideProps) {
  return (
    <Card className="flex flex-col items-center gap-2.5 p-10 text-center">
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      <div className="max-w-md text-xs leading-5 text-zinc-500">{desc}</div>
      <div className="mt-1.5 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={() => openWizard(projectId, wizardStep)}>用创作向导生成</Button>
        {children}
      </div>
    </Card>
  )
}
