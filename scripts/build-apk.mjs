// 一键出 APK。版本号最后落账：先把全部产物做出来，成功了才提交版本号、打 tag。
//   算版本 → 写 package.json → 确保电脑端 server 是最新构建 → 构建 APK → 部署为更新源 → 提交版本 + 打 tag
// 用法：npm run apk -- [版本号] [--skip-deploy]
//   版本号       手动指定（如 2.0.0）；不传则按 Conventional Commits 自最新 v* tag 自动推进（scripts/version.mjs）
//   --skip-deploy 不检查也不部署电脑端 server（确定主进程没改时用）// 约束：只能在运行电脑端 server 的那个 checkout 里出包——APK 会装进手机、tag 会留在当前分支。
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentVersion, readBuildInfo, sourceFingerprint } from './build-info.mjs'
import { findProdServer, resolveDataDir, serverCheckoutFile } from './prod-server.mjs'
import { bumpVersion, ensureVersionTag } from './version.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const skipDeploy = args.includes('--skip-deploy')
const [manualVersion] = args.filter((a) => !a.startsWith('--'))
const dataDir = resolveDataDir(args)

const sh = (cmd, cwd) => {
  console.log(`\n[apk] ${cmd}`)
  const r = spawnSync(cmd, { cwd, stdio: 'inherit', shell: true })
  if (r.status !== 0) throw new Error(`「${cmd}」失败（exit ${r.status}）`)
}

const git = (gitArgs) => spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' })

const samePath = (a, b) => {
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  return norm(a) === norm(b)
}

// 只改 version 这一行，不重新序列化整个文件
function setVersionField(version) {
  const path = join(root, 'package.json')
  const text = readFileSync(path, 'utf8')
  const m = /"version"\s*:\s*"([^"]*)"/.exec(text)
  if (!m) throw new Error('package.json 里找不到 version 字段')
  if (m[1] === version) return
  const at = m.index + m[0].lastIndexOf(m[1])
  writeFileSync(path, `${text.slice(0, at)}${version}${text.slice(at + m[1].length)}`)
}

/** APK 只调电脑端 server 的接口：server 还跑着旧代码时，新 APK 的功能会静默失效 */
async function ensureServerCurrent() {
  let recorded = ''
  try {
    recorded = readFileSync(serverCheckoutFile(dataDir), 'utf8').trim()
  } catch {
    /* 首次部署，还没有记录 */
  }
  if (recorded && existsSync(recorded) && !samePath(recorded, root)) {
    throw new Error(
      `电脑端 server 由另一个 checkout 运行：\n  ${recorded}\n` +
        'APK 只能在那个 checkout 里出（先把改动合并过去），否则手机会装上未合并的代码、版本 tag 也会打错分支。'
    )
  }

  console.log('\n[apk] 确保电脑端 server 是最新构建…')
  const r = spawnSync(process.execPath, [join('scripts', 'deploy.mjs'), '--if-stale'], {
    cwd: root,
    stdio: 'inherit'
  })
  if (r.status === 0) return
  const live = await findProdServer(dataDir)
  if (!live) {
    throw new Error(
      '电脑端 server 自动部署失败，且当前没有服务在应答。先手动 npm run deploy，成功后再 npm run apk'
    )
  }
  if (live.health.build?.sourceHash !== sourceFingerprint(root)) {
    throw new Error(
      `电脑端 server 自动部署没有成功（仍是 ${live.health.version}）。` +
        '常见原因是有写作任务在跑——等它结束后 npm run deploy，再 npm run apk'
    )
  }
  console.warn(
    `[apk] 提示：电脑端 server 没有重启（${live.health.version}），原因见上方 [deploy] 输出`
  )
}

