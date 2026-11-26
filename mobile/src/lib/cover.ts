/**
 * 封面取色：写书页的主卡 / 书格与范文页的范文卡共用。
 * 书 id 哈希到暖色系之一——稳定不随刷新变化，同一个 id 在哪儿都是同一个颜色。
 */
const SPINE_COLORS = ['#ea580c', '#d97706', '#c2410c', '#b45309', '#9a3412', '#e11d48']

export function spineColor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return SPINE_COLORS[h % SPINE_COLORS.length] ?? '#ea580c'
}

/**
 * 封面底色：沿用「书脊色 → 琥珀」的斜向渐变，上面叠一层左上高光与下半压暗，做出纸面的立体感。
 * CSS 多层 background 先写的在上层。
 */
export function coverBackground(id: string): string {
  const c = spineColor(id)
  return [
    'radial-gradient(120% 90% at 10% 0%, rgba(255, 255, 255, 0.28) 0%, rgba(255, 255, 255, 0) 55%)',
    'linear-gradient(180deg, rgba(0, 0, 0, 0) 55%, rgba(0, 0, 0, 0.16) 100%)',
    `linear-gradient(135deg, ${c} 0%, #f59e0b 130%)`
  ].join(', ')
}

/** 封面水印字：书名里第一个是文字的字符（跳过引号、破折号等标点）；取不到就用「书」 */
export function coverGlyph(name: string): string {
  return Array.from(name).find((ch) => /[\p{L}\p{N}]/u.test(ch)) ?? '书'
}
