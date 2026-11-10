/* 孤儿自愈回归测试（2026-11-10）
   覆盖：packOrphanStats 孤儿占比统计、gcIfBloated 孤儿占比触发、reflog 钉死孤儿的根治
   （旧 gc 不过期 reflog → --prune=now 删不掉 squash 孤儿 → 480MB 积压 392MB 的真凶）、
   pushWithSelfHeal 推送成功后补巡检。
   注意：本套件 await 每个用例（旧 test-part-chain.mjs 的 t() 未 await，异步断言失败会被吞）。
   注意：execFileSync 直拉 git.exe——ops_bash/node 环境 cmd.exe 不在 PATH，execSync 不可用。
   跑法：node test/test-gc-orphan.mjs
*/
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const mod = require('../src/index.js')
const { packOrphanStats, gcIfBloated, pushWithSelfHeal } = mod.__internals

let pass = 0, fail = 0
const ok = (v, msg) => { if (!v) throw new Error(msg || '断言失败') }
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

// ~N MB 不可压随机块（保证 pack 体积不因 zlib 蒸发）
const blob = (mb) => randomBytes(Math.round(mb * 1024 * 1024))

// 临时根目录放套件自身工作区：os.tmpdir() 在 bash 系环境可能返回 POSIX 风格路径，
// 传给 spawn 当 cwd 会 ENOENT（test ④ 真仓 Windows 路径能跑就是反证）
const TEST_ROOT = join(process.cwd(), 'test', '.tmp-gc')

function newRepo() {
  mkdirSync(TEST_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TEST_ROOT, 'dshgc-'))
  const repo = join(dir, 'repo')
  const mk = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  mkdirSync(repo, { recursive: true })
  mk('init', '-q')
  mk('config', 'user.email', 'test@test')
  mk('config', 'user.name', 'test')
  return { dir, repo }
}
function cleanup({ dir }) { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
const g = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
const commitFile = (repo, name, buf, msg) => {
  writeFileSync(join(repo, name), buf)
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '-m', msg)
}
// 把全部对象收进 pack（含不可达对象，但不清剪）——模拟 squash 后「孤儿已在 pack 里」的形态
const packAll = (repo) => g(repo, '-c', 'gc.pruneExpire=never', 'gc', '--quiet')
const objectGone = (repo, sha) => { try { g(repo, 'cat-file', '-t', sha); return false } catch { return true } }

const logger = () => {
  const calls = []
  return { calls, warn: (m) => calls.push(['warn', String(m)]), info: (m) => calls.push(['info', String(m)]) }
}

console.log('\n=== ① packOrphanStats：孤儿占比统计 ===')

await t('干净仓：可达=已打包，孤儿占比 0', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(1), 'base')
    packAll(r.repo)
    const st = await packOrphanStats('git', r.repo)
    ok(st.inPack > 0, `in-pack 应 > 0，实得 ${st.inPack}`)
    ok(st.orphanRatio === 0, `干净仓孤儿占比应为 0，实得 ${st.orphanRatio}`)
    ok(st.mb > 0.5, `pack 应 ≥ 0.5MB，实得 ${st.mb}`)
  } finally { cleanup(r) }
})

await t('squash 形态：reset 孤儿化旧提交 → 占比 > 0，对象暂存但 refs 不可达', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(1), 'base')
    packAll(r.repo)
    commitFile(r.repo, 'b.bin', blob(2), 'second')
    const orphanSha = g(r.repo, 'rev-parse', 'HEAD').trim()
    packAll(r.repo)
    g(r.repo, 'reset', '-q', '--hard', 'HEAD~1') // 模拟 squash：旧链从 refs 上摘掉
    const st = await packOrphanStats('git', r.repo)
    ok(st.orphans > 0, '孤儿对象数应 > 0')
    ok(st.orphanRatio > 0.3, `孤儿占比应 > 0.3，实得 ${st.orphanRatio.toFixed(2)}`)
    ok(st.reachable > 0 && st.reachable < st.inPack, '可达数应严格小于已打包数')
    ok(!objectGone(r.repo, orphanSha), '前置：孤儿提交对象此刻应仍存在（待 gc 回收）')
  } finally { cleanup(r) }
})

console.log('\n=== ② gcIfBloated：孤儿占比触发 + reflog 根治 ===')

