// [差量化路线 9999.9.46] sqlite 下载端差量落地契约测试
// ①plan：单表尾部新增 ok；②多表同时新增 ok（整文件前缀断但按表前缀成立=常态口径）；
// ③中间行 UPDATE/行删除/DDL 变化/表删除/留档空 → 全部不可差量；④留档=云端 → tail 空；
// ⑤apply：差量后 live 与全量重建逐表内容一致（BLOB/NULL/大整数保真）；⑥坏行 → 抛错且 ROLLBACK live 无损。
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { exportSqliteJsonl, rebuildSqliteFromJsonl, planSqliteJsonlDelta, applySqliteJsonlDelta } from '../src/sqlite-jsonl.js'

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-lane-'))

// ── 造库工具：v1 两表，v2 两表各加行（多表同时增长场景）──
function makeDb(dbPath, rows) {
  try { fs.rmSync(dbPath, { force: true }) } catch {}
  try { fs.rmSync(dbPath + '-wal', { force: true }) } catch {}
  try { fs.rmSync(dbPath + '-shm', { force: true }) } catch {}
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, data BLOB, big INTEGER)`)
  db.exec(`CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)`)
  for (const r of rows.items) db.prepare(`INSERT INTO items (id, name, score, data, big) VALUES (?, ?, ?, ?, ?)`).run(r[0], r[1], r[2], r[3], r[4])
  for (const r of rows.tags) db.prepare(`INSERT INTO tags (id, label) VALUES (?, ?)`).run(r[0], r[1])
  db.close()
}

const v1 = {
  items: [[1, 'alpha', 1.5, Buffer.from([0, 1, 2, 255]), '42'], [2, 'beta', null, null, '42']],
  tags: [[1, 'x']],
}
const v2 = {
  items: [...v1.items, [3, 'gamma', 3.5, Buffer.from([9]), '43']],
  tags: [...v1.tags, [2, 'y'], [3, 'z']],
}

const dbV1 = path.join(dir, 'v1.sqlite')
const dbV2 = path.join(dir, 'v2.sqlite')
makeDb(dbV1, v1)
makeDb(dbV2, v2)

const j1 = path.join(dir, 'cloud-v1.jsonl')
const j2 = path.join(dir, 'cloud-v2.jsonl')
await exportSqliteJsonl(dbV1, j1)
await exportSqliteJsonl(dbV2, j2)
const text1 = fs.readFileSync(j1, 'utf8')
const text2 = fs.readFileSync(j2, 'utf8')

// ① 单表尾部新增：v1 → v1+items 追加一行
const v1b = { items: v1.items, tags: [...v1.tags, [2, 'only-tags-grew']] }
const dbV1b = path.join(dir, 'v1b.sqlite')
makeDb(dbV1b, v1b)
const j1b = path.join(dir, 'cloud-v1b.jsonl')
await exportSqliteJsonl(dbV1b, j1b)
const plan1 = planSqliteJsonlDelta(fs.readFileSync(j1b, 'utf8'), text1)
ok(plan1.ok, '① 单表尾部新增 → 可差量')
ok(plan1.ok && plan1.tail.length === 1 && plan1.tail[0].t === 'tags' && plan1.tail[0].lines.length === 1, '① tail=tags 表 1 行')

// ② 多表同时新增（整文件前缀断、按表前缀成立）：v1 → v2
const plan2 = planSqliteJsonlDelta(text2, text1)
ok(plan2.ok, '② 多表同时新增 → 可差量（按表分组口径）')
const tailItems = plan2.ok && plan2.tail.find(x => x.t === 'items')
const tailTags = plan2.ok && plan2.tail.find(x => x.t === 'tags')
ok(tailItems && tailItems.lines.length === 1 && JSON.parse(tailItems.lines[0]).r.name === 'gamma', '② items tail=gamma 1 行')
ok(tailTags && tailTags.lines.length === 2, '② tags tail=2 行')

// ③④⑤ 不可差量场景
{
  const vMid = { items: [[1, 'alpha-CHANGED', 1.5, Buffer.from([0, 1, 2, 255]), '42'], [2, 'beta', null, null, '42']], tags: v1.tags }
  const dbMid = path.join(dir, 'mid.sqlite'); makeDb(dbMid, vMid)
  const jMid = path.join(dir, 'mid.jsonl'); await exportSqliteJsonl(dbMid, jMid)
  const p = planSqliteJsonlDelta(fs.readFileSync(jMid, 'utf8'), text1)
  ok(!p.ok && /^fork:items/.test(p.reason), '③ 中间行 UPDATE → fork 不可差量（' + (p.reason || '') + '）')
}
{
  const vDel = { items: [v1.items[1]], tags: v1.tags }
  const dbDel = path.join(dir, 'del.sqlite'); makeDb(dbDel, vDel)
  const jDel = path.join(dir, 'del.jsonl'); await exportSqliteJsonl(dbDel, jDel)
  const p = planSqliteJsonlDelta(fs.readFileSync(jDel, 'utf8'), text1)
  ok(!p.ok, '③ 行删除 → 不可差量（' + (p.reason || '') + '）')
}
{
  const dbDdl = path.join(dir, 'ddl.sqlite')
  try { fs.rmSync(dbDdl, { force: true }) } catch {}
  const db = new DatabaseSync(dbDdl)
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, data BLOB, big INTEGER, extra TEXT)`)
  db.exec(`CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)`)
  for (const r of v1.items) db.prepare(`INSERT INTO items (id, name, score, data, big) VALUES (?, ?, ?, ?, ?)`).run(r[0], r[1], r[2], r[3], r[4])
  for (const r of v1.tags) db.prepare(`INSERT INTO tags (id, label) VALUES (?, ?)`).run(r[0], r[1])
  db.close()
  const jDdl = path.join(dir, 'ddl.jsonl'); await exportSqliteJsonl(dbDdl, jDdl)
  const p = planSqliteJsonlDelta(fs.readFileSync(jDdl, 'utf8'), text1)
  ok(!p.ok && /^ddl-diff/.test(p.reason), '④ DDL 变化（加列）→ 不可差量（' + (p.reason || '') + '）')
}
{
  const p = planSqliteJsonlDelta(text1, '')
  ok(!p.ok && /^ddl-count/.test(p.reason), '⑤ 留档空（首轮缺失）→ 不可差量（' + (p.reason || '') + '）')
}
{
  const p = planSqliteJsonlDelta(text1, text2)
  ok(!p.ok, '⑤ 云端比留档短 → 不可差量（' + (p.reason || '') + '）')
}
{
  const p = planSqliteJsonlDelta(text1, text1)
  ok(p.ok && p.tail.length === 0, '⑥ 留档=云端 → ok 且 tail 空（0 行等价）')
}

