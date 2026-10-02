// 一键出 APK：构建 mobile web → 打进 APK（semver 版本）→ 部署 APK 到电脑端（更新源）→ 拷到项目根
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sh = (cmd, cwd) => {
  console.log(`\n[apk] ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit', shell: true })
}

// semver 单一事实源：根 package.json 的 version 字段
const version = process.argv[2] ?? JSON.parse(await readFile(join(root, 'package.json'), 'utf-8')).version
// versionCode 必须是 int：用分钟级 epoch（单调递增且不溢出）
const versionCode = String(Math.floor(Date.now() / 60000))

try {
  // 版本注入：gradle 读 version.properties
  await writeFile(
    join(root, 'mobile-app', 'android', 'version.properties'),
    `versionName=${version}\nversionCode=${versionCode}\n`
  )
  // 必须以仓库根为 cwd 跑并显式指 config：Tailwind v4 扫描 base 跟随 cwd，
  // 在 mobile/ 下跑会漏扫 src/wizard（向导类全缺→弹窗白框样式失效）
  sh('npx vite build --config mobile/vite.config.ts', root)
  // 哨兵校验：@source 路径错配/cwd 漂移会让整源类静默缺失（白框教训），构建期拦截
  sh('node scripts/check-tailwind-classes.mjs dist-mobile/assets --mobile', root)
  sh('node scripts/sync-bundle.mjs', join(root, 'mobile-app'))
  sh('npx cap sync android', join(root, 'mobile-app'))
  sh('gradlew.bat assembleDebug --console=plain -q', join(root, 'mobile-app', 'android'))
  const apk = join(root, 'mobile-app', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  await copyFile(apk, join(root, 'NovelMaker.apk'))
  // APK 部署为电脑端更新源（manifest.apk），手机端「APP 更新」自动下载安装
  sh(`node scripts/pack-mobile.mjs --apk "${apk}" --apk-version ${version}`, root)
  console.log(`\n[apk] 完成 v${version} → NovelMaker.apk（项目根目录），并已部署为更新源`)
} catch (err) {
  console.error('[apk] failed:', err.message)
  process.exit(1)
}
