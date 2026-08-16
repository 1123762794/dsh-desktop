'use strict'

/**
 * DSH Desktop — 极简版桌面客户端（单个文件）。
 *
 * 只做三件事：
 *   1. 探测本地 dsh 实例（默认端口 3080），有则直接连接
 *   2. 没有则用系统 node 拉起 dsh web，健康后加载界面
 *   3. 退出时清理自己拉起的服务进程（不碰外部已有实例）
 *
 * 用法：
 *   npm start                          # 默认端口 3080
 *   npm start -- --port 3099           # 换端口
 *   npm start -- --dsh-root D:\x       # 指定 DSH 检出目录
 *   环境变量：DSH_DESKTOP_DSH_ROOT（检出目录）、DSH_DESKTOP_NODE_PATH（node 路径）
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawn, execFile } = require('node:child_process')
const net = require('node:net')

// ---------- 配置 ----------

const DEFAULT_DSH_ROOT = 'C:\\Users\\11237\\deepseek-harness'
const BOOT_MARKER = '__DSH_BOOT__'

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const DSH_ROOT = argValue('--dsh-root') || process.env.DSH_DESKTOP_DSH_ROOT || DEFAULT_DSH_ROOT
const PORT = Number(argValue('--port')) || 3080
const IS_DEV = process.argv.includes('--dev')

// ---------- 工具 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isPortBusy(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port })
    const done = (ok) => { clearTimeout(t); s.destroy(); resolve(ok) }
    const t = setTimeout(() => done(false), 800)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

async function isDsh(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.ok && (await res.text()).includes(BOOT_MARKER)
  } catch { return false }
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 8000 }, () => resolve())
    } else {
      try { process.kill(pid, 'SIGTERM') } catch {}
      resolve()
    }
  })
}

function resolveNode() {
  const p = process.env.DSH_DESKTOP_NODE_PATH
  return p && fs.existsSync(p) ? p : 'node'
}

/**
 * 找一个可用的 dsh 启动入口（bin.js / bin.ts），按优先级：
 *   1. DSH_DESKTOP_DSH_BIN 环境变量显式指定的 bin.js
 *   2. npx 缓存里的完整发布包 @deepseek-ai/dsh（lib/bin.js，自带构建产物）
 *   3. 检出目录源码（apps/cli/src/bin.ts，需 tsx）
 * 返回 { bin, cwd, args, kind }；找不到返回 null。
 */
function resolveDshBin() {
  // 1) 显式指定
  const explicit = process.env.DSH_DESKTOP_DSH_BIN
  if (explicit && fs.existsSync(explicit)) {
    return { bin: explicit, cwd: path.dirname(explicit), args: [], kind: 'bin' }
  }

  // 2) npx 缓存完整包：%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh\lib\bin.js
  if (process.platform === 'win32') {
    const npxRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx')
    try {
      const hashes = fs.readdirSync(npxRoot)
        .map((h) => path.join(npxRoot, h))
        .filter((d) => { try { return fs.statSync(d).isDirectory() } catch { return false } })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) // 最新优先
      for (const dir of hashes) {
        const cand = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if (fs.existsSync(cand)) {
          return { bin: cand, cwd: path.dirname(cand), args: [], kind: 'bin' }
        }
      }
    } catch {}
  }

  // 3) 检出目录源码（需 tsx 与 node_modules）
  const src = path.join(DSH_ROOT, 'apps', 'cli', 'src', 'bin.ts')
  if (fs.existsSync(src) && fs.existsSync(path.join(DSH_ROOT, 'node_modules'))) {
    return { bin: src, cwd: DSH_ROOT, args: ['--import', 'tsx/esm'], kind: 'src' }
  }

  return null
}

// ---------- 服务 ----------

let child = null     // 本应用拉起的 dsh 进程
let serverUrl = ''   // 当前服务 URL
let status = { state: 'starting', detail: '' }

function setStatus(state, detail) {
  status = { state, detail, url: serverUrl }
  try {
    if (win && !win.isDestroyed()) win.webContents.send('dsh:status', status)
  } catch { /* 窗口已销毁等竞态，忽略 */ }
}

