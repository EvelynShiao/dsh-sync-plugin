/* test-platform.mjs — 9999.9.34 多平台适配 + 体积自愈 UI 化（配置化）回归
   ①detectPlatform 三家解析（gitcode/github/gitee，带/不带 .git）+ 非法/自建 URL 拒绝
   ②gcIfBloated 孤儿占比线可配置（eff.gcOrphanRatio）：高线不触发、低线触发
   ③自动删仓重建总闸（eff.rebuildAutoEnabled）：false 拦截 + 默认放行到平台门禁
   ④platformRequest 三家认证分派（mock fetch，全程无网）+ checkRepoPrivate 私仓校验
   全部离线：fetch 用桩替换，git 操作只落 test/.tmp-platform/。 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const mod = require('../src/index.js')
const { detectPlatform, platformRequest, checkRepoPrivate, gcIfBloated, packOrphanStats, rebuildCloudRepoIfBloated, gitExec } = mod.__internals

let pass = 0, fail = 0
const ok = (v, msg) => { if (!v) throw new Error(msg || '断言失败') }
const eq = (a, b, msg) => { const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) throw new Error(`${msg || ''} 期望 ${B} 实得 ${A}`) }
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}

const TEST_ROOT = join(process.cwd(), 'test', '.tmp-platform')
function newRepo() {
  const dir = mkdtempSync(join(TEST_ROOT, 'repo-'))
  const repo = join(dir, 'shadow')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  return { dir, repo }
}
const cleanup = ({ dir }) => { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
const g = (repo, ...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
const blob = (mb) => randomBytes(Math.round(mb * 1024 * 1024))
const commitFile = (repo, name, buf, msg) => {
  writeFileSync(join(repo, name), buf)
  g(repo, 'add', name)
  g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg)
}
const packAll = (repo) => g(repo, '-c', 'gc.pruneExpire=never', 'gc', '--quiet')
const logger = () => { const calls = []; return { calls, warn: (m) => calls.push(['warn', String(m)]), info: (m) => calls.push(['info', String(m)]) } }

mkdirSync(TEST_ROOT, { recursive: true })

console.log('\n=== ① detectPlatform：三家解析 ===')

await t('三家 URL 各归各家（带/不带 .git / 带 query）', () => {
  const a = detectPlatform('https://gitcode.com/gcw_x/dsh-sync-plugin.git')
  eq([a.platform, a.owner, a.repo], ['gitcode', 'gcw_x', 'dsh-sync-plugin'], 'gitcode .git')
  const b = detectPlatform('https://github.com/EvelynShiao/dsh-sync-plugin')
  eq([b.platform, b.owner, b.repo], ['github', 'EvelynShiao', 'dsh-sync-plugin'], 'github 裸')
  const c = detectPlatform('https://gitee.com/evelynshiao/dsh-sync.git')
  eq([c.platform, c.owner, c.repo], ['gitee', 'evelynshiao', 'dsh-sync'], 'gitee .git')
  const d = detectPlatform('https://gitcode.com/o/r/pulls/1#x')
  eq([d.platform, d.owner, d.repo], ['gitcode', 'o', 'r'], 'gitcode 子路径')
})

await t('非三家/空 URL → null（自建 git 保持 prSkipped 行为）', () => {
  eq(detectPlatform('https://git.local/foo/bar.git'), null, '自建 git')
  eq(detectPlatform('https://bitbucket.org/o/r.git'), null, 'bitbucket 不在三家')
  eq(detectPlatform(''), null, '空串')
  eq(detectPlatform(null), null, 'null')
  eq(detectPlatform('https://gitcode.com/only-owner'), null, '缺 repo 段')
})

console.log('\n=== ② gcIfBloated：孤儿占比线可配置 ===')

await t('高占比线（0.9）：50% 孤儿不触发 gc', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(1), 'base')
    commitFile(r.repo, 'b.bin', blob(2), 'second')
    packAll(r.repo)
    g(r.repo, 'reset', '-q', '--hard', 'HEAD~1') // ~2MB 孤儿 / ~3MB pack ≈ 60%
    const st = await packOrphanStats('git', r.repo)
    ok(st.orphanRatio >= 0.3 && st.orphanRatio < 0.9, `前置：占比应在 [0.3,0.9)，实得 ${st.orphanRatio.toFixed(2)}`)
    const lg = logger()
    await gcIfBloated('git', r.repo, { repoGcThresholdMB: 9999, gcOrphanRatio: 0.9, gcOrphanMinPackMB: 0.5 }, lg)
    ok(!lg.calls.some(([, m]) => m.includes('自动 git gc')), '高线不应触发 gc: ' + JSON.stringify(lg.calls))
  } finally { cleanup(r) }
})

await t('低占比线（0.3）：同款 50% 孤儿触发 gc 并清零', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(1), 'base')
    commitFile(r.repo, 'b.bin', blob(2), 'second')
    const orphanSha = g(r.repo, 'rev-parse', 'HEAD').trim()
    packAll(r.repo)
    g(r.repo, 'reset', '-q', '--hard', 'HEAD~1')
    const lg = logger()
    await gcIfBloated('git', r.repo, { repoGcThresholdMB: 9999, gcOrphanRatio: 0.3, gcOrphanMinPackMB: 0.5 }, lg)
    ok(lg.calls.some(([, m]) => m.includes('孤儿占比')), '低线应按占比触发: ' + JSON.stringify(lg.calls))
    ok(lg.calls.some(([, m]) => m.includes('30%')), '日志应带配置后的线值 30%: ' + JSON.stringify(lg.calls))
    let gone = false
    try { g(r.repo, 'cat-file', '-t', orphanSha) } catch { gone = true }
    ok(gone, '孤儿对象应被 gc 回收')
  } finally { cleanup(r) }
})

console.log('\n=== ③ rebuildCloudRepoIfBloated：自动删仓总闸 ===')

const BANNER = 'remote: fatal: pack exceeds the limit (1.1 GiB)'

await t('rebuildAutoEnabled=false：横幅命中也拦截，且日志明示开关已关', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(0.5), 'base')
    const lg = logger()
    const eff = { rebuildAutoEnabled: false, repoUrl: 'https://gitcode.com/o/r.git', token: 'x', gitBinary: 'git' }
    const out = await rebuildCloudRepoIfBloated(BANNER, eff, r.repo, {}, lg)
    eq(out, false, '应返回 false')
    ok(lg.calls.some(([, m]) => m.includes('自动删仓重建') && m.includes('已被关闭')), '日志应明示开关已关: ' + JSON.stringify(lg.calls))
  } finally { cleanup(r) }
})

await t('开关缺省（老配置）：不拦截，继续走到平台门禁（无 repoUrl 报不支持）', async () => {
  const r = newRepo()
  try {
    commitFile(r.repo, 'a.bin', blob(0.5), 'base')
    const lg = logger()
    const eff = { gitBinary: 'git' } // 无 rebuildAutoEnabled 字段 = 老配置，默认放行
    const out = await rebuildCloudRepoIfBloated(BANNER, eff, r.repo, {}, lg)
    eq(out, false, '平台门禁应拒绝（repoUrl 缺失）')
    ok(lg.calls.some(([, m]) => m.includes('不受支持')), '应卡在平台门禁而非总闸: ' + JSON.stringify(lg.calls))
  } finally { cleanup(r) }
})

console.log('\n=== ④ platformRequest：三家认证分派（无网，fetch 桩） ===')

const origFetch = globalThis.fetch
try {
  let captured = null
  globalThis.fetch = async (url, init) => { captured = { url: String(url), init }; return { ok: true, status: 200, text: async () => '{"private":true}' } }

  await t('gitcode：PRIVATE-TOKEN 头', async () => {
    await platformRequest('TOK', 'gitcode', 'GET', '/repos/o/r')
    ok(captured.init.headers['PRIVATE-TOKEN'] === 'TOK', '应有 PRIVATE-TOKEN: ' + JSON.stringify(captured.init.headers))
    ok(captured.url.startsWith('https://api.gitcode.com/api/v5/repos/o/r'), 'base 应为 gitcode v5: ' + captured.url)
  })

  await t('github：Authorization Bearer 头', async () => {
    await platformRequest('TOK', 'github', 'GET', '/repos/o/r')
    ok(captured.init.headers['Authorization'] === 'Bearer TOK', '应为 Bearer: ' + JSON.stringify(captured.init.headers))
    ok(captured.url.startsWith('https://api.github.com/repos/o/r'), 'base 应为 github api: ' + captured.url)
  })

  await t('gitee：access_token 走 query（v5 官方方式）', async () => {
    await platformRequest('TOK', 'gitee', 'GET', '/repos/o/r')
    ok(captured.url.includes('https://gitee.com/api/v5/repos/o/r?access_token=TOK'), 'query 应带 access_token: ' + captured.url)
    ok(!captured.init.headers['PRIVATE-TOKEN'] && !captured.init.headers['Authorization'], '不应带认证头')
  })

  await t('gitee 已带 query 时用 & 续接', async () => {
    await platformRequest('TOK', 'gitee', 'GET', '/repos/o/r/pulls?state=merged')
    ok(captured.url.includes('?state=merged&access_token=TOK'), '应 & 续接: ' + captured.url)
  })

  await t('checkRepoPrivate：github 私仓校验通过（走 detectPlatform 全链）', async () => {
    const r = await checkRepoPrivate('TOK', 'https://github.com/EvelynShiao/dsh-sync.git')
    ok(r.ok === true, '应 ok: ' + JSON.stringify(r))
    eq(r.platform, 'github', 'platform')
    eq(r.defaultBranch, 'main', 'default_branch 缺省 main')
  })

  await t('checkRepoPrivate：公共仓拒绝（private:false）', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"private":false}' })
    const r = await checkRepoPrivate('TOK', 'https://gitee.com/u/r.git')
    ok(r.ok === false && r.isPublic === true, '公共仓应拒: ' + JSON.stringify(r))
  })

  await t('TLS 证书错误 → 系统 curl 回退（桩化 execFileSync，无网）', async () => {
    const cp = require('node:child_process')
    const origExec = cp.execFileSync
    let curlArgs = null
    cp.execFileSync = (cmd, args) => {
      if (String(cmd).includes('curl')) { curlArgs = args; return '{"private":true,"default_branch":"main"}\n200' }
      return origExec(cmd, args)
    }
    try {
      globalThis.fetch = async () => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('cert'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }); throw e }
      const r = await checkRepoPrivate('TOK', 'https://github.com/u/r.git')
      ok(r.ok === true && r.platform === 'github', '证书错误应回退 curl 并成功: ' + JSON.stringify(r))
      ok(Array.isArray(curlArgs) && curlArgs[0] === '-s' && curlArgs.includes('https://api.github.com/repos/u/r'), 'curl 参数应含 -s 与目标 URL')
      ok(curlArgs.some((x) => String(x).includes('Bearer TOK')), 'curl 应带 Bearer 头')
    } finally {
      cp.execFileSync = origExec
      globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"private":true}' })
    }
  })
} finally {
  globalThis.fetch = origFetch
  try { rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
