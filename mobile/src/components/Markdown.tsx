import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 聊天流 Markdown 渲染（导演白话/引导回复/节点文案） */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (p) => <a {...p} className="text-orange-700 underline underline-offset-2" target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
