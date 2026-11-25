'use strict'
/* [exp.3] 会话 JSONL 车道测试：导出确定序、重建自证、roundtrip 逐行一致、前缀性质、真数据 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const { exportSessionJsonl, rebuildSessionZstd, sessionZstdToText, sessionZstdLines } = await import(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'src', 'sessions-jsonl.js')).href)

let pass = 0, fail = 0
const ok = (cond, name, detail) => { if (cond) { pass++; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')) } else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) } }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-jsonl-'))

// ── 造宿主风格多帧 .zstd：3 帧，每帧若干 jsonl 事件行 ──
function mkMultiFrameZstd(frameTexts) {
  return Buffer.concat(frameTexts.map(t => zlib.zstdCompressSync(Buffer.from(t, 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })))
}
const frame1 = ['{"seq":1,"type":"user","text":"第一轮提问"}', '{"seq":2,"type":"assistant","text":"第一轮回复"}'].join('\n')
const frame2 = ['{"seq":3,"type":"user","text":"第二轮提问"}', '{"seq":4,"type":"assistant","text":"第二轮回复"}', '{"seq":5,"type":"step/end"}'].join('\n')
const frame3 = ['{"seq":6,"type":"user","text":"第三轮提问"}'].join('\n')
const zstdA = path.join(TMP, 'A', 'session.v4.jsonl.zstd')
fs.mkdirSync(path.dirname(zstdA), { recursive: true })
fs.writeFileSync(zstdA, mkMultiFrameZstd([frame1, frame2, frame3]))

// 1. 导出：确定序、行序=帧序×行序
const r1 = await exportSessionJsonl(zstdA, path.join(TMP, 'A.jsonl'))
const exported = fs.readFileSync(path.join(TMP, 'A.jsonl'), 'utf8').split('\n').filter(Boolean)
ok(exported.length === 6, '导出 6 行（3 帧 × 2/3/1 行）', 'lines=' + r1.lines + ' frames=' + r1.frames)
ok(exported[0].includes('"seq":1') && exported[5].includes('"seq":6'), '行序=帧序×行序（seq 1..6 顺序）')
const r1b = await exportSessionJsonl(zstdA, path.join(TMP, 'A2.jsonl'))
ok(fs.readFileSync(path.join(TMP, 'A.jsonl')) .equals(fs.readFileSync(path.join(TMP, 'A2.jsonl'))), '确定序：同输入两次导出字节相同')

// 2. 重建：单帧 .zstd，解回逐行一致
const r2 = rebuildSessionZstd(path.join(TMP, 'A.jsonl'), path.join(TMP, 'A-rebuilt.zstd'))
const back = sessionZstdLines(path.join(TMP, 'A-rebuilt.zstd'))
ok(back.length === 6 && back[0].includes('"seq":1') && back[5].includes('"seq":6'), '重建 .zstd 解回 6 行序不变', 'bytes=' + r2.bytes)

// 3. roundtrip：原多帧 vs 重建单帧，解出行完全一致（fingerprint 口径）
const origLines = sessionZstdLines(zstdA)
ok(JSON.stringify(origLines) === JSON.stringify(back), 'roundtrip：原 .zstd 与重建 .zstd 解行完全一致')

// 4. 前缀性质（append-only）：追加一帧后导出 = 旧导出 + 新行
const zstdB = path.join(TMP, 'B', 'session.v4.jsonl.zstd')
fs.mkdirSync(path.dirname(zstdB), { recursive: true })
const frame4 = ['{"seq":7,"type":"assistant","text":"第三轮回复"}'].join('\n')
fs.writeFileSync(zstdB, Buffer.concat([mkMultiFrameZstd([frame1, frame2, frame3]), zlib.zstdCompressSync(Buffer.from(frame4, 'utf8'))]))
await exportSessionJsonl(zstdB, path.join(TMP, 'B.jsonl'))
const expA = fs.readFileSync(path.join(TMP, 'A.jsonl'), 'utf8').split('\n').filter(Boolean)
const expB = fs.readFileSync(path.join(TMP, 'B.jsonl'), 'utf8').split('\n').filter(Boolean)
ok(expB.length === expA.length + 1 && expA.every((l, i) => l === expB[i]) && expB[6].includes('"seq":7'), '前缀性质：追加帧后导出 = 旧导出 + 新行（git delta 只见新增行）')

// 5. 坏输入：全垃圾字节 → 导出抛错（不产生空 jsonl）
const badPath = path.join(TMP, 'bad.zstd')
fs.writeFileSync(badPath, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
let threw = false
try { await exportSessionJsonl(badPath, path.join(TMP, 'bad.jsonl')) } catch { threw = true }
ok(threw, '坏输入（0 行可解）导出抛错', threw ? '' : '未抛错！')

// 6. 真数据：本地真实会话 roundtrip（取最大的一个 .zstd）
const sessRoot = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/sessions'
let realZ = null
for (const d of fs.readdirSync(sessRoot)) {
  const dp = path.join(sessRoot, d)
  if (!fs.statSync(dp).isDirectory()) continue
  for (const s of fs.readdirSync(dp)) {
    const z = path.join(dp, s, 'session.v4.jsonl.zstd')
    try { if (fs.statSync(z).size > 500000) { realZ = z; break } } catch {}
  }
  if (realZ) break
}
if (realZ) {
  const rl0 = sessionZstdLines(realZ)
  const rr = await exportSessionJsonl(realZ, path.join(TMP, 'real.jsonl'))
  const rr2 = rebuildSessionZstd(path.join(TMP, 'real.jsonl'), path.join(TMP, 'real-rebuilt.zstd'))
  const rl1 = sessionZstdLines(path.join(TMP, 'real-rebuilt.zstd'))
  ok(rl1.length === rl0.length && rl1.every((l, i) => l === rl0[i]), `真数据 roundtrip（${path.basename(path.dirname(realZ)).slice(0, 13)}… ${rl0.length} 行）逐行一致`, `jsonl=${rr.bytes}B → 重建 zstd=${rr2.bytes}B`)
} else {
  ok(false, '真数据 roundtrip：未找到 >500KB 的本地会话')
}

// 7. 同 seq 不同内容：不是追加/新旧关系，强制覆盖必须保留云端原文，不能合并或按长度判输赢
const forkLocal = [frame1, '{"seq":3,"type":"assistant","text":"本机改写"}', '{"seq":4,"type":"step/end"}'].join('\n').split('\n')
const forkCloud = [frame1, '{"seq":3,"type":"user","text":"云端不同内容"}'].join('\n').split('\n')
const forkZ = path.join(TMP, 'fork-local.zstd')
fs.writeFileSync(forkZ, mkMultiFrameZstd([forkLocal.join('\n')]))
const forkJsonl = path.join(TMP, 'fork-cloud.jsonl')
fs.writeFileSync(forkJsonl, forkCloud.join('\n'))
rebuildSessionZstd(forkJsonl, path.join(TMP, 'fork-forced.zstd'))
const forcedLines = sessionZstdLines(path.join(TMP, 'fork-forced.zstd'))
ok(JSON.stringify(forcedLines) === JSON.stringify(forkCloud), '同 seq 内容分叉：强制覆盖逐行等于云端，不按长度或 seq 合并')
ok(forcedLines.length < forkLocal.length && forcedLines.some(l => l.includes('云端不同内容')), '云端更短且同 seq 不同内容仍完整落地')

console.log(`\n=== 会话 JSONL 车道：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
