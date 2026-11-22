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
    /* [9999.9.50 性能根修] 全部写入包进单事务。旧版逐行 autocommit：每行一次隐式提交
       ≈ 一次刷盘，Android flash 上 13,590 行实测 203.9s（11-21「零变化下载仍卡 3 分钟」
       主犯之一）。包事务 + 回滚日志放内存后，同数据量实测降为个位数秒。临时库用完即弃
       （调用方 rm 后重建），进程中断留下的半成品无害。 */
    db.exec('PRAGMA journal_mode = MEMORY')
    db.exec('BEGIN')
    let n = 0
    try {
      for (const line of lines) {
        const o = JSON.parse(line)
        if (o.k === 'ddl') db.exec(o.sql)
      }
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
      db.exec('COMMIT')
    } catch (eTx) {
      try { db.exec('ROLLBACK') } catch {}
      throw eTx
    }
    const fkBad = db.prepare('PRAGMA foreign_key_check').all()
    return { lines: lines.length, rows: n, fkViolations: fkBad.length, fkDetail: fkBad.slice(0, 20) }
  } finally { db.close() }
}

/* ── [9999.9.50 fork 兜底升级] SQL 级整体替换：宿主在线时替代「整文件覆盖」的安全落地 ──
 * 背景（11-21 手机实锤）：PC 对共享 memory 车道做非 append-only 重写（改旧行）→
 * planSqliteJsonlDelta 返回 fork → 退回全量重建 → 落地必须整文件覆盖 live 主文件。
 * Windows 下 safeSqliteLanding 靠「rm -wal 失败=宿主在写」挡住；Android/Linux 的 unlink
 * 对打开中文件照样成功 → 守卫失效 → 宿主活着时主文件被覆盖 + WAL 被孤儿化（11-17 事故
 * 配方的平台变体，2026-11-21 16:50 手机实发，16:53 重启丢未 checkpoint 尾巴）。
 * 本函数与整文件覆盖语义一致（live := 云端 jsonl 全量，含行删除/行更新），但走 SQL：
 * 单事务 DELETE 全部导出表 + FTS 影子表 → 重插全部行 → COMMIT；任何一步失败 ROLLBACK，
 * live 原样无损。WAL 多连接并发安全，宿主在线可用，无需退出 DSH。
 * 前置条件：DDL 与 live 完全一致——调用方仅在 plan.reason 以 fork:/shrink: 开头（该判定
 * 在 ddl-diff 校验之后）或重建临时库已过 integrity 门时调用。FTS 影子表本就不导，
 * 清空后由宿主 initFts 自愈（与全量重建新建空 FTS 同语义）。 */
function sqlReplaceLiveFromJsonl(livePath, jsonlPath) {
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean)
  const db = new DatabaseSync(livePath, { enableForeignKeyConstraints: false })
  try {
    db.exec('PRAGMA busy_timeout=3000')
    // 删除集合 = 云端 DDL 里的全部表（含云端已清空的零行表）∪ 出现过行线的表
    const delTables = []
    const seen = new Set()
    for (const line of lines) {
      let o = null
      try { o = JSON.parse(line) } catch { continue }
      if (!o || o.k !== 'ddl' || o.type !== 'table' || !o.name || seen.has(o.name)) continue
      seen.add(o.name); delTables.push(o.name)
    }
    for (const line of lines) {
      let o = null
      try { o = JSON.parse(line) } catch { continue }
      if (!o || o.k !== 'row' || !o.t || seen.has(o.t)) continue
      seen.add(o.t); delTables.push(o.t)
    }
    /* FTS 影子族（与导出过滤同口径）一并清空：主表行全换后旧索引必脏。外部内容表可能
       拒绝直接 DELETE → 尽力清（失败不阻断），宿主 initFts 自愈兜底。 */
    let ftsTables = []
    try {
      ftsTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`).all().map(r => r.name).filter(n => /_fts/.test(n))
    } catch {}
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const t of ftsTables) { try { db.exec(`DELETE FROM "${t}"`) } catch {} }
      for (const t of delTables) db.exec(`DELETE FROM "${t}"`)
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
        db.prepare(`INSERT OR REPLACE INTO "${o.t}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals)
        n++
      }
      db.exec('COMMIT')
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
      return { rows: n, tables: delTables.length, ftsCleared: ftsTables.length }
    } catch (eTx) {
      try { db.exec('ROLLBACK') } catch {}
      throw eTx
    }
  } finally { try { db.close() } catch {} }
}

