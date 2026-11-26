// 旧配置清洗冒烟：settings.json 里残留已移除模型服务（GLM）的段——provider / profiles / apiKeys / routing——
// 加载时只在内存里剔除：不改名 .corrupt、不动磁盘文件，resolveAuth 对残留数据不抛异常；
// 合法的配置（含干净的 DeepSeek 配置）原样生效。不起服务，直接打 dist 里的模块。
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { removeTempDir } from './temp-dir.mjs'

const root = process.cwd()
const DATA = mkdtempSync(join(tmpdir(), 'nm-config-smoke-'))
// 数据目录按环境变量解析：必须在 import config 模块之前设定
process.env.NM_DATA_DIR = DATA
const config = await import(pathToFileURL(join(root, 'dist/main/config.js')).href)
const { SettingsPatchSchema } = await import(
  pathToFileURL(join(root, 'dist/shared/contract.js')).href
)

let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}

// 截获 config 的清洗日志，既断言它说清了情况，也原样打出来给人看措辞
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args.map(String).join(' '))

/** 写入一份 settings.json 后重新加载：initConfig() 是启动序列的入口，会清掉缓存、下次访问时重读磁盘 */
const boot = (settings, dir = DATA) => {
  process.env.NM_DATA_DIR = dir
  const file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify(settings, null, 2))
  warnings.length = 0
  config.initConfig()
  return readFileSync(file, 'utf8')
}
const settingsFile = () => join(process.env.NM_DATA_DIR, 'settings.json')
const SLOTS = ['director', 'writer', 'reviewer', 'utility']
/** 逐个槽解析，返回抛错的槽名（空数组 = 全部正常） */
const resolveAll = () =>
  SLOTS.filter((slot) => {
    try {
      config.resolveAuth(slot)
      return false
    } catch {
      return true
    }
  })

const DEEPSEEK = {
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-v4-pro',
  customModels: ''
}

