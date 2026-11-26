// 接口边界冒烟：未知通道 / 已拆除的通道 / 参数不符 / 请求体损坏——手机端靠这些状态码区分「调用错了」和「服务挂了」
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir, stopChild } from './temp-dir.mjs'

const PORT = 3981
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'nm-contract-smoke-'))
writeFileSync(join(DATA, 'settings.json'), JSON.stringify({ server: { port: PORT } }))

const server = spawn(process.execPath, ['dist/main/index.js'], {
  env: { ...process.env, NM_DATA_DIR: DATA },
  stdio: 'inherit'
})
let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}
/** 发原始请求体，返回 { status, body }——不经 invoke() 的成功检查 */
const post = async (channel, rawBody) => {
  const r = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

try {
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/api/health`)).ok
    } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 250))
  }
  ok('服务就绪', up)

  const unknown = await post('nope:whatever', '{"args":[]}')
  ok('未知通道 404', unknown.status === 404)
  ok('错误体点明是未知接口', String(unknown.body.error).includes('未知接口'))

  for (const gone of ['llm:chat', 'llm:abort', 'llm:poll']) {
    const r = await post(gone, '{"args":[]}')
    ok(`已拆除的通道 ${gone} 仍是不存在（404）`, r.status === 404)
  }

  const bad = await post('book:get', '{"args":[123]}')
  ok('参数类型不符 400', bad.status === 400)
  ok('错误体指出是参数校验', String(bad.body.error).includes('参数校验失败'))

  const broken = await post('book:list', '{"args": [')
  ok('请求体不是合法 JSON 时 400（不崩）', broken.status === 400)

  const after = await fetch(`${BASE}/api/health`)
  ok('以上请求之后服务仍正常', after.ok)
} catch (e) {
  ok(`异常：${e.message}`, false)
} finally {
  await stopChild(server)
  await removeTempDir(DATA)
}
console.log(`\n[接口边界冒烟] ${failed ? `失败 ×${failed}` : '全部通过'}`)
process.exitCode = failed ? 1 : 0
