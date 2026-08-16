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

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    injectCaptionStrip()
    injectBrowserButton()
  })
} else {
  injectCaptionStrip()
  injectBrowserButton()
}
