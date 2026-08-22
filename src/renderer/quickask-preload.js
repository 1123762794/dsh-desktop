'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('quickAsk', {
  submit: (text) => ipcRenderer.send('quickask:submit', String(text || '').slice(0, 8000)),
  onResult: (cb) => {
    const l = (_e, r) => cb(r)
    ipcRenderer.on('quickask:result', l)
  },
})