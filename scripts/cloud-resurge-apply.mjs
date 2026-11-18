// 云端 C 形态修复手术 · 执行（2026-11-18）
// dry-run 已验证：PC live 会话=86/86 全部超集（PC 下载落地过 df37229+本地新增），memory 核心内容表与手机零分叉。
// 步骤：对齐 7d0b4f8 → memory.jsonl=PC live 导出 → knowledge.jsonl=df37229 版 → 会话 86 全部 PC live 导出+PC 独有补入
//       → 删全部 raw/.part*/.zstd/session.lock → lane-state 留档 → commit → push
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REPO = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/dsh-sync/repo'
const LIVE_SESS = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/sessions'
const DH = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh'
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 28, cwd: REPO })

if (fs.existsSync(path.join(DH, 'dsh-sync', '.lock'))) { console.error('同步锁存在，中止'); process.exit(1) }

console.log('== 1. 对齐云端 tip 7d0b4f8 ==')
sh('git reset --hard 7d0b4f8')
console.log('HEAD =', sh('git rev-parse --short HEAD').trim())

const sj = await import('../src/sqlite-jsonl.js')
const ssj = await import('../src/sessions-jsonl.js')

console.log('== 2. memory.jsonl = PC live 导出 ==')
const memLive = path.join(DH, 'profiles', 'web', '.dsh-session-kit', 'memory.sqlite')
const rMem = await sj.exportSqliteJsonl(memLive, path.join(REPO, 'memory', 'memory.sqlite.jsonl'))
console.log(`导出 ${rMem.lines} 行（${rMem.tables} 表 / ${rMem.rows} 数据行）`)

console.log('== 3. knowledge.jsonl = df37229 版（手机 00:41 最新）==')
const kOut = path.join(REPO, 'knowledge', 'knowledge.sqlite.jsonl')
fs.writeFileSync(kOut, execSync(`git -C "${REPO}" show df37229:knowledge/knowledge.sqlite.jsonl`, { maxBuffer: 1 << 28 }))

console.log('== 4. 会话：PC live 全量导出 ==')
const wsDoc = JSON.parse(fs.readFileSync(path.join(DH, 'storages', 'workspace.json'), 'utf8'))
const wsPaths = Object.values(wsDoc?.tables?.workspaces ?? {}).map(w => w.path).filter(Boolean)
const encodeWorkspaceDir = (p) => {
  let readable = '', sepRun = false
  for (const ch of String(p)) {
    const code = ch.codePointAt(0)
    if (ch === '/' || ch === '\\' || ch === ':') { if (!sepRun) readable += '-'; sepRun = true }
    else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; sepRun = false }
    else { readable += '~' + code.toString(16).toUpperCase().padStart(4, '0'); sepRun = false }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
const encodeName = (n) => String(n).replace(/[^A-Za-z0-9._-]/g, (c) => '~' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
let nSess = 0, nSkip = 0
for (const p of wsPaths) {
  const folderKey = encodeName(String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop())
  const liveWs = path.join(LIVE_SESS, encodeWorkspaceDir(p))
  if (!fs.existsSync(liveWs)) continue
  for (const sid of fs.readdirSync(liveWs)) {
    if (!sid.startsWith('session-')) continue
    const z = path.join(liveWs, sid, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(z)) continue
    try {
      const lines = ssj.sessionZstdLines(z)
      if (!lines.length) { nSkip++; continue }
      const outDir = path.join(REPO, 'sessions', 'ws', folderKey, sid)
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, 'session.v4.jsonl'), lines.join('\n'))
      nSess++
    } catch (e) { nSkip++; console.log('  跳过 ' + sid + ': ' + String(e.message).slice(0, 80)) }
  }
}
console.log(`会话导出 ${nSess} 个（跳过 ${nSkip}）`)

console.log('== 5. 删 raw/.part*/.zstd/session.lock ==')
const killed = sh('git ls-files').trim().split('\n').filter(f => /\.sqlite$|\.sqlite-shm$|\.sqlite-wal$|\.zstd$|\.zstd\.part\d+$|session\.lock$/.test(f))
for (const f of killed) { try { fs.rmSync(path.join(REPO, f), { force: true }) } catch {} }
console.log(`删除 ${killed.length} 个旧形态文件`)

console.log('== 6. lane-state 留档（9.46 差量化基准）==')
const laneDir = path.join(DH, 'dsh-sync', 'lane-state')
fs.mkdirSync(laneDir, { recursive: true })
for (const [src, name] of [[path.join(REPO, 'memory', 'memory.sqlite.jsonl'), 'memory.sqlite.jsonl'], [kOut, 'knowledge.sqlite.jsonl']]) {
  const tmp = path.join(laneDir, '.' + name + '.tmp')
  fs.writeFileSync(tmp, fs.readFileSync(src))
  fs.renameSync(tmp, path.join(laneDir, name))
}
console.log('lane-state 留档完成')

console.log('== 7. commit + push ==')
sh('git add -A')
try { sh(`git -c user.name=dsh-sync -c user.email=dsh-sync@local commit -m "repair jsonl-lane form: restore 87 jsonl clobbered by old-process upload 7d0b4f8 (raw/part regression); memory=PC live export, knowledge=sessions=df37229 baseline + PC live superset; C-form single form for 9.45+ lanes"`) } catch (e) { console.log('commit:', String(e.message).slice(0, 100)) }
console.log(sh('git log --oneline -2').trim())
console.log(sh('git push origin HEAD:main 2>&1 | tail -2').trim())

console.log('== 8. 验证云端形态 ==')
sh('git fetch --depth 1 origin main')
const tree = sh('git ls-tree -r --name-only FETCH_HEAD')
const j = tree.split('\n').filter(f => f.endsWith('.jsonl')).length
const old = tree.split('\n').filter(f => /\.zstd|\.part\d|\.sqlite$|session\.lock/.test(f)).length
console.log(`云端 FETCH_HEAD：jsonl=${j}，旧形态=${old}`)