/* ── [差量化路线 §B 9999.9.46] sqlite 下载端差量落地（用户拍板「就该差量」，2026-11-17）──
 *
 * 为什么：rebuildSqliteFromJsonl 每轮下载全量重建（11689 行逐行 INSERT+integrity），
 * 手机写盘慢被放大。常态是 append-only：云端 jsonl 相对「上次已知状态」（lane-state 留档）
 * 只在表尾部追加新行 → 只把尾部新行 INSERT OR REPLACE 进 live 库即可，不再重建文件、
 * 不再覆盖主文件。任何不确定性（DDL 变化/中间行分叉/表收缩/留档缺失）→ 返回不可差量，
 * 调用方退回现有全量重建路径（保守兜底）。
 *
 * 前缀判定必须【按表分组】：导出行序=表名字母序×rowid 序，多表同时增长时
 * 整文件前缀必然断裂（tableA 新行会插在 tableB 旧行前面），逐表比前缀才是常态可成立的口径。
 * FTS 影子表本就不导（exportSqliteJsonl 过滤）→ 留档与云端同构，天然不参与 diff。
 */

/* 解析 jsonl 文本 → { ddlLines: [原始行], tableLines: { 表名: [原始行] } }。
   保留原始行字符串做逐行 === 比对（不 JSON.parse，11689 行解析成本省掉）。 */
function parseJsonlStructure(text) {
  const ddlLines = []
  const tableLines = {}
  for (const line of String(text || '').split('\n')) {
    if (!line) continue
    let o = null
    try { o = JSON.parse(line) } catch { ddlLines.push('\u0000BAD\u0000' + line); continue }
    if (o && o.k === 'ddl') ddlLines.push(line)
    else if (o && o.k === 'row' && typeof o.t === 'string') {
      (tableLines[o.t] = tableLines[o.t] || []).push(line)
    } else ddlLines.push('\u0000BAD\u0000' + line)
  }
  return { ddlLines, tableLines }
}

/* 差量判定：cloudText（云端 jsonl 全文）vs archiveText（留档全文）。
   返回 { ok: true, tail: [{ t, lines }] }（tail=各表超出留档的尾部行），
   或 { ok: false, reason }（调用方必须退回全量重建）。 */
function planSqliteJsonlDelta(cloudText, archiveText) {
  let cloud, arch
  try {
    cloud = parseJsonlStructure(cloudText)
    arch = parseJsonlStructure(archiveText)
  } catch (e) { return { ok: false, reason: 'parse: ' + String((e && e.message) || e) } }
  if (cloud.ddlLines.length !== arch.ddlLines.length) return { ok: false, reason: 'ddl-count ' + arch.ddlLines.length + '->' + cloud.ddlLines.length }
  for (let i = 0; i < cloud.ddlLines.length; i++) {
    if (cloud.ddlLines[i] !== arch.ddlLines[i]) return { ok: false, reason: 'ddl-diff@' + i }
  }
  for (const t of Object.keys(arch.tableLines)) {
    if (!cloud.tableLines[t]) return { ok: false, reason: 'table-removed:' + t }
  }
  const tail = []
  for (const t of Object.keys(cloud.tableLines)) {
    const cl = cloud.tableLines[t]
    const al = arch.tableLines[t] || []
    if (al.length > cl.length) return { ok: false, reason: 'shrink:' + t + ' ' + al.length + '->' + cl.length }
    for (let i = 0; i < al.length; i++) {
      if (al[i] !== cl[i]) return { ok: false, reason: 'fork:' + t + '@' + i }
    }
    if (cl.length > al.length) tail.push({ t, lines: cl.slice(al.length) })
  }
  return { ok: true, tail }
}

/* 差量应用：开 live 库（与宿主多连接并发安全，WAL 模式）逐行 INSERT OR REPLACE。
   调用方前置条件：sqliteHealthy(livePath) 已通过。
   事务包裹：任何一行失败 → ROLLBACK → live 无损（调用方退回全量重建）。
   成功后 wal_checkpoint(TRUNCATE) 收敛 WAL（可选尽力）。
   返回 { applied, fkViolations }；抛错=不可差量。 */
function applySqliteJsonlDelta(livePath, tail) {
  const db = new DatabaseSync(livePath, { enableForeignKeyConstraints: false })
  try {
    db.exec('PRAGMA busy_timeout=3000')
    db.exec('BEGIN IMMEDIATE')
    let n = 0
    try {
      for (const grp of tail || []) {
        for (const line of grp.lines) {
          const o = JSON.parse(line)
          if (o.k !== 'row') continue
          const cols = Object.keys(o.r)
          if (!cols.length) continue
          const vals = cols.map(c => {
            const v = o.r[c]
            return (v && typeof v === 'object' && v.__b64 !== undefined) ? Buffer.from(v.__b64, 'base64') : v
          })
          db.prepare(`INSERT OR REPLACE INTO "${o.t}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals)
          n++
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch {}
      throw e
    }
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
    let fkBad = []
    try { fkBad = db.prepare('PRAGMA foreign_key_check').all() } catch {}
    return { applied: n, fkViolations: fkBad.length }
  } finally { try { db.close() } catch {} }
}

module.exports = { exportSqliteJsonl, rebuildSqliteFromJsonl, sqlReplaceLiveFromJsonl, parseJsonlStructure, planSqliteJsonlDelta, applySqliteJsonlDelta }
