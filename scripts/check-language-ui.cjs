'use strict'
// Isolated Electron smoke test. No real accounts or Minecraft connections.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botify-language-ui-'))
process.env.BOTIFY_DATA = dir
app.setPath('userData', path.join(dir, 'electron'))
app.disableHardwareAcceleration()
let server; let win
const timeout = setTimeout(() => { console.error('UI check timed out'); app.exit(1) }, 45000)

app.whenReady().then(async () => {
  const { startServer } = require('../src/server')
  const { Store } = require('../src/store')
  server = await startServer({ port: 0 })
  const account = server.app.store.addAccount({ username: 'UiTest', type: 'offline', note: 'Не переводить' })
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  win.webContents.startPainting()
  const errors = []
  win.webContents.on('console-message', event => {
    if (event.level === 'error') { errors.push(event.message); console.error(event.message) }
  })
  const js = async source => {
    try { return await win.webContents.executeJavaScript(source) } catch (error) { console.error('Failed UI step:', source); throw error }
  }
  const until = condition => js(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (${condition}) resolve();
      else if (Date.now() > deadline) reject(new Error('Condition timed out'));
      else setTimeout(check, 25);
    }; check();
  })`)
  const openSettings = () => js(`document.querySelector('#open-settings').click(); new Promise(resolve => setTimeout(resolve, 60))`)
  const choose = lang => js(`(() => {
    const select = document.querySelector('#settings-language');
    const trigger = select.parentElement.querySelector('button');
    trigger.click();
    const index = [...select.options].findIndex(option => option.value === '${lang}');
    document.getElementById(trigger.getAttribute('aria-controls')).querySelectorAll('[role=option]')[index].click();
  })()`)
  const save = () => js(`document.querySelector('.modal-foot .primary').click()`)
  const cleanEnglish = async selector => {
    const text = await js(`(() => {
      const root = document.querySelector('${selector}');
      return root.textContent + [...root.querySelectorAll('[title], [placeholder]')].map(el => (el.title || '') + (el.placeholder || '')).join(' ');
    })()`)
    assert.doesNotMatch(text.replaceAll('Русский', ''), /[А-Яа-яЁё]/, `Untranslated content in ${selector}`)
  }

  await win.loadURL(server.url)
  await until(`document.querySelector('.bot-row')`)
  assert.equal(await js('document.documentElement.lang'), 'ru')
  await openSettings()
  await js(`document.querySelector('#settings-language').parentElement.querySelector('button').click()`)
  assert.equal(await js(`document.querySelector('#settings-language').parentElement.querySelector('button').getAttribute('aria-expanded')`), 'true')
  assert.equal(await js(`document.querySelector('.select-popup').getAnimations({ subtree: true }).length`), 2, 'Panel expansion precedes option reveal')
  await js(`document.querySelector('#settings-language').parentElement.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  assert.equal(await js(`!!document.querySelector('.modal')`), true, 'Escape closes the dropdown, not its modal')
  await choose('en')
  await js(`document.querySelector('.modal-foot .ghost').click()`)
  assert.equal(server.app.store.settings.ui.language, 'ru', 'Cancel must not persist language')
  await openSettings()
  await choose('en')
  await save()
  await until(`document.documentElement.lang === 'en' && !document.querySelector('.modal')`)
  assert.equal(server.app.store.settings.ui.language, 'en')
  assert.equal(await js(`document.querySelector('#search').placeholder`), 'Search bots')
  await cleanEnglish('.app')

  // Translations must persist through a store reload and a page reload.
  server.app.store.flush()
  const reopened = new Store(dir)
  assert.equal(reopened.settings.ui.language, 'en')
  reopened.flush()
  await win.loadURL(server.url)
  await until(`document.documentElement.lang === 'en' && document.querySelector('.bot-row')`)
  await cleanEnglish('.app')
  await openSettings()
  await cleanEnglish('.modal')
  // Keyboard selection works through the custom combobox.
  await js(`(() => {
    const trigger = document.querySelector('#settings-language').parentElement.querySelector('button');
    trigger.focus({ preventScroll: true });
    for (const key of ['ArrowDown', 'Home', 'Enter']) trigger.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  })()`)
  assert.equal(await js(`document.querySelector('#settings-language').value`), 'ru')
  await choose('en')

  const screenshots = path.resolve(__dirname, '../data/research')
  fs.mkdirSync(screenshots, { recursive: true })
  for (const theme of ['Dark', 'Light']) {
    await js(`(() => {
      [...document.querySelectorAll('.seg button')].find(button => button.textContent === '${theme}').click();
      const view = [...document.querySelectorAll('.modal select')].find(select => select.options[0]?.value === 'tiny');
      view.parentElement.querySelector('button').click();
    })()`)
    await js(`new Promise(resolve => setTimeout(resolve, 350))`)
    await until(`Number(getComputedStyle(document.querySelector('.modal')).opacity) > 0.99`)
    assert.equal(await js(`!!document.querySelector('.modal .select-trigger[aria-expanded=true]')`), true, 'Dropdown stays open during its animation')
    assert.equal(await js(`(() => {
      const panel = document.querySelector('.select-popup');
      const rect = panel.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
    })()`), true)
    fs.writeFileSync(path.join(screenshots, `settings-dropdown-${theme.toLowerCase()}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  }
  await js(`document.querySelector('.modal-foot .ghost').click()`)

  await js(`document.querySelector('#nav-farm').click()`)
  await cleanEnglish('.app')
  assert.equal(await js(`document.querySelector('.farm-page').scrollWidth <= document.querySelector('#view').clientWidth`), true)
  await js(`document.querySelector('.farm-page textarea').value = 'FriendDraft'`)
  await openSettings()
  await choose('ru')
  await save()
  await until(`document.documentElement.lang === 'ru' && !document.querySelector('.modal')`)
  assert.equal(await js(`document.querySelector('.farm-page textarea').value`), 'FriendDraft')
  assert.match(await js(`document.querySelector('#topbar').textContent`), /Автоферма/)
  await openSettings()
  await choose('en')
  await save()
  await until(`document.documentElement.lang === 'en' && !document.querySelector('.modal')`)

  await js(`document.querySelector('.bot-row').click()`)
  await cleanEnglish('.app')
  await js(`document.querySelector('#topbar .icon-btn').click()`)
  assert.deepEqual(await js(`[...document.querySelectorAll('.menu button')].map(button => button.textContent)`), ['Bot settings', 'Copy username', 'Delete'])
  assert.equal(await js(`document.querySelector('#topbar .btn').textContent`), 'Connect', 'Primary connect button is retained')
  const hoverDelete = async selector => {
    const point = await js(`(() => { const rect = document.querySelector('${selector}').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    await until(`getComputedStyle(document.querySelector('${selector}')).color === 'rgb(255, 95, 87)'`)
  }
  await hoverDelete('.menu .danger')
  await js(`document.querySelector('.menu button').click()`)
  await hoverDelete('.modal-foot .danger')
  await until(`document.querySelector('.seg').hasAttribute('data-ready')`)
  const initialX = await js(`document.querySelector('.seg').style.getPropertyValue('--seg-x')`)
  await js(`document.querySelector('.seg button:last-child').click()`)
  await until(`document.querySelector('.seg button:last-child').getAttribute('aria-pressed') === 'true'`)
  assert.notEqual(await js(`document.querySelector('.seg').style.getPropertyValue('--seg-x')`), initialX)
  assert.match(await js(`getComputedStyle(document.querySelector('.seg'), '::before').transitionProperty`), /transform/)
  await js(`document.querySelector('.modal-foot .danger').click()`)
  await hoverDelete('.modal-foot .danger')
  await js(`document.querySelector('.modal-foot .ghost').click()`)
  assert.equal(server.app.store.listAccounts().length, 1, 'Cancel deletion leaves the account intact')
  await js(`(() => {
    const input = document.querySelector('.prompt input');
    input.focus({ preventScroll: true }); input.value = '.'; input.dispatchEvent(new Event('input'));
  })()`)
  assert.equal(await js(`document.querySelector('.suggest').classList.contains('more-below')`), true)
  assert.equal(await js(`document.querySelector('.suggest').classList.contains('more-above')`), false)
  await js(`document.querySelector('.suggest-list').scrollTop = 100`)
  await until(`document.querySelector('.suggest').classList.contains('more-above')`)
  assert.equal(await js(`document.querySelector('.suggest').classList.contains('more-below')`), true)
  assert.equal(await js(`getComputedStyle(document.querySelector('.suggest'), '::before').backdropFilter`), 'blur(2px)')
  await js(`new Promise(resolve => setTimeout(resolve, 200))`)
  const suggestRect = await js(`(() => { const r = document.querySelector('.suggest').getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`)
  fs.writeFileSync(path.join(screenshots, 'command-suggestions-blur.png'), (await win.webContents.capturePage(suggestRect, { stayHidden: true })).toPNG())
  await js(`document.querySelector('.suggest-list').scrollTop = document.querySelector('.suggest-list').scrollHeight`)
  await until(`!document.querySelector('.suggest').classList.contains('more-below')`)
  assert.equal(await js(`document.querySelector('.suggest').classList.contains('more-above')`), true)
  await js(`document.querySelector('.prompt input').value = '.goto '; document.querySelector('.prompt input').dispatchEvent(new Event('input'))`)
  assert.equal(await js(`document.querySelector('.suggest').classList.contains('more-above') || document.querySelector('.suggest').classList.contains('more-below')`), false)
  await cleanEnglish('.suggest')
  assert.match(await js(`document.querySelector('.suggest').textContent`), /walk to a location/)
  await js(`document.querySelector('.prompt input').value = '.say hello world'; document.querySelector('.prompt input').dispatchEvent(new Event('input'))`)
  assert.equal(await js(`document.querySelector('.prompt .box').classList.contains('bad')`), false, 'Free text remains valid in English')

  const instance = server.app.manager.bots.get(account.id)
  instance.state = 'reconnecting'
  instance.reconnectAt = Date.now() + 10000
  server.app.manager.emit('update', instance.snapshot())
  await until(`document.querySelector('.bot-row .sub').textContent.startsWith('retry in ')`)
  // A Russian server message must survive unchanged when the UI is English.
  server.app.manager.emit('log', account.id, { t: Date.now(), kind: 'chat', text: 'Привет с сервера' })
  await until(`document.querySelector('.log').textContent.includes('Привет с сервера')`)
  instance.state = 'offline'
  instance.reconnectAt = null

  await js(`document.querySelector('#add-bots').click()`)
  await cleanEnglish('.modal')
  await js(`(() => { const buttons = [...document.querySelectorAll('.modal button')]; buttons.find(b => b.textContent === 'Tokens').click(); })()`)
  await cleanEnglish('.modal')
  await js(`document.querySelector('.modal-foot .ghost').click()`)

  // Unknown legacy values fall back safely without dropping unrelated UI settings.
  reopened.updateSettings({ ui: { language: 'unsupported' } })
  assert.equal(reopened.settings.ui.language, 'ru')
  assert.equal(reopened.settings.ui.theme, 'dark')
  reopened.flush()
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('UI passed: language save/cancel/restart, translated forms and hints, unchanged chat; custom dropdown mouse/keyboard/Escape, both themes, segmented indicators, red delete hover, simplified bot menu and suggestion edge blur.')
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
