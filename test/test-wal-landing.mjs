'use strict'
/* [2026-11-17 挂账②根修验证] WAL 套用事故复现 + safeSqliteLanding 分支验证。
 * 事故配方（11-17 15:29 memory.sqlite 被炸成 malformed）：
 *   宿主连接开着写库 → -wal 有帧未合并 → 下载端 writeFile 覆盖主文件 →
 *   WAL 帧套在新主文件上 → 页序错位 malformed → 记忆工具被宿主移除 11 个。
 * 修复（9999.9.44-exp.4）：落地前 safeSqliteLanding——
 *   ① 死 -wal（无连接）→ 直接删 → 落地安全
 *   ② 活连接 -wal → wal_checkpoint(TRUNCATE) 截 0B → 落地安全
 *   ③ 落地后 sqliteLandingCleanup 清残留
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const mod = require('../src/index.js')
const { walCheckpointTruncate, safeSqliteLanding, sqliteLandingCleanup } = mod.__internals

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshsync-wal-'))
let pass = 0
const ok = (name) => { pass++; console.log('  PASS ' + name) }

function makeDb(p, rows) {
  const db = new DatabaseSync(p)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')
  const ins = db.prepare('INSERT INTO t(v) VALUES (?)')
  for (const r of rows) ins.run(r)
  return db
}

function integrity(p) {
  const db = new DatabaseSync(p, { readOnly: true })
  try { return db.prepare('PRAGMA integrity_check').get().integrity_check } finally { db.close() }
}

/* ── 场景①：事故配方复刻（宽松，只展示不断言炸法）── */
const live = path.join(dir, 'memory.sqlite')
const dbA = makeDb(live, ['wal-frame-1', 'wal-frame-2'])
const scene = path.join(dir, 'scene')
fs.mkdirSync(scene)
fs.copyFileSync(live, path.join(scene, 'm.sqlite'))
fs.copyFileSync(live + '-wal', path.join(scene, 'm.sqlite-wal'))
fs.copyFileSync(live + '-shm', path.join(scene, 'm.sqlite-shm'))
const dbB = makeDb(path.join(dir, 'b.sqlite'), [])
dbB.close()
fs.copyFileSync(path.join(dir, 'b.sqlite'), path.join(scene, 'm.sqlite')) // 下载端覆盖主文件
try {
  const verdict = integrity(path.join(scene, 'm.sqlite'))
  console.log('  [复现] 事故配方 integrity=' + verdict + '（' + (verdict === 'ok' ? 'SQLite 忽略了不匹配帧' : '损坏复现') + '）')
} catch (e) {
  console.log('  [复现] 事故配方打开即炸：' + e.message)
}
dbA.close()
ok('事故配方复刻完成（主文件已换 + 未合并 -wal 残留）')

/* ── 场景②：修复-死 wal 分支（删除收敛）── */
const s2 = path.join(dir, 's2')
fs.mkdirSync(s2)
const live2 = path.join(s2, 'm.sqlite')
const db2 = makeDb(live2, ['old-row'])
fs.copyFileSync(live2, path.join(s2, 'snapshot.sqlite'))
fs.copyFileSync(live2 + '-wal', path.join(s2, 'orphan-wal')) // 连接开着时拷出=带帧
db2.close()
fs.copyFileSync(path.join(s2, 'snapshot.sqlite'), live2)
fs.copyFileSync(path.join(s2, 'orphan-wal'), live2 + '-wal')
assert(fs.statSync(live2 + '-wal').size > 0, '前置：死 wal 非空')
const land1 = await safeSqliteLanding(live2, null)
assert.strictEqual(land1.ok, true, '死 wal 应被删除收敛: ' + (land1.reason || ''))
assert(!fs.existsSync(live2 + '-wal'), '死 wal 应已删除')
ok('safeSqliteLanding 死 wal 分支：删除收敛后落地安全')

/* ── 场景③：修复-活连接 checkpoint 分支（TRUNCATE 截 0B）── */
const s3 = path.join(dir, 's3')
fs.mkdirSync(s3)
const live3 = path.join(s3, 'm.sqlite')
const db3 = makeDb(live3, ['row-a'])
db3.prepare('INSERT INTO t(v) VALUES (?)').run('row-b') // wal 有帧，连接保持打开
assert(fs.statSync(live3 + '-wal').size > 0, '前置：活 wal 非空')
walCheckpointTruncate(live3)
assert.strictEqual(fs.statSync(live3 + '-wal').size, 0, 'TRUNCATE 后 wal 应为 0B')
ok('walCheckpointTruncate 活连接：wal 截 0B（帧已合并）')
const dbNew = makeDb(path.join(s3, 'new.sqlite'), [])
dbNew.close()
fs.copyFileSync(path.join(s3, 'new.sqlite'), live3) // 模拟下载端落地新主文件
assert.strictEqual(integrity(live3), 'ok', '落地后 integrity 应 ok')
ok('落地后新主文件 integrity ok')

/* ── 场景④：sqliteLandingCleanup（在无连接的 live2 上测，避免活连接锁）── */
fs.writeFileSync(live2 + '-wal', 'x')
fs.writeFileSync(live2 + '-shm', 'x')
await sqliteLandingCleanup(live2)
assert(!fs.existsSync(live2 + '-wal') && !fs.existsSync(live2 + '-shm'), '清理应删掉 wal/shm 残留')
ok('sqliteLandingCleanup 清残留')

db3.close()
console.log('\nWAL 落地安全封装 ' + pass + '/4 全绿')
fs.rmSync(dir, { recursive: true, force: true })
