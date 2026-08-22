'use strict'

/**
 * DSH Desktop — 极简版桌面客户端（单个文件）。
 *
 * 做四件事：
 *   1. 探测本地 dsh 实例（默认端口 3080），有则直接连接
 *   2. 没有则用系统 node 拉起 dsh web，健康后加载界面
 *   3. 关闭窗口 = 最小化到托盘，dsh 服务继续后台运行（飞书渠道等不中断）
 *   4. 托盘「退出」才真正结束应用并清理自己拉起的服务进程（不碰外部已有实例）
 *
 * 用法：
 *   npm start                          # 默认端口 3080
 *   npm start -- --port 3099           # 换端口
 *   npm start -- --dsh-root D:\x       # 指定 DSH 检出目录
 *   环境变量：DSH_DESKTOP_DSH_ROOT（检出目录）、DSH_DESKTOP_NODE_PATH（node 路径）
 */

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn, execFile } = require('node:child_process')
const net = require('node:net')
const tokenStats = require('./token-stats')
const costMod = require('./cost')
const balance = require('./balance')

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

// ---------- 设置持久化（userData/settings.json） ----------

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')
let settings = {}

function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } catch { settings = {} }
  return settings
}

function saveSettings(patch) {
  settings = { ...settings, ...(patch || {}) }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
  } catch { /* 磁盘异常时静默，下次再试 */ }
  return settings
}

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
    if (tray) tray.setToolTip('DeepSeek Harness — ' + (state === 'ready' ? '服务运行中 (' + serverUrl + ')' : state === 'starting' ? '启动中…' : state))
  } catch { /* 窗口已销毁等竞态，忽略 */ }
}

/** 重启本应用拉起的 DSH 服务；附着外部实例时仅提示，不动别人的进程。 */
async function restartServer() {
  if (!child) {
    notify('当前附着的是外部 DSH 实例（非本应用拉起），已跳过重启。')
    return
  }
  try {
    const c = child
    child = null
    await killTree(c.pid)
    setStatus('starting', '正在重启 DSH 服务…')
    serverUrl = await startServer()
    setStatus('ready', '')
    if (win && !win.isDestroyed()) await win.loadURL(serverUrl).catch(() => {})
    notify('DSH 服务已重启（' + serverUrl + '）')
  } catch (err) {
    setStatus('error', String((err && err.message) || err))
  }
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
  // 记录受管服务 pid：壳崩溃后下次启动可据此清理孤儿进程
  try {
    const pf = path.join(app.getPath('userData'), 'runtime-child.json')
    fs.mkdirSync(path.dirname(pf), { recursive: true })
    fs.writeFileSync(pf, JSON.stringify({ pid: child.pid, port, startedAt: Date.now() }))
  } catch {}
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

// ---------- 托盘与通知 ----------

let tray = null
let isQuitting = false        // true = 用户从托盘选择退出；false 时关窗仅隐藏到托盘
let hideNoticeShown = false   // 「已最小化到托盘」气泡只提示一次

/** 托盘气泡通知（Windows）；其他平台退化为系统通知；失败静默。 */
function notify(title, content) {
  try {
    if (tray && process.platform === 'win32') tray.displayBalloon({ iconType: 'info', title, content })
    else if (typeof Notification !== 'undefined') new Notification({ title, body: content }).show()
  } catch { /* 忽略 */ }
}

function showMainWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/** 托盘图标：打包态取 extraResources，开发态取 build/。 */
function resolveTrayIcon() {
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.png'),
  ]
  for (const p of candidates) { try { if (p && fs.existsSync(p)) return p } catch {} }
  return undefined
}

