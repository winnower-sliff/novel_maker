// 范文导入冒烟：手机端分片上传（UTF-8 / GBK / UTF-16 编码识别、重名另存、大文件、分片协议）、
// 电脑端 imports 文件夹老路、老库里的范文与绑定在升级后还在。无 LLM，端口 3970。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { removeTempDir, stopChild } from './temp-dir.mjs'

const PORT = 3970
const BASE = `http://127.0.0.1:${PORT}`
const root = fileURLToPath(new URL('..', import.meta.url))
const DATA = mkdtempSync(join(tmpdir(), 'nm-sample-upload-'))
writeFileSync(join(DATA, 'settings.json'), JSON.stringify({ server: { port: PORT } }))
/** 与契约 SAMPLE_UPLOAD.chunkBytes 同值：按它切片，大文件才会真的走多片 */
const CHUNK = 1024 * 1024

/**
 * 「升级前」的表结构：v4.7.0 时的样子，故意写死在这里而不引用 dist——以后再改表，
 * 这套冒烟验证的仍然是「带着旧范文数据的老库，被新代码打开后数据还在」。
 * 只建与范文有关的三张表，其余表由服务启动时照常补建。
 */
const OLD_DDL = `
CREATE TABLE books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  intro TEXT DEFAULT '',
  genre TEXT DEFAULT '',
  style_name TEXT DEFAULT '',
  style_sample TEXT DEFAULT '',
  style_notes TEXT DEFAULT '',
  target_words INTEGER DEFAULT 2000,
  redlines TEXT DEFAULT '[]',
  positive_words TEXT DEFAULT '[]',
  negative_words TEXT DEFAULT '[]',
  plan_mode INTEGER DEFAULT 0,
  active_line_id TEXT DEFAULT '',
  archived INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0,
  style_sample_source TEXT DEFAULT '',
  sample_sources TEXT DEFAULT '[]'
);
CREATE TABLE samples (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  chars INTEGER DEFAULT 0,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sample_sections (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  chars INTEGER NOT NULL
);
CREATE INDEX idx_sections_sample ON sample_sections(sample_id, start);
`

const para = (n) =>
  `码头的雾在半夜最重，少年把刀拢进怀里，听见木板上的脚步声由远及近，第${n}次数错了台阶。`
/** 三章的小范文：每章都超过「太薄不算一节」的 50 字门槛 */
const TEXT = [
  '测试范文',
  '',
  '第一章 夜港',
  '',
  para(1),
  para(2),
  '',
  '第二章 渡海',
  '',
  para(3),
  para(4),
  '',
  '第三章 旧账',
  '',
  para(5),
  para(6)
].join('\n')
/** 一段 GBK 编码的中文（「第一章 夜港\n少年的书人。」的 GBK 字节，Node 只能解 GBK 不能编，写死字节） */
const GBK_TEXT = '第一章 夜港\n少年的书人。'
const GBK_BYTES = Buffer.from('b5dad2bbd5c220d2b9b8db0ac9d9c4eab5c4cae9c8cba1a3', 'hex')
const swap16 = (b) => {
  const even = b.subarray(0, b.length - (b.length % 2))
  const out = Buffer.from(even)
  out.swap16()
  return out
}
/** 一百五十多万字的长篇：2000 章，UTF-8 下近 5 MB，要传 5 片 */
const bigText = () => {
  const out = []
  for (let i = 1; i <= 2000; i++) {
    out.push('', `第${i}章 试炼`, '')
    for (let p = 0; p < 12; p++) {
      out.push(`${para(i * 10 + p)}风从海面上吹过来，带着咸味，他想起师父说过的那些话。`)
    }
  }
  return out.join('\n')
}

// ── 造一个「升级前」的老库：一本旧范文（带两章的节）+ 一本绑定了它的书 ──────────
const OLD_TEXT = [
  '旧范文',
  '',
  '第一章 旧事',
  '',
  para(11),
  para(12),
  '',
  '第二章 旧账',
  '',
  para(13),
  para(14)
].join('\n')
const now = Date.now()
const oldDb = new DatabaseSync(join(DATA, 'novel.db'))
oldDb.exec(OLD_DDL)
oldDb
  .prepare(
    'INSERT INTO books (id, title, draft, archived, sample_sources, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?)'
  )
  .run('old-book', '老书', JSON.stringify(['old-sample']), now, now)
