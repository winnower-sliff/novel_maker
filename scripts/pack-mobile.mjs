// APK 更新分发：把构建好的 NovelMaker.apk 部署到 Electron userData/mobile/，
// 经内嵌服务器 /api/mobile/version|file 下发（manifest 白名单防穿越）。
// bundle 界面资源已不再单独下发——UI 更新统一走 APK 安装。
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function appDataDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'novel-maker')
  }
  return join(process.env.HOME ?? '', '.config', 'novel-maker')
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const apkSrc = arg('apk')
  const version = arg('apk-version')
  if (!apkSrc || !version) {
    console.error('[pack-mobile] 用法: node scripts/pack-mobile.mjs --apk <NovelMaker.apk> --apk-version <semver>')
    process.exit(1)
  }

  const buf = await readFile(apkSrc)
  const rel = 'apk/NovelMaker.apk'
  const target = join(appDataDir(), 'mobile')

  await rm(join(target, 'files'), { recursive: true, force: true })
  const dest = join(target, 'files', rel)
  await mkdir(join(dest, '..'), { recursive: true })
  await copyFile(apkSrc, dest)

  const manifest = {
    version,
    buildAt: new Date().toISOString(),
    apk: { version, path: rel, size: buf.length },
    files: [
      { path: rel, hash: createHash('sha256').update(buf).digest('hex'), size: buf.length }
    ]
  }
  await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const total = (await stat(dest)).size
  console.log(`[pack-mobile] APK v${version} (${(total / 1048576).toFixed(1)} MB) -> ${target}`)
  console.log('[pack-mobile] 已生效，手机端「更多 → APP 更新」即可检查下载')
}

main().catch((err) => {
  console.error('[pack-mobile] failed:', err)
  process.exit(1)
})
