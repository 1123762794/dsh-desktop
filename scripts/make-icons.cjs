/**
 * 把 build/icon.svg（官方鲸鱼）渲染为 PNG + ICO：
 *   npm run icons
 * 产出 build/icon.png, icon-16/32/48.png, icon.ico
 *
 * 使用 @resvg/resvg-js（纯 CPU 渲染，无需 Electron / GPU）。
 */
'use strict'
const { Resvg } = require('@resvg/resvg-js')
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'build')

// --- 最小 ICO 编码（多张 PNG 打包） ---
function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}
function encodeIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + pngs.length * 16
  for (const png of pngs) {
    const size = png.readUInt32BE(16)
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs])
}

const svg = fs.readFileSync(path.join(OUT, 'icon.svg'), 'utf8')

const pngs = [16, 32, 48, 256].map((size) => {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  const buf = resvg.render().asPng()
  const name = size === 256 ? 'icon.png' : 'icon-' + size + '.png'
  fs.writeFileSync(path.join(OUT, name), buf)
  console.log('wrote build/' + name, buf.length, 'bytes')
  return buf
})
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(pngs))
console.log('wrote build/icon.ico')
