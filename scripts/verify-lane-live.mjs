// 9.46 真机验收：GET /api/status（版本/配置回填）→ POST /api/download（差量路径首验）→ 读 init.log 验证
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const HOST = '127.0.0.1:3080'
const DSH = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh'
const cred = readFileSync(DSH + '/.credentials.yaml', 'utf8')
const SECRET = Buffer.from(cred.match(/secret:\s*(\S+)/)[1], 'base64url')
const b64url = b => Buffer.from(b).toString('base64url')
function cookie() {
  const now = Date.now()
  const p64 = b64url(JSON.stringify({ version: 1, authority: HOST, issuedAt: now, expiresAt: now + 3600_000 }))
  return 'dsh-auth-' + b64url(createHash('sha256').update(HOST).digest()) + '=v1.' + p64 + '.' + createHmac('sha256', SECRET).update(p64).digest('base64url')
}

const st = await fetch(`http://${HOST}/dsh-sync/api/status`, { headers: { cookie: cookie() }, signal: AbortSignal.timeout(15000) })
const stText = await st.text()
console.log('== /api/status HTTP', st.status, '==')
try {
  const j = JSON.parse(stText)
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in (o || {})).map(k => [k, o[k]]))
  console.log(JSON.stringify(pick(j, ['version', 'sqliteJsonlLane', 'sessionsJsonlLane', 'rebuildEveryUploads', 'lastSyncAt', 'lastResult']), null, 1).slice(0, 600))
  // 兜底：找嵌套字段
  const flat = JSON.stringify(j)
  for (const k of ['sqliteJsonlLane', 'sessionsJsonlLane', '"version"']) {
    const m = flat.match(new RegExp('"' + k + '":("?[a-z0-9.-]+"?)'))
    if (m) console.log('flat:', k, '=', m[1])
  }
} catch { console.log(stText.slice(0, 400)) }

console.log('\n== POST /api/download（差量路径首验）==')
const dl = await fetch(`http://${HOST}/dsh-sync/api/download`, { method: 'POST', headers: { cookie: cookie() }, signal: AbortSignal.timeout(120000) })
const dlText = await dl.text()
console.log('HTTP', dl.status, dlText.slice(0, 500))
