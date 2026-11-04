#!/usr/bin/env node
/**
 * build-client.mjs — 把 client/index.js 包成宿主插件加载器认的 client/bundle.js。
 *
 * 【为什么补这个文件】2026-11-04：client/bundle.js 是宿主 web 端实际加载的入口
 * （package.json exports["./client"]），但它曾长期落后于 client/index.js ——
 * 有人改了 index.js 的文案/开关却没重新构建，UI 上看到的是旧版字符串。
 * 原生成器 scripts/build-client.mjs 在仓库里丢失（历史提交里从未出现过），
 * 只留下 bundle.js 头部一行「Generated from ... — do not edit by hand」。
 * 本文件按现存 bundle.js 的实际形态逆向还原，带 --check 自校验模式，
 * 让「源码与产物不一致」这件事在 CI/手工检查里直接可见。
 *
 * 用法：
 *   node scripts/build-client.mjs           # 重建 client/bundle.js
 *   node scripts/build-client.mjs --check   # 只校验：产物是否等于 index.js 的构建结果（不一致 exit 1）
 *
 * 【格式（从现存 bundle.js 逆向确认，勿凭感觉改）】
 *   10 行头部（生成声明 + ModuleLoader.load({ id, factory }) + require("react")）
 *   + client/index.js 全文逐行缩进 4 空格（空行保持空）
 *   + 3 行尾部（return module.exports / } / })）
 *   换行符沿用 CRLF（与仓库内既有文件一致）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const SRC = path.join(root, 'client', 'index.js')
const OUT = path.join(root, 'client', 'bundle.js')
const PLUGIN_ID = '@weibaohui/dsh-sync'

const HEADER = [
  '/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.',
  ' * Regenerate with: npm run build:client',
  ' */',
  'window.__ModuleLoader__.load({',
  `  id: "${PLUGIN_ID}",`,
  '  factory: (require) => {',
  '    var module = { exports: {} }',
  '    var exports = module.exports',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })',
  '    var React = require("react")',
]

const FOOTER = [
  '    return module.exports',
  '  }',
  '})',
]

/** CRLF 归一 → 行数组（保留末尾空元素，与既有产物一致）。 */
function toLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n')
}

function build(indexText) {
  const lines = toLines(indexText).map((l) => (l === '' ? '' : '    ' + l))
  return HEADER.concat(lines, FOOTER).join('\r\n') + '\r\n'
}

function main() {
  const check = process.argv.includes('--check')
  const srcText = fs.readFileSync(SRC, 'utf8')
  const built = build(srcText)

  if (check) {
    let cur = ''
    try { cur = fs.readFileSync(OUT, 'utf8') } catch {
      console.error('[build-client] 缺少 client/bundle.js')
      process.exit(1)
    }
    if (cur.replace(/\r\n/g, '\n') === built.replace(/\r\n/g, '\n')) {
      console.log('[build-client] OK：bundle.js 与 index.js 一致')
      process.exit(0)
    }
    const a = toLines(cur), b = toLines(built)
    const n = Math.max(a.length, b.length)
    let shown = 0
    for (let i = 0; i < n && shown < 20; i++) {
      if ((a[i] ?? '') !== (b[i] ?? '')) {
        console.error(`[build-client] 第 ${i + 1} 行不一致（现产物 vs 应由 index.js 生成）：`)
        console.error('  产物: ' + String(a[i] ?? '<缺>').slice(0, 160))
        console.error('  应为: ' + String(b[i] ?? '<缺>').slice(0, 160))
        shown++
      }
    }
    console.error('[build-client] 不一致行数过多或结构不同 —— 运行不带 --check 重建')
    process.exit(1)
  }

  fs.writeFileSync(OUT, built)
  console.log(`[build-client] 已写入 ${path.relative(root, OUT)}（${built.split('\r\n').length - 1} 行）`)
}

main()