oldDb
  .prepare('INSERT INTO samples (id, name, chars, content, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('old-sample', '旧范文', OLD_TEXT.length, OLD_TEXT, now)
const secIns = oldDb.prepare(
  'INSERT INTO sample_sections (id, sample_id, kind, label, start, end, chars) VALUES (?, ?, ?, ?, ?, ?, ?)'
)
const s1 = OLD_TEXT.indexOf('第一章 旧事')
const s2 = OLD_TEXT.indexOf('第二章 旧账')
secIns.run('old-sec-1', 'old-sample', 'chapter', '第一章 旧事', s1, s2, s2 - s1)
secIns.run(
  'old-sec-2',
  'old-sample',
  'chapter',
  '第二章 旧账',
  s2,
  OLD_TEXT.length,
  OLD_TEXT.length - s2
)
oldDb.exec('PRAGMA user_version = 1')
oldDb.close()

mkdirSync(join(DATA, 'imports'), { recursive: true })
writeFileSync(join(DATA, 'imports', '旧站下载.txt'), GBK_BYTES)
writeFileSync(join(DATA, 'imports', '旧范文.txt'), TEXT)

const server = spawn(process.execPath, ['dist/main/index.js'], {
  cwd: root,
  env: { ...process.env, NM_DATA_DIR: DATA },
  stdio: 'inherit'
})
let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}
const post = async (channel, ...args) => {
  const r = await fetch(`${BASE}/api/invoke/${channel}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args })
  })
  return { status: r.status, body: await r.json() }
}
const invoke = async (channel, ...args) => {
  const { status, body } = await post(channel, ...args)
  if (status !== 200) throw new Error(`${channel} ${status} ${JSON.stringify(body)}`)
  return body.result
}
/** 模拟手机端：按片上传，返回入库结果 */
const uploadBytes = async (fileName, bytes, chunk = CHUNK) => {
  const total = Math.ceil(bytes.length / chunk)
  const { uploadId } = await invoke('sample:uploadBegin', fileName, total)
  for (let i = 0; i < total; i++) {
    await invoke(
      'sample:uploadChunk',
      uploadId,
      i,
      bytes.subarray(i * chunk, (i + 1) * chunk).toString('base64')
    )
  }
  return invoke('sample:uploadFinish', uploadId)
}
const waitReady = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server 未就绪')
}
/** 取整本正文（readText 单次上限 10000，分段拼回） */
const fullText = async (id, chars) => {
  let out = ''
  while (out.length < chars) out += (await invoke('sample:readText', id, out.length, 10000)).text
  return out
}
const byName = async (name) => (await invoke('sample:list')).find((x) => x.name === name)

try {
  await waitReady()
  ok('服务就绪', true)

  // ① 老库里的范文、章节、绑定都在
  const oldListed = await byName('旧范文')
  ok(
    `老库范文还在（${oldListed?.chars} 字 · ${oldListed?.chapterCount} 章）`,
    oldListed?.id === 'old-sample' &&
      oldListed.chars === OLD_TEXT.length &&
      oldListed.chapterCount === 2 &&
      oldListed.preview === OLD_TEXT.slice(0, 120)
  )
  const oldSecs = await invoke('sample:sections', 'old-sample')
  ok(
    '老库的章节切分原样保留',
    oldSecs.length === 2 &&
      oldSecs[0].label === '第一章 旧事' &&
      oldSecs[0].start === s1 &&
      oldSecs[1].start === s2 &&
      oldSecs[1].end === OLD_TEXT.length
  )
  ok('老库范文正文一字不差', (await fullText('old-sample', OLD_TEXT.length)) === OLD_TEXT)
  const oldBook = (await invoke('book:list')).find((b) => b.id === 'old-book')
  ok(
    '老库的书的范文绑定还在',
    JSON.stringify(oldBook?.sampleSources) === JSON.stringify(['old-sample']) &&
      oldBook?.styleSampleSource === ''
  )

  // ② 编码识别：UTF-8（带 / 不带 BOM）
  const utf8 = await uploadBytes('编码-utf8.txt', Buffer.from(TEXT, 'utf8'))
  ok(
    `UTF-8 无 BOM（${utf8.chars} 字 · ${utf8.chapterCount} 章）`,
    utf8.chars === TEXT.length && utf8.chapterCount === 3
  )
  ok('UTF-8 无 BOM 正文一致', (await fullText(utf8.id, utf8.chars)) === TEXT)
  ok(
    '导入结果不带「原书名」（没另存）',
    utf8.name === '编码-utf8' && utf8.originalName === undefined
  )
  const utf8Bom = await uploadBytes(
    '编码-utf8-bom.txt',
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, 'utf8')])
  )
  ok(
    'UTF-8 带 BOM：BOM 去掉',
    utf8Bom.chars === TEXT.length && (await fullText(utf8Bom.id, utf8Bom.chars)) === TEXT
  )
  const emojiText = `第一章 表情\n这是一段带表情的正文：😀🎉 中文。\n${para(1)}\n${para(2)}`
  const emoji = await uploadBytes('表情.txt', Buffer.from(emojiText, 'utf8'))
  ok('UTF-8 四字节字符不被误判', emoji.chars === emojiText.length)

  // ③ GBK / GB18030 兜底
  const gbk = await uploadBytes('旧站下载.txt', GBK_BYTES)
  ok(
    `GBK 自动识别（${JSON.stringify(gbk.preview)}）`,
    gbk.chars === GBK_TEXT.length &&
      gbk.preview === GBK_TEXT &&
      (await fullText(gbk.id, gbk.chars)) === GBK_TEXT
  )

  // ④ UTF-16：带 BOM 的 LE / BE，以及没带 BOM 的 LE
  const utf16le = await uploadBytes(
    'utf16le.txt',
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, 'utf16le')])
  )
  ok(
    'UTF-16 LE 带 BOM',
    utf16le.chars === TEXT.length && (await fullText(utf16le.id, utf16le.chars)) === TEXT
  )
  const utf16be = await uploadBytes(
    'utf16be.txt',
    Buffer.concat([Buffer.from([0xfe, 0xff]), swap16(Buffer.from(TEXT, 'utf16le'))])
  )
  ok(
    'UTF-16 BE 带 BOM',
    utf16be.chars === TEXT.length && (await fullText(utf16be.id, utf16be.chars)) === TEXT
  )
  const utf16bare = await uploadBytes('utf16-bare.txt', Buffer.from(TEXT, 'utf16le'))
  ok(
    'UTF-16 LE 没带 BOM 也能认出',
    utf16bare.chars === TEXT.length && (await fullText(utf16bare.id, utf16bare.chars)) === TEXT
  )

  // ⑤ 重名另存，不覆盖
  const first = await uploadBytes('重名.txt', Buffer.from(TEXT, 'utf8'))
  const firstId = first.id
  const second = await uploadBytes('重名.txt', Buffer.from(TEXT, 'utf8'))
  const third = await uploadBytes('重名.txt', Buffer.from(TEXT, 'utf8'))
  ok(
    `重名另存为「名（2）」「名（3）」（${second.name} / ${third.name}）`,
    first.name === '重名' &&
      second.name === '重名（2）' &&
      second.originalName === '重名' &&
      third.name === '重名（3）'
  )
  ok(
    '另存不动原来那本',
    second.id !== firstId &&
      (await byName('重名'))?.id === firstId &&
      (await fullText(firstId, first.chars)) === TEXT &&
      (await invoke('sample:sections', firstId)).length === 3
  )
  // 与老库范文重名：老的还在、绑定不漂移
  const dup = await uploadBytes('旧范文.txt', Buffer.from(TEXT, 'utf8'))
  ok(
    '与老库范文重名也只另存',
    dup.name === '旧范文（2）' &&
      dup.originalName === '旧范文' &&
      (await fullText('old-sample', OLD_TEXT.length)) === OLD_TEXT &&
      (await invoke('sample:sections', 'old-sample')).length === 2 &&
      JSON.stringify(
        (await invoke('book:list')).find((b) => b.id === 'old-book')?.sampleSources
      ) === JSON.stringify(['old-sample'])
  )
  const rebound = await invoke('sample:attach', 'old-book', ['old-sample', dup.id])
  ok(
    '老库的书可以再绑上新导入的范文',
    rebound.sampleSources.length === 2 && rebound.sampleSources[1] === dup.id
  )

  // ⑥ 大文件：多片上传、跨片的多字节字符拼回
  const big = bigText()
  const bigBytes = Buffer.from(big, 'utf8')
  const bigChunks = Math.ceil(bigBytes.length / CHUNK)
  const t0 = Date.now()
  const bigRes = await uploadBytes('长篇.txt', bigBytes)
  const bigMs = Date.now() - t0
  ok(
    `${(bigBytes.length / 1048576).toFixed(1)} MB 长篇分 ${bigChunks} 片上传（${(big.length / 10000).toFixed(1)} 万字 · ${bigRes.chapterCount} 章 · ${bigMs} ms）`,
    bigChunks >= 4 && bigRes.chars === big.length && bigRes.chapterCount === 2000
  )
  ok('长篇结尾一章读得到', (await fullText(bigRes.id, bigRes.chars)).endsWith(big.slice(-100)))
  const medium = big.slice(0, 30000)
  const mediumRes = await uploadBytes('切片.txt', Buffer.from(medium, 'utf8'), 2048)
  ok(
    `小片切片（2048 字节一片）拼回不缺字（${mediumRes.chars} 字）`,
    mediumRes.chars === medium.length && (await fullText(mediumRes.id, mediumRes.chars)) === medium
  )

  // ⑦ 分片协议：乱序、早收尾、失效、重发、放弃
  const proto = Buffer.from(TEXT, 'utf8')
  const p1 = await invoke('sample:uploadBegin', '协议.txt', 2)
  await invoke('sample:uploadChunk', p1.uploadId, 0, proto.toString('base64'))
  const again = await invoke('sample:uploadChunk', p1.uploadId, 0, proto.toString('base64'))
  ok('回执丢了重发同一片：不重复追加', again.received === 1)
  const early = await post('sample:uploadFinish', p1.uploadId)
  ok('没传完就收尾被拒', early.status === 400 && early.body.error.includes('没有传完'))
  const gone = await post('sample:uploadChunk', p1.uploadId, 1, proto.toString('base64'))
  ok('被拒的会话已作废', gone.status === 400 && gone.body.error.includes('上传已失效'))
  const p2 = await invoke('sample:uploadBegin', '协议.txt', 2)
  const wrong = await post('sample:uploadChunk', p2.uploadId, 1, proto.toString('base64'))
  ok('跳片被拒', wrong.status === 400 && wrong.body.error.includes('上传顺序不对'))
  const badB64 = await post('sample:uploadBegin', '协议.txt', 1).then((r) =>
    post('sample:uploadChunk', r.body.result.uploadId, 0, '!!!not-base64!!!')
  )
  ok('不是 base64 的片被拒', badB64.status === 400 && badB64.body.error.includes('不完整'))
  const p3 = await invoke('sample:uploadBegin', '协议.txt', 1)
  ok('中途放弃：丢掉半截数据', (await invoke('sample:uploadAbort', p3.uploadId)) === true)
  ok(
    '放弃后收尾被拒',
    (await post('sample:uploadFinish', p3.uploadId)).body.error.includes('上传已失效')
  )
  const tooMany = await post('sample:uploadBegin', '协议.txt', 100000)
  ok('片数超过上限被契约拦下', tooMany.status === 400)

  // ⑧ 空文件不入库
  const blank = await invoke('sample:uploadBegin', '空的.txt', 1)
  await invoke('sample:uploadChunk', blank.uploadId, 0, Buffer.from('  \n').toString('base64'))
  const blankDone = await post('sample:uploadFinish', blank.uploadId)
  ok('只有空白的文件不入库', blankDone.status === 400 && blankDone.body.error.includes('是空的'))

  // ⑨ 电脑端 imports 文件夹的老路：同样识别编码、同样重名另存
  const dir = await invoke('sample:listDir')
  const gbkFile = dir.find((f) => f.fileName === '旧站下载.txt')
  ok(
    `imports 列表预览识别 GBK（${JSON.stringify(gbkFile?.preview)}）`,
    gbkFile?.preview.startsWith('第一章 夜港') && gbkFile.sizeBytes === GBK_BYTES.length
  )
  const fromDir = await invoke('sample:import', { fileName: '旧站下载.txt' })
  ok(
    'imports 文件夹导入 GBK 文件不再乱码',
    fromDir.chars === GBK_TEXT.length && (await fullText(fromDir.id, fromDir.chars)) === GBK_TEXT
  )
  const fromDirDup = await invoke('sample:import', { fileName: '旧范文.txt' })
  ok(
    'imports 文件夹导入重名也只另存',
    fromDirDup.name === '旧范文（3）' && fromDirDup.originalName === '旧范文'
  )

  // ⑩ 解码函数本体：HTTP 通路覆盖不到的边角（没带 BOM 的 BE、奇数长度、纯西文）
  process.env.NM_DATA_DIR = DATA
  const { decodeSampleBytes } = await import('../dist/main/samples.js')
  const le = Buffer.from('中文一\n', 'utf16le')
  const cases = [
    ['没带 BOM 的 UTF-16 BE', swap16(le), 'utf-16be', '中文一\n'],
    ['没带 BOM 的 UTF-16 LE（含「一」）', le, 'utf-16le', '中文一\n'],
    [
      '纯西文的 UTF-16 LE 没带 BOM',
      Buffer.from('Chapter 1\nIt was a dark night.\n', 'utf16le'),
      'utf-16le',
      'Chapter 1\nIt was a dark night.\n'
    ],
    [
      'UTF-16 BOM 后面多出半个字符',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab', 'utf16le'), Buffer.from([0x61])]),
      'utf-16le',
      'ab'
    ],
    ['GBK', GBK_BYTES, 'gb18030', GBK_TEXT],
    [
      '带 BOM 的 UTF-8',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('正文', 'utf8')]),
      'utf-8',
      '正文'
    ],
    ['空文件', Buffer.alloc(0), 'utf-8', '']
  ]
  for (const [name, bytes, encoding, text] of cases) {
    const r = decodeSampleBytes(bytes)
    ok(`decode：${name}`, r.encoding === encoding && r.text === text)
  }
} catch (e) {
  ok(`异常：${e instanceof Error ? e.message : String(e)}`, false)
} finally {
  await stopChild(server)
  await removeTempDir(DATA)
}
console.log(`\n[范文导入冒烟] ${failed ? '失败' : '全部通过'}${failed ? ` ×${failed}` : ''}`)
process.exitCode = failed ? 1 : 0
