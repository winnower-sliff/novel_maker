import { coverBackground, coverGlyph } from '../lib/cover'

/**
 * 色块封面：按 id 取色的渐变 + 左侧书脊 + 居中的书名首字。
 * 纯装饰（名字、章数都写在封面下方），对读屏隐藏。
 */
export function Cover({
  id,
  name,
  glyphSize = 40,
  className = ''
}: {
  id: string
  name: string
  /** 水印字号（px）：封面越大字越大 */
  glyphSize?: number
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={`relative block overflow-hidden ${className}`}
      style={{ background: coverBackground(id) }}
    >
      {/* 书脊：靠左一道压暗的窄条，内侧一条折线 */}
      <span className="absolute inset-y-0 left-0 w-[8%] bg-black/15" />
      <span className="absolute inset-y-0 left-[11%] w-px bg-white/30" />
      <span
        className="absolute inset-0 flex items-center justify-center font-serif font-bold text-white [text-shadow:0_1px_3px_rgba(76,29,0,0.35)]"
        style={{ fontSize: glyphSize }}
      >
        {coverGlyph(name)}
      </span>
    </span>
  )
}
