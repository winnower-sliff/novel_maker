// Tailwind 源扫描哨兵校验：@source 路径错配 / 构建 cwd 漂移会让整源类静默缺失，
// 页面按无样式裸奔（实锤案例：mobile/styles.css 的 @source "../../wizard" 相对路径
// 抄错深度 → 向导类全缺 → APK 白框+样式失效）。本脚本在产物 CSS 里查找每个扫描源
// 的代表类，缺失即退出非零，把静默失效变成构建失败。
//
// 用法：node scripts/check-tailwind-classes.mjs <css 目录> [--mobile]
//   --mobile  额外校验仅手机端存在的源（mobile/ui、mobile/pages）
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dir = args[0]
if (!dir) {
  console.error('用法: node scripts/check-tailwind-classes.mjs <css目录> [--mobile]')
  process.exit(1)
}

// 类名为 CSS 内转义字面量（如 sm\:p-6）；每项 [类, 守护的扫描源]
const COMMON = [
  ['rounded-none', 'src/wizard（OverlayCard 手机全屏）'],
  ['sm\\:p-6', 'src/wizard（OverlayCard 桌面弹窗）'],
  ['bg-black\\/60', 'src/wizard（OverlayCard 遮罩）'],
  ['rounded-md', 'renderer/ui + src/wizard（StreamBox 等）']
]
const MOBILE_ONLY = [
  ['px-3\\.5', 'mobile/ui（Button）'],
  ['active\\:bg-zinc-900', 'mobile/pages/Codex（Row）']
]

async function collectCss(d) {
  const out = []
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...(await collectCss(p)))
    else if (e.name.endsWith('.css')) out.push(await readFile(p, 'utf8'))
  }
  return out
}

const all = (await collectCss(dir)).join('\n')
if (!all) {
  console.error(`[tailwind-check] ${dir} 下没有 CSS 产物`)
  process.exit(1)
}
const sentinels = args.includes('--mobile') ? [...COMMON, ...MOBILE_ONLY] : COMMON
const missing = sentinels.filter(([cls]) => !all.includes(cls))
if (missing.length > 0) {
  console.error('[tailwind-check] 缺失哨兵类（对应源未进扫描，检查 styles.css @source 路径与构建 cwd）：')
  for (const [cls, src] of missing) console.error(`  - ${cls}  ← ${src}`)
  process.exit(1)
}
console.log(`[tailwind-check] ${sentinels.length} 个哨兵类全部命中 ✓`)
