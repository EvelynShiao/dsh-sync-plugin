'use strict'

/* [exp/text-export 9999.9.44-exp.2] C 车道：sqlite 确定序 JSONL 导出/重建（实验，默认关）
 * exp.2：重建库连接关闭 FK 强制（node:sqlite 默认开，字母序插行子表先于父表必炸），
 *        返回值带 foreign_key_check 画像——live 库悬空引用（宿主 FK 关闭删父行所留）忠实还原。
 *
 * 为什么：2026-11-16 探针（sqlite-delta-probe.mjs）显示逻辑级 diff 对 sqlite 物理页噪声
 * 免疫——knowledge 零变化时 JSONL 字节相同=真传 0，而 raw 直进 git 依赖二进制 delta 对
 * 页噪声的容忍度。本车道是 main（9999.9.43 raw 直进 git）的实验后手，不与 main 并线。
 *
 * JSONL 行格式 v1（每行一 JSON，UTF-8，\n 分隔，表名序+rowid 序，字节级确定）：
 *   {"k":"ddl","type":"table|view|index|trigger","name":..,"sql":"CREATE ..."} 先行
 *   {"k":"row","t":<表名>,"r":{col:val}} 其后（BLOB→{"__b64":..}；大 INTEGER→字符串）
 * FTS5 影子表整族不导（_fts 命中）——宿主 initFts 会按 tokenizer 版本自动重建。
 * sqlite_sequence（AUTOINCREMENT 计数）不导——INTEGER PRIMARY KEY=rowid 别名天然续号。
 *
 * 重建：全新临时库按 DDL 建对象→逐行 INSERT→交上层 sqliteHealthyBuf integrity 门→落地。
 */

const fs = require('node:fs')
const fsP = require('node:fs/promises')
const { DatabaseSync } = require('node:sqlite')

const FTS_SHADOW = /_fts/

function dumpRows(db, table) {
  let rows
  try { rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() } catch { rows = db.prepare(`SELECT * FROM "${table}"`).all() }
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (r[k] instanceof Uint8Array) r[k] = { __b64: Buffer.from(r[k]).toString('base64') }
      else if (typeof r[k] === 'bigint') r[k] = String(r[k])
    }
  }
  return rows
}

async function exportSqliteJsonl(livePath, outPath) {
  const db = new DatabaseSync(livePath, { readOnly: true })
  try {
    const objs = db.prepare(`SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`).all()
    // DDL 输出顺序：table → view → index → trigger（依赖方向），同名组内按名字序=确定性
    const rank = { table: 0, view: 1, index: 2, trigger: 3 }
    const ddls = objs
      .filter(o => o.sql && !FTS_SHADOW.test(o.name) && rank[o.type] !== undefined)
      .sort((a, b) => (rank[a.type] - rank[b.type]) || (a.name < b.name ? -1 : 1))
    const tables = objs.filter(o => o.type === 'table' && !FTS_SHADOW.test(o.name)).map(o => o.name).sort()
    const chunks = []
    for (const d of ddls) chunks.push(JSON.stringify({ k: 'ddl', type: d.type, name: d.name, sql: d.sql }))
    let rowCount = 0
    for (const t of tables) {
      for (const r of dumpRows(db, t)) { chunks.push(JSON.stringify({ k: 'row', t, r })); rowCount++ }
    }
    await fsP.writeFile(outPath, chunks.join('\n'))
    return { lines: chunks.length, tables: tables.length, rows: rowCount }
  } finally { db.close() }
}

function rebuildSqliteFromJsonl(jsonlPath, outPath) {
  try { fs.rmSync(outPath, { force: true }) } catch {}
  try { fs.rmSync(outPath + '-wal', { force: true }) } catch {}
  try { fs.rmSync(outPath + '-shm', { force: true }) } catch {}
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)
  // FK 强制必须关（9999.9.44-exp.2）：node:sqlite 默认 enableForeignKeyConstraints=true，
  // 而行按表名字母序插，子表（memories/task_context_marks 等）会先于父表（memory_directories/tasks）
  // 落库 → FOREIGN KEY constraint failed。schema 里 REFERENCES 定义原样保留，落地前 foreign_key_check 画像随返回值带出。
  const db = new DatabaseSync(outPath, { enableForeignKeyConstraints: false })
  try {
    for (const line of lines) {
      const o = JSON.parse(line)
      if (o.k === 'ddl') db.exec(o.sql)
    }
    let n = 0
    for (const line of lines) {
      const o = JSON.parse(line)
      if (o.k !== 'row') continue
      const cols = Object.keys(o.r)
      if (!cols.length) continue
      const vals = cols.map(c => {
        const v = o.r[c]
        return (v && typeof v === 'object' && v.__b64 !== undefined) ? Buffer.from(v.__b64, 'base64') : v
      })
      db.prepare(`INSERT INTO "${o.t}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals)
      n++
    }
    const fkBad = db.prepare('PRAGMA foreign_key_check').all()
    return { lines: lines.length, rows: n, fkViolations: fkBad.length, fkDetail: fkBad.slice(0, 20) }
  } finally { db.close() }
}

module.exports = { exportSqliteJsonl, rebuildSqliteFromJsonl }
