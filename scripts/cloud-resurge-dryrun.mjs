// 云端 C 形态修复手术 · dry-run 计划（2026-11-18）
// 背景：PC 旧进程（jsonlLane 运行时=false）01:55 上传 7d0b4f8 把云端 87 个 jsonl 删光换回 raw+part，
// 手机（9.45 C 车道）下载拉不到。修复=云端回归全 jsonl 单一形态：
//   memory=PC live 导出（核心内容表已验证与手机一致，PC 日志类略多）
//   knowledge+会话基底=df37229（手机 00:41 全量，PC 从未落地过这批数据）
//   会话逐个行数对比：PC live 行数>df 版 → PC 版；否则 df 版；PC 独有 → 新增
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REPO = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/dsh-sync/repo'
const LIVE_SESS = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/sessions'
const DH = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh'
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 28, cwd: REPO })

// 影子仓状态
console.log('== 影子仓状态 ==')
console.log(sh('git status --short | head -5').trim() || '(clean)')
console.log('HEAD:', sh('git rev-parse --short HEAD').trim())
console.log('sync .lock:', fs.existsSync(path.join(DH, 'dsh-sync', '.lock')) ? 'EXISTS(有同步在跑，中止)' : '无锁 ✓')

// workspace 映射：live 目录名 <-> 云端 wsKey
const wsDoc = JSON.parse(fs.readFileSync(path.join(DH, 'storages', 'workspace.json'), 'utf8'))
const wsPaths = Object.values(wsDoc?.tables?.workspaces ?? {}).map(w => w.path).filter(Boolean)
const encodeWorkspaceDir = (p) => {
  const cwd = String(p)
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
const encodeName = (n) => String(n).replace(/[^A-Za-z0-9._-]/g, (c) => '~' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
const liveDirByKey = new Map()
for (const p of wsPaths) {
  const dirName = encodeWorkspaceDir(p)
  const folderKey = encodeName(String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop())
  liveDirByKey.set(folderKey, path.join(LIVE_SESS, dirName))
}
console.log('\n== ws 映射 ==')
for (const [k, v] of liveDirByKey) console.log(`ws/${k} -> ${path.basename(v)} ${fs.existsSync(v) ? '✓' : '(live 缺)'}`)

// df37229 的全部 jsonl 清单
const dfJsonls = sh('git ls-tree -r --name-only df37229').split('\n').filter(f => f.endsWith('.jsonl'))
const dfSess = dfJsonls.filter(f => f.startsWith('sessions/ws/'))
console.log(`\n== df37229 jsonl：共 ${dfJsonls.length}（会话 ${dfSess.length}）==`)

// 会话级计划
let pcNewer = 0, dfKeep = 0, pcOnly = 0, missLive = 0
const plan = []
for (const f of dfSess) {
  const m = f.match(/^sessions\/ws\/([^/]+)\/(session-[^/]+)\/session\.v4\.jsonl$/)
  if (!m) continue
  const [, wsKey, sid] = m
  const liveWs = liveDirByKey.get(wsKey)
  const liveZ = liveWs ? path.join(liveWs, sid, 'session.v4.jsonl.zstd') : null
  let liveLines = -1
  if (liveZ && fs.existsSync(liveZ)) {
    try {
      const sj = await import('../src/sessions-jsonl.js')
      liveLines = sj.sessionZstdLines(liveZ).length
    } catch { liveLines = -1 }
  } else missLive++
  const dfLines = parseInt(sh(`git show df37229:"${f}" | wc -l`).trim(), 10)
  if (liveLines > dfLines) { pcNewer++; plan.push(`PC版  ${wsKey}/${sid} live=${liveLines} > df=${dfLines}`) }
  else if (liveLines >= 0 && liveLines < dfLines) { dfKeep++; plan.push(`df版  ${wsKey}/${sid} live=${liveLines} < df=${dfLines}`) }
  else if (liveLines === dfLines) { dfKeep++; plan.push(`df版  ${wsKey}/${sid} live=df=${dfLines}（等长保 df）`) }
  else { dfKeep++; plan.push(`df版  ${wsKey}/${sid}（live 无此会话 .zstd）`) }
}
// PC 独有会话（df 没有的）
const dfIds = new Set(dfSess.map(f => f.match(/(session-[^/]+)\//)?.[1]))
for (const [wsKey, wsDir] of liveDirByKey) {
  if (!fs.existsSync(wsDir)) continue
  for (const sid of fs.readdirSync(wsDir)) {
    if (!sid.startsWith('session-') || dfIds.has(sid)) continue
    const z = path.join(wsDir, sid, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(z)) continue
    pcOnly++
    plan.push(`PC新增 ${wsKey}/${sid}（df37229 无）`)
  }
}
console.log(`PC更新=${pcNewer} df保留=${dfKeep} PC独有=${pcOnly} live缺=${missLive}`)
for (const l of plan.filter(p => !p.startsWith('df版')).slice(0, 30)) console.log('  ' + l)
if (plan.filter(p => !p.startsWith('df版')).length > 30) console.log(`  ...（另有 ${plan.filter(p => !p.startsWith('df版')).length - 30} 条）`)
