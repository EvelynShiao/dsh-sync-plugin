/* 提示词同步链路回归测试（2026-10-17）
   覆盖本次修复的 5 个失效点：
   ① mergeOrder 本机字段缺失时不再抹掉云端值
   ② mergeOrder promptWorkshop 深合并（空 versions 不覆盖云端真实版本）
   ③ memoryDbHealth 能识别损坏的 SQLite
   ④ validatePresetLitePatch 拦得住残废/空/丢标记的投影文件
   ⑤ 真实 memory.sqlite 读得出绑定与版本
   跑法：node test/test-prompt-sync.mjs
*/
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
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

// ── 从源码抽出纯函数来测（不启动插件，避免依赖宿主 ctx）──
const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`找不到 ${name}`)
  // 从函数起点做花括号配平
  let i = src.indexOf('{', start), depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error(`${name} 花括号不配平`)
}
// mergeOrder / validatePresetLitePatch 需要的外部符号
const prelude = `
  const join = (...a) => a.join('/')
  const dshHome = () => '/tmp/fake-home'
  const memorySqlitePath = (home) => join(home, 'profiles/web/.dsh-session-kit/memory.sqlite')
`
const factory = new Function(`${prelude}
${extractFn('validatePresetLitePatch')}
${extractFn('mergeOrder')}
return { validatePresetLitePatch, mergeOrder }`)
const { validatePresetLitePatch, mergeOrder } = factory()

console.log('\n① mergeOrder：本机读不到 ≠ 抹掉云端')
t('本机无 promptBindings 字段时，云端绑定原样保留', () => {
  const local = { version: 1, workspaces: ['Evelyn'], sessions: { Evelyn: ['s1'] } }
  const cloud = {
    version: 1, workspaces: ['Evelyn'], sessions: {},
    promptBindings: { Evelyn: 'lite', 学习: 'lite-plain' },
  }
  const out = mergeOrder(local, cloud)
  eq(out.promptBindings, { Evelyn: 'lite', 学习: 'lite-plain' }, '云端绑定被丢了')
})
t('本机标记 _promptUnreadable 时，云端绑定原样保留（即使本机有旧值）', () => {
  const local = { version: 1, workspaces: ['Evelyn'], sessions: {}, promptBindings: { Evelyn: 'lite-plain' } }
  Object.defineProperty(local, '_promptUnreadable', { value: true, enumerable: false })
  const cloud = { version: 1, workspaces: [], sessions: {}, promptBindings: { Evelyn: 'lite', 作文: 'lite-v2' } }
  const out = mergeOrder(local, cloud)
  eq(out.promptBindings, { Evelyn: 'lite', 作文: 'lite-v2' }, '不可信本机状态覆盖了云端')
})
t('两边都有绑定：键并集，本机同键赢', () => {
  const local = { version: 1, workspaces: [], sessions: {}, promptBindings: { Evelyn: 'lite', 学习: 'lite-v3' } }
  const cloud = { version: 1, workspaces: [], sessions: {}, promptBindings: { Evelyn: 'lite-plain', 作文: 'lite-v2' } }
  const out = mergeOrder(local, cloud)
  eq(out.promptBindings, { Evelyn: 'lite', 作文: 'lite-v2', 学习: 'lite-v3' })
})
t('_promptUnreadable 不会被写进输出（不污染云端文件）', () => {
  const local = { version: 1, workspaces: [], sessions: {} }
  Object.defineProperty(local, '_promptUnreadable', { value: true, enumerable: false })
  const out = mergeOrder(local, { version: 1, workspaces: [], sessions: {} })
  ok(!('_promptUnreadable' in out), '标记泄漏进输出')
  ok(!JSON.stringify(out).includes('_promptUnreadable'), '标记被序列化')
})

