// src/token-stats.js — 从 dsh 会话日志读取 token 用量。
//
// 会话位于 <DSH_HOME>/sessions/<project>/<session-id>/session.jsonl[.zstd]。
// 用量数据挂在 `assistant/message` 事件的 data.usage =
// { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }，
// 以及 `assistant/chunk` 的 usage chunk。
//
// 实现借鉴 DshCockpit (https://github.com/Lxiayu/DshCockpit, MIT) 的
// src/token-stats.js 精简而来：保留异步遍历、(size,mtime) 解析缓存与
// plain 日志增量解析；去掉 session-search 同步路径。zstd 用 fzstd 纯 JS 解压。
'use strict'

const fsp = require('node:fs/promises')
const path = require('node:path')
const { decompress } = require('fzstd')

const ZSTD = '.jsonl.zstd'
const PLAIN = '.jsonl'

// file -> { size, mtimeMs, result, offset?, wkey }
const parseCache = new Map()

/** 解析会话首行 JSON 头（id / cwd 元信息）。 */
function parseHeader(text) {
  const nl = text.indexOf('\n')
  const first = nl === -1 ? text : text.slice(0, nl)
  try {
    const meta = JSON.parse(first)
    return { id: typeof meta.id === 'string' ? meta.id : undefined, cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined }
  } catch { return {} }
}

/**
 * 累加一段日志文本里所有 usage 事件。带 windows（峰谷时段，北京时间）时
 * 按 ev.time 分入 peak/offPeak 桶；无时间字段的事件进 offPeak。
 * lastUsage 记录最近一次用量（上下文压力的计算基准）。
 */
function sumUsage(text, windows) {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0
  const peak = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const offPeak = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const bucketed = !!(windows && windows.length)
  let lastUsage = null
  let lines = 0
  let start = 0
  while (start <= text.length) {
    const nl = text.indexOf('\n', start)
    const end = nl === -1 ? text.length : nl
    const line = text.slice(start, end)
    start = end + 1
    if (line.length === 0) {
      if (nl === -1) break
      continue
    }
    lines += 1
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    let usage = null
    if (ev && ev.type === 'assistant/message' && ev.data && ev.data.usage) usage = ev.data.usage
    else if (ev && ev.type === 'assistant/chunk' && ev.data && ev.data.chunk && ev.data.chunk.type === 'usage') usage = ev.data.chunk.usage
    if (!usage) continue
    const ui = usage.inputTokens || 0, uo = usage.outputTokens || 0
    const ucr = usage.cacheReadTokens || 0, ucw = usage.cacheWriteTokens || 0
    input += ui; output += uo; cacheRead += ucr; cacheWrite += ucw
    lastUsage = { input: ui, output: uo, cacheRead: ucr, cacheWrite: ucw }
    if (bucketed) {
      const dst = (typeof ev.time === 'number' && isPeakTime(ev.time, windows)) ? peak : offPeak
      dst.input += ui; dst.output += uo; dst.cacheRead += ucr; dst.cacheWrite += ucw
    }
    if (nl === -1) break
  }
  return { input, output, cacheRead, cacheWrite, lines, peak, offPeak, lastUsage }
}

// cost.isPeakTime 前置声明避免循环依赖：cost.js 不依赖本文件。
function isPeakTime(ms, windows) {
  if (!windows || !windows.length) return false
  const h = Math.floor(((ms / 3_600_000) % 24 + 8 + 24) % 24)
  return windows.some(([s, e]) => h >= s && h < e)
}

async function decodeSessionLogAsync(file) {
  const buf = await fsp.readFile(file)
  if (file.endsWith(ZSTD)) {
    try {
      return Buffer.from(decompress(new Uint8Array(buf))).toString('utf8')
    } catch {
      return null // zstd 帧错误（日志写入中）→ 本轮跳过
    }
  }
  return buf.toString('utf8')
}

function windowsKey(windows) {
  return windows && windows.length ? JSON.stringify(windows) : ''
}

