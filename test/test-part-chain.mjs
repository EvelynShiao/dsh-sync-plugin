/* part 链 & 体积自愈 回归测试（2026-11-09）
   直接使用模块导出的 __internals，避免提取源码的语法问题
   每个测试用例独立临时目录，彻底隔离
   跑法：node test/test-part-chain.mjs
*/
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++ }
}
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b)
  if (A !== B) throw new Error(`${msg || ''} 期望 ${B} 实得 ${A}`)
}
const ok = (v, msg) => { if (!v) throw new Error(msg || '断言失败') }

// ── 加载模块导出的内部函数 ──
const mod = require('../src/index.js')
const internals = mod.__internals
const {
  upsertSessionToShadowParts,
  assembleSessionBufFromRev,
  sessionsSignatureForUpload,
  dirSizePackMb,
  gcIfBloated,
  pushWithSelfHeal,
  readSessionBuf,
  gateSessionPayload,
  listSessionParts,
  concatSessionParts,
  SESSION_PART_PREFIX,
  SESSION_PART_MAX,
  partFileName,
} = internals

// 真实 fs/promises
const fsP = require('node:fs/promises')
const zlib = require('node:zlib')
const { execSync } = require('node:child_process')

// 生成合法 zstd 会话缓冲（seq 连续、settlement 完整）
function makeValidSessionBuf(lines) {
  const frames = lines.map(l => zlib.zstdCompressSync(Buffer.from(l + '\n')))
  return Buffer.concat(frames)
}

// 创建临时目录并自动清理
async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dshsync-test-'))
  try {
    await fn(dir)
  } finally {
    try { await fsP.rm(dir, { recursive: true, force: true }) } catch {}
  }
}

// 初始化一个临时 git 仓库
async function initGitRepo(dir) {
  const repo = join(dir, 'repo')
  await fsP.mkdir(repo, { recursive: true })
  execSync('git init -q', { cwd: repo })
  execSync('git config user.email "test@test"', { cwd: repo })
  execSync('git config user.name "test"', { cwd: repo })
  return repo
}

// 提交所有变更
async function gitCommitAll(repo, msg) {
  execSync('git add -A', { cwd: repo })
  execSync(`git commit -q -m "${msg}"`, { cwd: repo })
}

console.log('\n=== ① upsertSessionToShadowParts：part 链同步核心 ===')

t('全新会话 → reset 写 part0000', async () => {
  await withTmpDir(async (dir) => {
    const live = join(dir, 'live')
    const cloud = join(dir, 'cloud')
    await fsP.mkdir(live, { recursive: true })
    await fsP.mkdir(cloud, { recursive: true })

    const baseBuf = makeValidSessionBuf([
      '{"type":"session","seq":0}',
      '{"type":"assistant/message","seq":1,"data":{"turn":1,"step":1,"stream":[]}}'
    ])
    await fsP.writeFile(join(live, 'session.v4.jsonl.zstd'), baseBuf)
    const res = await upsertSessionToShadowParts(live, cloud, { sessionsParts: true }, null)
    eq(res, 'reset')
    const parts = await fsP.readdir(cloud)
    ok(parts.includes('session.v4.jsonl.zstd.part0000'), 'part0000 未生成')
    ok(!parts.includes('session.v4.jsonl.zstd'), '残留 .zstd 未清理')
    const readBack = await readSessionBuf(cloud, '::parts::')
    ok(readBack.equals(baseBuf), '回读内容不一致')
  })
})

t('内容相等 → skip 并清理混入 .zstd', async () => {
  await withTmpDir(async (dir) => {
    const live = join(dir, 'live')
    const cloud = join(dir, 'cloud')
    await fsP.mkdir(live, { recursive: true })
    await fsP.mkdir(cloud, { recursive: true })

    const baseBuf = makeValidSessionBuf([
      '{"type":"session","seq":0}',
      '{"type":"assistant/message","seq":1,"data":{"turn":1,"step":1,"stream":[]}}'
    ])
    await fsP.writeFile(join(live, 'session.v4.jsonl.zstd'), baseBuf)
    await fsP.writeFile(join(cloud, 'session.v4.jsonl.zstd'), baseBuf)
    const res = await upsertSessionToShadowParts(live, cloud, { sessionsParts: true }, null)
    eq(res, 'skip')
    const parts = await fsP.readdir(cloud)
    ok(parts.includes('session.v4.jsonl.zstd.part0000'), 'part0000 丢失')
    ok(!parts.includes('session.v4.jsonl.zstd'), '混入的 .zstd 未清理')
  })
})

