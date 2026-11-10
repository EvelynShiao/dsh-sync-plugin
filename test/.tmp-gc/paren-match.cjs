// 括号栈配对：输出 1035-1046 行每个闭括号匹配的开括号位置，以及 sk-body(941) 的关闭行
const fs = require('fs')
const src = fs.readFileSync('C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/work/Evelyn/dsh-sync-plugin-src/client/index.js', 'utf8')
const lines = src.split('\n')
const stack = [] // {ch, line, col}
let inStr = null, esc = false, inTpl = false, tplBrace = [] // ${} 插值支持
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i]
  for (let j = 0; j < ln.length; j++) {
    const c = ln[j]
    if (inStr) { if (esc) { esc = false; continue } if (c === '\\') { esc = true; continue } if (c === inStr) inStr = null; continue }
    if (inTpl) {
      if (c === '\\') { j++; continue }
      if (c === '`') { inTpl = false; continue }
      if (c === '$' && ln[j + 1] === '{') { tplBrace.push(true); stack.push({ ch: '{', line: i + 1, col: j + 1, tpl: true }); j++; continue }
      continue
    }
    if (c === '"' || c === "'") { inStr = c; continue }
    if (c === '`') { inTpl = true; continue }
    if (c === '(' || c === '{' || c === '[') { stack.push({ ch: c, line: i + 1, col: j + 1 }); continue }
    if (c === ')' || c === '}' || c === ']') {
      const top = stack.pop()
      if ((i + 1) >= 1035 && (i + 1) <= 1050 && (c === ')')) {
        console.log(`L${i + 1}:${j + 1} ')' 关闭 <- L${top ? top.line : '?'}:${top ? top.col : '?'} '${top ? top.ch : '?'}'${top && top.tpl ? ' (tpl插值)' : ''}`)
      }
      if (top && top.tpl) { tplBrace.pop() }
      if (!top || top.ch !== { ')': '(', '}': '{', ']': '[' }[c]) {
        console.log(`!! L${i + 1}:${j + 1} 不匹配的 '${c}'，栈顶是 L${top ? top.line : '空'} '${top ? top.ch : ''}'`)
      }
    }
  }
}
const skBody = stack.find((s) => s.line === 941)
console.log('sk-body(941) 是否在文件尾仍未关闭:', !!skBody)
// 找 941 的 ( 的配对——重跑一遍只为 941 输出关闭行
const stack2 = []
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i]
  for (let j = 0; j < ln.length; j++) {
    const c = ln[j]
    if (inStr) { if (esc) { esc = false; continue } if (c === '\\') { esc = true; continue } if (c === inStr) inStr = null; continue }
    if (inTpl) { if (c === '\\') { j++; continue } if (c === '`') inTpl = false; if (c === '$' && ln[j + 1] === '{') { stack2.push({ ch: '{', tpl: true }); j++ } continue }
    if (c === '"' || c === "'") { inStr = c; continue }
    if (c === '`') { inTpl = true; continue }
    if (c === '(' || c === '{' || c === '[') { stack2.push({ ch: c, line: i + 1, tpl: false }); continue }
    if (c === ')' || c === '}' || c === ']') {
      const top = stack2.pop()
      if (top && top.line === 941 && top.ch === '(') { console.log(`sk-body(941 的 ( 关闭于 L${i + 1}:${j + 1}`); i = lines.length; break }
    }
  }
}
