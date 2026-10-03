// 版本号自动推进：按 Conventional Commits，自最新 v* git tag 以来算 semver 增量。
// breaking(! 或 BREAKING CHANGE) → major；feat → minor；fix/perf → patch；其余不升。
// 基线用 git tag（vX.Y.Z），每次推进自动打新 tag；无 tag 时首跑在当前 HEAD 建基线、不升版。
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

const parseSemver = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function latestVersionTag(cwd) {
  const out = git(['tag', '--list', 'v*', '--sort=-v:refname'], cwd)
  if (!out) return null
  return out.split('\n').map((s) => s.trim()).filter((t) => parseSemver(t.slice(1)))[0] ?? null
}

const tagExists = (cwd, name) => Boolean(git(['tag', '--list', name], cwd))

// 打基线 tag。strict=true 时 tag 已存在/创建失败一律抛出，避免「版本与基线 tag 不一致」被静默吞掉。
function createTag(cwd, version, { strict = false } = {}) {
  const name = `v${version}`
  if (tagExists(cwd, name)) {
    if (strict) throw new Error(`tag ${name} 已存在：package.json 版本与基线不一致，请先核对`)
    return false
  }
  try {
    execFileSync('git', ['tag', name], { cwd, encoding: 'utf-8' })
  } catch (err) {
    throw new Error(`创建 tag ${name} 失败：${err.message}`)
  }
  return true
}

// 供外部（如 build-apk 手动指定版本时）确保基线 tag 存在；失败仅告警不中断
export function ensureVersionTag(cwd, version) {
  try {
    return createTag(cwd, version, { strict: false })
  } catch (err) {
    console.warn(`[version] ${err.message}`)
    return false
  }
}

function classify(subject, body) {
  if (/^[a-z]+(\([^)]*\))?!:/.test(subject) || /BREAKING[ -]CHANGE:/.test(body)) return 'major'
  if (/^feat(\([^)]*\))?:/.test(subject)) return 'minor'
  if (/^(fix|perf)(\([^)]*\))?:/.test(subject)) return 'patch'
  return null
}

function bumpSemver([maj, min, pat], kind) {
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

// 返回推进后的版本号（dry=true 时不写回 package.json、不打 tag）
export async function bumpVersion(cwd, { dry = false } = {}) {
  const pkgPath = join(cwd, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
  const current = pkg.version
  const cur = parseSemver(current)
  if (!cur) {
    console.warn(`[version] package.json version "${current}" 非 semver，跳过自动推进`)
    return current
  }

  const tag = latestVersionTag(cwd)
  if (!tag) {
    if (!dry) ensureVersionTag(cwd, current)
    console.log(`[version] 无历史 tag：在 HEAD 建基线 v${current}${dry ? '（dry-run）' : ''}，本次不升版`)
    return current
  }

  const raw = git(['log', `${tag}..HEAD`, '--format=%s%x1f%b%x1e'], cwd)
  const recs = raw ? raw.split('\x1e').map((r) => r.trim()).filter(Boolean) : []
  const rank = { patch: 1, minor: 2, major: 3 }
  const counts = { major: 0, minor: 0, patch: 0 }
  let kind = null
  for (const rec of recs) {
    const [subject = '', ...rest] = rec.split('\x1f')
    const k = classify(subject, rest.join('\x1f'))
    if (!k) continue
    counts[k]++
    if (!kind || rank[k] > rank[kind]) kind = k
  }

  if (!kind) {
    console.log(`[version] 自 ${tag} 起无 feat/fix/breaking，semver 保持 ${current}`)
    return current
  }

  const next = bumpSemver(cur, kind)
  if (!dry) {
    createTag(cwd, next, { strict: true })
    pkg.version = next
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  console.log(
    `[version] ${current} → ${next}（${kind}；自 ${tag} 起 breaking×${counts.major} feat×${counts.minor} fix/perf×${counts.patch}）${dry ? ' [dry-run]' : ''}`
  )
  return next
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dry = process.argv.includes('--dry')
  bumpVersion(process.cwd(), { dry })
    .then((v) => console.log(v))
    .catch((err) => {
      console.error('[version] failed:', err.message)
      process.exit(1)
    })
}