/** 连接已有实例，否则在空闲端口拉起新实例。返回服务 URL。 */
async function startServer() {
  const entry = resolveDshBin()
  if (!entry) {
    throw new Error('找不到可用的 DSH 启动入口（已检查 npx 缓存与检出目录 ' + DSH_ROOT + '）\n请设置 DSH_DESKTOP_DSH_BIN 指定 lib/bin.js')
  }

  // 1) 首选端口已有健康的 dsh 实例 → 直接连接（不重复启动，避免并发读写 ~/.dsh）
  const primary = 'http://127.0.0.1:' + PORT
  if (await isDsh(primary)) return primary

  // 2) 找一个空闲端口
  let port = PORT
  for (let i = 0; i < 20; i++) {
    if (!(await isPortBusy(PORT + i))) { port = PORT + i; break }
  }

  // 3) 拉起 dsh web（完整包直接 node lib/bin.js；检出目录源码经 tsx 加载）
  setStatus('starting', '正在启动 DSH 服务（端口 ' + port + '，首次约需十几秒）…')
  child = spawn(resolveNode(), [...entry.args, entry.bin, 'web', '--port', String(port)], {
    cwd: entry.cwd, env: { ...process.env }, stdio: 'ignore', windowsHide: true,
  })
  child.on('exit', (code) => {
    if (child && status.state !== 'error') setStatus('error', 'DSH 服务进程退出（code ' + code + '）')
  })

  // 4) 轮询健康
  const url = 'http://127.0.0.1:' + port
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (await isDsh(url)) return url
    await sleep(800)
  }
  throw new Error('等待 ' + url + ' 就绪超时')
}

// ---------- 窗口 ----------

let win = null

/** Codex 风格主题样式（注入到 loading 页与 DSH 主页面） */
const CODEX_CSS = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'renderer', 'codex-theme.css'), 'utf8')
  } catch {
    return ''
  }
})()

/** 把 Codex 主题 CSS 注入当前页面（整页导航后失效，需在导航事件里重注） */
function injectCodexTheme(contents) {
  if (!CODEX_CSS) return
  try { contents.insertCSS(CODEX_CSS) } catch { /* 页面加载窗口期忽略 */ }
}

/**
 * 平台化窗口选项（参考 anywhere-labs/deepseek-harness-desktop 高级模式）：
 * - Windows：隐藏标题栏 + titleBarOverlay 原生窗口按钮 + Mica 材质 + 圆角阴影
 *   （Codex 桌面端 Windows 版即此形态：系统按钮 + 亚克力毛玻璃）
 * - macOS：hiddenInset + 原生红绿灯 + vibrancy 毛玻璃
 * - 其他平台：普通系统窗口
 */
function windowOptions() {
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#7f858f', height: 32 },
      backgroundColor: '#00000000',
      backgroundMaterial: 'mica',          // Windows 11 22H2+ 原生材质（旧系统自动回退）
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
      autoHideMenuBar: true,
    }
  }
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    }
  }
  return { autoHideMenuBar: true, backgroundColor: '#0a0a0a' }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    show: false,                         // 避免启动闪白
    ...windowOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(__dirname, 'renderer', 'loading.html'))

  // Codex 主题：整页加载与导航完成后注入
  win.webContents.on('did-finish-load', () => injectCodexTheme(win.webContents))
  win.webContents.on('did-navigate', () => injectCodexTheme(win.webContents))

  // 外部链接跳系统浏览器；其它源导航一律拦截
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://') || (serverUrl && url.startsWith(serverUrl))) return
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  })
  win.on('closed', () => { win = null })

  // 最大化状态变化 → 通知渲染层切换 最大化/还原 图标
  win.on('maximize', () => { if (win) win.webContents.send('window:maximized', true) })
  win.on('unmaximize', () => { if (win) win.webContents.send('window:maximized', false) })

  if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' })
}

// ---------- 窗口控制 IPC（自绘标题栏） ----------

ipcMain.on('window:minimize', () => { if (win) win.minimize() })
ipcMain.on('window:maximize-toggle', () => {
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('window:close', () => { if (win) win.close() })
ipcMain.handle('window:is-maximized', () => (win ? win.isMaximized() : false))

ipcMain.handle('dsh:get-state', () => status)
ipcMain.handle('dsh:open-external', () => { if (serverUrl) shell.openExternal(serverUrl) })

// ---------- 启动 ----------

app.whenReady().then(async () => {
  createWindow()
  try {
    serverUrl = await startServer()
    setStatus('ready', '服务就绪，正在打开…')
    await win.loadURL(serverUrl)
    win.setTitle('DeepSeek Harness')
  } catch (err) {
    setStatus('error', String((err && err.message) || err))
  }
})

// ---------- 退出：清理受管服务 ----------

app.on('before-quit', (event) => {
  if (!child) return
  event.preventDefault()
  const c = child
  child = null
  killTree(c.pid).finally(() => app.quit())
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
  })
  app.on('window-all-closed', () => app.quit())
}
