// 括号深度追踪：确认 L1039-1044 仓库维护块挂在哪一层
const fs = require('fs')
const src = fs.readFileSync('C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/work/Evelyn/dsh-sync-plugin-src/client/index.js', 'utf8')
const lines = src.split('\n')
let depth = 0, inStr = null, esc = false, inTpl = false
const events = []
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i]
  for (let j = 0; j < ln.length; j++) {
    const c = ln[j]
    if (inStr) { if (esc) { esc = false; continue } if (c === '\\') { esc = true; continue } if (c === inStr) inStr = null; continue }
    if (inTpl) { if (c === '\\') continue; if (c === '`') inTpl = false; continue }
    if (c === '"' || c === "'") { inStr = c; continue }
    if (c === '`') { inTpl = true; continue }
    const line = i + 1
    if (c === '(' || c === '{' || c === '[') { depth++; if (line >= 941 && line <= 1045) events.push({ line, col: j + 1, depth, t: c }) }
    else if (c === ')' || c === '}' || c === ']') { depth--; if (line >= 941 && line <= 1045) events.push({ line, col: j + 1, depth, t: 'close' + c }) }
  }
}
const skBody = events.find((e) => e.line === 941 && e.t === '(')
console.log('sk-body 行941 开括号 depth =', skBody ? skBody.depth : 'N/A')
const l1038 = events.filter((e) => e.line === 1038)
console.log('L1038 结束后 depth =', l1038.length ? l1038[l1038.length - 1].depth : 'N/A')
const l1039 = events.filter((e) => e.line === 1039)
console.log('L1039 新块 h( 的 depth =', l1039.length ? l1039[0].depth : 'N/A')
const l1040 = events.filter((e) => e.line === 1040 && e.t === '(')
console.log('L1040 repoMaintTitle h( 的 depth =', l1040.length ? l1040[0].depth : 'N/A')
const l1044 = events.filter((e) => e.line === 1044)
console.log('L1044 结束后 depth =', l1044.length ? l1044[l1044.length - 1].depth : 'N/A')
