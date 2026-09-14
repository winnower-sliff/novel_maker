import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Link, Parent, PhrasingContent, Root } from 'mdast'
import type { Plugin } from 'unified'

export interface WikiLinkTarget {
  category?: string
  preview: string
}

export interface WikiLinkHandlers {
  resolve: (name: string) => WikiLinkTarget | null
  onOpen: (name: string) => void
}

const WIKI_LINK_RE = /\[\[([^\[\]]+?)\]\]/g
const WIKI_URL_PREFIX = 'wiki:'
const HOVER_DELAY_MS = 500

const remarkWikiLinks: Plugin<[], Root> = () => (tree) => {
  const walk = (parent: Parent): void => {
    const children = parent.children
    for (let i = 0; i < children.length; i++) {
      const node = children[i]
      if (node.type === 'text' && node.value.includes('[[')) {
        const segs = splitWikiText(node.value)
        children.splice(i, 1, ...segs)
        i += segs.length - 1
      } else if ('children' in node && Array.isArray((node as Parent).children)) {
        walk(node as Parent)
      }
    }
  }
  walk(tree as unknown as Parent)
}

function splitWikiText(value: string): PhrasingContent[] {
  const out: PhrasingContent[] = []
  let last = 0
  for (const m of value.matchAll(WIKI_LINK_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ type: 'text', value: value.slice(last, idx) })
    const name = m[1].trim()
    if (name) {
      const link: Link = {
        type: 'link',
        url: WIKI_URL_PREFIX + encodeURIComponent(name),
        children: [{ type: 'text', value: name }]
      }
      out.push(link)
    }
    last = idx + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

const WikiLink = memo(function WikiLink({
  name,
  children,
  resolve,
  onOpen
}: {
  name: string
  children: React.ReactNode
  resolve: WikiLinkHandlers['resolve']
  onOpen: WikiLinkHandlers['onOpen']
}) {
  const [hover, setHover] = useState<{ x: number; y: number; target: WikiLinkTarget } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nameRef = useRef<HTMLSpanElement | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  const clearHover = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setHover(null)
  }

  const known = resolve(name)

  return (
    <span
      ref={nameRef}
      role="link"
      tabIndex={0}
      className={`underline decoration-dotted underline-offset-2 transition-colors ${
        known ? 'cursor-pointer text-amber-400/90 hover:text-amber-300' : 'cursor-default text-zinc-500 decoration-zinc-600'
      }`}
      onClick={(e) => {
        e.stopPropagation()
        if (known) onOpen(name)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.stopPropagation()
          if (known) onOpen(name)
        }
      }}
      onMouseEnter={() => {
        const target = resolve(name)
        if (!target) return
        timerRef.current = setTimeout(() => {
          const rect = nameRef.current?.getBoundingClientRect()
          if (rect) setHover({ x: rect.left, y: rect.bottom, target })
        }, HOVER_DELAY_MS)
      }}
      onMouseLeave={clearHover}
    >
      {children}
      {hover && (
        <div
          className="fixed z-50 block w-72 rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 text-left shadow-xl"
          style={{
            left: Math.min(hover.x, Math.max(8, window.innerWidth - 300)),
            top: Math.min(hover.y + 6, Math.max(8, window.innerHeight - 220))
          }}
          onMouseLeave={clearHover}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {hover.target.category ?? '条目'}
            </span>
            <span className="text-xs font-medium text-zinc-200">{name}</span>
          </div>
          <Markdown
            text={hover.target.preview}
            className="max-h-40 overflow-y-auto text-[11px] leading-4 text-zinc-400"
            wiki={{ resolve, onOpen }}
          />
        </div>
      )}
    </span>
  )
})

