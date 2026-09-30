// 一键出 APK：构建 mobile web → 部署到电脑端（静默更新源）→ 打进 APK → 拷到项目根
import { copyFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sh = (cmd, cwd) => {
  console.log(`\n[apk] ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit', shell: true })
}

try {
  sh('npx vite build', join(root, 'mobile'))
  sh('node scripts/pack-mobile.mjs', root)
  sh('node scripts/sync-bundle.mjs', join(root, 'mobile-app'))
  sh('npx cap sync android', join(root, 'mobile-app'))
  sh('gradlew.bat assembleDebug --console=plain -q', join(root, 'mobile-app', 'android'))
  const apk = join(root, 'mobile-app', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  await copyFile(apk, join(root, 'NovelMaker.apk'))
  console.log('\n[apk] 完成 → NovelMaker.apk（项目根目录），安装到手机即可')
} catch (err) {
  console.error('[apk] failed:', err.message)
  process.exit(1)
}
