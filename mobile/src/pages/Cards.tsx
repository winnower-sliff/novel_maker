import { useState } from 'react'
import type { Card, Character, Foreshadow } from '@shared/types'
import { useBook, useCards, useCharacters, useForeshadows } from '../lib/queries'
import { useUiStore } from '../lib/uiStore'

/** 内置类别 slug（顺序=筛选栏顺序）；自定义类别原名直显 */
const KIND_LABEL: Record<string, string> = {
  all: '全部',
  geography: '地理',
  faction: '势力',
  history: '历史',
  power: '力量体系',
  item: '物品',
  custom: '其他'
}
const BUILTIN_KINDS = ['geography', 'faction', 'history', 'power', 'item', 'custom']
const kindLabel = (k: string) => KIND_LABEL[k] ?? k

export default function Cards() {
  const openBookId = useUiStore((s) => s.openBookId) ?? ''
  const { data } = useBook(openBookId)
  const [seg, setSeg] = useState<'cards' | 'characters' | 'foreshadows'>('cards')
  const lineId = data?.book.activeLineId ?? ''

  return (
    <div className="px-4 py-4">
      <div className="mb-4 flex rounded-xl bg-white p-1">
        {(
          [
            ['cards', '设定卡'],
            ['characters', '人物'],
            ['foreshadows', '伏笔']
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={
              'flex-1 rounded-lg py-2 text-xs ' + (seg === k ? 'bg-orange-600 text-white' : 'text-stone-500')
            }
            onClick={() => setSeg(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {!lineId ? (
        <div className="py-16 text-center text-sm text-stone-400">加载中…</div>
      ) : seg === 'cards' ? (
        <CardsList lineId={lineId} />
      ) : seg === 'characters' ? (
        <CharactersList lineId={lineId} />
      ) : (
        <ForeshadowsList lineId={lineId} />
      )}
    </div>
  )
}

async function toggleCardPin(card: Card) {
  await window.api.card.save({ id: card.id, lineId: card.lineId, title: card.title, pinned: !card.pinned })
}

function CardsList({ lineId }: { lineId: string }) {
  const { data: cards = [], refetch } = useCards(lineId)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [kind, setKind] = useState<string>('all')

  // 筛选胶囊：全部 + 内置六类 + 数据里出现的自定义类别（保持出现序）
  const extraKinds = Array.from(
    new Set(cards.map((c) => c.kind ?? 'custom').filter((k) => !BUILTIN_KINDS.includes(k)))
  )
  const kindTabs = ['all', ...BUILTIN_KINDS, ...extraKinds]

  const filtered = kind === 'all' ? cards : cards.filter((c) => (c.kind ?? 'custom') === kind)
  const pinned = filtered.filter((c) => c.pinned)
  const rest = filtered.filter((c) => !c.pinned)

  const item = (c: Card) => (
    <div key={c.id} className="rounded-xl border border-orange-100 bg-white">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-3 text-left"
        onClick={() => setExpanded(expanded === c.id ? null : c.id)}
      >
        <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] text-stone-500">
          {kindLabel(c.kind ?? 'custom')}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
        {c.pinned && <span className="text-[11px] text-orange-600">已钉选</span>}
        <span
          role="button"
          tabIndex={0}
          className="rounded-full p-1.5 text-stone-400"
          onClick={async (e) => {
            e.stopPropagation()
            await toggleCardPin(c)
            refetch()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation()
              toggleCardPin(c).then(() => refetch())
            }
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={c.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M12 17v5M9 3h6l1 7 3 3H5l3-3 1-7z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {expanded === c.id && (
        <div className="border-t border-orange-100/70 px-4 py-3">
          {c.readerText && (
            <div className="mb-2">
              <div className="mb-1 text-[11px] text-stone-400">读者已知</div>
              <div className="whitespace-pre-wrap text-xs leading-relaxed text-stone-500">{c.readerText}</div>
            </div>
          )}
          {c.authorText && (
            <div className="mb-2">
              <div className="mb-1 text-[11px] text-stone-400">作者真相</div>
              <div className="whitespace-pre-wrap text-xs leading-relaxed text-stone-500">{c.authorText}</div>
            </div>
          )}
          {c.revealPlan && (
            <div>
              <div className="mb-1 text-[11px] text-stone-400">揭示计划</div>
              <div className="text-xs leading-relaxed text-stone-500">{c.revealPlan}</div>
            </div>
          )}
          {c.data && Object.keys(c.data).length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] text-stone-400">数据表</div>
              {Object.entries(c.data).map(([k, v]) => (
                <div key={k} className="mb-2">
                  <div className="mb-0.5 text-xs font-medium text-stone-600">{k}</div>
                  <JsonView value={v} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div>
      <div className="no-scrollbar mb-3 flex gap-1.5 overflow-x-auto">
        {kindTabs.map((k) => (
          <button
            key={k}
            type="button"
            className={
              'shrink-0 rounded-full px-3 py-1 text-xs ' +
              (kind === k ? 'bg-orange-600 text-white' : 'bg-white text-stone-500')
            }
            onClick={() => setKind(k)}
          >
            {kindLabel(k)}
          </button>
        ))}
      </div>
      {pinned.length > 0 && (
        <>
          <div className="mb-2 text-[11px] text-stone-400">钉选（每次写作必带）</div>
          <div className="mb-4 space-y-1.5">{pinned.map(item)}</div>
        </>
      )}
      {rest.length > 0 && (
        <>
          <div className="mb-2 text-[11px] text-stone-400">其余（按相关度自动带）</div>
          <div className="space-y-1.5">{rest.map(item)}</div>
        </>
      )}
      {filtered.length === 0 && <div className="py-16 text-center text-sm text-stone-400">还没有设定卡</div>}
    </div>
  )
}

/** 设定页递归 JSON 渲染：对象→键值树、对象数组→表格、标量数组→列表、标量→文本；值类型不合法不崩 */
function JsonView({ value }: { value: unknown }) {
  if (value == null || value === '') return <span className="text-xs text-stone-300">—</span>
  if (typeof value !== 'object') {
    return <span className="whitespace-pre-wrap text-xs leading-relaxed text-stone-600">{String(value)}</span>
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-xs text-stone-300">—</span>
    if (value.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const rows = value as Array<Record<string, unknown>>
      const cols = [...new Set(rows.flatMap((o) => Object.keys(o)))].slice(0, 6)
      return (
        <div className="no-scrollbar overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {cols.map((k) => (
                  <th
                    key={k}
                    className="border border-orange-200 bg-orange-50 px-1.5 py-1 text-left font-semibold text-stone-500"
                  >
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {cols.map((k) => (
                    <td key={k} className="border border-orange-200 px-1.5 py-1 align-top text-stone-600">
                      <JsonView value={row[k]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    return (
      <ul className="list-disc space-y-0.5 pl-4">
        {value.map((x, i) => (
          <li key={i} className="text-xs text-stone-600">
            <JsonView value={x} />
          </li>
        ))}
      </ul>
    )
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v != null)
  if (entries.length === 0) return <span className="text-xs text-stone-300">—</span>
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k}>
          <div className="text-[11px] text-stone-400">{k}</div>
          <div className="ml-1.5 border-l border-orange-100 pl-2">
            <JsonView value={v} />
          </div>
        </div>
      ))}
    </div>
  )
}

function CharactersList({ lineId }: { lineId: string }) {
  const { data: characters = [], refetch } = useCharacters(lineId)
  const [expanded, setExpanded] = useState<string | null>(null)

  if (characters.length === 0) return <div className="py-16 text-center text-sm text-stone-400">还没有人物</div>

  return (
    <div className="space-y-1.5">
      {characters.map((ch) => (
        <div key={ch.id} className="rounded-xl border border-orange-100 bg-white">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-3 text-left"
            onClick={() => setExpanded(expanded === ch.id ? null : ch.id)}
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{ch.name}</span>
            {ch.role && <span className="truncate text-xs text-stone-400">{ch.role}</span>}
            {ch.pinned && <span className="text-[11px] text-orange-600">已钉选</span>}
          </button>
          {expanded === ch.id && <CharacterDetail ch={ch} onPin={() => refetch()} />}
        </div>
      ))}
    </div>
  )
}

const STATE_BASE_KEYS = ['location', 'body', 'mood', 'items', 'knows', 'goal']

function CharacterDetail({ ch, onPin }: { ch: Character; onPin: () => void }) {
  const state = (ch.state ?? {}) as Record<string, unknown>
  const stateBase = STATE_BASE_KEYS.filter((k) => typeof state[k] === 'string' && state[k])
  const stateExtra = Object.keys(state).filter(
    (k) => !STATE_BASE_KEYS.includes(k) && state[k] != null && typeof state[k] === 'object'
  )
  const cardKeys = Object.keys(ch.card ?? {}).filter((k) => ch.card[k] != null)
  return (
    <div className="border-t border-orange-100/70 px-4 py-3">
      {stateBase.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          {stateBase.map((k) => (
            <div key={k} className="rounded-lg bg-orange-50 p-2">
              <div className="text-[11px] text-stone-400">{k}</div>
              <div className="text-xs text-stone-600">{state[k] as string}</div>
            </div>
          ))}
        </div>
      )}
      {stateExtra.map((k) => (
        <div key={k} className="mb-3">
          <div className="mb-1 text-[11px] text-stone-400">{k}</div>
          <JsonView value={state[k]} />
        </div>
      ))}
      {ch.relations && ch.relations.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[11px] text-stone-400">关系</div>
          {ch.relations.map((r, i) => (
            <div key={i} className="text-xs text-stone-500">
              {ch.name} —{r.label}— {r.to}
            </div>
          ))}
        </div>
      )}
      {cardKeys.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[11px] text-stone-400">人设</div>
          {cardKeys.map((k) => (
            <div key={k} className="mb-1.5">
              <div className="text-[11px] text-stone-400">{k}</div>
              <div className="ml-1.5 border-l border-orange-100 pl-2">
                <JsonView value={ch.card[k]} />
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="rounded-lg border border-orange-100 px-3 py-1.5 text-xs text-stone-500"
        onClick={async () => {
          await window.api.character.save({ id: ch.id, lineId: ch.lineId, name: ch.name, pinned: !ch.pinned })
          onPin()
        }}
      >
        {ch.pinned ? '取消钉选' : '钉选（写作必带）'}
      </button>
    </div>
  )
}

function ForeshadowsList({ lineId }: { lineId: string }) {
  const [status, setStatus] = useState<'open' | 'planned' | 'resolved' | undefined>(undefined)
  const { data: all = [] } = useForeshadows(lineId)
  const foreshadows = status ? all.filter((f) => f.status === status) : all
  const open = foreshadows.filter((f) => f.status !== 'resolved')
  const resolved = foreshadows.filter((f) => f.status === 'resolved')

  const row = (f: Foreshadow, dim: boolean) => (
    <div
      key={f.id}
      className={'rounded-xl border border-orange-100 bg-white px-3 py-3 ' + (dim ? 'opacity-50' : '')}
    >
      <div className="flex items-center gap-2">
        <span
          className={
            'rounded-full px-2 py-0.5 text-[11px] ' +
            (f.status === 'resolved'
              ? 'bg-orange-100 text-stone-500'
              : f.status === 'planned'
                ? 'bg-amber-200/90 text-orange-800'
                : 'bg-orange-100 text-orange-700')
          }
        >
          {f.status === 'resolved' ? '已回收' : f.status === 'planned' ? '已计划' : '埋设中'}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{f.title}</span>
      </div>
      {f.detail && <div className="mt-1.5 line-clamp-2 text-xs text-stone-500">{f.detail}</div>}
    </div>
  )

  return (
    <div>
      <div className="mb-3 flex gap-1.5">
        {(
          [
            [undefined, '全部'],
            ['open', '埋设中'],
            ['planned', '已计划'],
            ['resolved', '已回收']
          ] as Array<[typeof status, string]>
        ).map(([k, label]) => (
          <button
            key={label}
            type="button"
            className={
              'rounded-full px-3 py-1 text-xs ' + (status === k ? 'bg-orange-600 text-white' : 'bg-white text-stone-500')
            }
            onClick={() => setStatus(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {open.length > 0 && <div className="space-y-1.5">{open.map((f) => row(f, false))}</div>}
      {resolved.length > 0 && (
        <>
          <div className="mb-2 mt-4 text-[11px] text-stone-400">已回收</div>
          <div className="space-y-1.5">{resolved.map((f) => row(f, true))}</div>
        </>
      )}
      {foreshadows.length === 0 && <div className="py-16 text-center text-sm text-stone-400">没有伏笔</div>}
    </div>
  )
}
