// 逐表对比 df37229（手机 00:41 全量 jsonl）与 PC live memory.sqlite（one-shot 诊断脚本）
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rebuildSqliteFromJsonl } from '../src/sqlite-jsonl.js'

const repo = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/dsh-sync/repo'
const tmpDir = 'C:/Users/Evelyn/AppData/Local/Temp/mem-cmp'
fs.mkdirSync(tmpDir, { recursive: true })
const { execSync } = await import('node:child_process')
const jsonl = path.join(tmpDir, 'mem-df.jsonl')
fs.writeFileSync(jsonl, execSync(`git -C "${repo}" show df37229:memory/memory.sqlite.jsonl`, { maxBuffer: 1 << 28 }))
const reb = path.join(tmpDir, 'mem-df.sqlite')
const r = rebuildSqliteFromJsonl(jsonl, reb)
console.log('df37229 rebuild rows:', r.rows)

const live = new DatabaseSync('C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/profiles/web/.dsh-session-kit/memory.sqlite', { readOnly: true })
const reb2 = new DatabaseSync(reb, { readOnly: true })
const tables = reb2.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`).all().map(x => x.name)
let diff = 0
console.log('table | df37229 | PC-live | match')
for (const t of tables) {
  const c1 = reb2.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
  const c2 = live.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
  if (c1 !== c2) diff++
  console.log(`${t} | ${c1} | ${c2} | ${c1 === c2 ? '==' : 'DIFF'}`)
}
console.log('diff tables:', diff)
live.close(); reb2.close()
