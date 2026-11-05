import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 保持稳定引用，避免每次渲染重建插件数组导致整块重新解析 */
const PLUGINS = [remarkGfm]

const components: Components = {
  a: (p) => <a {...p} className="text-orange-700 underline underline-offset-2" target="_blank" rel="noreferrer" />
}

/** 聊天流 Markdown 渲染（导演白话/引导回复/节点文案）；memo 化，长列表里非流式气泡不随页面状态重渲染 */
export const Markdown = memo(function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
