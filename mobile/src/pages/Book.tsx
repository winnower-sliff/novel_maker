import { useState } from 'react'
import AgentChat from '@mobile/pages/AgentChat'
import Codex from '@mobile/pages/Codex'
import Write from '@mobile/pages/Write'
import { Button } from '@mobile/components/ui'

type BookTab = 'write' | 'codex' | 'agent'

const TABS: Array<{ key: BookTab; label: string }> = [
  { key: 'write', label: '写作' },
  { key: 'codex', label: '设定' },
  { key: 'agent', label: '智能体' }
]

export default function Book({
  projectId,
  title,
  onClose
}: {
  projectId: string
  title: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<BookTab>('write')

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-2">
        <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={onClose}>
          ← 书架
        </Button>
        <div className="min-w-0 flex-1 truncate py-1.5 text-center text-sm font-medium text-zinc-200">
          {title}
        </div>
        <div className="w-14" />
      </div>
      <div className="flex border-b border-zinc-800 bg-zinc-950/95">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 cursor-pointer py-2.5 text-sm ${
              tab === t.key
                ? 'border-b-2 border-amber-500 font-medium text-amber-400'
                : 'text-zinc-500'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <main className="min-h-0 flex-1 overflow-hidden">
        {tab === 'write' && <Write projectId={projectId} />}
        {tab === 'codex' && <Codex projectId={projectId} />}
        {tab === 'agent' && <AgentChat projectId={projectId} />}
      </main>
    </div>
  )
}
