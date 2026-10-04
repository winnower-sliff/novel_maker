#!/usr/bin/env node
// 一次性迁移：世界观条目正文里的 [[人物名]] 反向链接改为纯文本，并把关系短语原样平移到
// 对应人物卡文末「关联：」行（正向 [[世界观标题|关系]]）。链接方向纪律：人物→世界观单向。
// 用法：默认 dry-run 只打印清单；node scripts/fix-wb-char-links.mjs --apply 实际写入（先自动备份 db）。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const apply = process.argv.includes('--apply')
const userData =
  process.env.NM_USER_DATA ?? join(homedir(), 'AppData', 'Roaming', 'novel-maker')
const dbPath = join(userData, 'data', 'novel.db')
if (!existsSync(dbPath)) {
  console.error(`[migrate] 找不到数据库：${dbPath}`)
  process.exit(1)
}

if (apply) {
  const backupDir = join(userData, 'data', 'backup')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupDir, `novel.db.bak-${stamp}`)
  copyFileSync(dbPath, backupPath)
  console.log(`[migrate] 已备份 → ${backupPath}`)
}

const db = new DatabaseSync(dbPath)
const LINK_RE = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g

const chars = db.prepare('SELECT id, project_id, name, card FROM characters').all()
const wbRows = db.prepare('SELECT id, project_id, title, content FROM worldbuild').all()

// 同项目内按人物名精确索引（与 graph nameIndex 同规则：只认 name）
const charsByProject = new Map()
for (const c of chars) {
  if (!charsByProject.has(c.project_id)) charsByProject.set(c.project_id, new Map())
  charsByProject.get(c.project_id).set(c.name, c)
}

// 人物待追加的关联项：charId -> { byTarget: Map<标题, rel>, order: [] }
const charLinks = new Map()
const addCharLink = (charId, title, rel) => {
  if (!charLinks.has(charId)) charLinks.set(charId, { byTarget: new Map(), order: [] })
  const entry = charLinks.get(charId)
  if (entry.byTarget.has(title)) return
  entry.byTarget.set(title, rel)
  entry.order.push({ title, rel })
}

let wbChanged = 0
const wbLog = []
for (const wb of wbRows) {
  const byName = charsByProject.get(wb.project_id)
  if (!byName || !wb.content) continue
  let hit = false
  const next = wb.content.replace(LINK_RE, (full, rawName, rawRel) => {
    const name = rawName.trim()
    const rel = (rawRel ?? '').trim()
    const ch = byName.get(name)
    if (!ch) return full // 无对应人物（含 dangling）不动
    hit = true
    addCharLink(ch.id, wb.title, rel)
    wbLog.push(`  ${wb.title}：${full} → ${rel ? `${name}（${rel}）` : name} ⇒ ${ch.name} 卡 +[[${wb.title}${rel ? `|${rel}` : ''}]]`)
    return rel ? `${name}（${rel}）` : name
  })
  if (hit) {
    wbChanged++
    if (apply) db.prepare('UPDATE worldbuild SET content = ? WHERE id = ?').run(next, wb.id)
  }
}

let charChanged = 0
const charLog = []
for (const [charId, entry] of charLinks) {
  const ch = chars.find((c) => c.id === charId)
  const additions = entry.order
    .filter(({ title }) => !ch.card.includes(`[[${title}`)) // 已有同目标链接去重跳过
  if (additions.length === 0) continue
  const addLine = `关联：${additions.map(({ title, rel }) => `[[${title}${rel ? `|${rel}` : ''}]]`).join('、')}`
  const relLine = /^关联：.*$/m.exec(ch.card)
  let next
  if (relLine) {
    next = ch.card.replace(relLine[0], `${relLine[0]}、${addLine.replace('关联：', '')}`)
  } else {
    next = `${ch.card.replace(/\s+$/, '')}\n\n${addLine}\n`
  }
  charChanged++
  charLog.push(`  ${ch.name}：+ ${additions.map(({ title }) => `[[${title}]]`).join('、')}`)
  if (apply) db.prepare('UPDATE characters SET card = ? WHERE id = ?').run(next, ch.id)
}

console.log(`[migrate] 世界观反向链接：${wbChanged} 条目受影响`)
for (const l of wbLog) console.log(l)
console.log(`[migrate] 人物卡关联行：${charChanged} 人物受影响`)
for (const l of charLog) console.log(l)
if (!apply) console.log('[migrate] dry-run 未写库；确认无误后加 --apply 执行（会先自动备份）')
db.close()
