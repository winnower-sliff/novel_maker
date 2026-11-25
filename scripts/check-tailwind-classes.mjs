// Tailwind 源扫描哨兵校验：构建 cwd 漂移或样式入口没被扫到时，整批工具类会静默缺失——
// 页面按无样式裸奔，而构建照样成功。本脚本在产物 CSS 里查找几个代表类，缺失即退出非零，
// 把静默失效变成构建失败。
//
// 用法：node scripts/check-tailwind-classes.mjs <css 目录> [--mobile]
//   --mobile  多校验几个只在高频页面上用到的类
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dir = args[0]
if (!dir) {
  console.error('用法: node scripts/check-tailwind-classes.mjs <css目录> [--mobile]')
  process.exit(1)
}

// 类名为 CSS 内转义字面量（如 sm\:p-6）；每项 [类, 守护的扫描源]
// v2：唯一 UI 源 = mobile/src（vite root 扫描）；src/ 为主进程无 CSS
const COMMON = [
  ['rounded-t-2xl', 'src/pages（底部弹层）'],
  ['grid-cols-2', 'src/pages/Settings（用量统计）'],
  ['line-clamp-2', 'src/pages/Write+Cards（摘要截断）']
]
const MOBILE_ONLY = [
  ['bg-orange-100', 'src/pages（次级按钮/徽标）'],
  ['bg-\\[\\#fbf6ec\\]', '全局（暖米白页面底色）']
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
  console.error('[tailwind-check] 缺失哨兵类（样式源没进扫描：检查 vite 构建的 cwd 与 --config）：')
  for (const [cls, src] of missing) console.error(`  - ${cls}  ← ${src}`)
  process.exit(1)
}
console.log(`[tailwind-check] ${sentinels.length} 个哨兵类全部命中 ✓`)
