'use strict'
// Electron shell. Bots run in a separate utility process (src/backend.js); this process
// only owns the window, so the UI stays smooth no matter how busy the bots are.
const { app, BrowserWindow, ipcMain, shell, nativeImage, utilityProcess, dialog } = require('electron')
const path = require('path')

const THEMES = {
  dark: { color: '#0e0e10', symbolColor: '#e9e9ec' },
  light: { color: '#f4f4f5', symbolColor: '#1b1b1d' }
}
const isMac = process.platform === 'darwin'

let win = null
let backend = null
let backendUrl = null
let quitting = false

function applyTheme (theme) {
  const t = THEMES[theme] || THEMES.dark
  if (!win) return
  win.setBackgroundColor(t.color)
  if (!isMac) { try { win.setTitleBarOverlay({ ...t, height: 44 }) } catch {} }
}

function startBackend () {
  return new Promise((resolve, reject) => {
    backend = utilityProcess.fork(path.join(__dirname, 'backend.js'), [], {
      serviceName: 'Botify backend',
      stdio: 'inherit'
    })
    backend.on('message', (m) => {
      if (m?.type === 'ready') { backendUrl = m.url; resolve(m) }
      if (m?.type === 'theme') applyTheme(m.theme)
      if (m?.type === 'fatal') reject(new Error(m.error))
    })
    backend.on('exit', (code) => {
      backend = null
      if (quitting) return
      // backend died unexpectedly → bring it back and reload the UI
      console.error(`[botify] backend exited (${code}), restarting…`)
      setTimeout(() => startBackend().then(() => win?.loadURL(backendUrl)).catch(() => {}), 1000)
    })
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })

  app.whenReady().then(async () => {
    let info
    try {
      info = await startBackend()
    } catch (e) {
      dialog.showErrorBox('Botify', `Не удалось запустить бэкенд:\n${e.message}`)
      app.quit()
      return
    }
    const theme = info.theme === 'light' ? 'light' : 'dark'

    win = new BrowserWindow({
      width: 1320,
      height: 840,
      minWidth: 980,
      minHeight: 620,
      title: 'Botify',
      backgroundColor: THEMES[theme].color,
      icon: nativeImage.createFromPath(path.join(__dirname, '..', 'public', 'icon.png')),
      titleBarStyle: 'hidden',
      ...(isMac ? { trafficLightPosition: { x: 16, y: 16 } } : { titleBarOverlay: { ...THEMES[theme], height: 44 } }),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win.setMenuBarVisibility(false)
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(backendUrl)) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url) }
    })
    win.loadURL(backendUrl)
  })

  ipcMain.on('botify:theme', (_e, theme) => applyTheme(theme))

  app.on('before-quit', (e) => {
    if (quitting || !backend) return
    e.preventDefault()
    quitting = true
    const b = backend
    const done = () => app.quit()
    b.once('exit', done)
    b.postMessage({ type: 'shutdown' })
    setTimeout(() => { try { b.kill() } catch {} done() }, 5000)
  })
  app.on('window-all-closed', () => app.quit())
}
