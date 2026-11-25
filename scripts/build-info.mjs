#!/usr/bin/env node
// 构建指纹：tsc 之后写 dist/build-info.json（版本 / commit / 构建时间 / 主进程源码哈希）。
// - /api/health 原样返回（另带 pid）——版本号取构建快照，而非运行时读 package.json；
// - deploy 探测后比对，确认「应答的就是本次构建、就是这个进程」；
// - build-apk 用它判断生产 server 是否落后于源码（主进程改了却只出 APK 的坑）。
// 用法：node scripts/build-info.mjs            写 dist/build-info.json
//       node scripts/build-info.mjs --print   只打印当前源码指纹
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 主进程源码指纹：src/main + src/shared 下全部 .ts 按「相对路径 + 内容」依序哈希。
 * 换行统一成 LF——git autocrlf 会让不同检出的换行不同，指纹只应反映内容差异。
 * 不含 package.json 的 version：版本号另行比对，避免「只升了版本号」被误判成代码变了。
 */
export function sourceFingerprint(root) {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.ts')) files.push(full)
    }
  }
  walk(join(root, 'src', 'main'))
  walk(join(root, 'src', 'shared'))
  const h = createHash('sha256')
  for (const f of files) {
    const rel = relative(root, f).replace(/\\/g, '/')
    h.update(`${rel}\0${readFileSync(f, 'utf8').replace(/\r\n/g, '\n')}\0`)
  }
  return h.digest('hex').slice(0, 16)
}

export function currentVersion(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

export function readBuildInfo(root, distDir = join(root, 'dist')) {
  try {
    return JSON.parse(readFileSync(join(distDir, 'build-info.json'), 'utf8'))
  } catch {
    return null
  }
}

export function writeBuildInfo(root, distDir = join(root, 'dist')) {
  const git = (cmd) => {
    try {
      return execSync(`git ${cmd}`, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch {
      return ''
    }
  }
  const commit = git('rev-parse --short HEAD') || 'unknown'
  const dirty = git('status --porcelain -- src') !== ''
  const info = {
    version: currentVersion(root),
    commit: dirty ? `${commit}-dirty` : commit,
    builtAt: new Date().toISOString(),
    sourceHash: sourceFingerprint(root)
  }
  writeFileSync(join(distDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
  return info
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  if (process.argv.includes('--print')) {
    console.log(sourceFingerprint(root))
  } else {
    const info = writeBuildInfo(root)
    console.log(`[build-info] ${info.version} ${info.commit} 指纹 ${info.sourceHash}`)
  }
}