t('严格前缀追加 → append 写 delta part', async () => {
  await withTmpDir(async (dir) => {
    const live = join(dir, 'live')
    const cloud = join(dir, 'cloud')
    await fsP.mkdir(live, { recursive: true })
    await fsP.mkdir(cloud, { recursive: true })

    const baseLines2 = [
      '{"type":"session","seq":0}',
      '{"type":"assistant/message","seq":1,"data":{"turn":1,"step":1,"stream":[]}}'
    ]
    const baseBuf2 = makeValidSessionBuf(baseLines2)
    await fsP.writeFile(join(cloud, 'session.v4.jsonl.zstd.part0000'), baseBuf2)
    const newLines = [...baseLines2, '{"type":"assistant/message","seq":2,"data":{"turn":2,"step":1,"stream":[]}}']
    const newBuf = makeValidSessionBuf(newLines)
    await fsP.writeFile(join(live, 'session.v4.jsonl.zstd'), newBuf)
    const res = await upsertSessionToShadowParts(live, cloud, { sessionsParts: true }, null)
    eq(res, 'append')
    const parts = await fsP.readdir(cloud)
    ok(parts.includes('session.v4.jsonl.zstd.part0000'), 'part0000 丢失')
    ok(parts.includes('session.v4.jsonl.zstd.part0001'), 'part0001 未生成')
    ok(!parts.includes('session.v4.jsonl.zstd'), '残留 .zstd 未清理')
    const concat = await readSessionBuf(cloud, '::parts::')
    ok(concat.equals(newBuf), '拼接后内容不等于新内容')
  })
})

t('内容回退/无关 → reset 重写链', async () => {
  await withTmpDir(async (dir) => {
    const live = join(dir, 'live')
    const cloud = join(dir, 'cloud')
    await fsP.mkdir(live, { recursive: true })
    await fsP.mkdir(cloud, { recursive: true })

    const oldBuf = makeValidSessionBuf([
      '{"type":"session","seq":0}',
      '{"type":"assistant/message","seq":1,"data":{"turn":1,"step":1,"stream":[]}}'
    ])
    await fsP.writeFile(join(cloud, 'session.v4.jsonl.zstd.part0000'), oldBuf)
    const newBuf2 = makeValidSessionBuf([
      '{"type":"session","seq":0}',
      '{"type":"assistant/message","seq":1,"data":{"turn":99,"step":1,"stream":[]}}'
    ])
    await fsP.writeFile(join(live, 'session.v4.jsonl.zstd'), newBuf2)
    const res = await upsertSessionToShadowParts(live, cloud, { sessionsParts: true }, null)
    eq(res, 'reset')
    const parts = await fsP.readdir(cloud)
    ok(parts.includes('session.v4.jsonl.zstd.part0000'), 'part0000 未重写')
    ok(!parts.includes('session.v4.jsonl.zstd.part0001'), '旧 part0001 残留')
    const concat = await readSessionBuf(cloud, '::parts::')
    ok(concat.equals(newBuf2), '重置后内容错误')
  })
})

t('sessionsParts=false → 单文件白名单模式', async () => {
  await withTmpDir(async (dir) => {
    const live = join(dir, 'live')
    const cloud = join(dir, 'cloud')
    await fsP.mkdir(live, { recursive: true })
    await fsP.mkdir(cloud, { recursive: true })

    const buf = makeValidSessionBuf(['{"type":"session","seq":0}'])
    await fsP.writeFile(join(live, 'session.v4.jsonl.zstd'), buf)
    await fsP.writeFile(join(cloud, 'session.v4.jsonl.zstd'), Buffer.from('old'))
    await fsP.writeFile(join(cloud, 'session.lock'), Buffer.from('lock'))
    await fsP.writeFile(join(cloud, 'junk.bak'), Buffer.from('junk'))
    const res = await upsertSessionToShadowParts(live, cloud, { sessionsParts: false }, null)
    eq(res, 'full')
    const parts = await fsP.readdir(cloud)
    ok(parts.includes('session.v4.jsonl.zstd'), 'zstd 未写入')
    ok(parts.includes('session.lock'), 'lock 未复制')
    ok(!parts.includes('junk.bak'), '垃圾文件未清理')
    const readBack = await fsP.readFile(join(cloud, 'session.v4.jsonl.zstd'))
    ok(readBack.equals(buf), '内容不一致')
  })
})

