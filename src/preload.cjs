'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  getState: () => ipcRenderer.invoke('dsh:get-state'),
  openExternal: () => ipcRenderer.invoke('dsh:open-external'),
  onStatus: (cb) => {
    const l = (_e, s) => cb(s)
    ipcRenderer.on('dsh:status', l)
    return () => ipcRenderer.removeListener('dsh:status', l)
  },
  // Token/成本快照（主进程 5s 轮询会话日志）
  getTokens: () => ipcRenderer.invoke('tokens:get'),
  onTokens: (cb) => {
    const l = (_e, s) => cb(s)
    ipcRenderer.on('dsh:tokens', l)
    return () => ipcRenderer.removeListener('dsh:tokens', l)
  },
  // 存储占用（P2-L）
  getStorage: () => ipcRenderer.invoke('storage:stats'),
  // 窗口控制（caption 拖拽条双击最大化用；窗口按钮由系统 titleBarOverlay 原生绘制）
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:maximize-toggle'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximized: (cb) => {
      const l = (_e, v) => cb(v)
      ipcRenderer.on('window:maximized', l)
      return () => ipcRenderer.removeListener('window:maximized', l)
    },
  },
})

/**
 * 在 DSH 页面（http）注入顶部 caption 拖拽条（仿 anywhere-labs 高级模式）：
 * 32px 高的透明原生拖拽区域，右侧避让 Windows 原生窗口按钮（138px）/
 * 左侧避让 macOS 红绿灯（80px）；双击切换最大化。
 * 窗口按钮与 Mica 材质由 Electron 原生提供，页面不再自绘标题栏。
 * loading.html（file://）自带静态 caption，不在此注入。
 */
function injectCaptionStrip() {
  try {
    if (!location.href.startsWith('http://')) return // 只注入到 DSH 页面
    if (document.getElementById('dsh-caption')) return

    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '')
    document.body.dataset.dshDesktopPlatform = isMac ? 'darwin' : 'win32'

    const strip = document.createElement('div')
    strip.id = 'dsh-caption'
    strip.className = isMac ? 'dsh-caption--mac' : 'dsh-caption--win'
    strip.setAttribute('aria-hidden', 'true')
    const wc = window.dshDesktop && window.dshDesktop.windowControls
    strip.addEventListener('dblclick', () => wc && wc.toggleMaximize())
    document.body.appendChild(strip)
  } catch (err) {
    console.error('[dsh-desktop] inject caption strip failed:', err)
  }
}

/**
 * 在 DSH 页面右下角注入低调的「在浏览器中打开」浮动按钮
 * （从自绘标题栏迁回：原生窗口方案后 caption 条不放按钮，恢复最早的位置）。
 */
function injectBrowserButton() {
  try {
    if (!location.href.startsWith('http://')) return // 只注入到 DSH 页面
    if (document.getElementById('dsh-browser-btn')) return
    const btn = document.createElement('button')
    btn.id = 'dsh-browser-btn'
    btn.title = '在系统浏览器中打开 DeepSeek Harness'
    btn.setAttribute('aria-label', '在浏览器中打开')
    btn.innerHTML = '<span class="dsh-browser-ico">&#8599;</span><span class="dsh-browser-label">在浏览器中打开</span>'
    btn.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483646',
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'padding:6px 12px', 'font-size:12px', 'line-height:1',
      'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif',
      'color:rgba(237,237,237,.85)', 'background:rgba(16,16,16,.72)',
      'border:1px solid rgba(255,255,255,.14)', 'border-radius:999px',
      'cursor:pointer', 'opacity:.45', 'transition:opacity .15s, background .15s',
      'backdrop-filter:blur(8px)', 'box-shadow:0 2px 8px rgba(0,0,0,.3)',
    ].join(';')
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1' })
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '.45' })
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      ipcRenderer.invoke('dsh:open-external')
    })
    document.body.appendChild(btn)
  } catch (err) {
    console.error('[dsh-desktop] inject browser button failed:', err)
  }
}

/**
 * Token / Context 胶囊（P1）：右上角悬浮小胶囊显示当前会话上下文压力，
 * 点击展开明细（压力进度条、in/out/cache、会话数、今日/周/月估算成本与预算）。
 * 数据来自主进程对 ~/.dsh 会话日志的 5s 轮询，不触碰 Harness 页面内部结构。
 */
