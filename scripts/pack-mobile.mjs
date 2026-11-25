// APK 更新分发：把构建好的 NovelMaker.apk 部署到数据目录 mobile/，
// 经内嵌服务器 /api/mobile/version 与 /api/mobile/apk 下发（manifest 白名单防穿越）。
// bundle 界面资源已不再单独下发——UI 更新统一走 APK 安装。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDataDir } from './prod-server.mjs'

/** 本次更新说明：自最新 v* tag 以来的 commit 主题（build-apk 全部成功后才打本次 tag，所以最新 tag 就是上一版） */
function gitNotes() {
  try {
    const tag = execFileSync('git', ['tag', '--sort=-v:refname', '--list', 'v*'], {
      encoding: 'utf8'
    })
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean)
    return (
      execFileSync('git', ['log', '--pretty=%s', tag ? `${tag}..HEAD` : '-20'], {
        encoding: 'utf8'
      })
        .split('\n')
        .map((s) => s.trim())
        // 交接板与发版自身的提交对读者没有信息量
        .filter((s) => s && !/^(chore\(release\)|docs\(handoff\))[:：]|^Merge /.test(s))
        .slice(0, 20)
    )
  } catch {
    return []
  }
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const apkSrc = arg('apk')
  const version = arg('apk-version')
  const versionCode = Number(arg('apk-code')) || 0
  if (!apkSrc || !version) {
    console.error(
      '[pack-mobile] 用法: node scripts/pack-mobile.mjs --apk <NovelMaker.apk> --apk-version <version> [--apk-code <int>]'
    )
    process.exit(1)
  }

  const buf = await readFile(apkSrc)
  const rel = 'apk/NovelMaker.apk'
  const target = join(resolveDataDir(), 'mobile')

  await rm(join(target, 'files'), { recursive: true, force: true })
  const dest = join(target, 'files', rel)
  await mkdir(join(dest, '..'), { recursive: true })
  await copyFile(apkSrc, dest)

  const manifest = {
    version,
    buildAt: new Date().toISOString(),
    apk: { version, versionCode, path: rel, size: buf.length, notes: gitNotes() },
    files: [{ path: rel, hash: createHash('sha256').update(buf).digest('hex'), size: buf.length }]
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