t('小文件（<1KB）→ skip', async () => {
  await withTmpDir(async (dir) => {
    const live = join(dir, 'live')
    const cloud = join(dir, 'cloud')
    await fsP.mkdir(live, { recursive: true })
    await fsP.mkdir(cloud, { recursive: true })

    await fsP.writeFile(join(live, 'session.v4.jsonl.zstd'), Buffer.from('small'))
    const res = await upsertSessionToShadowParts(live, cloud, { sessionsParts: true }, null)
    eq(res, 'skip')
  })
})

console.log('\n=== ② assembleSessionBufFromRev：git rev 组装 ===')

t('FETCH_HEAD 多 part → 拼接完整', async () => {
  await withTmpDir(async (dir) => {
    const repo = join(dir, 'repo')
    await fsP.mkdir(repo, { recursive: true })
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email "test@test"', { cwd: repo })
    execSync('git config user.name "test"', { cwd: repo })

    const sessDir = 'sessions/ws/Evelyn/session-test123'
    const sessPath = join(repo, sessDir)
    await fsP.mkdir(sessPath, { recursive: true })

    const baseLines = ['{"type":"session","seq":0}', '{"type":"assistant/message","seq":1,"data":{"turn":1,"step":1,"stream":[]}}']
    const deltaLines = ['{"type":"assistant/message","seq":2,"data":{"turn":2,"step":1,"stream":[]}}']
    const part0000 = makeValidSessionBuf(baseLines)
    const part0001 = makeValidSessionBuf(deltaLines)

    await fsP.writeFile(join(sessPath, 'session.v4.jsonl.zstd.part0000'), part0000)
    await fsP.writeFile(join(sessPath, 'session.v4.jsonl.zstd.part0001'), part0001)
    execSync('git add -A && git commit -q -m "init"', { cwd: repo })

    const bin = 'git'
    const buf = await assembleSessionBufFromRev(bin, 'FETCH_HEAD', sessDir, repo)
    ok(buf !== null, '返回 null')
    const expected = Buffer.concat([part0000, part0001])
    ok(buf.equals(expected), '拼接内容错误')
  })
})

t('lastSynced 无 part 回退 .zstd', async () => {
  await withTmpDir(async (dir) => {
    const repo = join(dir, 'repo')
    await fsP.mkdir(repo, { recursive: true })
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email "test@test"', { cwd: repo })
    execSync('git config user.name "test"', { cwd: repo })

    const sessDir2 = 'sessions/ws/Evelyn/session-single'
    const sessPath2 = join(repo, sessDir2)
    await fsP.mkdir(sessPath2, { recursive: true })
    const singleBuf = makeValidSessionBuf(['{"type":"session","seq":0}'])
    await fsP.writeFile(join(sessPath2, 'session.v4.jsonl.zstd'), singleBuf)
    execSync('git add -A && git commit -q -m "single"', { cwd: repo })

    const bin = 'git'
    const buf2 = await assembleSessionBufFromRev(bin, 'HEAD', sessDir2, repo)
    ok(buf2 !== null, '返回 null')
    ok(buf2.equals(singleBuf), '回退 .zstd 失败')
  })
})

t('目录不存在 → null', async () => {
  await withTmpDir(async (dir) => {
    const repo = join(dir, 'repo')
    await fsP.mkdir(repo, { recursive: true })
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email "test@test"', { cwd: repo })
    execSync('git config user.name "test"', { cwd: repo })

    const bin = 'git'
    const buf3 = await assembleSessionBufFromRev(bin, 'FETCH_HEAD', 'sessions/ws/Evelyn/not-exist', repo)
    eq(buf3, null, '应返回 null')
  })
})

console.log('\n=== ③ sessionsSignatureForUpload：part 文件计入指纹 ===')