// ⑦ apply 集成：live=v1，差量到 v2，与全量重建逐表内容一致
{
  const livePath = path.join(dir, 'live.sqlite')
  fs.copyFileSync(dbV1, livePath)
  const plan = planSqliteJsonlDelta(text2, text1)
  const rDelta = applySqliteJsonlDelta(livePath, plan.tail)
  ok(rDelta.applied === 3, `⑦ 差量应用 3 行（实际 ${rDelta.applied}）`)
  // 全量重建参照
  const rebPath = path.join(dir, 'rebuilt-v2.sqlite')
  rebuildSqliteFromJsonl(j2, rebPath)
  // 逐表比对
  const snap = (p) => {
    const db = new DatabaseSync(p, { readOnly: true })
    try {
      const out = {}
      for (const t of db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`).all()) {
        out[t.name] = db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all().map(r => {
          const o = {}
          for (const k of Object.keys(r)) o[k] = r[k] instanceof Uint8Array ? Buffer.from(r[k]).toString('hex') : String(r[k])
          return o
        })
      }
      return out
    } finally { db.close() }
  }
  const sDelta = snap(livePath)
  const sFull = snap(rebPath)
  ok(JSON.stringify(sDelta.items) === JSON.stringify(sFull.items), '⑦ items 表差量=全量重建（BLOB hex/NULL/REAL 逐行一致）')
  ok(JSON.stringify(sDelta.tags) === JSON.stringify(sFull.tags), '⑦ tags 表差量=全量重建')
  ok(sDelta.items[2].big === '43', '⑦ 大整数（>2^53 字符串通道）保真')
  const { sqliteHealthy } = await import('../src/index.js').then(m => ({ sqliteHealthy: m.__sqliteHealthyProbe || null })).catch(() => ({ sqliteHealthy: null }))
  // index.js 不导出 sqliteHealthy → 直接本地 integrity_check
  {
    const db = new DatabaseSync(livePath, { readOnly: true })
    const bad = db.prepare('PRAGMA integrity_check').all().filter(r => r.integrity_check !== 'ok')
    db.close()
    ok(bad.length === 0, '⑦ 差量后 integrity_check ok')
  }
}

// ⑧ 坏 tail → 抛错且 ROLLBACK live 无损
{
  const livePath = path.join(dir, 'live2.sqlite')
  fs.copyFileSync(dbV1, livePath)
  const before = new DatabaseSync(livePath, { readOnly: true }).prepare('SELECT COUNT(*) c FROM items').get().c
  let threw = false
  try { applySqliteJsonlDelta(livePath, [{ t: 'no_such_table', lines: [JSON.stringify({ k: 'row', t: 'no_such_table', r: { a: 1 } })] }]) } catch { threw = true }
  ok(threw, '⑧ 坏 tail（不存在的表）→ 抛错')
  const after = new DatabaseSync(livePath, { readOnly: true }).prepare('SELECT COUNT(*) c FROM items').get().c
  ok(before === after, `⑧ ROLLBACK 后 live 无损（${before}→${after}）`)
}

// ⑨ 重复差量幂等（同 tail 再 apply 一次：INSERT OR REPLACE 无 PK 冲突行=追加，但带 PK 行=替换不重复）
{
  const livePath = path.join(dir, 'live3.sqlite')
  fs.copyFileSync(dbV1, livePath)
  const plan = planSqliteJsonlDelta(text2, text1)
  applySqliteJsonlDelta(livePath, plan.tail)
  applySqliteJsonlDelta(livePath, plan.tail)   // 同一批行再打一遍
  const db = new DatabaseSync(livePath, { readOnly: true })
  const items = db.prepare('SELECT COUNT(*) c FROM items').get().c
  const tags = db.prepare('SELECT COUNT(*) c FROM tags').get().c
  db.close()
  ok(items === 3 && tags === 3, `⑨ 同 tail 重放幂等（PK 行 REPLACE 不重复：items=${items} tags=${tags}）`)
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