/** 产物全部就绪后才落账：版本号提交 + tag。提交失败不影响已出的包，只提示。 */
function release() {
  let committed = false
  if (version === prevVersion) {
    committed = true
  } else {
    // package.json 里除了版本号还有别的未提交改动（比如刚装了依赖）时不代为提交，免得把无关改动裹进发版
    const [added, deleted] = git(['diff', 'HEAD', '--numstat', '--', 'package.json']).stdout.split(
      '\t'
    )
    if (added === '1' && deleted === '1') {
      const c = spawnSync(
        'git',
        ['commit', '-m', `chore(release): v${version}`, '--', 'package.json'],
        {
          cwd: root,
          stdio: 'inherit'
        }
      )
      committed = c.status === 0
    }
    if (!committed) {
      console.warn(
        `[apk] 警告：版本号没提交成，请手动提交 package.json（chore(release): v${version}）`
      )
    }
  }
  ensureVersionTag(root, version)

  // 构建指纹记的是构建时的状态（发版提交之前）；产物对应的正是发版提交，回填成它。
  // 版本号一并回填：只改手机端时 server 不重启也能对得上，/api/health 始终报最新版本
  const info = readBuildInfo(root)
  const head = git(['rev-parse', '--short', 'HEAD']).stdout.trim()
  if (info && head && info.sourceHash === sourceFingerprint(root)) {
    const dirty = git(['status', '--porcelain', '--', 'src']).stdout.trim() !== ''
    const next = { ...info, version, commit: dirty ? `${head}-dirty` : head }
    if (next.version !== info.version || next.commit !== info.commit) {
      writeFileSync(join(root, 'dist', 'build-info.json'), `${JSON.stringify(next, null, 2)}\n`)
    }
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
  for (const ref of branch === 'HEAD' ? [`v${version}`] : [branch, `v${version}`]) {
    const p = spawnSync('git', ['push', 'origin', ref], { cwd: root, encoding: 'utf8' })
    if (p.status !== 0) console.warn(`[apk] 警告：推送 ${ref} 失败（网络？），稍后手动 git push`)
  }
  return { changed: version !== prevVersion, committed }
}

if (manualVersion && !/^\d+\.\d+\.\d+$/.test(manualVersion)) {
  console.error(`[apk] 中止：版本号「${manualVersion}」不是 semver（如 5.0.0）`)
  process.exit(1)
}

// semver 单一事实源：根 package.json 的 version 字段。手动传参优先；否则自最新 v* tag 自动推进
const prevVersion = currentVersion(root)
const version = manualVersion ?? (await bumpVersion(root, { dry: true }))
// versionCode 必须是 int：用分钟级 epoch（单调递增且不溢出）
const versionCode = String(Math.floor(Date.now() / 60000))
// versionName 追加构建时间戳：手机端「检查更新」靠 versionName/versionCode 区分新旧包，
// 纯 semver（如 1.0.0）多次构建不变会让旧机误判「已是最新」而拉不到新包
const p2 = (n) => String(n).padStart(2, '0')
const d = new Date()
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`
const versionName = `${version}-${stamp}`

setVersionField(version)
try {
  if (!skipDeploy) await ensureServerCurrent()

  // 版本注入：gradle 读 version.properties
  writeFileSync(
    join(root, 'mobile-app', 'android', 'version.properties'),
    `versionName=${versionName}\nversionCode=${versionCode}\n`
  )
  // 必须以仓库根为 cwd 跑并显式指 config：Tailwind v4 的扫描范围跟随 vite root，
  // 换 cwd 或省掉 --config 都可能让整源类静默缺失
  // 版本标签经 env 注入 web bundle：同一构建同一字符串，杜绝「APK 本地钟 vs bundle UTC 钟」不一致
  process.env.NM_APK_VERSION = versionName
  sh('npx vite build --config mobile/vite.config.ts', root)
  // 哨兵校验：@source 路径错配/cwd 漂移会让整源类静默缺失（白框教训），构建期拦截
  sh('node scripts/check-tailwind-classes.mjs dist-mobile/assets --mobile', root)
  sh('node scripts/sync-bundle.mjs', join(root, 'mobile-app'))
  sh('npx cap sync android', join(root, 'mobile-app'))
  sh('gradlew.bat assembleDebug --console=plain -q', join(root, 'mobile-app', 'android'))
  const apk = join(
    root,
    'mobile-app',
    'android',
    'app',
    'build',
    'outputs',
    'apk',
    'debug',
    'app-debug.apk'
  )
  copyFileSync(apk, join(root, 'NovelMaker.apk'))
  // APK 部署为电脑端更新源（manifest.apk），手机端「APP 更新」自动下载安装
  sh(
    `node scripts/pack-mobile.mjs --apk "${apk}" --apk-version ${versionName} --apk-code ${versionCode}`,
    root
  )
} catch (err) {
  setVersionField(prevVersion)
  console.error(
    `\n[apk] 中止：${err.message}\n[apk] 版本号已回退为 ${prevVersion}，未提交、未打 tag；修复后重跑即可`
  )
  process.exit(1)
}

const { changed, committed } = release()
console.log(`\n[apk] 完成 v${versionName} → NovelMaker.apk（项目根目录），并已部署为更新源`)
console.log(
  changed
    ? committed
      ? `[apk] 版本 ${version} 已提交并打 tag v${version}`
      : `[apk] tag v${version} 已打；版本号提交见上方警告`
    : `[apk] 版本 ${version} 未变（tag v${version} 已确保存在）`
)