function createTray() {
  try {
    const icon = resolveTrayIcon()
    tray = new Tray(icon || nativeImage.createEmpty())
    tray.setToolTip('DeepSeek Harness — 启动中…')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 DeepSeek Harness', click: showMainWindow },
      { label: '在浏览器中打开', click: () => { if (serverUrl) shell.openExternal(serverUrl) } },
      { type: 'separator' },
      { label: 'Quick Ask（Ctrl+Alt+Space）', click: toggleQuickAsk },
      { label: '重启 DSH 服务', click: () => restartServer() },
      { type: 'separator' },
      {
        label: '清理 DSH 缓存',
        click: async () => {
          // 直接清理并气泡反馈（避免阻塞式确认框）
          const cacheDir = path.join(dshHomeOf(), 'cache')
          let n = 0
          try {
            const items = await fs.promises.readdir(cacheDir)
            for (const name of items) {
              try { await fs.promises.rm(path.join(cacheDir, name), { recursive: true, force: true }); n++ } catch {}
            }
          } catch {}
          notify('DSH 缓存清理', `已清理 ${n} 项`)
        },
      },
      { label: '打开 DSH 数据目录', click: () => shell.openPath(dshHomeOf()) },
      { type: 'separator' },
      { label: '退出（结束本应用拉起的服务）', click: () => { isQuitting = true; app.quit() } },
    ]))
    tray.on('double-click', showMainWindow)
  } catch (err) {
    console.error('[dsh-desktop] 托盘创建失败', err)
  }
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
  const b = (settings && settings.winBounds) || {}
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 840,
    x: b.x, y: b.y,                    // 上次位置（无记录时 undefined = 居中）
    minWidth: 900, minHeight: 600,
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
  // 关窗 = 隐藏到托盘，dsh 服务继续后台运行；托盘「退出」才真正结束（P0-A）
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      try {
        if (!win.isMaximized() && !win.isMinimized()) saveSettings({ winBounds: win.getBounds() })
      } catch {}
      win.hide()
      if (!hideNoticeShown) {
        hideNoticeShown = true
        notify('DSH Desktop 已最小化到托盘', 'DSH 服务仍在后台运行。双击托盘图标回到窗口；托盘右键菜单可退出。')
      }
    }
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

// 设置读写（开机自启等持久配置）
ipcMain.handle('settings:get', () => settings)
ipcMain.handle('settings:set', (_e, patch) => {
  const s = saveSettings(patch || {})
  if (patch && 'autoLaunch' in patch) applyAutoLaunch()
  return s
})

// ---------- Token / 成本轮询（P1，借鉴 DshCockpit 思路） ----------

const dshHomeOf = () => (settings && settings.dshHome) || path.join(os.homedir(), '.dsh')
const TOKEN_POLL_MS = 5_000
const COST_HISTORY_FILE = path.join(app.getPath('userData'), 'cost-history.json')
const budgetNotified = new Set()
let tokenPollBusy = false
let lastCostUpdateAt = 0

// DeepSeek 官方余额监控（P1-I）：key 来源 env > ~/.dsh/.credentials.yaml > ~/.dsh/.env，
// key 永不进日志/IPC/设置，只有快照对外。
const balanceMonitor = balance.createMonitor({
  readKey: () => balance.findApiKey({
    env: process.env,
    credentialsPath: path.join(dshHomeOf(), '.credentials.yaml'),
    envPath: path.join(dshHomeOf(), '.env'),
  }),
  fetch: (key) => balance.fetchBalanceHttp(key),
  snapshotFile: path.join(app.getPath('userData'), 'balance.json'),
  budgetOf: () => (settings && Number(settings.monthlyBudget)) || 0,
  onLowBalance: (snap, threshold) => notify(
    'DeepSeek 官方余额不足',
    `余额 ¥${snap.total.toFixed(2)} 已低于提醒线 ¥${threshold.toFixed(2)}（总额/赠送/充值：${snap.total}/${snap.granted}/${snap.toppedUp}）`,
  ),
  log: (line) => console.log('[dsh-desktop]', line),
})

/** 今日活跃会话（mtime 在今天）的用量合计——日历史的写入口径。 */
function todayUsage(stats) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 }
  for (const s of stats.sessions) {
    if ((s.mtimeMs || 0) >= today.getTime()) {
      out.input += s.usage.input; out.output += s.usage.output
      out.cacheRead += s.usage.cacheRead; out.cacheWrite += s.usage.cacheWrite
      out.sessions += 1
    }
  }
  return out
}