try {
  // ── 旧配置： provider 选着 glm，profiles / apiKeys 留有 glm 段，导演槽指向 glm ──────────
  console.log('\n[1] 旧配置（GLM 残留）')
  const legacyDisk = boot({
    server: { port: 3979 },
    provider: 'glm',
    profiles: {
      glm: {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: 'glm-4.6',
        customModels: ''
      },
      deepseek: DEEPSEEK
    },
    apiKeys: { glm: 'leftover-glm-key', deepseek: 'sk-deepseek-test' },
    routing: { director: { provider: 'glm', model: 'glm-4.6' } }
  })
  const view = config.viewSettings()
  const log = warnings.join('\n')

  ok(
    'settings.json 没有被改名 .corrupt',
    existsSync(settingsFile()) &&
      !readdirSync(DATA).some((f) => f.includes('corrupt')) &&
      readdirSync(DATA).length === 1
  )
  ok('磁盘上的文件一字未动（清洗只在内存里）', readFileSync(settingsFile(), 'utf8') === legacyDisk)
  ok('端口等其它设置照常生效', config.getPort() === 3979)
  ok('provider 回落到 deepseek', view.provider === 'deepseek')
  ok(
    'profiles 不再有 glm',
    !('glm' in view.profiles) && Object.keys(view.profiles).sort().join() === 'custom,deepseek'
  )
  ok(
    'deepseek 的 profile 原样保留',
    view.profiles.deepseek.baseUrl === DEEPSEEK.baseUrl &&
      view.profiles.deepseek.defaultModel === DEEPSEEK.defaultModel
  )
  ok(
    'apiKeys 不再有 glm',
    config.apiKey('glm') === '' && config.apiKey('deepseek') === 'sk-deepseek-test'
  )
  ok('routing.director 被清掉', Object.keys(view.routing).length === 0)
  ok(
    '写了一条日志：哪个槽、指向谁、为什么清',
    log.includes('「director」') &&
      log.includes('「glm」') &&
      log.includes('不在可选范围') &&
      log.includes('默认模型')
  )
  console.log(`    日志：${log}`)
  ok('四个模型槽的 resolveAuth 都不抛错', resolveAll().length === 0)
  const auth = config.resolveAuth('director')
  ok(
    '导演槽解析到 DeepSeek：地址、模型、Key 都是 deepseek 的',
    auth.provider === 'deepseek' &&
      auth.baseUrl === DEEPSEEK.baseUrl &&
      auth.model === DEEPSEEK.defaultModel &&
      auth.apiKey === 'sk-deepseek-test'
  )
  // 清洗只在内存里，要等下次保存设置才写回：存一次空改动，看落盘的内容
  config.saveSettings({})
  const saved = JSON.parse(readFileSync(settingsFile(), 'utf8'))
  ok(
    '下次保存设置时才把清洗结果写回磁盘',
    saved.provider === 'deepseek' &&
      !('glm' in saved.profiles) &&
      !('glm' in saved.apiKeys) &&
      saved.apiKeys.deepseek === 'sk-deepseek-test' &&
      Object.keys(saved.routing).length === 0 &&
      saved.server.port === 3979
  )

  // ── 混合路由：合法的槽保留，指向 glm 的槽回退到导演槽 ──────────────────────────────
  console.log('\n[2] 混合路由（合法槽 + 指向 glm 的槽）')
  boot({
    server: { port: 3979 },
    provider: 'deepseek',
    profiles: { deepseek: { ...DEEPSEEK, defaultModel: 'deepseek-chat' } },
    apiKeys: { deepseek: 'sk-deepseek-test' },
    routing: {
      director: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      writer: { provider: 'glm', model: 'glm-4.6' },
      reviewer: { provider: 'custom', model: 'local-model' }
    }
  })
  const director = config.resolveAuth('director')
  const writer = config.resolveAuth('writer')
  const reviewer = config.resolveAuth('reviewer')
  ok(
    '合法的槽原样保留',
    director.model === 'deepseek-v4-pro' &&
      reviewer.provider === 'custom' &&
      reviewer.model === 'local-model'
  )
  ok(
    '指向 glm 的槽回退到导演槽',
    writer.provider === 'deepseek' && writer.model === 'deepseek-v4-pro'
  )
  ok(
    'routing 只剩合法的槽',
    Object.keys(config.viewSettings().routing).sort().join() === 'director,reviewer'
  )
  ok('日志点名 writer 槽', warnings.join('\n').includes('「writer」'))
  ok('四个模型槽的 resolveAuth 都不抛错', resolveAll().length === 0)

  // ── 干净的 DeepSeek 配置：完全不受影响 ──────────────────────────────────────────
  console.log('\n[3] 干净的 DeepSeek 配置')
  const clean = {
    server: { port: 3979 },
    provider: 'deepseek',
    profiles: { deepseek: { ...DEEPSEEK, customModels: 'deepseek-chat, deepseek-reasoner' } },
    apiKeys: { deepseek: 'sk-clean-12345678' },
    routing: { reviewer: { provider: 'deepseek', model: 'deepseek-reasoner' } }
  }
  boot(clean)
  const cleanView = config.viewSettings()
  ok(
    'provider / profile / Key / 路由逐项一致',
    cleanView.provider === 'deepseek' &&
      JSON.stringify(cleanView.profiles.deepseek) === JSON.stringify(clean.profiles.deepseek) &&
      config.apiKey('deepseek') === 'sk-clean-12345678' &&
      JSON.stringify(cleanView.routing) === JSON.stringify(clean.routing) &&
      config.getPort() === 3979
  )
  ok(
    '各槽按配置解析',
    config.resolveAuth('director').model === 'deepseek-v4-pro' &&
      config.resolveAuth('reviewer').model === 'deepseek-reasoner'
  )
  ok('没有任何清洗日志', warnings.length === 0)

  // ── 全新安装：没有 settings.json 时的默认服务 ────────────────────────────────────
  console.log('\n[4] 全新安装')
  process.env.NM_DATA_DIR = join(DATA, 'fresh')
  warnings.length = 0
  config.initConfig()
  ok(
    '默认服务是 DeepSeek',
    config.viewSettings().provider === 'deepseek' && existsSync(settingsFile())
  )
  ok('没有清洗日志', warnings.length === 0)

  // ── 契约：已移除的服务不能再保存 ────────────────────────────────────────────────
  console.log('\n[5] 契约')
  ok(
    '旧版 APP 传来 provider:"glm" 会被拒绝',
    !SettingsPatchSchema.safeParse({ provider: 'glm' }).success
  )
  ok(
    '现有服务的保存不受影响',
    SettingsPatchSchema.safeParse({
      provider: 'deepseek',
      profiles: { deepseek: { baseUrl: 'https://api.deepseek.com' } }
    }).success
  )
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  console.warn = originalWarn
  await removeTempDir(DATA)
}

console.log(`\n[配置清洗冒烟] ${failed ? `失败 ×${failed}` : '全部通过'}`)
process.exitCode = failed ? 1 : 0
