'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('botifyShell', {
  platform: process.platform,
  setTheme: (theme) => ipcRenderer.send('botify:theme', theme)
})