/** 组装推给胶囊的快照：压力 + 今日/本周/本月估算成本 + 预算状态。 */
function buildSnapshot(stats) {
  const cfg = settings || {}
  const contextWindow = Number(cfg.contextWindow) || 128000
  const peakEnabled = !!cfg.costPeakEnabled
  const windows = peakEnabled ? (costMod.parseWindows(cfg.costPeakWindows) || costMod.DEFAULT_WINDOWS) : null

  // 用户配置单价优先；未配置时用官方价目表估算
  const rates = {
    inputPerM: cfg.costInputPerM ?? costMod.modelRates(cfg.costModel, false).inputPerM,
    outputPerM: cfg.costOutputPerM ?? costMod.modelRates(cfg.costModel, false).outputPerM,
    cacheReadPerM: cfg.costCacheReadPerM ?? costMod.modelRates(cfg.costModel, false).cacheReadPerM,
    cacheWritePerM: cfg.costCacheWritePerM ?? costMod.modelRates(cfg.costModel, false).cacheWritePerM,
  }

  // 今日成本：今日活跃会话折算（含峰谷分桶）
  let todayCost = 0, todaySaved = 0
  const today = new Date(); today.setHours(0, 0, 0, 0)
  for (const s of stats.sessions) {
    if ((s.mtimeMs || 0) >= today.getTime()) {
      const tc = costMod.turnCost(s.usage, cfg.costModel)
      todayCost += tc.cost; todaySaved += tc.saved
    }
  }

  // 每 10 分钟把当日口径落进日历史（供周/月汇总）
  const now = Date.now()
  if (now - lastCostUpdateAt > 10 * 60 * 1000) {
    lastCostUpdateAt = now
    const u = todayUsage(stats)
    const tu = costMod.turnCost(u, cfg.costModel)
    costMod.updateHistory(COST_HISTORY_FILE, {
      input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
      sessions: u.sessions, cost: tu.cost, peakCost: 0,
    })
  }

  const history = costMod.loadHistory(COST_HISTORY_FILE)
  const week = costMod.summarize(history, 7)
  const month = costMod.summarize(history, 30)

  // 官方余额：随 token 轮询顺带刷新（monitor 自带 5 分钟节流 + 指数退避）
  balanceMonitor.refresh().catch(() => {})
  const bal = balanceMonitor.snapshot()

  // 预算报警：跨阈值只提示一次
  const budget = Number(cfg.monthlyBudget) || 0
  const level = costMod.budgetStatus(month.cost, budget)
  if (level) {
    const key = `${costMod.todayKey().slice(0, 7)}:${level}`
    if (!budgetNotified.has(key)) {
      budgetNotified.add(key)
      notify(
        level === 'exceed' ? '月度预算已超出' : '月度预算预警',
        `本月估算费用${level === 'exceed' ? '已达' : '达到'}预算的 ${Math.round((month.cost / budget) * 100)}%（¥${month.cost.toFixed(2)} / ¥${budget}）`,
      )
    }
  } else {
    budgetNotified.clear()
  }

  const pressureTokens = tokenStats.pressureOf(stats.current)
  return {
    usage: {
      current: stats.current,
      totals: stats.totals,
      sessionCount: stats.sessionCount,
      pressureTokens,
      contextWindow,
      pressurePct: Math.min(100, Math.max(0, Math.round((pressureTokens / Math.max(1, contextWindow)) * 100))),
    },
    cost: {
      currency: '¥',
      today: { cost: todayCost, saved: todaySaved },
      week: { cost: week.cost },
      month: { cost: month.cost },
      budget: budget > 0 ? { monthly: budget, pct: Math.round((month.cost / budget) * 100), level: level || 'ok' } : null,
      balance: bal ? { total: bal.total, granted: bal.granted, toppedUp: bal.toppedUp, currency: bal.currency } : null,
      estimate: true,
    },
  }
}

async function pollTokens() {
  if (tokenPollBusy || isQuitting) return
  tokenPollBusy = true
  try {
    const windows = (settings && settings.costPeakEnabled)
      ? (costMod.parseWindows(settings.costPeakWindows) || costMod.DEFAULT_WINDOWS)
      : null
    const stats = await tokenStats.collect(dshHomeOf(), { windows })
    const snapshot = buildSnapshot(stats)
    if (win && !win.isDestroyed()) win.webContents.send('dsh:tokens', snapshot)
  } catch { /* 日志读取失败本轮跳过 */ }
  finally {
    tokenPollBusy = false
    if (!isQuitting) setTimeout(pollTokens, TOKEN_POLL_MS)
  }
}

ipcMain.handle('tokens:get', async () => {
  const windows = (settings && settings.costPeakEnabled)
    ? (costMod.parseWindows(settings.costPeakWindows) || costMod.DEFAULT_WINDOWS)
    : null
  return buildSnapshot(await tokenStats.collect(dshHomeOf(), { windows }))
})

