'use strict'

/* [exp/text-export 9999.9.44-exp.3] C 方案扩展到 sessions：会话 JSONL 化（2026-11-17 用户拍板）
 *
 * 为什么：会话 .zstd 是多帧压缩二进制，上传 git 仍是不透明 blob，每轮上传都产生
 * 历史提交记录（用户零容忍）。sqliteJsonlLane 已实证 C 方案效果（knowledge 零变化
 * 真传 0、memory 只有行级 delta）；本模块把同一方案扩展到会话组。
 *
 * 形态约定：
 *   本地（live）：session.v4.jsonl.zstd —— DSH 宿主原生多帧压缩形态，不动
 *   云端（shadow）：session.v4.jsonl —— 确定序明文（行序=帧序×行序=时间序，append-only）
 *   上传：本地解帧拼接 → 与云端 jsonl 哈希不同才整文件覆盖（git pack 层自动只传新增行的 delta）
 *   下载：云端 jsonl → 重建两帧 .zstd → 自证解压行与 jsonl 一致 → 调用方过 gateSessionPayload → 落地
 *
 * 帧边界：**RFC8878 帧头+块结构精确解析**（魔数扫描会撞上压缩数据里的伪魔数导致丢帧；
 * node 的 zstdDecompressSync 只解第一帧且忽略尾部垃圾，不能直接对多帧 buffer 用）。
 *  解析链：Magic(4B) → FHD(1B) → Window_Descriptor(非 single-segment 时 1B) → Dictionary_ID
 *  → Frame_Content_Size → blocks（每块 3B 头：last/类型/大小）→ Content_Checksum(4B)。
 *  每帧解析出的 [off,end) 再用 zstdDecompressSync 验证（解压成功才接受，双保险）。
 * 重建分帧：两帧（头一帧、事件一帧，与宿主 materialize 同款）。**单帧会被宿主拒收**：
 *  readFirstZstdLine → assertZstdHeaderFrame 要求第一帧恰好只有 header 一行
 *  （dsh-session-persistence-jsonl lib/index.js:2293），单帧重建文件在 listArtifacts
 *  扫描时被静默 continue 剔除出内存表（11-19 会话孤儿事故根因：verify 绿但侧栏不可见）。
 * 前缀性质：会话是 append-only 流，M≥N 时旧导出是新导出的前缀（跨轮 delta 天然成立）。
 */

const fs = require('node:fs')
const fsP = require('node:fs/promises')
const zlib = require('node:zlib')
const { createHash } = require('node:crypto')

const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/* 从 off 起按 RFC8878 解析一个 zstd 帧，返回帧尾 offset；结构非法返回 -1 */
function zstdFrameEnd(buf, off) {
  let p = off + 4
  if (p + 1 > buf.length) return -1
  const fhd = buf[p]; p++
  const fcsFlag = (fhd >> 6) & 3
  const singleSeg = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const didBytes = [0, 1, 2, 4][fhd & 3]
  const fcsBytes = singleSeg ? [1, 2, 4, 8][fcsFlag] : (fcsFlag === 0 ? 0 : [2, 4, 8][fcsFlag - 1])
  if (!singleSeg) p += 1            // Window_Descriptor
  p += didBytes
  p += fcsBytes
  if (p > buf.length) return -1
  for (;;) {                         // 遍历块直到 Last_Block
    if (p + 3 > buf.length) return -1
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    const last = bh & 1
    const btype = (bh >> 1) & 3
    const bsize = bh >> 3
    p += 3
    if (btype === 3) return -1       // Reserved
    p += (btype === 1 ? 1 : bsize)   // RLE 占 1 字节，其余按块大小
    if (p > buf.length) return -1
    if (last) break
  }
  if (checksum) p += 4
  return p <= buf.length ? p : -1
}

/* 扫描全部帧：magic 候选 → 结构解析 → 解压验证（三重过滤，伪魔数/坏帧全挡） */
function scanFrames(buf) {
  const frames = []
  let k = buf.indexOf(MAGIC)
  while (k !== -1) {
    const end = zstdFrameEnd(buf, k)
    if (end !== -1) {
      try {
        const text = zlib.zstdDecompressSync(buf.subarray(k, end)).toString('utf8')
        frames.push(text)
        k = buf.indexOf(MAGIC, end)
        continue
      } catch { /* 解析通过但解压失败=伪帧起点，继续找 */ }
    }
    k = buf.indexOf(MAGIC, k + 1)
  }
  return frames
}

/* 解多帧 .zstd → 确定序文本（帧序×行序展平重组；不依赖各帧尾部换行习惯） */
function sessionZstdToText(buf) {
  return scanFrames(buf).flatMap(t => t.split('\n').filter(Boolean)).join('\n')
}

function textLines(text) { return text.split('\n').filter(Boolean) }

function sha1Of(lines) { return createHash('sha1').update(lines.join('\n')).digest('hex') }

/* 导出：本地 .zstd → 云端 jsonl。返回 {frames, lines, sha1, bytes} */
async function exportSessionJsonl(zstdPath, outJsonlPath) {
  const buf = await fsP.readFile(zstdPath)
  const lines = textLines(sessionZstdToText(buf))
  if (!lines.length) throw new Error('会话解帧后为空（0 行），拒绝导出：' + zstdPath)
  const body = lines.join('\n')
  await fsP.writeFile(outJsonlPath, body)
  return { frames: scanFrames(buf).length, lines: lines.length, sha1: sha1Of(lines), bytes: Buffer.byteLength(body) }
}

/* 增量判定用：只解行，不写盘 */
function sessionZstdLines(zstdPath) {
  const buf = fs.readFileSync(zstdPath)
  return textLines(sessionZstdToText(buf))
}

/* 内存重建：行数组 → 两帧 .zstd Buffer（头一帧、事件一帧；自证用多帧逐帧解压展平比对，
   下载端先 gate 后落盘用）。单帧形态会被宿主 assertZstdHeaderFrame 拒收（见文件头注释）。 */
function buildSessionZstd(lines) {
  if (!lines || !lines.length) throw new Error('0 行拒绝重建')
  const headFrame = zlib.zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
  const bodyFrame = zlib.zstdCompressSync(Buffer.from(lines.slice(1).join('\n') + '\n', 'utf8'), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })
  const out = Buffer.concat([headFrame, bodyFrame])
  const back = textLines(sessionZstdToText(out))
  if (back.length !== lines.length || back.some((l, i) => l !== lines[i])) throw new Error('会话重建自证失败：行数/内容不一致')
  return out
}

/* 重建：云端 jsonl → 本地 .zstd（两帧；写盘前自证解压行与源逐行一致） */
function rebuildSessionZstd(jsonlPath, outZstdPath) {
  const lines = textLines(fs.readFileSync(jsonlPath, 'utf8'))
  const frame = buildSessionZstd(lines)
  fs.writeFileSync(outZstdPath, frame)
  return { lines: lines.length, bytes: frame.length, sha1: sha1Of(lines) }
}

module.exports = { exportSessionJsonl, rebuildSessionZstd, buildSessionZstd, sessionZstdLines, sessionZstdToText, scanFrames, zstdFrameEnd, sha1Of }
