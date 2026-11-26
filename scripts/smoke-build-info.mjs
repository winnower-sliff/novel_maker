// 构建指纹冒烟：进程加载后 dist/build-info.json 被后来的构建改写，仍须如实报本进程加载的那一份
// （否则 deploy --if-stale 会把旧进程当成最新而跳过部署）。不需要起服务，直接打 dist 里的模块。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const infoFile = join(root, 'dist/build-info.json')
const original = readFileSync(infoFile, 'utf8')
const { buildInfo } = await import(pathToFileURL(join(root, 'dist/main/buildInfo.js')).href)

let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}

const loaded = buildInfo()
ok(
  '构建指纹可读（先 npm run build）',
  typeof loaded?.sourceHash === 'string' && loaded.sourceHash.length > 0
)

try {
  // 模拟「主 checkout 里又跑了一次构建」：文件换成了另一份主进程源码的指纹
  writeFileSync(
    infoFile,
    JSON.stringify({
      ...loaded,
      sourceHash: 'f'.repeat(16),
      commit: 'fake0000',
      builtAt: '2099-01-01T00:00:00.000Z'
    })
  )
  const after = buildInfo()
  ok('文件被后来的构建改写后，仍如实报本进程加载的指纹', after?.sourceHash === loaded.sourceHash)
  ok('连带提交号也报加载时那一份', after?.commit === loaded.commit)

  // 模拟「出包后回填版本号」：指纹没变，只是版本/提交更新了 → 采用文件里的
  writeFileSync(infoFile, JSON.stringify({ ...loaded, version: '9.9.9', commit: 'beef0001' }))
  const bumped = buildInfo()
  ok(
    '指纹一致的回填（出包后改版本号）照常生效',
    bumped?.version === '9.9.9' && bumped.sourceHash === loaded.sourceHash
  )
} finally {
  writeFileSync(infoFile, original)
}

console.log(`\n[构建指纹冒烟] ${failed ? '失败' : '全部通过'}${failed ? ` ×${failed}` : ''}`)
process.exitCode = failed ? 1 : 0