console.log('\n② mergeOrder：promptWorkshop 深合并')
t('本机 versions 为空时，云端真实版本列表保留', () => {
  const local = { version: 1, workspaces: [], sessions: {}, promptWorkshop: { versions: [], bindings: {}, autoApply: true } }
  const cloud = { version: 1, workspaces: [], sessions: {}, promptWorkshop: {
    versions: [{ presetId: 'lite-plain', name: '普通节约', text: 'x' }], bindings: { 学习: 'lite-plain' }, autoApply: true } }
  const out = mergeOrder(local, cloud)
  eq(out.promptWorkshop.versions.length, 1, '云端版本被空数组覆盖')
  eq(out.promptWorkshop.versions[0].presetId, 'lite-plain')
})
t('本机有版本时以本机为准（本机是真源）', () => {
  const local = { version: 1, workspaces: [], sessions: {}, promptWorkshop: {
    versions: [{ presetId: 'lite-v3', name: 'Learning', text: 'y' }], bindings: {}, autoApply: false } }
  const cloud = { version: 1, workspaces: [], sessions: {}, promptWorkshop: {
    versions: [{ presetId: 'lite-plain', name: '普通节约', text: 'x' }], bindings: {}, autoApply: true } }
  const out = mergeOrder(local, cloud)
  eq(out.promptWorkshop.versions[0].presetId, 'lite-v3')
  eq(out.promptWorkshop.autoApply, false, 'autoApply 应以本机为准')
})
t('bindings 键并集（云端独有工作区不丢）', () => {
  const local = { version: 1, workspaces: [], sessions: {}, promptWorkshop: {
    versions: [{ presetId: 'a', name: 'a', text: 'x' }], bindings: { Evelyn: 'lite' }, autoApply: true } }
  const cloud = { version: 1, workspaces: [], sessions: {}, promptWorkshop: {
    versions: [], bindings: { Evelyn: 'lite-plain', 作文: 'lite-v2' }, autoApply: true } }
  const out = mergeOrder(local, cloud)
  eq(out.promptWorkshop.bindings, { Evelyn: 'lite', 作文: 'lite-v2' })
})
t('云端没有该字段时不凭空造出来', () => {
  const local = { version: 1, workspaces: [], sessions: {}, promptBindings: { Evelyn: 'lite' } }
  const out = mergeOrder(local, { version: 1, workspaces: [], sessions: {} })
  eq(out.promptBindings, { Evelyn: 'lite' })
  ok(!('promptWorkshop' in out), '凭空造了 promptWorkshop')
})

console.log('\n③ memoryDbHealth：识别损坏的 SQLite（调用源码里的真函数）')
t('健康库 → ok；截断库 → 不 ok', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshsync-'))
  try {
    const p = join(dir, 'profiles/web/.dsh-session-kit')
    require('node:fs').mkdirSync(p, { recursive: true })
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(join(p, 'memory.sqlite'))
    db.exec("CREATE TABLE memory_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
    db.exec("INSERT INTO memory_settings VALUES ('promptWorkshop','{}',0)")
    db.close()
    // 用源码里的 memoryDbHealth，只把 memorySqlitePath 的 home 换成临时目录
    const makeHealth = new Function('memorySqlitePath', 'require', `
      ${extractFn('memoryDbHealth')}
      return memoryDbHealth`)
    const health = makeHealth((home) => join(home, 'profiles/web/.dsh-session-kit/memory.sqlite'), require)
    eq(health(dir), { ok: true }, '健康库被判为损坏')
    const f = join(p, 'memory.sqlite')
    const buf = readFileSync(f)
    writeFileSync(f, buf.subarray(0, Math.max(1024, buf.length - 2048)))
    const bad = health(dir)
    ok(!bad.ok, '截断的库仍被判为健康')
    ok(typeof bad.reason === 'string' && bad.reason.length > 0, '损坏时没有给出原因')
    console.log(`      （截断库被识别，原因：${bad.reason.split('\n')[0]}）`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log('\n④ validatePresetLitePatch：拦残废投影文件')
const GOOD = `- insert:
    - id: preset-lite
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: lite
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              # >>> workshop:dafeyu >>>
              prefix: |
                ${'x'.repeat(600)}
              # <<< workshop:dafeyu <<<
`
t('合法文件通过', () => eq(validatePresetLitePatch(GOOD), { ok: true }))
t('空文件被拒', () => ok(!validatePresetLitePatch('').ok))
t('过短文件被拒', () => ok(!validatePresetLitePatch('x'.repeat(100)).ok))
t('丢 dafeyu 起始标记被拒', () => ok(!validatePresetLitePatch(GOOD.replace('# >>> workshop:dafeyu >>>', '')).ok))
t('丢 dafeyu 结束标记被拒', () => ok(!validatePresetLitePatch(GOOD.replace('# <<< workshop:dafeyu <<<', '')).ok))
t('丢 preset-lite 声明被拒', () => ok(!validatePresetLitePatch(GOOD.replace('id: preset-lite', 'id: other')).ok))
t('丢 persona 声明被拒', () => ok(!validatePresetLitePatch(GOOD.replace('id: persona', 'id: nobody')).ok))
t('非字符串被拒', () => ok(!validatePresetLitePatch(null).ok))

console.log('\n⑤ 真实 memory.sqlite：绑定与版本读得出')
t('promptWorkshop 行可解析且含 versions', () => {
  const home = process.env.DSH_HOME || '/root/.dsh'
  const dbPath = join(home, 'profiles/web/.dsh-session-kit/memory.sqlite')
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    ok(db.prepare('PRAGMA quick_check').get(), 'quick_check 无结果')
    const row = db.prepare("SELECT value FROM memory_settings WHERE key='promptWorkshop'").get()
    ok(row?.value, '没有 promptWorkshop 行')
    const j = JSON.parse(row.value)
    ok(Array.isArray(j.versions), 'versions 不是数组')
    ok(j.versions.length > 0, 'versions 为空')
    ok(j.workspacePresets && Object.keys(j.workspacePresets).length > 0, 'workspacePresets 为空')
    console.log(`      （versions=${j.versions.length} bindings=${Object.keys(j.workspacePresets).length}）`)
  } finally { db.close() }
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
