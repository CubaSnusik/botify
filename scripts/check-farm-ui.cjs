'use strict'
// Run with Electron. Uses an isolated temporary store and never connects accounts.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botify-farm-ui-'))
process.env.BOTIFY_DATA = dir
app.setPath('userData', path.join(dir, 'electron'))
app.disableHardwareAcceleration()
let server; let win
const timeout = setTimeout(() => { console.error('UI check timed out'); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  const { startServer } = require('../src/server')
  server = await startServer({ port: 0 })
  server.app.store.addAccount({ username: 'UiTest', type: 'offline' })
  win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  await win.loadURL(server.url)
  await win.webContents.executeJavaScript(`new Promise(resolve => {
    const check = () => { if (document.querySelector('.bot-row')) resolve(); else setTimeout(check, 25) }; check()
  })`)
  await win.webContents.executeJavaScript(`document.querySelector('#nav-farm').click()`)
  const form = await win.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('#topbar').textContent,
    fields: document.querySelectorAll('.farm-page input').length,
    buttons: [...document.querySelectorAll('.farm-page button')].map(b => b.textContent),
    fits: document.querySelector('.farm-page').scrollWidth <= document.querySelector('#view').clientWidth
  }))()`)
  assert.match(form.title, /Автоферма/)
  assert.equal(form.fields, 12)
  assert.ok(form.buttons.includes('Сохранить и запустить'))
  assert.equal(form.fits, true)
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.farm-page textarea').value = 'TrustedFriend';
    [...document.querySelectorAll('.farm-page button')].find(b => b.textContent === 'Сохранить').click()
  })()`)
  await win.webContents.executeJavaScript(`new Promise(resolve => {
    const check = () => { if (document.querySelector('#toasts').textContent.includes('сохранены')) resolve(); else setTimeout(check, 25) }; check()
  })`)
  assert.deepEqual(server.app.store.settings.friends, ['TrustedFriend'])
  assert.equal(server.app.store.settings.farm.mealLabel, '1')
  const notifications = []
  server.app.manager.discord.send = async (url, body) => { notifications.push({ url, body }) }
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.farm-page input[type="password"]').value = 'https://discord.com/api/webhooks/123456/fake_test_token';
    const toggle = [...document.querySelectorAll('.farm-page label')].find(e => e.textContent.includes('Уведомлять о проблемах'));
    toggle.querySelector('input').checked = true;
    [...document.querySelectorAll('.farm-page button')].find(b => b.textContent === 'Сохранить и проверить Discord').click();
  })()`)
  await win.webContents.executeJavaScript(`new Promise(resolve => {
    const check = () => { if (document.querySelector('#toasts').textContent.includes('отправлено в Discord')) resolve(); else setTimeout(check, 25) }; check();
  })`)
  assert.equal(server.app.store.settings.farm.discordEnabled, true)
  assert.equal(server.app.store.settings.farm.axeAlertPercent, 10)
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].body, /Проверка уведомлений Botify/)
  const instance = [...server.app.manager.bots.values()][0]
  const commands = []
  instance.command = line => { commands.push(line) }
  instance.setState('online')
  await win.webContents.executeJavaScript(`new Promise(resolve => {
    const check = () => { if (document.querySelector('.farm-page').textContent.includes('· в сети')) resolve(); else setTimeout(check, 25) }; check()
  })`)
  await win.webContents.executeJavaScript(`document.querySelector('.farm-page .primary').click()`)
  await win.webContents.executeJavaScript(`new Promise(resolve => {
    const check = () => { if (document.querySelector('#toasts').textContent.includes('Автоферма запущена')) resolve(); else setTimeout(check, 25) }; check()
  })`)
  assert.deepEqual(commands, ['.autotree'])
  assert.equal(errors.length, 0, errors.join('\n'))
  const screenshot = await win.webContents.capturePage()
  const file = path.resolve(__dirname, '../data/research/auto-farm-ui.png')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, screenshot.toPNG())
  console.log(`Farm UI rendered, saved settings and friends; screenshot: ${file}`)
  win.destroy()
  await server.close()
  clearTimeout(timeout)
  app.exit(0)
}).catch(async error => {
  console.error(error)
  win?.destroy()
  if (server) await server.close()
  clearTimeout(timeout)
  app.exit(1)
})
