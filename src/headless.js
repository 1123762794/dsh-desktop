// src/headless.js — 后台跑一次性 `dsh --profile headless <prompt>` 并捕获最终回答。
// Quick Ask 专用。借鉴 DshCockpit (MIT) 同名模块：输出走 fd 写日志文件（不走管道）。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * @param {object} opts { dshBin, nodeBin, dshHome, workspace, logDir, prompt, timeoutMs }
 * @returns Promise<{ ok: boolean, output: string, durationMs: number }>
 */
function runHeadless(opts) {
  const outFile = path.join(opts.logDir, `headless-${Date.now()}.out`)
  fs.mkdirSync(opts.logDir, { recursive: true })
  let fd = -1
  try { fd = fs.openSync(outFile, 'a') } catch { /* ignore */ }
  return new Promise((resolve) => {
    const env = { ...process.env, DSH_HOME: opts.dshHome }
    const started = Date.now()
    let child
    try {
      child = spawn(opts.nodeBin, [opts.dshBin, '--profile', 'headless', opts.prompt], {
        env,
        cwd: opts.workspace || opts.dshHome,
        windowsHide: true,
        stdio: fd === -1 ? 'ignore' : ['ignore', fd, fd],
      })
    } catch (e) {
      if (fd !== -1) { try { fs.closeSync(fd) } catch {} }
      resolve({ ok: false, output: e.message, durationMs: 0 })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      if (fd !== -1) { try { fs.closeSync(fd) } catch {} }
      resolve({ ok: false, output: 'timeout', durationMs: Date.now() - started })
    }, opts.timeoutMs || 10 * 60 * 1000)
    child.on('error', (e) => {
      clearTimeout(timer)
      if (fd !== -1) { try { fs.closeSync(fd) } catch {} }
      resolve({ ok: false, output: e.message, durationMs: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (fd !== -1) { try { fs.closeSync(fd) } catch {} }
      let out = ''
      try { out = fs.readFileSync(outFile, 'utf8') } catch {}
      resolve({ ok: code === 0, output: out.trim(), durationMs: Date.now() - started })
    })
  })
}

module.exports = { runHeadless }