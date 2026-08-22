// src/cost.js — token → 金额估算、按日历史、预算检查。
//
// 费率为可配置估算值（settings.cost*PerM），展示一律标注"估算"，
// 不构成官方计费。实现借鉴 DshCockpit (MIT) src/cost.js 精简而来。
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const HISTORY_MAX_DAYS = 90

// 峰谷时段（北京时间，[start,end) 左闭右开）。默认 DeepSeek 高峰 9-12 / 14-18。
const DEFAULT_WINDOWS = [[9, 12], [14, 18]]

// DeepSeek 官方价目（¥/1M tokens）：模型 x 时段。2026-08-17 起生效；
// peak = off-peak x 2。cacheWrite 官方不计费故为 0。
const PRICE_MATRIX = {
  'deepseek-v4-flash': {
    offPeak: { inputPerM: 1.5, outputPerM: 4.5, cacheReadPerM: 0.05, cacheWritePerM: 0 },
    peak: { inputPerM: 3, outputPerM: 9, cacheReadPerM: 0.1, cacheWritePerM: 0 },
  },
  'deepseek-v4-pro': {
    offPeak: { inputPerM: 4.5, outputPerM: 13.5, cacheReadPerM: 0.15, cacheWritePerM: 0 },
    peak: { inputPerM: 9, outputPerM: 27, cacheReadPerM: 0.3, cacheWritePerM: 0 },
  },
}
const DEFAULT_MODEL = 'deepseek-v4-flash'

function normalizeModel(name) {
  const n = String(name || '').toLowerCase()
  if (n.includes('pro')) return 'deepseek-v4-pro'
  return 'deepseek-v4-flash'
}

function modelRates(model, isPeak) {
  const m = PRICE_MATRIX[normalizeModel(model)]
  return isPeak ? m.peak : m.offPeak
}

/** 一轮用量按官方价折算；带峰谷子桶时各桶按各自时段计价。
 * 同时返回缓存节省额（hit 按 miss 价 - hit 价差）。 */
function turnCost(totals, model) {
  const buckets = totals && totals.peak && totals.offPeak
    ? [['peak', true], ['offPeak', false]]
    : null
  const list = buckets
    ? buckets.map(([k, isPeak]) => ({ usage: totals[k], rates: modelRates(model, isPeak) }))
    : [{ usage: totals, rates: modelRates(model, false) }]
  let cost = 0, saved = 0
  let input = 0, output = 0, cacheRead = 0
  for (const { usage, rates } of list) {
    const miss = usage.input || 0, hit = usage.cacheRead || 0, out = usage.output || 0
    cost += (miss * rates.inputPerM + hit * rates.cacheReadPerM + out * rates.outputPerM
      + (usage.cacheWrite || 0) * rates.cacheWritePerM) / 1e6
    saved += hit * (rates.inputPerM - rates.cacheReadPerM) / 1e6
    input += miss; output += out; cacheRead += hit
  }
  return { cost, saved, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead }
}

const historyCache = new Map() // file -> { mtimeMs, history }

function todayKey() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 解析 "9-12,14-18" 为 [[9,12],[14,18]]（北京时间）；非法返回 null。 */
function parseWindows(str) {
  if (typeof str !== 'string' || !str.trim()) return null
  const out = []
  for (const segRaw of str.split(',')) {
    const seg = segRaw.trim()
    const m = seg.match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/)
    if (!m) return null
    const start = Number(m[1])
    const end = m[2] === undefined ? start + 1 : Number(m[2])
    if (!(start >= 0 && start < 24) || !(end > start && end <= 24)) return null
    out.push([start, end])
  }
  return out.length ? out : null
}

/** 时间戳是否处于高峰时段（北京时间）。 */
function isPeakTime(ms, windows) {
  if (!windows || !windows.length) return false
  const h = Math.floor(((ms / 3_600_000) % 24 + 8 + 24) % 24)
  return windows.some(([s, e]) => h >= s && h < e)
}

function costOf(usage, rates) {
  const perM = (n, rate) => (n || 0) * (rate || 0) / 1e6
  return perM(usage.input, rates.inputPerM)
    + perM(usage.output, rates.outputPerM)
    + perM(usage.cacheRead, rates.cacheReadPerM)
    + perM(usage.cacheWrite, rates.cacheWritePerM)
}

function loadHistory(file) {
  let st
  try { st = fs.statSync(file) } catch {
    historyCache.delete(file)
    return []
  }
  const hit = historyCache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.history
  let history = []
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(raw)) history = raw
  } catch { /* first run / corrupt */ }
  history = history.map((h) => ({ ...h }))
  historyCache.set(file, { mtimeMs: st.mtimeMs, history })
  return history
}

/** 更新今日条目并清理超期历史（原子写）。 */
function updateHistory(file, entry) {
  let history = loadHistory(file)
  const key = todayKey()
  const idx = history.findIndex((h) => h.date === key)
  if (idx === -1) history.push({ date: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, cost: 0 })
  const cur = history[idx === -1 ? history.length - 1 : idx]
  cur.input = entry.input; cur.output = entry.output
  cur.cacheRead = entry.cacheRead; cur.cacheWrite = entry.cacheWrite
  cur.sessions = entry.sessions; cur.cost = entry.cost
  cur.peakCost = entry.peakCost ?? 0
  const cutoff = new Date(Date.now() - HISTORY_MAX_DAYS * 86_400_000)
  history = history.filter((h) => !h.date || new Date(h.date + 'T00:00:00') >= cutoff)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2))
    fs.renameSync(tmp, file)
  } catch { /* ignore */ }
  try {
    const st = fs.statSync(file)
    historyCache.set(file, { mtimeMs: st.mtimeMs, history: history.map((h) => ({ ...h })) })
  } catch { historyCache.delete(file) }
  return history
}

/** 最近 N 个自然日汇总。 */
function summarize(history, days) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, cost: 0, peakCost: 0 }
  const seen = new Set()
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i]
    if (!h || !h.date) continue
    if (seen.size >= days) break
    seen.add(h.date)
    out.input += h.input || 0; out.output += h.output || 0
    out.cacheRead += h.cacheRead || 0; out.cacheWrite += h.cacheWrite || 0
    out.sessions += h.sessions || 0; out.cost += h.cost || 0
    out.peakCost += h.peakCost || 0
  }
  return out
}

/** 预算阈值：返回 'warn'(≥80%) | 'exceed'(≥100%) | null。 */
function budgetStatus(monthCost, budget) {
  if (!budget || budget <= 0) return null
  const pct = monthCost / budget
  if (pct >= 1) return 'exceed'
  if (pct >= 0.8) return 'warn'
  return null
}

module.exports = { todayKey, loadHistory, updateHistory, summarize, budgetStatus, HISTORY_MAX_DAYS, DEFAULT_WINDOWS, parseWindows, isPeakTime, PRICE_MATRIX, DEFAULT_MODEL, normalizeModel, modelRates, turnCost, costOf }