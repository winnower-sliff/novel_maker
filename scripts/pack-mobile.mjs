// 构建移动端 web bundle 并部署到 Electron userData/mobile/，
// 供电脑端内嵌服务器经 /api/mobile/version|file 下发增量更新。
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const distDir = join(root, 'dist-mobile')

function appDataDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'novel-maker')
  }
  return join(process.env.HOME ?? '', '.config', 'novel-maker')
}

async function listFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(full)))
    else out.push(full)
  }
  return out
}

async function main() {
  const version = process.argv[2] ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  console.log(`[pack-mobile] version=${version}`)

  const { execSync } = await import('node:child_process')
  execSync('npx vite build', { cwd: join(root, 'mobile'), stdio: 'inherit' })

  const files = await listFiles(distDir)
  const manifest = { version, buildAt: new Date().toISOString(), files: [] }
  for (const full of files) {
    const path = relative(distDir, full).replaceAll('\\', '/')
    const buf = await readFile(full)
    manifest.files.push({
      path,
      hash: createHash('sha256').update(buf).digest('hex'),
      size: buf.length
    })
  }

  const target = join(appDataDir(), 'mobile')
  await rm(join(target, 'files'), { recursive: true, force: true })
  await mkdir(join(target, 'files'), { recursive: true })
  for (const full of files) {
    const dest = join(target, 'files', relative(distDir, full))
    await mkdir(join(dest, '..'), { recursive: true })
    await cp(full, dest)
  }
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const total = manifest.files.reduce((s, f) => s + f.size, 0)
  console.log(`[pack-mobile] deployed ${manifest.files.length} files (${(total / 1024).toFixed(0)} KB) -> ${target}`)
  console.log(`[pack-mobile] 版本 ${version} 已生效，手机端检查更新即可拿到`)
}

main().catch((err) => {
  console.error('[pack-mobile] failed:', err)
  process.exit(1)
})
