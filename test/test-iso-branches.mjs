// 双分支·双开关隔离测试 v2（2026-11-22）
// 沙箱用与插件相同的编码函数生成工作区键，确保 loadWorkspaceMap 能对上
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const REPO = process.env.TEST_REPO
const LABEL = process.env.TEST_LABEL || 'unknown'
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-iso-'))
process.env.DSH_HOME = SANDBOX

const require = createRequire(path.join(REPO, 'package.json'))
const plugin = require(path.join(REPO, 'src', 'index.js'))
const I = plugin.__internals
if (!I) { console.log('FAIL: __internals 不存在'); process.exit(1) }

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail })
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// 从插件源码提取 encodeWorkspaceDir/encodeName 真身（vm 执行，保证与插件逐字符一致）
import vm from 'node:vm'
const srcText = fs.readFileSync(path.join(REPO, 'src', 'index.js'), 'utf8')
const encFns = ['encodeWorkspaceDir', 'encodeName'].map(n => {
  const m = srcText.match(new RegExp('function ' + n + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'))
  if (!m) throw new Error(n + ' not found')
  return m[0]
}).join('\n')
const sb = {}
vm.createContext(sb)
vm.runInContext(encFns, sb)
const encodeWorkspaceDir = sb.encodeWorkspaceDir
const encodeName = sb.encodeName

const WS_PATH = path.join(SANDBOX, 'work', 'alpha')
const LIVE_DIRNAME = encodeWorkspaceDir(WS_PATH.replace(/\\/g, '/'))
const WSKEY = encodeName('alpha')

const SESS = path.join(SANDBOX, 'sessions')
const REPODIR = path.join(SANDBOX, 'dsh-sync', 'repo')
const LIVE_WS = path.join(SESS, LIVE_DIRNAME)
fs.mkdirSync(path.join(REPODIR, 'sessions', 'ws', WSKEY), { recursive: true })
fs.mkdirSync(path.join(SANDBOX, 'storages'), { recursive: true })
fs.mkdirSync(LIVE_WS, { recursive: true })

const mkSession = (dir) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 0x28))
}
const exists = p => fs.existsSync(p)
function resetScenario() {
  for (const p of [
    path.join(LIVE_WS, 'session-live-only'),
    path.join(LIVE_WS, 'session-both'),
    path.join(REPODIR, 'sessions', 'ws', WSKEY, 'session-cloud-only'),
    path.join(REPODIR, 'sessions', 'ws', WSKEY, 'session-both'),
  ]) mkSession(p)
}

// workspace.json：path 用正斜杠（loadWorkspaceMap 对分隔符做归一）
fs.writeFileSync(path.join(SANDBOX, 'storages', 'workspace.json'), JSON.stringify({
  tables: { workspaces: { 'w1': { id: 'w1', path: WS_PATH.replace(/\\/g, '/'), title: 'alpha' } } }
}))

const effBase = { syncSessions: true, sessionsStrategy: 'merge', sessionsDeleteSync: true, sessionsParts: true }
const logger = { info: () => {}, warn: () => {} }

async function testDeletionSync(enabled) {
  const eff = { ...effBase, sessionsDeleteSync: enabled }
  let up
  try { up = await I.pruneCloudExtras(REPODIR, eff, logger) } catch (e) { up = { error: String(e.message) } }
  const wsGroups = new Map()
  wsGroups.set(LIVE_WS, { targetWs: { path: WS_PATH.replace(/\\/g, '/'), id: 'w1', title: 'alpha' }, targetWsDir: LIVE_WS, targetDirName: LIVE_DIRNAME, cloudBases: [WSKEY], copies: new Map() })
  let down
  try { down = await I.pruneLocalOnlySessions(REPODIR, wsGroups, { eff, logger, ctx: null, state: {} }) } catch (e) { down = { error: String(e.message) } }
  return { up, down }
}

console.log(`\n=== [${LABEL}] 会话删除传导开关 ===`)
resetScenario()
{
  const r = await testDeletionSync(true)
  check('开关开：上传删云端独有(cloud-only)', !exists(path.join(REPODIR, 'sessions', 'ws', WSKEY, 'session-cloud-only')), JSON.stringify(r.up))
  check('开关开：下载删本机独有(live-only)', !exists(path.join(LIVE_WS, 'session-live-only')), JSON.stringify(r.down))
  check('开关开：两边都有(both)保留', exists(path.join(LIVE_WS, 'session-both')) && exists(path.join(REPODIR, 'sessions', 'ws', WSKEY, 'session-both')))
}
resetScenario()
{
  const r = await testDeletionSync(false)
  check('开关关：云端独有保留', exists(path.join(REPODIR, 'sessions', 'ws', WSKEY, 'session-cloud-only')), JSON.stringify(r.up))
  check('开关关：本机独有保留', exists(path.join(LIVE_WS, 'session-live-only')), JSON.stringify(r.down))
}

