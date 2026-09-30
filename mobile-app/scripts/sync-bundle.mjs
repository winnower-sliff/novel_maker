// 把根项目 dist-mobile/ 拷进 www/，作为 APK 内置的初始 bundle
import { cp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const distDir = join(here, '..', '..', 'dist-mobile')
const wwwDir = join(here, '..', 'www')

await rm(wwwDir, { recursive: true, force: true })
await cp(distDir, wwwDir, { recursive: true })

// 记录内置版本，供 MainActivity 首启动时确定 bundle 目录名
const html = await readFile(join(wwwDir, 'index.html'), 'utf-8')
const m = html.match(/assets\/index-([A-Za-z0-9_-]+)\.js/)
await writeFile(
  join(wwwDir, 'nm-bundle.json'),
  JSON.stringify({ embedded: true, key: m ? `embedded-${m[1]}` : 'embedded' })
)
console.log('[sync-bundle] www/ 已更新')