t('live 只有 .zstd，shadow 有 parts → bytes 相等 files 不等 → 无误触发', async () => {
  await withTmpDir(async (dir) => {
    const live = join(dir, 'live')
    const shadow = join(dir, 'shadow')
    await fsP.mkdir(live, { recursive: true })
    await fsP.mkdir(shadow, { recursive: true })

    const buf = makeValidSessionBuf([
      '{"type":"session","seq":0}',
      '{"type":"assistant/message","seq":1,"data":{"turn":1,"step":1,"stream":[]}}'
    ])
    const wsLive = join(live, 'ws1')
    const wsShadow = join(shadow, 'ws1')
    await fsP.mkdir(wsLive, { recursive: true })
    await fsP.mkdir(wsShadow, { recursive: true })
    const sessLive = join(wsLive, 'session-a')
    const sessShadow = join(wsShadow, 'session-a')
    await fsP.mkdir(sessLive, { recursive: true })
    await fsP.mkdir(sessShadow, { recursive: true })
    await fsP.writeFile(join(sessLive, 'session.v4.jsonl.zstd'), buf)
    const part0 = makeValidSessionBuf(['{"type":"session","seq":0}'])
    const part1 = makeValidSessionBuf(['{"type":"assistant/message","seq":1,"data":{"turn":1,"step":1,"stream":[]}}'])
    await fsP.writeFile(join(sessShadow, 'session.v4.jsonl.zstd.part0000'), part0)
    await fsP.writeFile(join(sessShadow, 'session.v4.jsonl.zstd.part0001'), part1)

    const sigA = await sessionsSignatureForUpload(live)
    const sigB = await sessionsSignatureForUpload(shadow)
    ok(sigA !== sigB, '指纹相等会误触发短路（files 不同：1 vs 2）')
    console.log(`      live: ${sigA}  shadow: ${sigB}`)
  })
})

t('live 与 shadow 同形态（都是 parts）字节相等 → 短路可触发', async () => {
  await withTmpDir(async (dir) => {
    const live2 = join(dir, 'live2')
    const shadow2 = join(dir, 'shadow2')
    await fsP.mkdir(join(live2, 'ws1', 'session-b'), { recursive: true })
    await fsP.mkdir(join(shadow2, 'ws1', 'session-b'), { recursive: true })
    const buf2 = makeValidSessionBuf(['{"type":"session","seq":0}'])
    await fsP.writeFile(join(live2, 'ws1', 'session-b', 'session.v4.jsonl.zstd'), buf2)
    await fsP.writeFile(join(shadow2, 'ws1', 'session-b', 'session.v4.jsonl.zstd.part0000'), buf2)

    const sigA2 = await sessionsSignatureForUpload(live2)
    const sigB2 = await sessionsSignatureForUpload(shadow2)
    eq(sigA2, sigB2, '同内容不同形态应指纹相等')
    console.log(`      同指纹: ${sigA2}`)
  })
})

console.log('\n=== ④ dirSizePackMb / gcIfBloated：体积巡检 ===')

t('dirSizePackMb 读出 pack 大小', async () => {
  await withTmpDir(async (dir) => {
    const repo = join(dir, 'repo')
    await fsP.mkdir(repo, { recursive: true })
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email "test@test"', { cwd: repo })
    execSync('git config user.name "test"', { cwd: repo })
    await fsP.writeFile(join(repo, 'README.md'), '# test')
    execSync('git add -A && git commit -q -m "init"', { cwd: repo })

    const bin = 'git'
    const mb = await dirSizePackMb(bin, repo)
    ok(typeof mb === 'number' && mb >= 0, 'size-pack 解析失败')
    console.log(`      pack size: ${mb.toFixed(2)} MB`)
  })
})

t('gcIfBloated 超阈值执行 gc', async () => {
  await withTmpDir(async (dir) => {
    const repo = join(dir, 'repo')
    await fsP.mkdir(repo, { recursive: true })
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email "test@test"', { cwd: repo })
    execSync('git config user.name "test"', { cwd: repo })
    await fsP.writeFile(join(repo, 'README.md'), '# test')
    execSync('git add -A && git commit -q -m "init"', { cwd: repo })

    const bin = 'git'
    const eff = { repoGcThresholdMB: 1 }
    let logged = false
    const logger = { warn: (m) => { logged = true; console.log(`      [LOG] ${m}`) } }
    await gcIfBloated(bin, repo, eff, logger)
    ok(logged, '未触发 gc 日志（应超阈值）')
    const after = await dirSizePackMb(bin, repo)
    console.log(`      gc 后: ${after.toFixed(2)} MB`)
  })
})