await t('真凶回归：reflog 钉住的孤儿，gcIfBloated 后必须真正消失', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(1), 'base')
    commitFile(r.repo, 'b.bin', blob(2), 'second')
    packAll(r.repo)
    const orphanSha = g(r.repo, 'rev-parse', 'HEAD').trim()
    g(r.repo, 'reset', '-q', '--hard', 'HEAD~1') // HEAD reflog 仍钉着 orphanSha
    ok(g(r.repo, 'reflog', 'HEAD').includes(orphanSha.slice(0, 7)), '前置：reflog 应钉着孤儿')
    const lg = logger()
    await gcIfBloated('git', r.repo, { repoGcThresholdMB: 1, gcOrphanMinPackMB: 0.5 }, lg)
    ok(lg.calls.some(([, m]) => m.includes('体积巡检') && m.includes('自动 git gc')), '未触发 gc 日志')
    ok(objectGone(r.repo, orphanSha), '孤儿对象未被回收——reflog 未过期（旧版真凶复现）')
    const st = await packOrphanStats('git', r.repo)
    ok(st.orphanRatio < 0.05, `gc 后孤儿占比应归零，实得 ${st.orphanRatio.toFixed(2)}`)
  } finally { cleanup(r) }
})

await t('占比触发：绝对阈值拉满，孤儿 ≥50% 也会 gc', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(1), 'base') // 可达 ~1MB
    commitFile(r.repo, 'b.bin', blob(2), 'second') // 孤儿 ~2MB
    const orphanSha = g(r.repo, 'rev-parse', 'HEAD').trim()
    packAll(r.repo)
    g(r.repo, 'reset', '-q', '--hard', 'HEAD~1')
    const lg = logger()
    // 阈值 9999 永不满足，只能靠占比触发（下限降到 0.5MB 让 3MB 测试仓过门槛）
    await gcIfBloated('git', r.repo, { repoGcThresholdMB: 9999, gcOrphanMinPackMB: 0.5 }, lg)
    ok(lg.calls.some(([, m]) => m.includes('孤儿占比')), '未按孤儿占比触发')
    ok(objectGone(r.repo, orphanSha), '占比触发后孤儿未回收')
  } finally { cleanup(r) }
})

await t('干净小仓不空转：占比 0 且低于下限 → 不 gc、不动 reflog', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(1), 'base')
    packAll(r.repo)
    const before = g(r.repo, 'reflog', 'HEAD')
    const lg = logger()
    await gcIfBloated('git', r.repo, { repoGcThresholdMB: 9999 }, lg) // 下限走默认 64MB
    ok(!lg.calls.some(([, m]) => m.includes('自动 git gc')), '不该触发 gc')
    ok(g(r.repo, 'reflog', 'HEAD') === before, 'reflog 不应被动过')
  } finally { cleanup(r) }
})

console.log('\n=== ③ pushWithSelfHeal：推送成功后补巡检 ===')

await t('推送成功 → 推送后巡检执行（孤儿占比路径可见）', async () => {
  const r = newRepo()
  const remote = join(r.dir, 'remote.git')
  try {
    execFileSync('git', ['init', '-q', '--bare', remote])
    commitFile(r.repo, 'a.bin', blob(2), 'base')
    packAll(r.repo)
    g(r.repo, 'remote', 'add', 'origin', remote)
    g(r.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    const lg = logger()
    const eff = { repoGcThresholdMB: 1, gcOrphanMinPackMB: 0.5 }
    await pushWithSelfHeal('git', ['push', 'origin', 'HEAD:main'], r.repo, eff, {}, lg)
    ok(lg.calls.some(([, m]) => m.includes('(推送后)')), '推送后巡检未执行: ' + JSON.stringify(lg.calls))
  } finally { cleanup(r) }
})

await t('推送失败且非体积原因 → 原样抛错、不触发 gc 阶梯', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(0.2), 'base')
    g(r.repo, 'remote', 'add', 'origin', 'https://invalid.invalid/nope.git')
    const lg = logger()
    let threw = false
    try {
      await pushWithSelfHeal('git', ['push', 'origin', 'HEAD:main'], r.repo, { repoGcThresholdMB: 1, gcOrphanMinPackMB: 0.5 }, {}, lg)
    } catch { threw = true }
    ok(threw, '推送失败应抛错')
    ok(!lg.calls.some(([, m]) => m.includes('(推送后)')), '失败路径不应有推送后巡检')
    ok(!lg.calls.some(([, m]) => m.includes('自动 git gc')), '非体积错误不应触发 gc 阶梯')
  } finally { cleanup(r) }
})

console.log('\n=== ④ 真实影子仓冒烟（只读，不动库） ===')

await t('packOrphanStats 读真仓：体积与占比可解析', async () => {
  try {
    const st = await packOrphanStats('git', process.env.DSH_SYNC_REPO || 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/dsh-sync/repo')
    ok(typeof st.mb === 'number' && st.mb >= 0, `mb 解析失败: ${st.mb}`)
    ok(st.orphanRatio >= 0 && st.orphanRatio <= 1, `占比越界: ${st.orphanRatio}`)
    console.log(`      真仓: pack ${st.mb.toFixed(0)}MB / 孤儿占比 ${(st.orphanRatio * 100).toFixed(1)}% (${st.orphans}/${st.inPack})`)
  } catch (e) { throw new Error('真仓读取失败: ' + e.message) }
})

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