function injectTokenPill() {
  try {
    if (!location.href.startsWith('http://')) return
    if (document.getElementById('dsh-token-pill')) return

    const fmt = (n) => {
      if (n == null) return '—'
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(n)
    }

    const pill = document.createElement('div')
    pill.id = 'dsh-token-pill'
    pill.innerHTML =
      '<span class="dsh-tp-dot"></span>' +
      '<span class="dsh-tp-text">—</span>' +
      '<div class="dsh-tp-panel" style="display:none">' +
      '  <div class="dsh-tp-row dsh-tp-head"><b>Token · 用量</b><span class="dsh-tp-close">×</span></div>' +
      '  <div class="dsh-tp-meter"><div class="dsh-tp-fill"></div></div>' +
      '  <div class="dsh-tp-line"><span>上下文压力</span><b class="dsh-tp-pressure">—</b></div>' +
      '  <div class="dsh-tp-line"><span>最近请求</span><b class="dsh-tp-ptok">—</b></div>' +
      '  <div class="dsh-tp-line"><span>输入 / 输出</span><b class="dsh-tp-io">—</b></div>' +
      '  <div class="dsh-tp-line"><span>缓存读写</span><b class="dsh-tp-cache">—</b></div>' +
      '  <div class="dsh-tp-line"><span>会话数</span><b class="dsh-tp-sessions">—</b></div>' +
      '  <div class="dsh-tp-sep"></div>' +
      '  <div class="dsh-tp-line"><span>今日估算</span><b class="dsh-tp-today">—</b></div>' +
      '  <div class="dsh-tp-line"><span>本周 / 本月</span><b class="dsh-tp-month">—</b></div>' +
      '  <div class="dsh-tp-line"><span>预算</span><b class="dsh-tp-budget">未设置</b></div>' +
      '  <div class="dsh-tp-line dsh-tp-balance-row" style="display:none"><span>官方余额</span><b class="dsh-tp-balance">—</b></div>' +
      '  <div class="dsh-tp-line"><span>本地存储</span><b class="dsh-tp-storage">—</b></div>' +
      '  <div class="dsh-tp-note">金额为本地日志按官方价的估算值</div>' +
      '</div>'
    pill.style.cssText = [
      'position:fixed', 'top:40px', 'right:12px', 'z-index:2147483646',
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'padding:4px 10px', 'font-size:11px', 'line-height:16px',
      'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif',
      'color:rgba(237,237,237,.85)', 'background:rgba(16,16,16,.72)',
      'border:1px solid rgba(255,255,255,.14)', 'border-radius:999px',
      'cursor:pointer', 'user-select:none', 'backdrop-filter:blur(8px)',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)', 'transition:border-color .2s',
    ].join(';')

    const style = document.createElement('style')
    style.textContent = [
      '#dsh-token-pill .dsh-tp-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#3fb950);flex:none}',
      '#dsh-token-pill.warn .dsh-tp-dot{background:#d29922}#dsh-token-pill.warn{border-color:#d29922}',
      '#dsh-token-pill.bad .dsh-tp-dot{background:#f85149}#dsh-token-pill.bad{border-color:#f85149}',
      '#dsh-token-pill .dsh-tp-text{font-variant-numeric:tabular-nums;white-space:nowrap}',
      '#dsh-token-pill .dsh-tp-panel{position:absolute;top:calc(100% + 8px);right:0;width:250px;',
      '  background:rgba(22,22,22,.96);border:1px solid rgba(255,255,255,.14);border-radius:10px;',
      '  padding:10px 12px;color:rgba(237,237,237,.88);cursor:default;box-shadow:0 4px 16px rgba(0,0,0,.4)}',
      '#dsh-token-pill .dsh-tp-row{display:flex;justify-content:space-between;margin-bottom:6px}',
      '#dsh-token-pill .dsh-tp-head b{font-size:12px}#dsh-token-pill .dsh-tp-close{opacity:.5;cursor:pointer;padding:0 2px}',
      '#dsh-token-pill .dsh-tp-meter{height:5px;background:rgba(255,255,255,.12);border-radius:3px;overflow:hidden;margin-bottom:8px}',
      '#dsh-token-pill .dsh-tp-fill{height:100%;width:0%;background:#3fb950;border-radius:3px;transition:width .3s}',
      '#dsh-token-pill.warn .dsh-tp-fill{background:#d29922}#dsh-token-pill.bad .dsh-tp-fill{background:#f85149}',
      '#dsh-token-pill .dsh-tp-line{display:flex;justify-content:space-between;line-height:20px;font-size:11.5px}',
      '#dsh-token-pill .dsh-tp-line span{opacity:.6}#dsh-token-pill .dsh-tp-line b{font-weight:500;font-variant-numeric:tabular-nums}',
      '#dsh-token-pill .dsh-tp-sep{height:1px;background:rgba(255,255,255,.1);margin:7px 0}',
      '#dsh-token-pill .dsh-tp-note{margin-top:7px;font-size:10px;opacity:.4;line-height:14px}',
    ].join('')
    document.head.appendChild(style)
    document.body.appendChild(pill)

    const panel = pill.querySelector('.dsh-tp-panel')
    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      const open = panel.style.display === 'none'
      panel.style.display = open ? 'block' : 'none'
      if (open) {
        window.dshDesktop.getTokens()
        window.dshDesktop.getStorage().then((s) => {
          if (s) pill.querySelector('.dsh-tp-storage').textContent = `${s.totalMB}（会话 ${s.sessionsMB}）`
        }).catch(() => {})
      }
    })
    pill.querySelector('.dsh-tp-close').addEventListener('click', (e) => {
      e.stopPropagation(); panel.style.display = 'none'
    })
    document.addEventListener('click', (e) => {
      if (!pill.contains(e.target)) panel.style.display = 'none'
    })

    const render = (s) => {
      if (!s || !s.usage) return
      const u = s.usage, c = s.cost
      const pct = u.pressurePct || 0
      pill.querySelector('.dsh-tp-text').textContent =
        u.current ? `${fmt(u.pressureTokens)} · ${pct}%` : '— —'
      pill.classList.toggle('warn', pct >= 60 && pct < 85)
      pill.classList.toggle('bad', pct >= 85)
      pill.querySelector('.dsh-tp-fill').style.width = Math.min(100, pct) + '%'
      pill.querySelector('.dsh-tp-pressure').textContent = pct + '%'
      pill.querySelector('.dsh-tp-ptok').textContent = `${fmt(u.pressureTokens)} / ${fmt(u.contextWindow)}`
      pill.querySelector('.dsh-tp-io').textContent = u.current ? `${fmt(u.current.input)} / ${fmt(u.current.output)}` : '—'
      pill.querySelector('.dsh-tp-cache').textContent = u.current ? `${fmt(u.current.cacheRead)} / ${fmt(u.current.cacheWrite)}` : '—'
      pill.querySelector('.dsh-tp-sessions').textContent = String(u.sessionCount ?? '—')
      if (c) {
        pill.querySelector('.dsh-tp-today').textContent = `¥${c.today.cost.toFixed(2)}（省 ¥${c.today.saved.toFixed(2)}）`
        pill.querySelector('.dsh-tp-month').textContent = `¥${c.week.cost.toFixed(2)} / ¥${c.month.cost.toFixed(2)}`
        const b = pill.querySelector('.dsh-tp-budget')
        if (c.budget) {
          b.textContent = `¥${c.budget.monthly} · ${c.budget.pct}%` + (c.budget.level === 'exceed' ? ' 超支' : c.budget.level === 'warn' ? ' 预警' : '')
          b.style.color = c.budget.level === 'exceed' ? '#f85149' : c.budget.level === 'warn' ? '#d29922' : ''
        } else { b.textContent = '未设置'; b.style.color = '' }
        const balRow = pill.querySelector('.dsh-tp-balance-row')
        if (c.balance) {
          balRow.style.display = 'flex'
          const bel = pill.querySelector('.dsh-tp-balance')
          bel.textContent = `¥${Number(c.balance.total).toFixed(2)}（赠送 ¥${Number(c.balance.granted).toFixed(2)}）`
          bel.style.color = c.balance.total <= 10 ? '#f85149' : ''
        }
      }
    }
    window.dshDesktop.onTokens(render)
    window.dshDesktop.getTokens().then(render).catch(() => {})
  } catch (err) {
    console.error('[dsh-desktop] inject token pill failed:', err)
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    injectCaptionStrip()
    injectBrowserButton()
    injectTokenPill()
  })
} else {
  injectCaptionStrip()
  injectBrowserButton()
  injectTokenPill()
}