// ---------- Quick Ask（P2-J）：全局热键 + headless 一次性提问 ----------

const { globalShortcut } = require('electron')
const { runHeadless } = require('./headless')
let qaWin = null

function createQuickAskWindow() {
  if (qaWin && !qaWin.isDestroyed()) { qaWin.show(); qaWin.focus(); return }
  qaWin = new BrowserWindow({
    width: 480, height: 260, show: false, frame: false,
    transparent: true, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'quickask-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  })
  qaWin.setAlwaysOnTop(true, 'screen-saver')
  qaWin.once('ready-to-show', () => { qaWin.show(); qaWin.focus() })
  qaWin.loadFile(path.join(__dirname, 'renderer', 'quickask.html'))
  qaWin.on('blur', () => { try { if (qaWin) qaWin.hide() } catch {} })
  qaWin.on('closed', () => { qaWin = null })
}

function toggleQuickAsk() {
  if (qaWin && !qaWin.isDestroyed() && qaWin.isVisible()) qaWin.hide()
  else createQuickAskWindow()
}

let qaBusy = false
ipcMain.on('quickask:submit', async (_e, text) => {
  const entry = resolveDshBin()
  if (!entry || qaBusy) {
    if (qaWin && !qaWin.isDestroyed()) qaWin.webContents.send('quickask:result', { ok: false, output: entry ? '上一个问题还在运行中' : '找不到 DSH 启动入口' })
    return
  }
  qaBusy = true
  try {
    const r = await runHeadless({
      dshBin: entry.bin,
      nodeBin: resolveNode(),
      dshHome: dshHomeOf(),
      workspace: dshHomeOf(),
      logDir: path.join(app.getPath('userData'), 'logs'),
      prompt: String(text),
    })
    if (qaWin && !qaWin.isDestroyed()) qaWin.webContents.send('quickask:result', r)
    notify(r.ok ? 'Quick Ask 完成' : 'Quick Ask 失败', r.output ? String(r.output).slice(0, 160) : '无输出')
  } finally {
    qaBusy = false
  }
})

// ---------- 启动 ----------

/** 开机自启：仅打包态生效（dev 态注册 electron.exe 无意义）。 */
function applyAutoLaunch() {
  try {
    if (process.defaultApp) return
    app.setLoginItemSettings({ openAtLogin: !!settings.autoLaunch, path: process.execPath })
  } catch { /* 忽略 */ }
}

/**
 * 上次壳异常退出可能留下仍在服务的 dsh 进程（pid 记录于 runtime-child.json）。
 * 与 DshCockpit 不同：本机 dsh 是常驻服务（IM 渠道依赖），孤儿=特性而非 bug，
 * 故不清理——startServer 会探测端口并直接附着它；此处只消费掉过期记录。
 */
async function reapOrphanRuntime() {
  const pf = path.join(app.getPath('userData'), 'runtime-child.json')
  try {
    const rec = JSON.parse(fs.readFileSync(pf, 'utf8'))
    if (rec && rec.pid) console.log('[dsh-desktop] 发现上次受管服务记录 pid=' + rec.pid + '（若仍存活将直接附着）')
  } catch { /* 无记录 */ }
  finally { try { fs.unlinkSync(pf) } catch {} }
}

app.whenReady().then(async () => {
  loadSettings()
  await reapOrphanRuntime()
  applyAutoLaunch()
  createWindow()
  createTray()
  try {
    serverUrl = await startServer()
    setStatus('ready', '服务就绪，正在打开…')
    await win.loadURL(serverUrl)
    win.setTitle('DeepSeek Harness')
  } catch (err) {
    setStatus('error', String((err && err.message) || err))
  }
  // Token/成本轮询：首扫延迟 3s，避免与会话树初始化抢 IO
  setTimeout(pollTokens, 3000)
  // 运行时更新检查：启动 15s 后一次，之后每 24h（P2-K）
  setTimeout(() => checkRuntimeUpdate(true), 15000)
  setInterval(() => checkRuntimeUpdate(false), 24 * 3600_000)
  // Quick Ask 全局热键（P2-J）：Ctrl+Alt+Space 唤起/隐藏小窗
  try {
    globalShortcut.register('CommandOrControl+Alt+Space', toggleQuickAsk)
    if (settings.quickAskHotkey && settings.quickAskHotkey !== 'CommandOrControl+Alt+Space') {
      globalShortcut.register(settings.quickAskHotkey, toggleQuickAsk)
    }
  } catch (e) { console.error('[dsh-desktop] quick ask hotkey failed', e) }
})

app.on('will-quit', () => { try { globalShortcut.unregisterAll() } catch {} })

// ---------- 运行时更新检查（P2-K）与存储占用（P2-L） ----------

/** 本机已安装的 @deepseek-ai/dsh 版本（npx 缓存或显式 bin）。 */
function readInstalledVersion() {
  const entry = resolveDshBin()
  if (!entry || entry.kind !== 'bin') return null
  try {
    // <pkg>/lib/bin.js → <pkg>/package.json
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry.bin), '..', 'package.json'), 'utf8'))
    return pkg.version || null
  } catch { return null }
}

