// [exp/text-export 9999.9.44-exp.1] C 车道（sqlite 确定序 JSONL 导出/重建）契约测试
// ①导出含 DDL+行、排除 FTS 族；②确定性（两次导出字节相同）；③重建行/值/BLOB 一致+integrity ok；
// ④AUTOINCREMENT 序号续接；⑤sqlite_sequence/sqlite_% 不出现。
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { exportSqliteJsonl, rebuildSqliteFromJsonl } from '../src/sqlite-jsonl.js'

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name) } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-lane-'))
const dbPath = path.join(dir, 'src.sqlite')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, score REAL, data BLOB, created_at TEXT)`)
  db.exec(`CREATE INDEX idx_items_name ON items(name)`)
  db.exec(`CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)`)
  db.exec(`CREATE VIRTUAL TABLE items_fts USING fts5(name, content='items')`) // FTS 族：应整族排除
  const ins = db.prepare(`INSERT INTO items (name, score, data, created_at) VALUES (?, ?, ?, ?)`)
  ins.run('alpha', 1.5, Buffer.from([0, 1, 2, 255]), '2026-11-16')
  ins.run('beta', 2.5, Buffer.from([9, 8]), '2026-11-16')
  ins.run('gamma', 3.5, null, '2026-11-16')
  db.prepare(`INSERT INTO tags (label) VALUES (?)`).run('x')
  db.close()
}

const out1 = path.join(dir, 'lane1.jsonl')
const meta1 = await exportSqliteJsonl(dbPath, out1)
const text1 = fs.readFileSync(out1, 'utf8')
const lines1 = text1.split('\n').filter(Boolean).map(l => JSON.parse(l))
const ddlNames = lines1.filter(l => l.k === 'ddl').map(l => l.name)
const rowTables = [...new Set(lines1.filter(l => l.k === 'row').map(l => l.t))]

ok(ddlNames.includes('items') && ddlNames.includes('idx_items_name'), 'DDL 含表与索引')
ok(!ddlNames.some(n => n.includes('_fts')), 'DDL 排除 FTS 族')
ok(!rowTables.some(t => t.includes('_fts')), '数据行排除 FTS 族')
ok(rowTables.includes('items') && rowTables.includes('tags'), '数据行含全部普通表')
ok(!lines1.some(l => (l.name || l.t || '').includes('sqlite_')), 'sqlite_% 系统对象不出现')
ok(meta1.rows === 4 && meta1.tables === 2, `导出计数 rows=4 tables=2（实际 ${meta1.rows}/${meta1.tables}）`)

const blobRow = lines1.find(l => l.k === 'row' && l.t === 'items' && l.r.data)
ok(blobRow && blobRow.r.data.__b64 === Buffer.from([0, 1, 2, 255]).toString('base64'), 'BLOB→base64 编码正确')

// 确定性：重导一次字节必须相同
const out2 = path.join(dir, 'lane2.jsonl')
await exportSqliteJsonl(dbPath, out2)
const h1 = createHash('sha1').update(fs.readFileSync(out1)).digest('hex')
const h2 = createHash('sha1').update(fs.readFileSync(out2)).digest('hex')
ok(h1 === h2, '两次导出字节级相同（确定序）')

// 重建：行/值/BLOB/integrity
const rebPath = path.join(dir, 'rebuilt.sqlite')
const metaR = rebuildSqliteFromJsonl(out1, rebPath)
ok(metaR.rows === 4, `重建行数 4（实际 ${metaR.rows}）`)
{
  const db = new DatabaseSync(rebPath, { readOnly: true })
  const ic = db.prepare(`PRAGMA integrity_check`).get()
  ok(ic && /ok/i.test(String(ic.integrity_check || ic['integrity_check'])), '重建库 integrity ok')
  const got = db.prepare(`SELECT id, name, score, data, created_at FROM items ORDER BY id`).all()
  ok(got.length === 3, 'items 3 行')
  ok(got[0].name === 'alpha' && got[0].score === 1.5 && got[0].created_at === '2026-11-16', '标量值一致')
  ok(Buffer.from(got[0].data).equals(Buffer.from([0, 1, 2, 255])), 'BLOB 回读一致')
  ok(got[2].data === null, 'NULL 回读一致')
  ok(got[2].id === 3, 'AUTOINCREMENT/主键序保留')
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_items_name'`).get()
  ok(!!idx, '索引随 DDL 重建')
  const fts = db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%_fts%'`).all()
  ok(fts.length === 0, '重建库无 FTS 残留（宿主 initFts 自愈口径）')
  db.close()
}

// 追加一轮变化再导出：只有新增行进入 JSONL diff
{
  const db = new DatabaseSync(dbPath)
  db.prepare(`INSERT INTO items (name, score, data, created_at) VALUES (?, ?, ?, ?)`).run('delta', 4.5, null, '2026-11-16')
  db.close()
}
const out3 = path.join(dir, 'lane3.jsonl')
await exportSqliteJsonl(dbPath, out3)
const t1 = fs.readFileSync(out1, 'utf8')
const t3 = fs.readFileSync(out3, 'utf8')
// 表名序导出下，items 新行插在 items 段末尾（tags 行之前）→ 不构成纯前缀追加；
// 正确断言=行级差集：新导出恰好只多 1 行且就是 delta 行，其余行字节级不变。
const a1 = t1.split('\n').filter(Boolean)
const a3 = t3.split('\n').filter(Boolean)
const set1 = new Set(a1)
const added = a3.filter(x => !set1.has(x))
ok(a3.length === a1.length + 1 && added.length === 1 && added[0].includes('"delta"'), '追加一行后导出仅多 delta 行，其余字节级不变')

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
