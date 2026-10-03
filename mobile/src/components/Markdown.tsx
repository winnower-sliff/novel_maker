import { memo, useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 移动端精简 Markdown：wikilink 用预处理降级为加粗文本，
 * 不做 AST 插件与 hover 预览（触屏无 hover，编辑查看在设定子页完成）。
 */

const WIKI_LINK_RE = /\[\[([^[\]]+?)\]\]/g

function stripWikiLinks(text: string): string {
  return text.replace(WIKI_LINK_RE, (_m, raw: string) => {
    const pipe = raw.indexOf('|')
    const label = (pipe >= 0 ? raw.slice(pipe + 1) : raw).trim() || raw.trim()
    return `**${label}**`
  })
}

const urlTransform: UrlTransform = (url) => defaultUrlTransform(url)

export const Markdown = memo(function Markdown({
  text,
  className = ''
}: {
  text: string
  className?: string
}) {
  const processed = useMemo(() => stripWikiLinks(text), [text])
  return (
    <div className={`break-words ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="my-1.5 list-disc space-y-0.5 pl-5 marker:text-zinc-500">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal space-y-0.5 pl-5 marker:text-zinc-500">{children}</ol>
          ),
          h1: ({ children }) => (
            <h1 className="mb-1.5 mt-3 text-lg font-semibold text-zinc-100 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-1.5 mt-3 text-base font-semibold text-zinc-100 first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1 mt-2 text-sm font-semibold text-zinc-100 first:mt-0">{children}</h3>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-amber-200/90">{children}</strong>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-amber-600/50 py-0.5 pl-3 text-zinc-400">
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded bg-zinc-800 px-1 py-px font-mono text-[0.9em] text-amber-200/90">
              {children}
            </code>
          ),
          a: ({ children, href }) => (
            <a href={href} className="text-amber-400/90 underline underline-offset-2">
              {children}
            </a>
          )
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
})
