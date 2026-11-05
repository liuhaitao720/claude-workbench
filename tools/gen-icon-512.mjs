// 生成 assets/icon-512.png（Linux 打包需要 ≥256px 图标；原 icon.png 仅 128px 且
// icon.ico 内嵌的最大真实像素帧也是 128——无法抽帧，须重绘）。
//
// 策略：背景圆角矩形按 SDF 数学重绘（512 下边缘锐利、无放大模糊）；白色品牌
// glyph 从原 128px 图提取（洪水填充分离白底 → glyph mask）后双线性 4x 放大合成。
// 用法：node tools/gen-icon-512.mjs（零依赖，Node 自带 zlib）
import { deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'assets', 'icon.png')
const DST = join(root, 'assets', 'icon-512.png')
const SIZE = 512

// ── 最小 PNG 解码（8bit RGBA，标准滤波）─────────────────────────────────
function decodePng(buf) {
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (buf[24] !== 8 || buf[25] !== 6) throw new Error('仅支持 8bit RGBA PNG')
  let off = 8
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len))
    off += 12 + len
  }
  const raw = deflateInflate(Buffer.concat(idat))
  const bpp = 4
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = x >= bpp && prev ? prev[x - bpp] : 0
      let v = row[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
  }
  return { w, h, data: out }
}
import { inflateSync as deflateInflate } from 'node:zlib'

// ── 最小 PNG 编码（单 IDAT，filter 0）───────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ── 1. 解码原图，分离「白底 / 橙底 / 白 glyph」────────────────────────────
const src = decodePng(readFileSync(SRC))
const { w: sw, h: sh, data: sd } = src
const spx = (x, y) => {
  const i = (y * sw + x) * 4
  return [sd[i], sd[i + 1], sd[i + 2]]
}
const isWhiteish = (x, y) => {
  const [r, g, b] = spx(x, y)
  return r > 205 && g > 205 && b > 205
}
// 洪水填充白底（从四角出发；图内被橙底包围的白色像素不会被触及 → 即 glyph）
const bgWhite = new Uint8Array(sw * sh)
const stack = []
for (const [sx, sy] of [
  [0, 0],
  [sw - 1, 0],
  [0, sh - 1],
  [sw - 1, sh - 1]
]) {
  if (isWhiteish(sx, sy) && !bgWhite[sy * sw + sx]) stack.push([sx, sy])
}
while (stack.length > 0) {
  const [x, y] = stack.pop()
  if (x < 0 || y < 0 || x >= sw || y >= sh) continue
  const k = y * sw + x
  if (bgWhite[k] || !isWhiteish(x, y)) continue
  bgWhite[k] = 1
  stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
}
// glyph 覆盖度：非白底的白ish 像素 = 1，边缘 AA 由亮度插值近似覆盖度。
// 阈值带须避开橙底自身亮度（#da7756 亮度 ≈0.57）——下限 0.62，否则纯橙像素
// 被计入 ~5% 白覆盖，整个背景蒙一层白雾（视觉验收发现的灰晕根因）
const glyph = new Float32Array(sw * sh)
for (let y = 0; y < sh; y++) {
  for (let x = 0; x < sw; x++) {
    const k = y * sw + x
    if (bgWhite[k]) continue
    const [r, g, b] = spx(x, y)
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255
    glyph[k] = lum >= 0.92 ? 1 : lum <= 0.62 ? 0 : (lum - 0.62) / 0.3
  }
}

// ── 2. 测原圆角半径（顶行首个非白像素 x ≈ r，圆角矩形贴满画布）────────────
let radiusPx = 0
for (let x = 0; x < sw; x++) {
  if (!isWhiteish(x, 0)) {
    radiusPx = x
    break
  }
}
const scale = SIZE / sw
const R = Math.round(radiusPx * scale)

// ── 3. 渲染 512：SDF 圆角矩形（锐利边缘）+ 双线性放大 glyph ─────────────
const ORANGE = [0xda, 0x77, 0x56]
// SDF（rounded box，中心化坐标）：d<0 在形内
function sdfRoundRect(px, py, half, r) {
  const qx = Math.abs(px) - (half - r)
  const qy = Math.abs(py) - (half - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}
// glyph 双线性采样（src 归一坐标）
function sampleGlyph(nx, ny) {
  const fx = nx * (sw - 1)
  const fy = ny * (sh - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, sw - 1)
  const y1 = Math.min(y0 + 1, sh - 1)
  const tx = fx - x0
  const ty = fy - y0
  const g00 = glyph[y0 * sw + x0]
  const g10 = glyph[y0 * sw + x1]
  const g01 = glyph[y1 * sw + x0]
  const g11 = glyph[y1 * sw + x1]
  return g00 * (1 - tx) * (1 - ty) + g10 * tx * (1 - ty) + g01 * (1 - tx) * ty + g11 * tx * ty
}

// smoothstep 收紧 glyph 过渡带：双线性 4x 放大的 AA 边（~4-6px 软边）压到 ~2px
function sharpen(g) {
  if (g <= 0.35) return 0
  if (g >= 0.65) return 1
  const t = (g - 0.35) / 0.3
  return t * t * (3 - 2 * t)
}

const out = Buffer.alloc(SIZE * SIZE * 4)
const half = SIZE / 2
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 4x 超采样 SDF → 覆盖度（边缘 ~1px 平滑，同矢量渲染）
    let cov = 0
    for (const dy of [0.25, 0.75]) {
      for (const dx of [0.25, 0.75]) {
        if (sdfRoundRect(x + dx - half, y + dy - half, half, R) <= 0) cov += 0.25
      }
    }
    const g = cov > 0 ? sharpen(sampleGlyph((x + 0.5) / SIZE, (y + 0.5) / SIZE)) : 0
    const i = (y * SIZE + x) * 4
    // 白 glyph premultiplied 合成到橙底；形外透明（Linux 图标惯例：圆角外不铺白）
    const r = ORANGE[0] * (1 - g) + 255 * g
    const gg = ORANGE[1] * (1 - g) + 255 * g
    const b = ORANGE[2] * (1 - g) + 255 * g
    out[i] = Math.round(r)
    out[i + 1] = Math.round(gg)
    out[i + 2] = Math.round(b)
    out[i + 3] = Math.round(255 * cov)
  }
}

writeFileSync(DST, encodePng(SIZE, SIZE, out))
console.log(`icon-512.png 生成：${SIZE}x${SIZE}，圆角半径 ${R}px（原 ${radiusPx}px @${sw}），输出 ${DST}`)