console.log(`\n=== [${LABEL}] 强制覆盖解除普通删除守卫 ===`)
for (const p of fs.readdirSync(LIVE_WS)) fs.rmSync(path.join(LIVE_WS, p), { recursive: true, force: true })
for (const p of fs.readdirSync(path.join(REPODIR, 'sessions', 'ws', WSKEY))) fs.rmSync(path.join(REPODIR, 'sessions', 'ws', WSKEY, p), { recursive: true, force: true })
resetScenario()
{
  const wsGroups = new Map()
  wsGroups.set(LIVE_WS, { targetWs: { path: WS_PATH.replace(/\\/g, '/'), id: 'w1', title: 'alpha' }, targetWsDir: LIVE_WS, targetDirName: LIVE_DIRNAME, cloudBases: [WSKEY], copies: new Map() })
  const normal = await I.pruneLocalOnlySessions(REPODIR, wsGroups, { eff: effBase, logger, ctx: null, state: { lastCloudSessions: {} } })
  check('普通下载：未上传本机独有会话保留', exists(path.join(LIVE_WS, 'session-live-only')), JSON.stringify(normal))
  fs.rmSync(path.join(REPODIR, 'sessions', 'ws', WSKEY, 'session-cloud-only'), { recursive: true, force: true })
  const forced = await I.pruneLocalOnlySessions(REPODIR, wsGroups, { eff: effBase, logger, ctx: null, state: { lastCloudSessions: {} }, force: true })
  check('强制覆盖：本机独有会话按云端集合删除', !exists(path.join(LIVE_WS, 'session-live-only')), JSON.stringify({ forced, liveWs: fs.readdirSync(LIVE_WS), cloudWs: fs.readdirSync(path.join(REPODIR, 'sessions', 'ws', WSKEY)), wsKey: WSKEY }))
}

console.log(`\n=== [${LABEL}] part 开关 ===`)
if (I.upsertSessionToShadowParts) {
  // 空云端场景：强制真写入，验证分片链形态（不走相等短路）
  for (const partsOn of [true, false]) {
    const liveDir = path.join(LIVE_WS, 'session-both')
    const cloudDir = path.join(REPODIR, 'sessions', 'ws', WSKEY, 'session-both')
    resetScenario()
    fs.writeFileSync(path.join(liveDir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 0x28))
    fs.rmSync(cloudDir, { recursive: true, force: true })  // 云端清空 → 必走 reset/full
    let mode
    try { mode = await I.upsertSessionToShadowParts(liveDir, cloudDir, { sessionsParts: partsOn }, logger) } catch (e) { mode = 'ERR:' + e.message }
    const files = fs.readdirSync(cloudDir)
    const hasPart = files.some(f => f.includes('.part'))
    const hasFull = files.includes('session.v4.jsonl.zstd')
    check(`空云端 part=${partsOn}：模式=${mode}`, mode === (partsOn ? 'reset' : 'full'), `files=[${files.join(',')}]`)
    if (partsOn) check('空云端 part=true：生成 part0000 分片链', hasPart && files.includes('session.v4.jsonl.zstd.part0000'), `files=[${files.join(',')}]`)
    else check('空云端 part=false：生成整文件 .zstd', hasFull && !hasPart, `files=[${files.join(',')}]`)
  }
  // 相等场景：验证短路行为
  for (const partsOn of [true, false]) {
    resetScenario()
    const liveDir = path.join(LIVE_WS, 'session-both')
    const cloudDir = path.join(REPODIR, 'sessions', 'ws', WSKEY, 'session-both')
    let mode
    try { mode = await I.upsertSessionToShadowParts(liveDir, cloudDir, { sessionsParts: partsOn }, logger) } catch (e) { mode = 'ERR:' + e.message }
    const files = fs.readdirSync(cloudDir)
    const hasPart = files.some(f => f.includes('.part'))
    const hasFull = files.includes('session.v4.jsonl.zstd')
    // 相等短路是合法行为（resetScenario 后两侧字节相同→skip 保留原形态）；
    // 真正要验的是「形态符合开关」：part=true 时若发生了写入必须是 part 链，part=false 时必须整文件
    const modeOk = partsOn ? ['reset', 'skip', 'append'].includes(mode) : ['full', 'skip'].includes(mode)
    check(`part=${partsOn}：模式合法(${mode})`, modeOk, `files=[${files.join(',')}]`)
    if (partsOn) check('part=true：形态为 .part 分片或相等跳过保留', hasPart || mode === 'skip', `files=[${files.join(',')}]`)
    else check('part=false：整文件 .zstd 形态', hasFull, `files=[${files.join(',')}]`)
  }
} else {
  console.log('  （未导出 upsertSessionToShadowParts，跳过）')
}

const pass = results.filter(r => r.pass).length
console.log(`\n[${LABEL}] 结果：${pass} 通过 / ${results.length - pass} 失败`)
fs.rmSync(SANDBOX, { recursive: true, force: true })
process.exit(pass === results.length ? 0 : 1)
