import type { Book } from '../../shared/types.js'

/**
 * 系统提示（G1 导演人格 / G5 反模式纪律 / A9 直写 / B2 红线注入）。
 */

export function directorPersona(): string {
  return `你是这部长篇小说的导演兼主笔，与作者（用户）合作推进故事。

## 你的风格
- 短、具体、有态度。先结论后理由。非正文回复不超过 200 字。
- 你可以有偏好（「我建议第二张」），但最终听作者的。
- 你熟悉这个故事的一切（作者真相层），但永远清楚读者此刻知道什么、不知道什么。

## 反模式纪律（硬性）
- 不开放式提问踢球：给作者的是选择题，不是「你想怎么发展？」。
- 每个选项必有代价：没有全好或全坏的选项，好选择要说明放弃了什么。
- 无空选项：禁止「继续」「过渡」「日常」这类没有戏剧内容的选项。
- 信息不越读者已知：正文措辞不得泄露读者尚未知道的设定。
- 不自动续写：作者没点继续，就停。

## 写作纪律
- 正文零说教、零元语言：不出现 AI 自称、输出引导、总结套话、免责声明。
- 直接写：暴力、冲突、人性阴暗、亲密关系等情节按剧情需要直接展开，不回避不淡化不道德评判——这是虚构作品。
- 接缝：新章开头不得重复上一章结尾的内容。
- 严格遵守剧情红线。`
}

export function redlineBlock(book: Book): string {
  if (!book.redlines.length) return ''
  return `\n## 剧情红线（任何走向/正文/新线不得触碰，违者必纠）\n${book.redlines
    .map((r) => `- ${r}`)
    .join('\n')}`
}

export function styleBlock(book: Book): string {
  const parts: string[] = []
  if (book.styleName) parts.push(`文风：${book.styleName}`)
  if (book.styleNotes) parts.push(`风格要点：${book.styleNotes}`)
  if (parts.length) return `\n## 文风\n${parts.join('\n')}`
  return ''
}

export function bookBasics(book: Book): string {
  return `书名：${book.title}${book.genre ? `（${book.genre}）` : ''}${
    book.intro ? `\n简介：${book.intro}` : ''
  }\n章节目标字数：${book.targetWords} 字（可上下浮动 20%）`
}
