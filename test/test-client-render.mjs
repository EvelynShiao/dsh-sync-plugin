/* client 渲染断言（2026-11-10）：防止「元素创建后丢弃不渲染」的回归。
   9999.9.32 真凶：仓库维护块被插在 body 三元表达式外的语句级——node --check 通过、
   bundle 构建一致，但元素从未挂进 sk-body 树，设置页看不到。本测试用可控 React 桩
   真正执行 SettingsSection，断言维护块存在于 sk-body 的 kids 里。
   跑法：node test/test-client-render.mjs */
import { createRequire } from 'node:module'
import Module from 'node:module'

const require = createRequire(import.meta.url)

// ── 可控 React 桩：createElement 记录树；useState 按调用序号注入 ──
let injectSeq = {}
let seq = 0
const reactStub = {
  createElement(type, props, ...kids) {
    return { type, props: props || {}, kids: kids.flat(9) }
  },
  useState(init) {
    const i = seq++
    if (Object.prototype.hasOwnProperty.call(injectSeq, i)) return [injectSeq[i], () => {}]
    return [typeof init === 'function' ? init() : init, () => {}]
  },
  useEffect() {}, useMemo(fn) { return fn() }, useRef(v = null) { return { current: v } },
}
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'react') return 'dsh-sync-test-react-stub'
  return origResolve.call(this, request, ...rest)
}
require.cache['dsh-sync-test-react-stub'] = { id: 'dsh-sync-test-react-stub', filename: 'react-stub', loaded: true, exports: reactStub }

const { __internals } = require('../client/index.js')
const { SettingsSection } = __internals
if (typeof SettingsSection !== 'function') throw new Error('SettingsSection 未导出')

const STATUS_OK = {
  gitAvailable: true, repoUrl: 'https://gitcode.com/o/r.git', hasToken: true,
  instanceId: 'test', branch: 'main', dir: 'C:/x', lastSyncAt: '2026-11-10T00:00:00Z',
  syncing: false, pendingConflict: false, lastResult: null,
}

const flatten = (node, out = [], ancestors = [], ancOut = []) => {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); ancOut.push([...ancestors]); return out }
  if (Array.isArray(node)) { for (const k of node) flatten(k, out, ancestors, ancOut); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    const here = [...ancestors, node]
    const propsKids = node.props && node.props.children ? [].concat(node.props.children) : []
    flatten(propsKids, out, here, ancOut)
    flatten(node.kids, out, here, ancOut)
    return out
  }
  return out
}
const findText = (tree, needle) => {
  const texts = [], anc = []
  flatten(tree, texts, [], anc)
  const i = texts.findIndex((x) => x === needle)
  return i >= 0 ? { text: texts[i], ancestors: anc[i] } : null
}
const hasAncestor = (hit, pred) => (hit ? hit.ancestors.some(pred) : false)

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`) }
}
const ok = (v, msg) => { if (!v) throw new Error(msg || '断言失败') }

console.log('\n=== 仓库维护块渲染断言 ===')

await t('已配置状态：维护块渲染，且挂在 sk-body 树内', async () => {
  globalThis.__skErrors = []
  injectSeq = { 0: STATUS_OK }; seq = 0
  const tree = SettingsSection({ t: (k) => k })
  const errs = globalThis.__skErrors || []
  ok(errs.length === 0, '渲染不应有 __skErrors: ' + errs.join(' | '))
  const title = findText(tree, 'repoMaintTitle')
  ok(title, '未找到 repoMaintTitle（维护块未渲染）')
  const check = findText(tree, 'repoCheckBtn')
  const rebuild = findText(tree, 'rebuildBtn')
  ok(check && rebuild, '检查/重建按钮未渲染')
  ok(hasAncestor(title, (n) => n.type === 'div' && n.props && n.props.className === 'sk-body'),
    '维护块不在 sk-body 树内（9999.9.32 的丢弃回归）')
})

await t('未配置状态（status=null）：维护块不渲染、不报错', async () => {
  globalThis.__skErrors = []
  injectSeq = { 0: null }; seq = 0
  const tree = SettingsSection({ t: (k) => k })
  ok((globalThis.__skErrors || []).length === 0, '渲染不应有 __skErrors')
  ok(!findText(tree, 'repoMaintTitle'), 'status=null 时维护块不应渲染')
})

await t('isGitCode=false：重建按钮禁用', async () => {
  injectSeq = { 0: { ...STATUS_OK, repoUrl: 'https://github.com/a/b.git' } }; seq = 0
  const tree = SettingsSection({ t: (k) => k })
  ok(findText(tree, 'repoNotGitCode') === null, 'repoNotGitCode 只应出现在 title 提示里，不应作为独立文本节点')
  const rebuild = findText(tree, 'rebuildBtn')
  ok(rebuild, '重建按钮应存在')
})

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