/** npm registry 最新版本；失败返回 null。 */
async function fetchLatestVersion() {
  try {
    const r = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest', {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' },
    })
    if (!r.ok) return null
    const j = await r.json()
    return j.version || null
  } catch { return null }
}

function isNewer(latest, current) {
  if (!latest || !current) return false
  const pa = String(latest).split('.').map(Number)
  const pb = String(current).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true
    if ((pa[i] || 0) < (pb[i] || 0)) return false
  }
  return false
}

let lastUpdateCheckAt = 0
let updateNotifiedFor = ''
async function checkRuntimeUpdate(force = false) {
  const now = Date.now()
  if (!force && now - lastUpdateCheckAt < 24 * 3600_000) return
  lastUpdateCheckAt = now
  const latest = await fetchLatestVersion()
  const current = readInstalledVersion()
  if (!latest || !current) return
  if (isNewer(latest, current) && updateNotifiedFor !== latest) {
    updateNotifiedFor = latest
    notify('DSH 有新版本', `当前 ${current} → 最新 ${latest}。可在终端执行 npx @deepseek-ai/dsh@latest 安装后重启服务。`)
  }
}

/** 目录大小（字节，异步递归）；不存在返回 0。 */
async function dirSize(p, depth = 0) {
  let st
  try { st = await fs.promises.stat(p) } catch { return 0 }
  if (!st.isDirectory()) return st.size
  if (depth > 6) return 0
  let total = 0
  let items
  try { items = await fs.promises.readdir(p, { withFileTypes: true }) } catch { return 0 }
  for (const it of items) {
    total += await dirSize(path.join(p, it.name), depth + 1)
  }
  return total
}

const MB = (n) => (n / 1048576).toFixed(1) + ' MB'

ipcMain.handle('storage:stats', async () => {
  const home = dshHomeOf()
  const [sessions, cache, storages] = await Promise.all([
    dirSize(path.join(home, 'sessions')),
    dirSize(path.join(home, 'cache')),
    dirSize(path.join(home, 'storages')),
  ])
  return { home, sessionsMB: MB(sessions), cacheMB: MB(cache), storagesMB: MB(storages), totalMB: MB(sessions + cache + storages) }
})

ipcMain.handle('storage:clear-cache', async () => {
  const cacheDir = path.join(dshHomeOf(), 'cache')
  let items = []
  try { items = await fs.promises.readdir(cacheDir) } catch { return { ok: false, message: '无 cache 目录' } }
  for (const n of items) {
    try { await fs.promises.rm(path.join(cacheDir, n), { recursive: true, force: true }) } catch {}
  }
  return { ok: true, message: `已清理 ${items.length} 项` }
})

// ---------- 退出：清理受管服务 ----------

app.on('before-quit', (event) => {
  // 退出前记住窗口位置（isQuitting 路径 close 不再拦截保存）
  try { if (win && !win.isDestroyed() && !win.isMaximized() && !win.isMinimized() && win.isVisible()) saveSettings({ winBounds: win.getBounds() }) } catch {}
  if (!child) return
  event.preventDefault()
  const c = child
  child = null
  killTree(c.pid).finally(() => {
    try { fs.unlinkSync(path.join(app.getPath('userData'), 'runtime-child.json')) } catch {}
    app.quit()
  })
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)
  // 常驻托盘：全部窗口关闭（含隐藏）不再退出应用，dsh 服务继续后台运行
}