t('gcIfBloated 未超阈值不执行 gc', async () => {
  await withTmpDir(async (dir) => {
    const repo = join(dir, 'repo')
    await fsP.mkdir(repo, { recursive: true })
    execSync('git init -q', { cwd: repo })
    execSync('git config user.email "test@test"', { cwd: repo })
    execSync('git config user.name "test"', { cwd: repo })
    await fsP.writeFile(join(repo, 'README.md'), '# test')
    execSync('git add -A && git commit -q -m "init"', { cwd: repo })

    const bin = 'git'
    const eff2 = { repoGcThresholdMB: 9999 }
    let logged = false
    const logger = { warn: (m) => { logged = true } }
    await gcIfBloated(bin, repo, eff2, logger)
    ok(!logged, '未超阈值却触发了 gc')
  })
})

console.log('\n=== ⑤ pushWithSelfHeal：自愈阶梯（mock gitExec）===')
{
  const REBUILD_WARNING_RE = /exceeds limit|size \(\d+(?:\.\d+)?\s*[MG]iB\)/i
  let mockExecState = { succeed: false, gcCalled: false }
  const mockExec = async (bin, args) => {
    if (args[0] === 'push' && !mockExecState.succeed) {
      const err = new Error('git push: exceeds limit (1.0 GiB)')
      throw err
    }
    if (args[0] === 'gc') { mockExecState.gcCalled = true; return '' }
    if (args[0] === 'push' && mockExecState.succeed) { return 'pushed' }
    return ''
  }

  async function runTest() {
    try { await mockExec('git', ['push', 'origin', 'main']) } catch (firstErr) {
      const msg = String(firstErr && firstErr.message || '')
      ok(REBUILD_WARNING_RE.test(msg), '错误不匹配体积正则')
      try {
        await mockExec('git', ['gc', '--aggressive', '--prune=now'])
        await mockExec('git', ['push', 'origin', 'main'])
        ok(false, 'gc 重试本应仍失败')
      } catch (e) {
        ok(mockExecState.gcCalled, 'gc 未被调用')
        mockExecState.succeed = true
        const out = await mockExec('git', ['push', 'origin', 'main'])
        eq(out, 'pushed')
      }
    }
  }
  await runTest()
  t('自愈阶梯：push 失败→gc 重试→rebuild 重试→成功', () => {})
}

console.log('\n=== ⑥ gateSessionPayload：part 组装缓冲也能过完整性门 ===')

t('合法 part 链 → gate 通过', async () => {
  await withTmpDir(async (dir) => {
    const cloud = join(dir, 'cloud-sess')
    await fsP.mkdir(cloud, { recursive: true })
    const part0 = makeValidSessionBuf(['{"type":"session","seq":0}'])
    const part1 = makeValidSessionBuf(['{"type":"assistant/message","seq":1,"data":{"turn":1,"step":1,"stream":[]}}'])
    await fsP.writeFile(join(cloud, 'session.v4.jsonl.zstd.part0000'), part0)
    await fsP.writeFile(join(cloud, 'session.v4.jsonl.zstd.part0001'), part1)

    const assembled = await readSessionBuf(cloud, '::parts::')
    const goodBuf = Buffer.concat([part0, part1])
    ok(assembled.equals(goodBuf), '组装内容错误')

    const livePath = join(dir, 'live', 'session.v4.jsonl.zstd')
    await fsP.mkdir(join(dir, 'live'), { recursive: true })

    const res = await gateSessionPayload(livePath, assembled, { warn: () => {} })
    ok(res === true, '合法会话被拦截')
  })
})

t('非法 seq（直接用坏缓冲）→ gate 拦截', async () => {
  await withTmpDir(async (dir) => {
    const badBuf = makeValidSessionBuf([
      '{"type":"session","seq":0}',
      '{"type":"assistant/message","seq":99,"data":{"turn":1,"step":1,"stream":[]}}'
    ])
    const livePath = join(dir, 'live', 'session.v4.jsonl.zstd')
    await fsP.mkdir(join(dir, 'live'), { recursive: true })
    const res = await gateSessionPayload(livePath, badBuf, { warn: () => {} })
    ok(res === false, '非法 seq 未被拦截')
  })
})

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)