function buildComponents(wiki: WikiLinkHandlers | undefined): Components {
  return {
    h1: ({ node: _n, ...p }) => <h1 {...p} className="mb-1.5 mt-2.5 text-[1.25em] font-semibold text-zinc-100 first:mt-0" />,
    h2: ({ node: _n, ...p }) => <h2 {...p} className="mb-1 mt-2 text-[1.15em] font-semibold text-zinc-100 first:mt-0" />,
    h3: ({ node: _n, ...p }) => <h3 {...p} className="mb-1 mt-1.5 text-[1.08em] font-semibold text-zinc-100 first:mt-0" />,
    h4: ({ node: _n, ...p }) => <h4 {...p} className="mb-1 mt-1.5 font-semibold text-zinc-100 first:mt-0" />,
    h5: ({ node: _n, ...p }) => <h5 {...p} className="mb-1 mt-1.5 font-semibold text-zinc-100 first:mt-0" />,
    h6: ({ node: _n, ...p }) => <h6 {...p} className="mb-1 mt-1.5 font-semibold text-zinc-100 first:mt-0" />,
    p: ({ node: _n, ...p }) => <p {...p} className="my-1 first:mt-0 last:mb-0" />,
    ul: ({ node: _n, ...p }) => <ul {...p} className="my-1 list-disc space-y-0.5 pl-5 marker:text-zinc-500" />,
    ol: ({ node: _n, ...p }) => <ol {...p} className="my-1 list-decimal space-y-0.5 pl-5 marker:text-zinc-500" />,
    li: ({ node: _n, ...p }) => <li {...p} className="[&>p]:my-0 [&>ul]:my-0 [&>ol]:my-0" />,
    blockquote: ({ node: _n, ...p }) => (
      <blockquote {...p} className="my-1.5 border-l-2 border-amber-600/50 py-0.5 pl-3 text-zinc-400" />
    ),
    hr: ({ node: _n, ...p }) => <hr {...p} className="my-2.5 border-zinc-800" />,
    strong: ({ node: _n, ...p }) => <strong {...p} className="font-semibold text-zinc-100" />,
    em: ({ node: _n, ...p }) => <em {...p} className="italic" />,
    del: ({ node: _n, ...p }) => <del {...p} className="text-zinc-500 line-through" />,
    a: ({ node: _node, href, children, ...rest }) => {
      if (wiki && typeof href === 'string' && href.startsWith(WIKI_URL_PREFIX)) {
        const name = decodeURIComponent(href.slice(WIKI_URL_PREFIX.length))
        return (
          <WikiLink name={name} resolve={wiki.resolve} onOpen={wiki.onOpen}>
            {children}
          </WikiLink>
        )
      }
      return (
        <a {...rest} href={href} target="_blank" rel="noreferrer" className="text-amber-400/90 underline underline-offset-2 hover:text-amber-300">
          {children}
        </a>
      )
    },
    code: ({ node: _n, ...p }) => <code {...p} className="rounded bg-zinc-800 px-1 py-px font-mono text-[0.9em] text-amber-200/90" />,
    pre: ({ node: _n, ...p }) => (
      <pre
        {...p}
        className="my-2 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[0.9em] leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-zinc-300"
      />
    ),
    table: ({ node: _n, ...p }) => <table {...p} className="my-2 w-full border-collapse" />,
    th: ({ node: _n, ...p }) => <th {...p} className="border-b border-zinc-700 px-2 py-1 text-left font-medium text-zinc-300" />,
    td: ({ node: _n, ...p }) => <td {...p} className="border-b border-zinc-800/70 px-2 py-1 align-top" />,
    img: ({ node: _n, ...p }) => <img {...p} className="max-w-full rounded-md" />
  }
}

const urlTransform: UrlTransform = (url) =>
  url.startsWith(WIKI_URL_PREFIX) ? url : defaultUrlTransform(url)

interface MarkdownProps {
  text: string
  className?: string
  wiki?: WikiLinkHandlers
}

export const Markdown = memo(function Markdown({ text, className = '', wiki }: MarkdownProps) {
  const remarkPlugins = useMemo(
    () => (wiki ? [remarkGfm, remarkWikiLinks] : [remarkGfm]),
    [wiki]
  )
  const components = useMemo(() => buildComponents(wiki), [wiki])
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