async function readFileRange(file, start, length) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.toString('utf8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * 解析单个会话日志；(size,mtime,wkey) 缓存命中直接返回。
 * plain 日志只增长时增量解析新字节；zstd/重写日志全量重解析。
 */
async function parseSessionLogAsync(file, windows) {
  let st
  try { st = await fsp.stat(file) } catch { return null }
  const wkey = windowsKey(windows)
  const hit = parseCache.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.wkey === wkey) return hit.result
  const isPlain = !file.endsWith(ZSTD)
  if (isPlain && hit && typeof hit.offset === 'number'
    && st.size > hit.size && st.size > hit.offset && hit.wkey === wkey) {
    try {
      const grown = await readFileRange(file, hit.offset, st.size - hit.offset)
      const lastNl = grown.lastIndexOf('\n')
      if (lastNl === -1) {
        const result = { ...hit.result, mtimeMs: st.mtimeMs }
        parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result, offset: hit.offset, wkey })
        return result
      }
      const fresh = grown.slice(0, lastNl + 1)
      const inc = sumUsage(fresh, windows)
      const base = hit.result.totals
      const t = {
        input: base.input + inc.input,
        output: base.output + inc.output,
        cacheRead: base.cacheRead + inc.cacheRead,
        cacheWrite: base.cacheWrite + inc.cacheWrite,
        lines: base.lines + inc.lines,
        lastUsage: inc.lastUsage || base.lastUsage,
        peak: {
          input: (base.peak ? base.peak.input : 0) + inc.peak.input,
          output: (base.peak ? base.peak.output : 0) + inc.peak.output,
          cacheRead: (base.peak ? base.peak.cacheRead : 0) + inc.peak.cacheRead,
          cacheWrite: (base.peak ? base.peak.cacheWrite : 0) + inc.peak.cacheWrite,
        },
        offPeak: {
          input: (base.offPeak ? base.offPeak.input : 0) + inc.offPeak.input,
          output: (base.offPeak ? base.offPeak.output : 0) + inc.offPeak.output,
          cacheRead: (base.offPeak ? base.offPeak.cacheRead : 0) + inc.offPeak.cacheRead,
          cacheWrite: (base.offPeak ? base.offPeak.cacheWrite : 0) + inc.offPeak.cacheWrite,
        },
      }
      if (parseCache.get(file) !== hit) throw new Error('cache advanced concurrently')
      const result = { totals: t, meta: hit.result.meta, mtimeMs: st.mtimeMs }
      parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result, offset: hit.offset + Buffer.byteLength(fresh, 'utf8'), wkey })
      return result
    } catch { /* 竞态 → 全量重解析 */ }
  }
  let text
  let offset
  if (isPlain) {
    const buf = await fsp.readFile(file)
    text = buf.toString('utf8')
    const lastNl = buf.lastIndexOf(0x0a)
    offset = lastNl === -1 ? 0 : lastNl + 1
  } else {
    text = await decodeSessionLogAsync(file)
    offset = undefined
  }
  const result = text === null ? null : { totals: sumUsage(text, windows), meta: parseHeader(text), mtimeMs: st.mtimeMs }
  if (result !== null) {
    if (parseCache.size > 100) {
      const first = parseCache.keys().next().value
      if (first !== undefined) parseCache.delete(first)
    }
    parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result, offset, wkey })
  }
  return result
}

const WALK_TTL_MS = 5_000
let walkCache = null

async function walkSessionFilesAsync(root) {
  if (walkCache && walkCache.root === root && walkCache.expiresAt > Date.now()) return walkCache.list
  const out = []
  let projects
  try { projects = await fsp.readdir(root, { withFileTypes: true }) } catch { return out }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const projDir = path.join(root, proj.name)
    let sessions
    try { sessions = await fsp.readdir(projDir, { withFileTypes: true }) } catch { continue }
    for (const ses of sessions) {
      if (!ses.isDirectory()) continue
      const sesDir = path.join(projDir, ses.name)
      let files
      try { files = await fsp.readdir(sesDir) } catch { continue }
      let found = null
      for (const n of files) {
        if (n === 'session.jsonl.zstd') { found = path.join(sesDir, n); break }
        if (n === 'session.jsonl') { found = path.join(sesDir, n) }
      }
      if (found) out.push(found)
    }
  }
  walkCache = { root, list: out, expiresAt: Date.now() + WALK_TTL_MS }
  return out
}

/**
 * 汇总全部会话的 token 用量（全异步，不阻塞主线程）。
 * 返回 { current, totals, sessionCount, sessions }；current = 最近活跃会话用量。
 */
async function collect(dshHome, opts) {
  const windows = opts && opts.windows && opts.windows.length ? opts.windows : null
  const root = path.join(dshHome, 'sessions')
  const totals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    offPeak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const sessions = []
  let sessionCount = 0
  let current = null
  let latestMtime = 0
  const files = await walkSessionFilesAsync(root)
  for (const file of files) {
    const r = await parseSessionLogAsync(file, windows)
    if (!r) continue
    const usage = r.totals
    sessionCount += 1
    totals.input += usage.input; totals.output += usage.output
    totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite
    if (usage.peak) {
      totals.peak.input += usage.peak.input || 0; totals.peak.output += usage.peak.output || 0
      totals.peak.cacheRead += usage.peak.cacheRead || 0; totals.peak.cacheWrite += usage.peak.cacheWrite || 0
    }
    if (usage.offPeak) {
      totals.offPeak.input += usage.offPeak.input || 0; totals.offPeak.output += usage.offPeak.output || 0
      totals.offPeak.cacheRead += usage.offPeak.cacheRead || 0; totals.offPeak.cacheWrite += usage.offPeak.cacheWrite || 0
    }
    const mtimeMs = r.mtimeMs || 0
    sessions.push({ file, cwd: r.meta.cwd, usage, mtimeMs })
    if (mtimeMs > latestMtime) { latestMtime = mtimeMs; current = usage }
    // 大会话树时逐个让出主线程
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { current, totals, sessionCount, sessions }
}

/** 1234 -> "1.2k"，1234567 -> "1.2M"。 */
function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** 上下文压力 = 最近一次 provider 报告用量的 prompt 侧
 * （input + cacheRead + cacheWrite）——是最后一次真实请求的大小，
 * 不是会话生命周期累计值。 */
function pressureOf(usage) {
  const u = usage && usage.lastUsage
  if (!u) return 0
  return (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0)
}

module.exports = { collect, fmt, parseSessionLogAsync, walkSessionFilesAsync, pressureOf }