import { t as tr, getLanguage, setLanguage, translateStatic, botCount, localizeCommand } from './i18n.js'
import { wrapSelect } from './ui-controls.js'

// ============================================================
// Botify UI
// ============================================================

// ---------- DOM helpers ----------
const $ = (s, r = document) => r.querySelector(s)

function h (tag, attrs, ...kids) {
  const el = document.createElement(tag === 'div' && attrs?.class?.split(' ').includes('seg') ? 'botify-segment' : tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k === 'html') el.innerHTML = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else if (v === true) el.setAttribute(k, '')
      else el.setAttribute(k, v)
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue
    el.append(kid instanceof HTMLSelectElement ? wrapSelect(kid) : kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return el
}

const SVG = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>',
  power: '<svg viewBox="0 0 24 24"><path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  hand: '<svg viewBox="0 0 24 24"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5M14 11.5V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6.5 7S5 18.5 4 15l-.5-2a1.5 1.5 0 0 1 2.7-1.2L8 14"/></svg>',
  drop: '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
  shirt: '<svg viewBox="0 0 24 24"><path d="M8 4 4 7l2 4 2-1v10h8V10l2 1 2-4-4-3a4 4 0 0 1-8 0z"/></svg>',
  clear: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M5 6h14M5 18h9"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  plug: '<svg viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'
}
const icon = (n) => { const t = document.createElement('template'); t.innerHTML = SVG[n]; return t.content.firstChild }

const pad = (n) => String(n).padStart(2, '0')
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1)
const ls = {
  get (k, d) { try { const v = localStorage.getItem('botify.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set (k, v) { try { localStorage.setItem('botify.' + k, JSON.stringify(v)) } catch {} }
}

const VERSIONS = ['auto', '26.2', '26.1', '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5', '1.12.2', '1.8.8']
const STATE_LABEL = () => ({ online: tr('в сети'), offline: tr('не в сети'), queued: tr('в очереди'), connecting: tr('подключение…'), reconnecting: tr('переподключение'), error: tr('ошибка') })
const TYPE_LABEL = () => ({ offline: tr('Оффлайн (пиратка)'), microsoft: tr('Microsoft (вход по коду)'), token: 'Access token', refresh: 'Refresh token' })

// ---------- state ----------
const S = {
  bots: new Map(),
  order: [],
  selected: null,
  settings: null,
  commands: [],
  logs: new Map(),
  inv: new Map(),
  glogs: [],
  targets: new Set(ls.get('targets', [])),
  filter: '',
  dataDir: '',
  msaHandler: null
}
let V = null // refs of the current view

// ---------- API ----------
const api = {
  ws: null,
  seq: 0,
  pending: new Map(),
  handlers: {},
  connect () {
    const ws = new WebSocket(`ws://${location.host}/`)
    this.ws = ws
    ws.onopen = async () => {
      $('#conn-banner').classList.add('hidden')
      const hello = await this.call('hello')
      onHello(hello)
    }
    ws.onmessage = (ev) => {
      const { type, data } = JSON.parse(ev.data)
      if (type === 'res') {
        const p = this.pending.get(data.reqId)
        if (!p) return
        this.pending.delete(data.reqId)
        data.ok ? p.resolve(data.data) : p.reject(new Error(data.error))
        return
      }
      this.handlers[type]?.(data)
    }
    ws.onclose = () => {
      $('#conn-banner').classList.remove('hidden')
      for (const p of this.pending.values()) p.reject(new Error(tr('соединение потеряно')))
      this.pending.clear()
      setTimeout(() => this.connect(), 1000)
    }
  },
  call (type, data) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error(tr('нет связи с бэкендом')))
      const reqId = ++this.seq
      this.pending.set(reqId, { resolve, reject })
      this.ws.send(JSON.stringify({ type, reqId, data }))
    })
  },
  on (type, fn) { this.handlers[type] = fn }
}

async function act (type, data, okMsg) {
  try {
    const r = await api.call(type, data)
    if (okMsg) toast(okMsg)
    return r
  } catch (e) {
    toast(e.message, true)
    throw e
  }
}

// ---------- toasts / tooltip / menu / modal ----------
function toast (text, err = false) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, text)
  $('#toasts').append(t)
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300) }, err ? 5000 : 2600)
}

const tip = $('#tooltip')
function showTip (el, content) {
  tip.replaceChildren(...[content].flat())
  tip.classList.remove('hidden')
  const r = el.getBoundingClientRect()
  const tr = tip.getBoundingClientRect()
  let x = r.left + r.width / 2 - tr.width / 2
  let y = r.top - tr.height - 8
  if (y < 8) y = r.bottom + 8
  x = Math.max(8, Math.min(window.innerWidth - tr.width - 8, x))
  tip.style.left = x + 'px'
  tip.style.top = y + 'px'
}
const hideTip = () => tip.classList.add('hidden')

function openMenu (x, y, items) {
  closeMenu()
  const menu = h('div', { class: 'menu' })
  for (const it of items) {
    if (it === '-') { menu.append(h('hr')); continue }
    if (it.el) { menu.append(it.el); continue }
    if (it.label && !it.run) { menu.append(h('div', { class: 'lbl' }, it.label)); continue }
    menu.append(h('button', { class: it.danger ? 'danger' : null, onclick: () => { closeMenu(); it.run() } }, it.icon ? icon(it.icon) : null, it.text))
  }
  $('#menu-root').append(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px'
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true))
  function onOutside (e) { if (!menu.contains(e.target)) closeMenu() }
  menu._off = () => document.removeEventListener('pointerdown', onOutside, true)
}
function closeMenu () {
  const m = $('#menu-root .menu')
  if (m) { m._off?.(); m.remove() }
}

const modals = []
function openModal ({ title, body, foot, wide, onClose, head }) {
  const close = () => {
    wrap.remove()
    const i = modals.indexOf(api_)
    if (i >= 0) modals.splice(i, 1)
    onClose?.()
  }
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
    h('div', { class: 'modal-head' }, head || null, h('h2', null, title),
      h('button', { class: 'icon-btn sm', title: tr('Закрыть'), onclick: () => close(), html: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>' })),
    h('div', { class: 'modal-body' }, body),
    foot ? h('div', { class: 'modal-foot' }, foot) : null
  )
  const wrap = h('div', { class: 'modal-wrap', onpointerdown: (e) => { if (e.target === wrap) close() } }, box)
  $('#modal-root').append(wrap)
  const api_ = { close, el: box }
  modals.push(api_)
  setTimeout(() => box.querySelector('input:not([type=checkbox]), textarea')?.focus(), 30)
  return api_
}

function confirmModal (title, text, okText = tr('Удалить')) {
  return new Promise((resolve) => {
    let done = false
    const m = openModal({
      title,
      body: h('div', { style: { color: 'var(--fg-2)' } }, text),
      foot: [
        h('button', { class: 'btn ghost', onclick: () => m.close() }, tr('Отмена')),
        h('button', { class: 'btn primary danger', onclick: () => { done = true; m.close(); resolve(true) } }, okText)
      ],
      onClose: () => { if (!done) resolve(false) }
    })
  })
}

// ---------- heads ----------
const headCache = new Map()
const headReady = new Map()
const headKey = (b) => `${b.id}|${b.uuid || ''}|${b.type === 'offline' ? b.username : ''}`
function loadHead (b) {
  const key = headKey(b)
  if (!headCache.has(key)) {
    headCache.set(key, new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = c.height = 8
        const x = c.getContext('2d')
        x.imageSmoothingEnabled = false
        x.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8)
        x.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8) // hat layer
        const url = c.toDataURL()
        headReady.set(key, url)
        resolve(url)
      }
      img.onerror = () => resolve(null)
      img.src = `/skin/${b.id}?k=${encodeURIComponent(key)}`
    }))
  }
  return headCache.get(key)
}
function headImg (b, cls = '') {
  const key = headKey(b)
  const img = h('img', { class: 'head ' + cls, alt: '', draggable: 'false' })
  img.dataset.key = key
  if (headReady.has(key)) img.src = headReady.get(key)
  else loadHead(b).then(u => { if (u) img.src = u })
  return img
}
function refreshHead (img, b) {
  if (img.dataset.key === headKey(b)) return
  img.dataset.key = headKey(b)
  loadHead(b).then(u => { if (u) img.src = u })
}

// ---------- helpers about bots ----------
const botName = (b) => b.username || (b.type === 'microsoft' ? tr('Microsoft-аккаунт') : tr('Без имени'))
const botTitle = (b) => `${b.accountIssue ? '! ' : ''}${botName(b)}`
const serverStr = (s) => !s.port || Number(s.port) === 25565 ? s.host : `${s.host}:${s.port}`
function subText (b) {
  if (b.accountIssue) return tr('утерян / украден · вход остановлен')
  if (b.state === 'queued') return tr('в очереди на вход')
  if (b.state === 'online' && b.dialog) return tr('диалог: {0}', b.dialog.title)
  if (b.state === 'online' && b.window) return tr('открыто меню')
  if (b.state === 'online' && b.live) return `${serverStr(b.server)} · ♥ ${f1(b.live.health)}`
  if (b.state === 'connecting') return b.authCode ? tr('ждёт вход Microsoft') : tr('подключение…')
  if (b.state === 'reconnecting') {
    const s = b.reconnectAt ? Math.max(0, Math.ceil((b.reconnectAt - Date.now()) / 1000)) : 0
    return tr('повтор через {0}с', s)
  }
  if (b.state === 'error') return b.error || tr('ошибка')
  return serverStr(b.server)
}
const onlineCount = () => [...S.bots.values()].filter(b => b.state === 'online').length
const isActive = (b) => ['online', 'connecting', 'reconnecting', 'queued'].includes(b.state)

// ---------- hello ----------
function onHello (d) {
  S.settings = d.settings
  S.commands = d.commands
  S.dataDir = d.dataDir
  S.glogs = d.globalLogs || []
  S.bots = new Map(d.bots.map(b => [b.id, b]))
  S.order = d.bots.map(b => b.id)
  S.logs.clear()
  S.inv.clear()
  setLanguage(S.settings.ui?.language)
  ls.set('language', getLanguage())
  translateStatic()
  applyTheme(S.settings.ui?.theme || 'dark')
  renderSidebar()
  const want = S.selected || ls.get('selected', 'global')
  select(S.bots.has(want) || want === 'farm' ? want : 'global', true)
  renderTpDock()
}

function applyTheme (t) {
  document.documentElement.dataset.theme = t
  window.botifyShell?.setTheme?.(t)
}

// ---------- events ----------
api.on('bot', (snap) => {
  const isNew = !S.bots.has(snap.id)
  S.bots.set(snap.id, snap)
  if (isNew) { if (!S.order.includes(snap.id)) S.order.push(snap.id); renderSidebar() } else patchRow(snap)
  updateCounts()
  if (S.selected === snap.id) schedule('view', updateBotView)
  if (S.selected === 'global') schedule('targets', renderTargets, 300)
  if (S.selected === 'farm') updateFarmStatus()
  schedule('tpdock', renderTpDock)
})

// coalesce frequent redraws (bots send updates several times per second each)
const scheduled = new Map()
function schedule (key, fn, delay = 0) {
  if (scheduled.has(key)) return
  scheduled.set(key, true)
  const run = () => { scheduled.delete(key); fn() }
  if (delay) setTimeout(() => requestAnimationFrame(run), delay)
  else requestAnimationFrame(run)
}
api.on('bots', (list) => {
  S.bots = new Map(list.map(b => [b.id, b]))
  S.order = list.map(b => b.id)
  renderSidebar()
  if (S.selected !== 'global' && !S.bots.has(S.selected)) select('global')
  else if (S.selected === 'global') renderTargets()
  else updateBotView()
  renderTpDock()
})
api.on('removed', ({ id }) => {
  S.bots.delete(id)
  S.order = S.order.filter(x => x !== id)
  renderSidebar()
  renderTpDock()
  if (S.selected === id) select('global')
})
api.on('log', ({ id, entry }) => {
  const arr = S.logs.get(id)
  if (arr) { arr.push(entry); if (arr.length > 800) arr.splice(0, arr.length - 800) }
  if (S.selected === id && V?.console) V.console.append(entry)
})
api.on('glog', (entry) => {
  S.glogs.push(entry)
  if (S.glogs.length > 1200) S.glogs.splice(0, S.glogs.length - 1200)
  if (S.selected === 'global' && V?.console) V.console.append(entry)
})
api.on('inventory', ({ id, inv }) => {
  S.inv.set(id, inv)
  if (S.selected === id) renderInventory()
})
api.on('authCode', ({ id, code }) => {
  const b = S.bots.get(id)
  if (b) { b.authCode = code; patchRow(b); if (S.selected === id) updateBotView() }
  if (code) toast(tr('{0}: нужен вход Microsoft — код {1}', b ? botName(b) : tr('Бот'), code.code))
})
api.on('settings', (s) => {
  S.settings = s
  applyTheme(s.ui?.theme || 'dark')
  if (setLanguage(s.ui?.language)) {
    ls.set('language', getLanguage())
    translateStatic()
    // Preserve drafts and selected form values while rebuilding translated views.
    const fields = [...$('#view').querySelectorAll('input, textarea, select')].map(el => ({ value: el.value, checked: el.checked }))
    renderSidebar()
    closeMenu()
    select(S.selected, true)
    $('#view').querySelectorAll('input, textarea, select').forEach((el, i) => {
      if (fields[i]) { el.value = fields[i].value; el.checked = fields[i].checked }
    })
    updateFarmStatus()
    renderTpDock()
  }
  for (const b of S.bots.values()) patchRow(b)
})
api.on('msaCode', (d) => S.msaHandler?.(d))

// ticking countdowns
setInterval(() => {
  for (const b of S.bots.values()) if (b.state === 'reconnecting') patchRow(b)
  if (S.selected && S.bots.get(S.selected)?.state === 'reconnecting') updateBotView()
}, 1000)

// X/Y/Z inputs: Space jumps to the next field, Enter submits,
// pasting "100 64 -200" fills all three.
function coordFields (fields, submit) {
  fields.forEach((input, i) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit()
      else if (e.key === ' ') {
        e.preventDefault()
        const next = fields[i + 1]
        if (next) { next.focus(); next.select() }
      } else if (e.key === 'Backspace' && !input.value && i > 0) {
        e.preventDefault()
        const prev = fields[i - 1]
        prev.focus(); prev.setSelectionRange(prev.value.length, prev.value.length)
      }
    })
    input.addEventListener('paste', (e) => {
      const parts = (e.clipboardData?.getData('text') || '').trim().split(/[\s,;]+/).filter(Boolean)
      if (parts.length < 2) return
      e.preventDefault()
      parts.slice(0, fields.length - i).forEach((p, k) => { fields[i + k].value = p })
      fields[Math.min(i + parts.length, fields.length) - 1].focus()
    })
  })
}

// ============================================================
// Sidebar
// ============================================================
const rows = new Map()

function renderSidebar () {
  const list = $('#bot-list')
  list.replaceChildren()
  rows.clear()
  const q = S.filter.trim().toLowerCase()
  // Rows slide in one after another only the first time the list fills.
  const intro = !S.listShown && S.bots.size > 0
  if (intro) S.listShown = true
  let shown = 0
  for (const id of S.order) {
    const b = S.bots.get(id)
    if (!b) continue
    if (q && !(botName(b).toLowerCase().includes(q) || b.server.host.toLowerCase().includes(q))) continue
    const row = buildRow(b)
    if (intro) { row.classList.add('intro'); row.style.animationDelay = `${Math.min(shown, 12) * 35}ms` }
    rows.set(id, row)
    list.append(row)
    shown++
  }
  if (!S.bots.size) {
    list.append(h('div', { class: 'empty-list' }, tr('Ботов пока нет.'), h('br'), tr('Жми «Добавить ботов» внизу.')))
  } else if (!shown) {
    list.append(h('div', { class: 'empty-list' }, tr('Ничего не найдено')))
  }
  updateCounts()
  $('#nav-global').classList.toggle('active', S.selected === 'global')
  $('#nav-farm').classList.toggle('active', S.selected === 'farm')
}

function buildRow (b) {
  const power = h('button', {
    class: 'power',
    disabled: !!b.accountIssue,
    title: isActive(b) ? tr('Отключить') : tr('Подключить'),
    onclick: (e) => { e.stopPropagation(); togglePower(S.bots.get(b.id)) }
  }, icon('power'))
  const row = h('div', {
    class: 'bot-row s-' + b.state + (S.selected === b.id ? ' active' : ''),
    dataset: { id: b.id },
    onclick: () => select(b.id),
    oncontextmenu: (e) => { e.preventDefault(); botMenu(S.bots.get(b.id), e.clientX, e.clientY) }
  },
  headImg(b),
  h('div', { class: 'meta' }, h('div', { class: 'name', title: b.accountIssue?.reason || '' }, botTitle(b)), h('div', { class: 'sub' }, subText(b))),
  power
  )
  return row
}

function patchRow (b) {
  const row = rows.get(b.id)
  if (!row) return
  for (const c of [...row.classList]) if (c.startsWith('s-') && c !== 's-' + b.state) row.classList.remove(c)
  row.classList.add('s-' + b.state)
  refreshHead(row.querySelector('.head'), b)
  row.querySelector('.name').textContent = botTitle(b)
  row.querySelector('.name').title = b.accountIssue?.reason || ''
  row.querySelector('.power').disabled = !!b.accountIssue
  row.querySelector('.sub').textContent = subText(b)
  row.querySelector('.power').title = isActive(b) ? tr('Отключить') : tr('Подключить')
}

function updateCounts () {
  const on = onlineCount()
  $('#online-badge').textContent = on
  $('#bots-count').textContent = S.bots.size ? `${on}/${S.bots.size}` : ''
}

function togglePower (b) {
  if (!b) return
  if (isActive(b)) act('bot.disconnect', { id: b.id })
  else act('bot.connect', { id: b.id })
}

function botMenu (b, x, y, { showPower = true } = {}) {
  if (!b) return
  openMenu(x, y, [
    { label: botName(b) },
    ...(showPower ? [isActive(b)
      ? { text: tr('Отключить'), icon: 'power', run: () => act('bot.disconnect', { id: b.id }) }
      : { text: tr('Подключить'), icon: 'plug', run: () => act('bot.connect', { id: b.id }) }] : []),
    { text: tr('Настройки бота'), icon: 'gear', run: () => botSettingsModal(b.id) },
    { text: tr('Скопировать ник'), icon: 'copy', run: () => copy(botName(b)) },
    '-',
    { text: tr('Удалить'), icon: 'trash', danger: true, run: () => removeBot(b.id) }
  ])
}

async function removeBot (id) {
  const b = S.bots.get(id)
  if (!b) return
  const ok = await confirmModal(tr('Удалить бота?'), tr('{0} будет отключён и удалён вместе с токенами из accounts.json.', botName(b)))
  if (ok) act('bot.remove', { id }, tr('Бот удалён'))
}

function copy (text) {
  navigator.clipboard?.writeText(text).then(() => toast(tr('Скопировано')), () => toast(tr('Не удалось скопировать'), true))
}

$('#search').addEventListener('input', (e) => { S.filter = e.target.value; renderSidebar() })
$('#nav-global').addEventListener('click', () => select('global'))
$('#nav-farm').addEventListener('click', () => select('farm'))
$('#connect-all').addEventListener('click', () => act('bots.connectAll', {}, tr('Подключаю всех…')))
$('#disconnect-all').addEventListener('click', () => act('bots.disconnectAll', {}, tr('Все отключены')))
$('#add-bots').addEventListener('click', () => addBotsModal())
$('#open-settings').addEventListener('click', () => settingsModal())

// ============================================================
// Selection / views
// ============================================================
function select (id, force = false) {
  if (S.selected === id && !force) return
  S.selected = id
  ls.set('selected', id)
  for (const [rid, row] of rows) row.classList.toggle('active', rid === id)
  $('#nav-global').classList.toggle('active', id === 'global')
  $('#nav-farm').classList.toggle('active', id === 'farm')
  hideTip()
  if (id === 'global') renderGlobal()
  else if (id === 'farm') renderFarm()
  else renderBot(id)
  requestAnimationFrame(placeTp)
}

function updateFarmStatus () {
  if (V?.kind !== 'farm') return
  for (const option of [...V.bot.options]) if (!S.bots.has(option.value)) option.remove()
  for (const b of S.bots.values()) {
    let option = [...V.bot.options].find(o => o.value === b.id)
    if (!option) { option = h('option', { value: b.id }); V.bot.append(option) }
    if (option.textContent !== botName(b)) option.textContent = botName(b)
  }
  const b = S.bots.get(V.bot.value)
  V.status.textContent = b ? `${botName(b)} · ${STATE_LABEL()[b.state]}${b.task ? ' · ' + b.task : ''}` : tr('Добавьте бота и подключите его к серверу')
}

function renderFarm () {
  const config = S.settings.farm || {}
  $('#topbar').replaceChildren(h('h2', null, tr('Автоферма')), h('span', { class: 'muted' }, tr('Команда запуска: .autotree · остановка: .stop')))
  const inputs = {}
  const field = (name, label, fallback, type = 'text', min, max) => {
    const input = h('input', { class: 'input', type, value: config[name] ?? fallback, min, max })
    inputs[name] = input
    return h('label', { class: 'field' }, h('span', null, label), input)
  }
  const toggle = (name, label, fallback) => {
    const input = h('input', { type: 'checkbox', checked: config[name] ?? fallback })
    inputs[name] = input
    return h('label', { class: 'toggle-row' }, h('span', null, label), h('span', { class: 'switch' }, input, h('i')))
  }
  const species = h('select', { class: 'input' }, ['spruce', 'jungle', 'dark_oak', 'pale_oak'].map(s => h('option', { value: s, selected: s === (config.species || 'spruce') }, s)))
  const botSelect = h('select', { class: 'input' }, [...S.bots.values()].map(b => h('option', { value: b.id }, botName(b))))
  const status = h('div', { class: 'hint' })
  botSelect.addEventListener('change', updateFarmStatus)
  const friends = h('textarea', { class: 'input', rows: 3, placeholder: tr('Ники через пробел, запятую или с новой строки') }, (S.settings.friends || []).join('\n'))
  const save = async () => {
    const farm = { species: species.value }
    for (const [name, input] of Object.entries(inputs)) farm[name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim()
    await act('settings.update', { patch: { farm, friends: friends.value.split(/[\s,;]+/).filter(Boolean) } }, tr('Настройки автофермы сохранены'))
  }
  const start = h('button', { class: 'btn primary', onclick: async () => {
    start.disabled = true
    try {
      const b = S.bots.get(botSelect.value)
      if (!b || b.state !== 'online') { toast(tr('Выберите подключённого бота'), true); return }
      await save()
      await act('bot.command', { id: b.id, line: '.autotree' }, tr('Автоферма запущена; ход работы — в чате бота'))
    } catch {} finally { start.disabled = false }
  } }, tr('Сохранить и запустить'))
  const body = h('div', { class: 'farm-page stack' },
    h('div', { class: 'sub-h' }, tr('Площадка и запуск')),
    h('p', { class: 'hint' }, tr('Бот ищет отдельный квадрат из четырёх блоков земли, подзола или грязи в загруженных чанках и подходит к нему. Топор Shard Axe должен быть в инвентаре.')),
    h('div', { class: 'farm-grid' }, h('label', { class: 'field' }, h('span', null, tr('Бот')), botSelect), h('label', { class: 'field' }, h('span', null, tr('Вид саженцев')), species), field('searchRadius', tr('Радиус поиска площадки и контейнеров'), 32, 'number', 4, 64)),
    status,
    h('div', { class: 'divider' }),
    h('div', { class: 'sub-h' }, tr('Пополнение из контейнеров')),
    toggle('restock', tr('Самостоятельно забирать запасы и возвращаться'), true),
    h('p', { class: 'hint' }, tr('Табличка на контейнере или непосредственно рядом с ним. Метка должна занимать отдельную строку. Поддерживаются сундуки, бочки, шалкеры, воронки, раздатчики и выбрасыватели.')),
    h('div', { class: 'farm-grid' }, field('mealLabel', tr('Метка: костная мука'), '1'), field('saplingLabel', tr('Метка: саженцы'), '3'), field('experienceLabel', tr('Метка: бутылочки опыта'), '2'), field('mealCount', tr('Запас муки, шт.'), 64, 'number', 4, 256), field('saplingCount', tr('Запас саженцев, шт.'), 64, 'number', 4, 256), field('experienceCount', tr('Запас опыта, шт. (0 — не брать)'), 16, 'number', 0, 64)),
    h('p', { class: 'hint' }, tr('Опыт только запасается. Автоматическая починка пока не включена.')),
    h('div', { class: 'divider' }),
    h('div', { class: 'sub-h' }, tr('Автолив и друзья')),
    toggle('autoLeave', tr('Отключаться при появлении постороннего игрока'), true),
    h('p', { class: 'hint' }, tr('Во время фарма и походов за запасами. Проверяется вся загруженная область. После автолива переподключения нет: следующий вход — только вручную. Ваши боты и друзья игнорируются.')),
    h('label', { class: 'field' }, h('span', null, tr('Общий список друзей для всех ботов')), friends),
    h('p', { class: 'hint' }, tr('.friend add Ник · .friend remove Ник · .friend clear · .friend list. Друзей боты не атакуют.')),
    h('div', { class: 'divider' }),
    h('div', { class: 'sub-h' }, tr('Уведомления Discord')),
    toggle('discordEnabled', tr('Уведомлять о проблемах всех ботов'), false),
    field('discordWebhook', 'Discord webhook URL', '', 'password'),
    field('axeAlertPercent', tr('Предупреждать при остатке прочности топора, %'), 10, 'number', 1, 100),
    h('p', { class: 'hint' }, tr('Кик/бан, отключение и автолив, смерть, ошибки фермы, частые коррекции и низкая прочность. О расходниках — только если бот открыл контейнер и нужного предмета там нет. Флаг античита по коррекциям не подтверждается. Повтор одной проблемы — не чаще раза в 5 минут. Ссылка сохраняется локально.')),
    h('button', { class: 'btn', onclick: async event => {
      const button = event.currentTarget; button.disabled = true
      try {
        if (!botSelect.value) { toast(tr('Добавьте и выберите бота для проверки'), true); return }
        await save()
        await act('discord.test', { id: botSelect.value }, tr('Проверочное сообщение отправлено в Discord'))
      } catch {} finally { button.disabled = false }
    } }, tr('Сохранить и проверить Discord')),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => save().catch(() => {}) }, tr('Сохранить')), start, h('button', { class: 'btn', onclick: () => { if (botSelect.value) act('bot.command', { id: botSelect.value, line: '.stop' }).catch(() => {}) } }, icon('stop'), tr('Остановить')))
  )
  V = { kind: 'farm', bot: botSelect, status }
  $('#view').replaceChildren(body)
  updateFarmStatus()
}

// ---------- console component ----------
// Candidates for a command's argument #i (args are the words typed so far, lower-case).
// PLAYERS expands to nicks from the tab list.
const PLAYERS = Symbol('players')
const HOLD_KEYS = ['lmb', 'rmb', 'w', 'a', 's', 'd', 'jump', 'sneak', 'sprint']
const ORBIT = (i) => i === 0 ? [PLAYERS] : ['spin', 'speed=']
const ARG_HINTS = {
  help: (i) => i === 0 ? S.commands.map(c => c.name) : null,
  goto: (i) => i === 0 ? [PLAYERS] : null,
  follow: ORBIT,
  circle: ORBIT,
  transfer: (i, a) => i === 1 ? [PLAYERS] : i === 2 ? ['chests'] : i >= 3 && a[2] === 'chests' ? ['reset'] : null,
  tree: (i, a) => i === 0 ? ['any', 'farm'] : i === 1 && a[0] === 'farm' ? ['spruce', 'jungle', 'dark_oak', 'pale_oak'] : null,
  slot: (i) => i === 0 ? ['1', '2', '3', '4', '5', '6', '7', '8', '9'] : null,
  hold: (i) => i === 0 ? HOLD_KEYS : null,
  release: (i) => i === 0 ? [...HOLD_KEYS, 'all'] : null,
  gui: (i, a) => i === 0 ? ['click', 'close'] : i === 2 && a[0] === 'click' ? ['right', 'shift'] : null,
  dialog: (i) => i === 0 ? ['set', 'close'] : null,
  equip: (i) => i === 1 ? ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] : null,
  drop: (i) => i === 0 ? ['all'] : null,
  use: (i) => i === 0 ? ['stop'] : null,
  lookat: (i) => i === 0 ? [PLAYERS] : null,
  friend: (i, a) => i === 0 ? ['add', 'remove', 'clear', 'list'] : i === 1 && (a[0] === 'add' || a[0] === 'remove') ? [PLAYERS] : null,
  attack: (i) => i === 0 ? ['nearest', PLAYERS] : null,
  sneak: (i) => i === 0 ? ['on', 'off'] : null
}

function createConsole ({ placeholder, onSubmit, historyKey, global = false, botId = null }) {
  const log = h('div', { class: 'log' })
  const input = h('input', { placeholder, spellcheck: 'false', autocomplete: 'off' })
  const suggestList = h('div', { class: 'suggest-list' })
  const suggest = h('div', { class: 'suggest hidden' }, suggestList)
  const updateSuggestEdges = () => {
    suggest.classList.toggle('more-above', suggestList.scrollTop > 1)
    suggest.classList.toggle('more-below', suggestList.scrollHeight - suggestList.clientHeight - suggestList.scrollTop > 1)
  }
  suggestList.addEventListener('scroll', updateSuggestEdges, { passive: true })
  const history = ls.get('hist.' + historyKey, [])
  let hi = history.length
  let sIdx = 0
  let sItems = []

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60

  function line (e) {
    const kind = e.kind || 'out'
    let text = e.text
    if (global && kind === 'cmd' && e.count != null) text = `${e.text}   → ${botCount(e.count)}`
    return h('div', { class: 'ln k-' + kind },
      h('time', null, clock(e.t)),
      global && e.bot ? h('span', { class: 'who' }, e.bot) : null,
      h('span', { class: 'tx' }, text))
  }

  function setEntries (list) {
    log.replaceChildren(...(list.length ? list.slice(-500).map(line) : [emptyNote()]))
    log.scrollTop = log.scrollHeight
  }
  function emptyNote () {
    return h('div', { class: 'log-empty' }, global
      ? tr('Команды отсюда уходят всем выбранным ботам (или всем онлайн). Можно адресовать: @Nick1,Nick2 .goto 0 64 0')
      : tr('Пусто. Пиши текст — уйдёт в чат. Команды начинаются с точки: .help'))
  }
  function append (e) {
    const stick = nearBottom()
    log.querySelector('.log-empty')?.remove()
    log.append(line(e))
    while (log.childElementCount > 800) log.firstChild.remove()
    if (stick) log.scrollTop = log.scrollHeight
  }

  function setError (msg) {
    box.classList.toggle('bad', !!msg)
  }
  // Nicks of players on the server (tab list), fetched on demand and cached briefly.
  let players = []; let playersAt = 0; let playersReq = null
  function needPlayers () {
    if (playersReq || Date.now() - playersAt < 4000) return
    playersReq = api.call('players.list', { id: botId })
      .then((list) => { players = list || [] })
      .catch(() => {})
      .finally(() => {
        playersReq = null; playersAt = Date.now()
        if (document.activeElement === input) updateSuggest()
      })
  }
  const nickItems = (token, base) => {
    needPlayers()
    const t = token.toLowerCase()
    return players.filter(n => n.toLowerCase().startsWith(t) && n !== token).slice(0, 100)
      .map(n => ({ code: n, desc: tr('игрок'), value: base + n + ' ' }))
  }

  // Items are { code, desc, value }: picking one replaces the whole input with `value`.
  function updateSuggest () {
    const v = input.value
    const typed = v.match(/^(@\S+\s+)?\.(\S*)(\s.*)?$/)
    if (!typed) { setError(null); return showItems(plainItems(v)) }
    const prefix = typed[1] || ''
    const q = typed[2].toLowerCase()
    // Arguments being typed: usage with the current argument lit + candidates for it.
    if (typed[3] !== undefined) {
      const c = findCommand(q)
      if (!c) { setError(true); return showItems([], h('span', { class: 'err' }, tr('неизвестная команда .{0}', q)), tr('.help — список команд')) }
      const args = typed[3].trim() ? typed[3].trim().split(/\s+/) : []
      const cur = /\s$/.test(typed[3]) ? args.length : args.length - 1
      const token = /\s$/.test(typed[3]) ? '' : args[args.length - 1]
      const spec = usageSpec(c.usage)
      const extra = spec && args.length > spec.max
      setError(extra)
      const base = v.slice(0, v.length - token.length)
      return showItems(extra ? [] : argItems(c.name, cur, args, token, base),
        spec ? usageView(c, spec, cur) : h('code', null, c.usage),
        extra ? h('span', { class: 'err' }, tr('лишние аргументы — максимум {0}', spec.max)) : c.desc)
    }
    // every registered command is listed (the box scrolls); name matches go before alias-only ones
    const byName = S.commands.filter(c => c.name.startsWith(q))
    const byAlias = S.commands.filter(c => !c.name.startsWith(q) && c.aliases.some(a => a.startsWith(q)))
    const items = [...byName, ...byAlias].map(localizeCommand).map(c => ({ code: c.usage, desc: c.desc, value: `${prefix}.${c.name} `, name: c.name }))
    if (!items.length && q) { setError(true); return showItems([], h('span', { class: 'err' }, tr('неизвестная команда .{0}', q)), tr('.help — список команд')) }
    setError(null)
    showItems(items)
  }

  // Outside of a .command: "@Nick1,Ni" → our bots (global console), last word → player nicks.
  function plainItems (v) {
    const at = global && v.match(/^@((?:[^\s,]+,)*)([^\s,]*)$/)
    if (at) {
      const t = at[2].toLowerCase()
      const chosen = new Set(at[1].toLowerCase().split(',').filter(Boolean))
      return [...S.bots.values()].map(b => b.username).filter(n => n && !chosen.has(n.toLowerCase()) && n.toLowerCase().startsWith(t))
        .map(n => ({ code: '@' + at[1] + n, desc: tr('бот'), value: `@${at[1]}${n} ` }))
    }
    const word = v.match(/(\S{2,})$/)
    if (!word || word[1].startsWith('@')) return []
    return nickItems(word[1], v.slice(0, v.length - word[1].length))
  }

  function argItems (cmd, i, args, token, base) {
    const fn = ARG_HINTS[cmd]
    const list = fn ? fn(i, args.map(a => a.toLowerCase())) : null
    if (!list) return []
    const t = token.toLowerCase()
    const items = []
    for (const x of list) {
      if (x === PLAYERS) { items.push(...nickItems(token, base)); continue }
      if (x.toLowerCase().startsWith(t) && x !== token && !args.slice(0, i).includes(x)) {
        items.push({ code: x, desc: '', value: base + x + (x.endsWith('=') ? '' : ' ') })
      }
    }
    return items
  }

  function showItems (items, noteMain, noteSub) {
    sItems = items
    if (!items.length && !noteMain) { suggest.classList.add('hidden'); return }
    sIdx = Math.min(sIdx, Math.max(0, items.length - 1))
    const rows = items.map((it, i) => h('div', {
      class: 'it' + (i === sIdx ? ' on' : ''),
      onpointerdown: (e) => { e.preventDefault(); complete(it) }
    }, h('code', null, it.code), it.desc ? h('span', null, it.desc) : null))
    suggestList.replaceChildren(...(noteMain ? [h('div', { class: 'it note' }, noteMain, noteSub ? h('span', null, noteSub) : null)] : []), ...rows)
    suggest.classList.remove('hidden')
    rows[sIdx]?.scrollIntoView({ block: 'nearest' })
    updateSuggestEdges()
  }
  function complete (it) {
    input.value = it.value
    sIdx = 0
    input.focus()
    updateSuggest() // show what the next argument can be
  }

  input.addEventListener('input', () => { sIdx = 0; updateSuggest() })
  input.addEventListener('blur', () => setTimeout(() => suggest.classList.add('hidden'), 100))
  input.addEventListener('focus', () => { if (input.value) updateSuggest() })
  input.addEventListener('keydown', (e) => {
    const sOpen = !suggest.classList.contains('hidden') && sItems.length
    if (e.key === 'Tab') {
      e.preventDefault()
      if (sOpen) complete(sItems[sIdx])
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      if (sOpen) {
        sIdx = (sIdx + (e.key === 'ArrowUp' ? -1 : 1) + sItems.length) % sItems.length
        updateSuggest()
        return
      }
      if (!history.length) return
      hi = Math.max(0, Math.min(history.length, hi + (e.key === 'ArrowUp' ? -1 : 1)))
      input.value = history[hi] ?? ''
      suggest.classList.add('hidden')
      setError(null)
      return
    }
    if (e.key === 'Escape') { suggest.classList.add('hidden'); return }
    if (e.key === 'Enter') {
      if (sOpen && /^(@\S+\s+)?\.\S*$/.test(input.value) && !S.commands.some(c => '.' + c.name === input.value.replace(/^@\S+\s+/, ''))) {
        e.preventDefault(); complete(sItems[sIdx]); return
      }
      const v = input.value.trim()
      if (!v) return
      if (history[history.length - 1] !== v) history.push(v)
      if (history.length > 100) history.splice(0, history.length - 100)
      ls.set('hist.' + historyKey, history)
      hi = history.length
      input.value = ''
      suggest.classList.add('hidden')
      setError(null)
      onSubmit(v)
    }
  })

  const box = h('div', { class: 'box' }, h('span', { class: 'caret' }, '›'), input,
    h('button', { class: 'icon-btn sm', title: tr('Отправить'), onclick: () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })) }, icon('send')))
  const el = h('div', { class: 'console-inner', style: { display: 'contents' } },
    log,
    h('div', { class: 'prompt' }, suggest, box)
  )
  return { el, append, setEntries, focus: () => input.focus(), input }
}
const findCommand = (q) => {
  const command = S.commands.find(c => c.name === q || c.aliases.includes(q))
  return command && localizeCommand(command)
}

// Arguments of a usage line like ".transfer <предмет> <ник покупателя> [chests [радиус] [reset]]".
// Usages with alternatives ("|") or free text are not counted.
function usageSpec (usage) {
  const rest = usage.replace(/^\.\S+\s*/, '')
  if (rest.includes('|') || /<(текст|значение|text|value)>/.test(rest)) return null
  const tokens = []; let depth = 0
  for (const m of rest.matchAll(/<[^>]*>|\[|\]|[^\s[\]<>]+/g)) {
    if (m[0] === '[') depth++
    else if (m[0] === ']') depth--
    else tokens.push({ text: m[0], required: depth === 0 && m[0].startsWith('<') })
  }
  return { tokens, max: tokens.length }
}
function usageView (c, spec, cur) {
  return h('code', null, `.${c.name}`, ...spec.tokens.map((t, i) => [' ',
    h('span', { class: 'arg' + (i === cur ? ' cur' : '') + (t.required ? '' : ' opt') }, t.required ? t.text : `[${t.text}]`)]).flat())
}


// ============================================================
// Rotation control (compass + pitch). Angles are F3-style:
// yaw 0 = south, 90 = west, ±180 = north, -90 = east; pitch -90 = up, 90 = down.
// ============================================================
const normYaw = (y) => ((((y + 180) % 360) + 360) % 360) - 180
const CARDINALS = () => [tr('Ю'), tr('ЮЗ'), tr('З'), tr('СЗ'), tr('С'), tr('СВ'), tr('В'), tr('ЮВ')]
const cardinal = (yaw) => CARDINALS()[Math.round((((yaw % 360) + 360) % 360) / 45) % 8]

function compassSvg () {
  let ticks = ''
  for (let a = 0; a < 360; a += 15) {
    const major = a % 90 === 0
    const r1 = major ? 44 : 48
    const rad = a * Math.PI / 180
    ticks += `<line class="tick${major ? ' major' : ''}" x1="${(Math.sin(rad) * r1).toFixed(2)}" y1="${(-Math.cos(rad) * r1).toFixed(2)}" x2="${(Math.sin(rad) * 53).toFixed(2)}" y2="${(-Math.cos(rad) * 53).toFixed(2)}"/>`
  }
  const t = document.createElement('template')
  t.innerHTML = `<svg class="compass" viewBox="-60 -60 120 120">
    <circle class="ring" r="57"/>${ticks}
    <text class="n" x="0" y="-35">${tr('С')}</text><text x="35" y="0">${tr('В')}</text><text x="0" y="35">${tr('Ю')}</text><text x="-35" y="0">${tr('З')}</text>
    <g class="needle"><line class="tail" x1="0" y1="0" x2="0" y2="14"/><line x1="0" y1="0" x2="0" y2="-40"/><circle r="3.5"/></g>
  </svg>`
  return t.content.firstChild
}

function createRotation ({ onLook, onTurn, live = true }) {
  let yaw = 0; let pitch = 0; let dragging = false; let lastSent = 0; let timer = null
  const svg = compassSvg()
  const needle = svg.querySelector('.needle')
  const yawIn = h('input', { class: 'input', placeholder: 'yaw', title: tr('Yaw (как в F3)') })
  const pitchIn = h('input', { class: 'input', placeholder: 'pitch', title: tr('Pitch (как в F3)') })
  const range = h('input', { type: 'range', min: -90, max: 90, step: 1, value: 0 })
  const now = h('div', { class: 'rot-now' + (live ? '' : ' hint') }, live ? '—' : tr('Тяни стрелку или задай углы (как в F3)'))

  const paint = () => {
    needle.setAttribute('transform', `rotate(${yaw + 180})`)
    if (document.activeElement !== yawIn) yawIn.value = f1(yaw)
    if (document.activeElement !== pitchIn) pitchIn.value = f1(pitch)
    range.value = Math.round(pitch)
  }
  const send = (final) => {
    clearTimeout(timer)
    const go = () => { lastSent = Date.now(); onLook(yaw, pitch) }
    if (final || Date.now() - lastSent > 90) go()
    else timer = setTimeout(go, 90)
  }
  const fromPointer = (e) => {
    const r = svg.getBoundingClientRect()
    const th = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI
    yaw = normYaw(Math.round(th - 180))
    paint()
  }
  svg.addEventListener('pointerdown', (e) => { dragging = true; svg.setPointerCapture(e.pointerId); fromPointer(e); send(false) })
  svg.addEventListener('pointermove', (e) => { if (dragging) { fromPointer(e); send(false) } })
  const end = () => { if (dragging) { dragging = false; send(true) } }
  svg.addEventListener('pointerup', end)
  svg.addEventListener('pointercancel', end)
  range.addEventListener('input', () => { pitch = Number(range.value); paint(); send(false) })
  range.addEventListener('change', () => send(true))
  const apply = () => {
    const y = Number(yawIn.value); const p = Number(pitchIn.value)
    if (yawIn.value.trim() !== '' && !Number.isNaN(y)) yaw = normYaw(y)
    if (pitchIn.value.trim() !== '' && !Number.isNaN(p)) pitch = Math.max(-90, Math.min(90, p))
    yawIn.blur(); pitchIn.blur()
    paint(); send(true)
  }
  for (const i of [yawIn, pitchIn]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply() })
  const set = (y, p) => () => { if (y != null) yaw = y; if (p != null) pitch = p; paint(); send(true) }
  const turn = (d) => () => { if (onTurn) onTurn(d, 0); else { yaw = normYaw(yaw + d); paint(); send(true) } }

  const el = h('div', { class: 'rot' },
    svg,
    h('div', { class: 'rot-side' },
      now,
      h('div', { class: 'rot-inputs' }, yawIn, pitchIn, h('button', { class: 'btn sm primary', onclick: apply }, tr('Повернуть'))),
      h('div', { class: 'pitch' }, h('span', null, tr('вверх')), range, h('span', null, tr('вниз'))),
      h('div', { class: 'presets' },
        h('button', { class: 'btn sm', onclick: set(180, null) }, tr('С')),
        h('button', { class: 'btn sm', onclick: set(-90, null) }, tr('В')),
        h('button', { class: 'btn sm', onclick: set(0, null) }, tr('Ю')),
        h('button', { class: 'btn sm', onclick: set(90, null) }, tr('З')),
        h('button', { class: 'btn sm', onclick: turn(-45), title: tr('Повернуться влево на 45°') }, '−45°'),
        h('button', { class: 'btn sm', onclick: turn(45), title: tr('Повернуться вправо на 45°') }, '+45°'),
        h('button', { class: 'btn sm', onclick: set(null, -90) }, tr('Вверх')),
        h('button', { class: 'btn sm', onclick: set(null, 0) }, tr('Прямо')),
        h('button', { class: 'btn sm', onclick: set(null, 90) }, tr('Вниз')))))
  paint()

  return {
    el,
    update (rot) {
      if (!live) return
      if (!rot) { now.textContent = '—'; return }
      now.replaceChildren('yaw ', h('b', null, f1(rot.yaw) + '°'), '  pitch ', h('b', null, f1(rot.pitch) + '°'), '  ' + cardinal(rot.yaw))
      // follow the real head unless the user is steering right now
      if (dragging || Date.now() - lastSent < 700) return
      yaw = rot.yaw; pitch = rot.pitch
      paint()
    }
  }
}

const HOLD_BTNS = () => [
  ['lmb', tr('ЛКМ'), tr('Ломать/бить то, куда смотрит (как зажатая ЛКМ)')],
  ['rmb', tr('ПКМ'), tr('Использовать предмет / ставить блок (как зажатая ПКМ)')],
  ['forward', 'W', tr('Идти вперёд')],
  ['sneak', 'Shift', tr('Красться')],
  ['jump', tr('Пробел'), tr('Прыгать')],
  ['sprint', tr('Спринт'), tr('Бежать')]
]

// ============================================================
// Bot view
// ============================================================
function renderBot (id) {
  const b = S.bots.get(id)
  if (!b) return select('global')

  // topbar
  const tb = $('#topbar')
  const tHead = headImg(b, 'sm')
  const tTitle = h('span', { class: 'title' }, botName(b))
  const tPill = h('span', { class: 'pill' }, h('span', { class: 'dot ' + b.state }), h('span', null, STATE_LABEL()[b.state]))
  const tCrumb = h('span', { class: 'crumb' }, serverStr(b.server))
  const tPower = h('button', { class: 'btn sm', onclick: () => togglePower(S.bots.get(id)) })
  tb.replaceChildren(tHead, tTitle, tPill, tCrumb, h('div', { class: 'spacer' }), tPower,
    h('button', { class: 'icon-btn sm', title: tr('Ещё'), onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); botMenu(S.bots.get(id), r.left - 150, r.bottom + 6, { showPower: false }) } }, icon('more')))

  // console
  const con = createConsole({
    placeholder: tr('Сообщение в чат или .команда  ·  Tab — дополнить, стрелки — история'),
    historyKey: 'bot',
    botId: id,
    onSubmit: (line) => act('bot.command', { id, line }).catch(() => {})
  })
  const consoleCard = h('div', { class: 'card console' },
    h('div', { class: 'card-head' }, h('h3', null, tr('Консоль')), h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost sm', onclick: () => { act('bot.clearLogs', { id }); S.logs.set(id, []); con.setEntries([]) } }, icon('clear'), tr('Очистить'))),
    con.el)

  // side column
  const statusCard = h('div', { class: 'card' })
  const invCard = h('div', { class: 'card' })
  const gx = h('input', { class: 'input', placeholder: 'X' })
  const gy = h('input', { class: 'input', placeholder: 'Y' })
  const gz = h('input', { class: 'input', placeholder: 'Z' })
  const go = () => {
    const xs = [gx.value.trim(), gy.value.trim(), gz.value.trim()]
    const parts = xs[1] ? xs : [xs[0], xs[2]]
    if (parts.some(p => p === '')) { toast(tr('Укажи X и Z (Y можно пропустить)'), true); return }
    act('bot.command', { id, line: `.goto ${parts.join(' ')}` })
  }
  coordFields([gx, gy, gz], go)
  const cmd = (line) => () => act('bot.command', { id, line })
  const actionsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, tr('Действия')), h('div', { class: 'spacer' }), h('span', { class: 'task-chip', id: 'task-chip' })),
    h('div', { class: 'goto' }, gx, gy, gz, h('button', { class: 'btn primary', onclick: go }, tr('Идти'))),
    h('div', { class: 'quick' },
      h('button', { class: 'btn sm', onclick: cmd('.stop') }, icon('stop'), tr('Стоп')),
      h('button', { class: 'btn sm', onclick: cmd('.jump') }, tr('Прыжок')),
      h('button', { class: 'btn sm', onclick: cmd('.sneak') }, tr('Присесть')),
      h('button', { class: 'btn sm', onclick: cmd('.break') }, tr('Сломать блок')),
      h('button', { class: 'btn sm', onclick: cmd('.eat') }, tr('Съесть')),
      h('button', { class: 'btn sm', onclick: cmd('.use') }, tr('ПКМ')),
      h('button', { class: 'btn sm', onclick: cmd('.drop') }, tr('Выбросить')),
      h('button', { class: 'btn sm', onclick: () => { const p = S.bots.get(id)?.live?.pos; if (p) { gx.value = Math.floor(p.x); gy.value = Math.floor(p.y); gz.value = Math.floor(p.z) } } }, tr('Мои коорд.'))
    ),
    h('div', { class: 'holds' },
      h('span', { class: 'lbl' }, tr('Зажать:')),
      HOLD_BTNS().map(([k, t, tip]) => h('button', {
        class: 'btn sm toggle',
        title: tip,
        dataset: { key: k },
        onclick: () => act('bot.hold', { id, key: k, on: !(S.bots.get(id)?.holds || []).includes(k) })
      }, t)),
      h('button', { class: 'btn sm ghost', onclick: cmd('.release') }, tr('Отпустить всё'))))

  const rot = createRotation({ onLook: (yaw, pitch) => api.call('bot.look', { id, yaw, pitch }).catch(() => {}) })
  const rotCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, tr('Поворот головы'))), rot.el)

  const dialogCard = h('div', { class: 'card screen hidden' })
  const windowCard = h('div', { class: 'card screen hidden' })
  const page = h('div', { class: 'page' }, consoleCard, h('div', { class: 'side-col' }, dialogCard, windowCard, statusCard, invCard, actionsCard, rotCard))
  $('#view').replaceChildren(page)

  V = { id, console: con, tHead, tTitle, tPill, tCrumb, tPower, statusCard, invCard, actionsCard, rot, rotCard, dialogCard, windowCard, dialogKey: null, lastStatusKey: '' }
  updateBotView()
  renderInventory()

  // logs
  if (S.logs.has(id)) con.setEntries(S.logs.get(id))
  else {
    con.setEntries([])
    api.call('bot.logs', { id }).then((logs) => {
      S.logs.set(id, logs)
      if (S.selected === id) con.setEntries(logs)
    }).catch(() => {})
  }
  if (!S.inv.has(id) && b.state === 'online') {
    api.call('bot.inventory', { id }).then((inv) => { S.inv.set(id, inv); if (S.selected === id) renderInventory() }).catch(() => {})
  }
  setTimeout(() => con.focus(), 0)
}

function updateBotView () {
  if (!V || V.id !== S.selected) return
  const b = S.bots.get(V.id)
  if (!b) return
  // topbar
  refreshHead(V.tHead, b)
  V.tTitle.textContent = botTitle(b)
  V.tPill.replaceChildren(h('span', { class: 'dot ' + b.state }), h('span', null, b.state === 'reconnecting' ? subText(b) : STATE_LABEL()[b.state]))
  V.tCrumb.textContent = `${serverStr(b.server)}${b.server.custom ? '' : tr(' · глобальный')}${b.live ? ' · ' + b.live.version : ''}`
  V.tPower.replaceChildren(icon(isActive(b) ? 'power' : 'plug'), isActive(b) ? tr('Отключить') : tr('Подключить'))
  V.tPower.className = 'btn sm' + (isActive(b) ? '' : ' primary')
  V.tPower.disabled = !!b.accountIssue

  const chip = $('#task-chip')
  if (chip) chip.replaceChildren(...(b.task ? [h('span', { class: 'spin' }), `.${b.task}`] : []))
  for (const btn of V.actionsCard.querySelectorAll('button')) btn.disabled = b.state !== 'online'
  const holds = b.holds || []
  for (const btn of V.actionsCard.querySelectorAll('.toggle')) btn.classList.toggle('on', holds.includes(btn.dataset.key))
  V.rotCard.classList.toggle('disabled', b.state !== 'online')
  V.rot.update(b.live?.rot)
  renderDialog(b)

  renderStatus(b)
}

function renderStatus (b) {
  const card = V.statusCard
  const who = h('div', { class: 'who-card' }, headImg(b, 'lg'),
    h('div', { class: 'meta' },
      h('div', { class: 'n' }, botName(b)),
      h('div', { class: 's' }, TYPE_LABEL()[b.type] || b.type)))
  const parts = [who]
  if (b.accountIssue) parts.push(h('div', { class: 'offline-state' },
    h('div', { class: 'err' }, tr('! Утерян / украден — вход остановлен для этого аккаунта')),
    h('div', { class: 'muted' }, b.accountIssue.reason),
    h('button', { class: 'btn sm', onclick: () => act('bot.update', { id: b.id, patch: { accountIssue: null } }) }, tr('Снять отметку'))))

  if (b.authCode) {
    parts.push(h('div', { class: 'auth-banner' },
      h('div', { class: 'muted' }, tr('Нужен вход в Microsoft. Открой страницу и введи код:')),
      h('div', { class: 'code' }, b.authCode.code),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => copy(b.authCode.code) }, icon('copy'), tr('Код')),
        h('a', { class: 'btn sm primary', href: b.authCode.url, target: '_blank', rel: 'noreferrer' }, icon('ext'), tr('Открыть')))))
  }

  if (b.state === 'online' && b.live) {
    const L = b.live
    parts.push(
      h('div', { class: 'meters' },
        meter(tr('Здоровье'), L.health, 20),
        meter(tr('Голод'), L.food, 20)),
      h('div', { class: 'xp', title: tr('Уровень {0}', L.level) }, h('i', { style: { width: (L.xpProgress * 100).toFixed(1) + '%' } })),
      h('dl', { class: 'kv' },
        h('dt', null, tr('Позиция')), h('dd', { class: 'copy', title: tr('Скопировать'), onclick: () => copy(`${Math.floor(L.pos.x)} ${Math.floor(L.pos.y)} ${Math.floor(L.pos.z)}`) }, `${f1(L.pos.x)}  ${f1(L.pos.y)}  ${f1(L.pos.z)}`),
        h('dt', null, tr('Измерение')), h('dd', null, String(L.dimension || '—').replace('minecraft:', '')),
        h('dt', null, tr('Режим')), h('dd', null, L.gameMode || '—'),
        h('dt', null, tr('Уровень')), h('dd', null, String(L.level)),
        h('dt', null, tr('Пинг')), h('dd', null, L.ping != null ? `${L.ping} ms` : '—'),
        h('dt', null, tr('Игроков')), h('dd', null, String(L.players)),
        L.actionBar ? [h('dt', null, tr('Экшн-бар')), h('dd', { title: L.actionBar }, L.actionBar)] : null,
        L.setbacks ? [h('dt', { title: tr('Коррекции позиции до 6 блоков за 10 секунд. Причина неизвестна: возможны античит, команда или плагин сервера.') }, tr('Коррекции')), h('dd', null, tr('{0} за 10 с', L.setbacks))] : null,
        h('dt', null, tr('Версия')), h('dd', null, L.version)))
  } else {
    const st = h('div', { class: 'offline-state' })
    if (b.error && b.state !== 'connecting') st.append(h('div', { class: 'err' }, b.error))
    if (b.state === 'connecting') st.append(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), b.authCode ? tr('Ждёт вход в Microsoft…') : tr('Подключение…')))
    else if (b.state === 'reconnecting') st.append(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), subText(b)))
    st.append(h('dl', { class: 'kv', style: { padding: '0' } },
      h('dt', null, tr('Сервер')), h('dd', null, serverStr(b.server)),
      h('dt', null, tr('Версия')), h('dd', null, b.server.version === 'auto' ? tr('авто') : b.server.version),
      b.tokenExpiresAt ? [h('dt', null, tr('Токен до')), h('dd', null, new Date(b.tokenExpiresAt).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'ru-RU'))] : null))
    if (b.state === 'queued') st.append(h('div', { class: 'muted' }, tr('В очереди: ожидает завершения входа предыдущего аккаунта')))
    if (!isActive(b) && !b.accountIssue) st.append(h('button', { class: 'btn primary', onclick: () => act('bot.connect', { id: b.id }) }, icon('plug'), tr('Подключить')))
    parts.push(st)
  }
  card.replaceChildren(...parts)
}

function meter (label, val, max) {
  const pct = Math.max(0, Math.min(100, (val / max) * 100))
  return h('div', { class: 'meter' },
    h('div', { class: 'lbl' }, h('span', null, label), h('b', null, `${f1(val).replace('.0', '')}/${max}`)),
    h('div', { class: 'bar' }, h('i', { style: { width: pct + '%' } })))
}

// ---------- server dialogs ----------
const liveDialog = (b) => b && (b.state === 'online' || b.state === 'connecting') ? b.dialog : null
// Teleport confirmations float above every page (see renderTpDock).
const isTpDialog = (d) => !!d && /teleport/i.test(d.title || '')

function renderDialog (b) {
  const card = V.dialogCard
  let d = liveDialog(b)
  if (isTpDialog(d)) d = null
  const key = d ? `${d.seq}|${d.waiting}` : null
  if (key === V.dialogKey) return // rebuild only for a new dialog — keeps what the user typed
  V.dialogKey = key
  if (!d) { card.classList.add('hidden'); card.replaceChildren(); return }
  card.replaceChildren(
    h('div', { class: 'card-head' }, h('h3', null, tr('Диалог сервера')), h('div', { class: 'spacer' }),
      d.canEscape ? h('button', { class: 'btn ghost sm', title: tr('Как Esc в игре'), onclick: () => act('bot.dialogClose', { id: b.id }) }, tr('Закрыть')) : null),
    dialogBody(b.id, d)
  )
  card.classList.remove('hidden')
}

// ---------- teleport confirmation dock (all bots, first come first shown) ----------
const tpQueue = new Map() // bot id -> { seq, at }
// Dynamic-Island style: the dock grows out of a small pill, collapses back into
// it between requests and to hide. Animations run one at a time; updates that
// arrive meanwhile are applied once the current one finishes.
const tp = { key: null, busy: false, again: false }
const PILL = { w: 120, h: 34 }
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// Centre the dock over the console of the current page (whole main area if none).
function placeTp () {
  const dock = $('#tp-dock')
  if (!dock) return
  const main = $('.main').getBoundingClientRect()
  const c = $('#view .card.console')?.getBoundingClientRect()
  const area = c && c.width ? c : main
  const w = Math.min(420, area.width - 24)
  dock.style.left = `${area.left - main.left + area.width / 2}px`
  dock.style.setProperty('--tp-w', `${Math.max(w, 260)}px`)
}
window.addEventListener('resize', placeTp)

async function renderTpDock () {
  if (tp.busy) { tp.again = true; return }
  syncTpQueue()
  let dock = $('#tp-dock')
  if (!dock) { dock = h('div', { id: 'tp-dock', class: 'tp-dock hidden' }, h('div', { class: 'tp-inner' })); $('.main').append(dock) }
  placeTp()
  const first = [...tpQueue.entries()].sort((a, b) => a[1].at - b[1].at)[0]
  const target = first ? `${first[0]}|${first[1].seq}` : null
  if (target === tp.key) { if (first) fillTp(dock, first[0], false); return }
  tp.busy = true
  try {
    if (tp.key) await islandCollapse(dock, !target)
    tp.key = target
    if (target) { fillTp(dock, first[0], true); await islandExpand(dock) }
  } finally { tp.busy = false }
  if (tp.again) { tp.again = false; renderTpDock() }
}

function syncTpQueue () {
  for (const [id, q] of tpQueue) {
    const d = liveDialog(S.bots.get(id))
    if (!isTpDialog(d)) tpQueue.delete(id)
    else if (d.seq !== q.seq) { q.seq = d.seq; q.at = Date.now() }
  }
  for (const b of S.bots.values()) {
    const d = liveDialog(b)
    if (isTpDialog(d) && !tpQueue.has(b.id)) tpQueue.set(b.id, { seq: d.seq, at: Date.now() })
  }
}

// Build the request (full) or only patch the queue counter / waiting state in place.
function fillTp (dock, id, full) {
  const inner = dock.firstChild
  const b = S.bots.get(id); const d = b.dialog
  const more = tpQueue.size - 1
  if (!full) {
    const count = inner.querySelector('.tp-count')
    count.textContent = more > 0 ? tr('ещё {0}', more) : ''
    count.classList.toggle('hidden', more <= 0)
    if (inner.dataset.waiting === String(!!d.waiting)) return
    inner.dataset.waiting = String(!!d.waiting)
    inner.querySelector('.dlg').replaceWith(dialogBody(id, d))
    return
  }
  inner.dataset.waiting = String(!!d.waiting)
  inner.replaceChildren(
    h('div', { class: 'card-head' },
      headImg(b, 'sm'),
      h('h3', null, botName(b)),
      h('span', { class: 'tp-count' + (more > 0 ? '' : ' hidden') }, more > 0 ? tr('ещё {0}', more) : ''),
      h('div', { class: 'spacer' }),
      d.canEscape ? h('button', { class: 'btn ghost sm', title: tr('Как Esc в игре'), onclick: () => act('bot.dialogClose', { id }) }, tr('Закрыть')) : null),
    dialogBody(id, d)
  )
}

async function islandExpand (dock) {
  dock.classList.remove('hidden')
  if (reducedMotion()) return
  const { width, height } = dock.getBoundingClientRect()
  const grow = dock.animate([
    { width: `${PILL.w}px`, height: `${PILL.h}px`, borderRadius: `${PILL.h / 2}px`, opacity: 0 },
    { opacity: 1, offset: 0.12 },
    { width: `${width}px`, height: `${height}px`, borderRadius: '20px', opacity: 1 }
  ], { duration: 560, easing: 'cubic-bezier(.3, 1.35, .45, 1)' })
  const show = dock.firstChild.animate([
    { opacity: 0, transform: 'scale(.94)', filter: 'blur(6px)' },
    { opacity: 1, transform: 'none', filter: 'none' }
  ], { duration: 300, delay: 200, easing: 'ease-out', fill: 'backwards' })
  await Promise.all([grow.finished, show.finished]).catch(() => {})
}

async function islandCollapse (dock, hide) {
  if (reducedMotion()) { if (hide) dock.classList.add('hidden'); return }
  const { width, height } = dock.getBoundingClientRect()
  await dock.firstChild.animate([
    { opacity: 1, filter: 'none' }, { opacity: 0, filter: 'blur(4px)' }
  ], { duration: 120, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {})
  await dock.animate([
    { width: `${width}px`, height: `${height}px`, borderRadius: '20px', opacity: 1 },
    { width: `${PILL.w}px`, height: `${PILL.h}px`, borderRadius: `${PILL.h / 2}px`, opacity: hide ? 0 : 1 }
  ], { duration: hide ? 300 : 240, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }).finished.catch(() => {})
  if (hide) { dock.classList.add('hidden'); dock.firstChild.replaceChildren() }
  for (const a of dock.getAnimations({ subtree: true })) a.cancel()
}

function dialogBody (id, d) {

  const getters = []
  const inputs = d.inputs.map((i) => {
    if (i.type === 'text') {
      const el = h(i.multiline ? 'textarea' : 'input', { class: 'input', maxlength: i.maxLength, rows: i.multiline ? 3 : null, style: i.multiline ? { minHeight: '64px', fontFamily: 'var(--font)' } : null })
      el.value = i.value
      getters.push(() => [i.key, el.value])
      return h('label', { class: 'field' }, h('span', null, i.label), el)
    }
    if (i.type === 'boolean') {
      const cb = h('input', { type: 'checkbox', checked: i.value })
      getters.push(() => [i.key, cb.checked])
      return h('label', { class: 'toggle-row' }, h('div', { class: 't' }, i.label), h('span', { class: 'switch' }, cb, h('i')))
    }
    if (i.type === 'option') {
      const sel = h('select', { class: 'input' }, i.options.map(o => h('option', { value: o.id, selected: o.id === i.value }, o.display)))
      getters.push(() => [i.key, sel.value])
      return h('label', { class: 'field' }, h('span', null, i.label), sel)
    }
    if (i.type === 'number') {
      const lo = Math.min(i.start, i.end); const hi = Math.max(i.start, i.end)
      const r = h('input', { type: 'range', min: lo, max: hi, step: i.step || 'any', value: i.value })
      const out = h('b', null, f1(i.value).replace('.0', ''))
      r.addEventListener('input', () => { out.textContent = f1(Number(r.value)).replace('.0', '') })
      getters.push(() => [i.key, Number(r.value)])
      return h('div', { class: 'field' }, h('span', null, i.label), h('div', { class: 'dlg-range' }, r, out))
    }
    return h('div', { class: 'muted' }, tr('{0}: (неподдерживаемое поле)', i.label))
  })
  const values = () => Object.fromEntries(getters.map(g => g()))

  return h('div', { class: 'dlg' },
    h('div', { class: 'dlg-title' }, d.title),
    d.body.filter(t => t.trim()).length ? h('div', { class: 'dlg-body' }, d.body.filter(t => t.trim()).join('\n\n')) : null,
    inputs.length ? h('div', { class: 'dlg-inputs' }, inputs) : null,
    d.waiting
      ? h('div', { class: 'dlg-wait' }, h('span', { class: 'spin' }), tr('Ждём ответа сервера…'))
      : h('div', { class: 'dlg-buttons' }, d.buttons.map((btn, n) => h('button', {
        class: 'btn' + (n === 0 ? ' primary' : ''),
        title: btn.tooltip || null,
        onclick: () => act('bot.dialogClick', { id, index: n, values: values() })
      }, btn.label))))
}

// ---------- menu GUIs (chests, /tpaccept-style screens) ----------
const FILLER_RE = /^((black|gray|light_gray|white)_stained_)?glass_pane$/

function renderWindow (id, inv) {
  const card = V.windowCard
  const w = inv?.window
  if (!w) { card.classList.add('hidden'); card.replaceChildren(); return }
  const rows = []
  for (let r = 0; r < Math.ceil(w.size / 9); r++) {
    rows.push(h('div', { class: 'inv-grid' }, Array.from({ length: Math.min(9, w.size - r * 9) }, (_, k) => guiSlotEl(id, w.slots[r * 9 + k], r * 9 + k, inv.version))))
  }
  card.replaceChildren(
    h('div', { class: 'card-head' }, h('h3', null, tr('Открыто меню')), h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost sm', onclick: () => act('bot.windowClose', { id }) }, tr('Закрыть'))),
    h('div', { class: 'gui' },
      h('div', { class: 'dlg-title', style: { marginBottom: '10px' } }, w.title),
      rows,
      h('div', { class: 'inv-hint' }, tr('Клик — ЛКМ · правый клик — ПКМ · '), h('kbd', null, 'Shift'), tr('+клик · в консоли: .gui click <№|текст>'))))
  card.classList.remove('hidden')
}

function guiSlotEl (id, it, slot, version) {
  const filler = it && FILLER_RE.test(it.name) && !(it.customName || '').trim()
  const el = h('div', { class: 'slot gui-slot' + (it ? ' filled' : ' empty') + (filler ? ' filler' : '') })
  el.append(h('span', { class: 'num' }, slot))
  if (it) {
    const img = h('img', { src: `/icon/${version}/${it.name}.png`, alt: '', draggable: 'false' })
    img.onerror = () => img.replaceWith(h('span', { class: 'abbr' }, abbr(it.name)))
    el.append(img)
    if (it.count > 1) el.append(h('span', { class: 'cnt' }, it.count))
    if (it.enchants?.length) el.append(h('span', { class: 'ench' }))
    el.addEventListener('mouseenter', () => showTip(el, [
      h('b', null, it.displayName),
      ...(it.lore || []).map(l => h('div', { class: 'lore' }, l)),
      h('div', { class: 'id' }, `#${slot} · minecraft:${it.name}${it.count > 1 ? ' × ' + it.count : ''}`)
    ]))
    el.addEventListener('mouseleave', hideTip)
  }
  el.addEventListener('click', (e) => { hideTip(); act('bot.windowClick', { id, slot, how: e.shiftKey ? 'shift' : 'left' }) })
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); hideTip(); act('bot.windowClick', { id, slot, how: 'right' }) })
  return el
}

// ---------- inventory ----------
const ARMOR = () => [[5, 'head', tr('Шлем')], [6, 'torso', tr('Нагрудник')], [7, 'legs', tr('Поножи')], [8, 'feet', tr('Ботинки')]]

function armorDest (name) {
  if (/helmet|_head$|_skull$|carved_pumpkin|turtle_helmet/.test(name)) return 'head'
  if (/chestplate|elytra/.test(name)) return 'torso'
  if (/leggings/.test(name)) return 'legs'
  if (/boots/.test(name)) return 'feet'
  return null
}

function renderInventory () {
  if (!V || V.id !== S.selected) return
  if (drag) { V.invDirty = true; return } // don't rebuild the grid under a drag in progress
  V.invDirty = false
  const id = V.id
  const b = S.bots.get(id)
  const inv = b?.state === 'online' ? S.inv.get(id) : null
  const slots = inv?.slots || []
  const held = inv ? 36 + inv.heldSlot : -1

  const mk = (i, opts = {}) => slotEl(id, slots[i], i, inv?.version, { held: i === held, ...opts })
  const dropZone = h('div', {
    class: 'drop-zone',
    ondragover: (e) => { e.preventDefault(); dropZone.classList.add('over') },
    ondragleave: () => dropZone.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault()
      dropZone.classList.remove('over')
      if (drag && drag.id === id) act('bot.drop', { id, slot: drag.slot, all: true })
    }
  }, icon('drop'), tr('Отпусти здесь — выбросить стак'))
  const hotbar = h('div', {
    class: 'inv-grid inv-hotbar',
    onwheel: (e) => {
      if (!inv) return
      e.preventDefault()
      const cur = S.inv.get(id)?.heldSlot ?? 0
      act('bot.hotbar', { id, index: (cur + (e.deltaY > 0 ? 1 : -1) + 9) % 9 })
    }
  }, Array.from({ length: 9 }, (_, k) => mk(36 + k, { num: k + 1 })))
  const wrap = h('div', { class: 'inv' + (inv ? '' : ' off') },
    h('div', { class: 'inv-top' },
      h('div', null, h('div', { class: 'inv-label' }, tr('Броня')), h('div', { class: 'inv-armor' }, ARMOR().map(([i, , t]) => mk(i, { title: t })))),
      h('div', { class: 'spacer' }),
      h('div', null, h('div', { class: 'inv-label' }, tr('Левая рука')), h('div', { class: 'inv-off' }, mk(45, { title: tr('Левая рука') })))),
    h('div', { class: 'inv-grid' }, Array.from({ length: 27 }, (_, k) => mk(9 + k))),
    hotbar,
    inv ? dropZone : null,
    inv
      ? h('div', { class: 'inv-hint' }, tr('Тащи предмет мышкой, чтобы переложить · '), h('kbd', null, 'Shift'), tr('+клик — быстро перекинуть · наведи и жми '),
        h('kbd', null, '1'), '–', h('kbd', null, '9'), tr(' — в слот хотбара, '), h('kbd', null, 'Q'), tr(' — выбросить · колёсико над хотбаром — сменить слот'))
      : h('div', { class: 'inv-note' }, tr('Инвентарь виден, когда бот в сети.'))
  )
  V.invWrap = wrap
  renderWindow(id, inv)
  const count = slots.filter((s, i) => s && i >= 9 && i <= 44).length
  V.invCard.replaceChildren(
    h('div', { class: 'card-head' }, h('h3', null, tr('Инвентарь')), h('div', { class: 'spacer' }), inv ? h('span', { class: 'muted', style: { fontSize: '11.5px' } }, tr('{0}/36 · ПКМ — действия', count)) : null),
    wrap)
}

const abbr = (name) => name.split('_').filter(Boolean).slice(0, 2).map(w => w[0]).join('')

let drag = null // { id, slot } while dragging an inventory stack
const mouse = { x: -1, y: -1 }
document.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY }, { passive: true })

function slotEl (id, it, index, version, { held, num, title } = {}) {
  const el = h('div', { class: 'slot' + (it ? ' filled' : '') + (held ? ' held' : ''), dataset: { slot: index, bot: id, filled: it ? '1' : '' } })
  const online = S.bots.get(id)?.state === 'online'
  if (online) {
    el.addEventListener('dragover', (e) => { if (drag) { e.preventDefault(); el.classList.add('drag-over') } })
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'))
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      el.classList.remove('drag-over')
      if (drag && drag.id === id && drag.slot !== index) act('bot.moveSlot', { id, from: drag.slot, to: index })
    })
  }
  if (it && online) {
    el.draggable = true
    el.addEventListener('dragstart', (e) => {
      hideTip()
      drag = { id, slot: index }
      e.dataTransfer.effectAllowed = 'move'
      try { e.dataTransfer.setData('text/plain', String(index)) } catch {}
      el.classList.add('dragging')
      V?.invWrap?.classList.add('drag')
    })
    el.addEventListener('dragend', () => {
      drag = null
      el.classList.remove('dragging')
      V?.invWrap?.classList.remove('drag')
      if (V?.invDirty) setTimeout(renderInventory, 0)
    })
  }
  if (num) el.append(h('span', { class: 'num' }, num))
  if (it) {
    const img = h('img', { src: `/icon/${version}/${it.name}.png`, alt: '', draggable: 'false' })
    img.onerror = () => img.replaceWith(h('span', { class: 'abbr' }, abbr(it.name)))
    el.append(img)
    if (it.count > 1) el.append(h('span', { class: 'cnt' }, it.count))
    if (it.maxDur && it.used > 0) {
      const left = Math.max(0, 1 - it.used / it.maxDur)
      el.append(h('span', { class: 'dur' }, h('i', { style: { width: (left * 100).toFixed(0) + '%' } })))
    }
    if (it.enchants?.length) el.append(h('span', { class: 'ench' }))
    el.addEventListener('mouseenter', () => showTip(el, [
      h('b', null, it.displayName),
      ...(it.lore || []).map(l => h('div', { class: 'lore' }, l)),
      h('div', { class: 'id' }, `minecraft:${it.name}${it.count > 1 ? ' × ' + it.count : ''}`),
      it.maxDur ? h('div', null, tr('Прочность: {0}/{1}', it.maxDur - it.used, it.maxDur)) : null,
      ...(it.enchants || []).map(e => h('div', { class: 'en' }, e.replace(/_/g, ' ')))
    ]))
    el.addEventListener('mouseleave', hideTip)
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); hideTip(); slotMenu(id, it, index, e.clientX, e.clientY) })
  } else if (title) {
    el.title = title
  }
  el.addEventListener('click', (e) => {
    if (e.shiftKey && it) { act('bot.quickMove', { id, slot: index }); return }
    if (index >= 36 && index <= 44) act('bot.hotbar', { id, index: index - 36 })
    else if (it) { hideTip(); slotMenu(id, it, index, e.clientX, e.clientY) }
  })
  return el
}

// in-game style hotkeys over a hovered inventory slot: 1–9 → hotbar, Q → drop one, Ctrl+Q → drop stack
document.addEventListener('keydown', (e) => {
  if (modals.length || e.altKey) return
  const ae = document.activeElement
  // allowed while focus is nowhere or in an EMPTY console prompt (it's focused by default)
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || (ae.tagName === 'INPUT' && (ae.value || !ae.closest('.prompt'))))) return
  const el = document.elementFromPoint(mouse.x, mouse.y)?.closest('.slot[data-bot]')
  if (!el || S.bots.get(el.dataset.bot)?.state !== 'online') return
  const id = el.dataset.bot; const slot = Number(el.dataset.slot); const filled = !!el.dataset.filled
  if (/^Digit[1-9]$/.test(e.code) && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    const n = Number(e.code.slice(5)) - 1
    if (filled) act('bot.hotbarSwap', { id, slot, index: n })
    else act('bot.hotbar', { id, index: n })
  } else if (e.code === 'KeyQ' && filled) {
    e.preventDefault()
    act('bot.drop', { id, slot, all: e.ctrlKey || e.metaKey })
  }
})

function slotMenu (id, it, index, x, y) {
  const dest = armorDest(it.name)
  const hbRow = h('div', null,
    h('div', { class: 'lbl' }, tr('Положить в слот хотбара и взять')),
    h('div', { class: 'hb-row' }, Array.from({ length: 9 }, (_, k) => h('button', {
      onclick: async () => {
        closeMenu()
        if (index !== 36 + k) await act('bot.hotbarSwap', { id, slot: index, index: k })
        act('bot.hotbar', { id, index: k })
      }
    }, k + 1))))
  const items = [
    { label: it.displayName },
    { el: hbRow },
    '-',
    { text: index >= 36 && index <= 44 ? tr('Выбрать слот') : tr('Взять в руку'), icon: 'hand', run: () => act('bot.equip', { id, slot: index, dest: 'hand' }) },
    { text: tr('В левую руку'), icon: 'hand', run: () => act('bot.equip', { id, slot: index, dest: 'off-hand' }) }
  ]
  if (dest && !(index >= 5 && index <= 8)) items.push({ text: tr('Надеть'), icon: 'shirt', run: () => act('bot.equip', { id, slot: index, dest }) })
  items.push('-')
  items.push({ text: tr('Выбросить стак'), icon: 'drop', run: () => act('bot.drop', { id, slot: index, all: true }) })
  if (it.count > 1) items.push({ text: tr('Выбросить 1'), icon: 'drop', run: () => act('bot.drop', { id, slot: index, all: false }) })
  openMenu(x, y, items)
}

// ============================================================
// Global console
// ============================================================
function renderGlobal () {
  const tb = $('#topbar')
  tb.replaceChildren(
    h('span', { class: 'title' }, tr('Общая консоль')),
    h('span', { class: 'pill', id: 'g-pill' }),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', onclick: () => act('bots.connectAll', { ids: S.targets.size ? [...S.targets] : undefined }, tr('Подключаю…')) }, icon('plug'), S.targets.size ? tr('Подключить выбранных') : tr('Подключить всех')),
    h('button', { class: 'btn sm', onclick: disconnectTargets }, icon('power'), tr('Отключить')))

  const con = createConsole({
    placeholder: tr('Команда всем выбранным: .goto 100 64 -20, .break, .slot 2, привет…'),
    historyKey: 'global',
    global: true,
    onSubmit: (line) => act('global.command', { line, targets: S.targets.size ? [...S.targets] : null }).catch(() => {})
  })
  const consoleCard = h('div', { class: 'card console' },
    h('div', { class: 'card-head' }, h('h3', null, tr('Все боты')), h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost sm', onclick: () => { act('global.clear'); S.glogs = []; con.setEntries([]) } }, icon('clear'), tr('Очистить'))),
    con.el)

  const targetsCard = h('div', { class: 'card', id: 'targets-card' })

  const gx = h('input', { class: 'input', placeholder: 'X' })
  const gy = h('input', { class: 'input', placeholder: 'Y' })
  const gz = h('input', { class: 'input', placeholder: 'Z' })
  const send = (line) => act('global.command', { line, targets: S.targets.size ? [...S.targets] : null })
  const go = () => {
    const xs = [gx.value.trim(), gy.value.trim(), gz.value.trim()]
    const parts = xs[1] ? xs : [xs[0], xs[2]]
    if (parts.some(p => p === '')) { toast(tr('Укажи X и Z'), true); return }
    send(`.goto ${parts.join(' ')}`)
  }
  coordFields([gx, gy, gz], go)
  const actionsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, tr('Всем сразу'))),
    h('div', { class: 'goto' }, gx, gy, gz, h('button', { class: 'btn primary', onclick: go }, tr('Идти'))),
    h('div', { class: 'quick' },
      h('button', { class: 'btn sm', onclick: () => send('.stop') }, icon('stop'), tr('Стоп')),
      h('button', { class: 'btn sm', onclick: () => send('.jump') }, tr('Прыжок')),
      h('button', { class: 'btn sm', onclick: () => send('.sneak') }, tr('Присесть')),
      h('button', { class: 'btn sm', onclick: () => send('.break') }, tr('Сломать')),
      h('button', { class: 'btn sm', onclick: () => send('.eat') }, tr('Съесть')),
      h('button', { class: 'btn sm', onclick: () => send('.status') }, tr('Статус'))),
    h('div', { class: 'holds' },
      h('span', { class: 'lbl' }, tr('Слот:')),
      h('div', { class: 'slot-nums' }, Array.from({ length: 9 }, (_, k) => h('button', { class: 'btn sm', onclick: () => send(`.slot ${k + 1}`) }, k + 1)))),
    h('div', { class: 'holds' },
      h('span', { class: 'lbl' }, tr('Зажать:')),
      HOLD_BTNS().map(([k, t, tip]) => h('button', { class: 'btn sm', title: tip, onclick: () => send(`.hold ${k}`) }, t)),
      h('button', { class: 'btn sm ghost', onclick: () => send('.release') }, tr('Отпустить всё'))))

  const targets = () => S.targets.size ? [...S.targets] : null
  const rot = createRotation({
    live: false,
    onLook: (yaw, pitch) => api.call('global.look', { targets: targets(), yaw, pitch }).catch(() => {}),
    onTurn: (dy) => send(`.turn ${dy}`)
  })
  const rotCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, tr('Поворот всем'))), rot.el)

  $('#view').replaceChildren(h('div', { class: 'page global' }, consoleCard, h('div', { class: 'side-col' }, targetsCard, actionsCard, rotCard)))
  V = { id: 'global', console: con }
  con.setEntries(S.glogs)
  renderTargets()
  setTimeout(() => con.focus(), 0)
}

function disconnectTargets () {
  const ids = S.targets.size ? [...S.targets] : [...S.bots.keys()]
  Promise.all(ids.map(id => api.call('bot.disconnect', { id }).catch(() => {}))).then(() => toast(tr('Отключены')))
}

function renderTargets () {
  const card = $('#targets-card')
  if (!card) return
  for (const t of [...S.targets]) if (!S.bots.has(t)) S.targets.delete(t)
  const on = onlineCount()
  const pill = $('#g-pill')
  if (pill) pill.replaceChildren(h('span', { class: 'dot ' + (on ? 'online' : 'offline') }), tr('{0} из {1} в сети', on, S.bots.size))

  const sorted = [...S.order].map(id => S.bots.get(id)).filter(Boolean)
    .sort((a, b) => (b.state === 'online') - (a.state === 'online'))
  const selOnline = [...S.targets].filter(id => S.bots.get(id)?.state === 'online').length
  card.replaceChildren(
    h('div', { class: 'card-head' }, h('h3', null, tr('Кому')), h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost sm', onclick: () => { for (const b of S.bots.values()) S.targets.add(b.id); saveTargets() } }, tr('Все')),
      h('button', { class: 'btn ghost sm', onclick: () => { S.targets.clear(); saveTargets() } }, tr('Сброс'))),
    h('div', { class: 'targets-info' }, S.targets.size
      ? tr('Выбрано {0}, из них в сети {1}', S.targets.size, selOnline)
      : tr('Никто не выбран → команды получат все онлайн ({0})', on)),
    h('div', { class: 'targets' }, sorted.length ? sorted.map(b => h('div', {
      class: 'target' + (S.targets.has(b.id) ? ' on' : '') + (b.state === 'online' ? '' : ' dim'),
      onclick: () => { S.targets.has(b.id) ? S.targets.delete(b.id) : S.targets.add(b.id); saveTargets() },
      oncontextmenu: (e) => { e.preventDefault(); botMenu(b, e.clientX, e.clientY) }
    },
    h('span', { class: 'check' }, icon('check')),
    headImg(b, 'sm'),
    h('span', { class: 'nm' }, botName(b)),
    b.live ? h('span', { class: 'hp' }, `♥ ${f1(b.live.health)}`) : null,
    h('span', { class: 'dot ' + b.state })
    )) : h('div', { class: 'empty-list' }, tr('Нет ботов'))))
}
function saveTargets () {
  ls.set('targets', [...S.targets])
  renderTargets()
  if (S.selected === 'global') renderGlobalTopbarLabel()
}
function renderGlobalTopbarLabel () {
  const btn = $('#topbar .btn')
  if (btn) btn.lastChild.textContent = S.targets.size ? tr('Подключить выбранных') : tr('Подключить всех')
}

// ============================================================
// Modals: add bots / settings / bot settings
// ============================================================
function serverPicker (initial) {
  const g = S.settings.server
  let custom = !!(initial && initial.host)
  const host = h('input', { class: 'input', placeholder: tr('mc.example.com  или  1.2.3.4:25565'), value: initial?.host ? serverStr(initial) : '' })
  const ver = versionSelect(initial?.version || 'auto')
  const fields = h('div', { class: 'stack', style: { gap: '8px' } },
    h('div', { class: 'field' }, h('span', null, tr('Адрес сервера')), host,
      h('div', { class: 'hint' }, tr('Порт можно не писать — тогда 25565 или SRV-запись домена, как в обычном клиенте.'))),
    h('div', { class: 'field' }, h('span', null, tr('Версия')), ver))
  const bGlobal = h('button', { type: 'button' }, tr('Глобальный · {0}', serverStr(g)))
  const bCustom = h('button', { type: 'button' }, tr('Свой сервер'))
  const sync = () => {
    bGlobal.classList.toggle('on', !custom)
    bCustom.classList.toggle('on', custom)
    fields.classList.toggle('hidden', !custom)
  }
  bGlobal.onclick = () => { custom = false; sync() }
  bCustom.onclick = () => { custom = true; sync(); host.focus() }
  sync()
  return {
    el: h('div', { class: 'stack', style: { gap: '10px' } }, h('div', { class: 'seg full' }, bGlobal, bCustom), fields),
    value () {
      if (!custom) return null
      const hv = host.value.trim()
      if (!hv) throw new Error(tr('Укажи адрес сервера'))
      return { host: hv, port: null, version: ver.value } // backend splits "host:port"
    }
  }
}

function versionSelect (value) {
  const sel = h('select', { class: 'input' }, VERSIONS.map(v => h('option', { value: v, selected: v === value }, v === 'auto' ? tr('Авто (спросить сервер)') : v)))
  if (!VERSIONS.includes(value)) sel.append(h('option', { value, selected: true }, value))
  return sel
}

function addBotsModal () {
  let tab = ls.get('addTab', 'offline')
  const server = serverPicker(null)
  const body = h('div', { class: 'stack' })
  const footBtn = h('button', { class: 'btn primary' })
  const tabsEl = h('div', { class: 'seg full' })
  const content = h('div')
  let cleanup = () => {}

  // offline
  const names = h('textarea', { class: 'input', placeholder: 'Steve\nAlex\nBot_01', rows: 6 })
  const prefix = h('input', { class: 'input', value: 'Bot_', style: { width: '110px' } })
  const count = h('input', { class: 'input', type: 'number', value: 5, min: 1, max: 500, style: { width: '80px' } })
  const offlineTab = h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('span', null, tr('Ники, по одному на строку')), names,
      h('div', { class: 'hint' }, tr('Для серверов с online-mode=false. 1–16 символов: латиница, цифры, _.'))),
    h('div', { class: 'row' }, h('span', { class: 'muted' }, tr('Сгенерировать')), prefix, count,
      h('button', {
        class: 'btn sm',
        onclick: () => {
          const n = Math.max(1, Math.min(500, Number(count.value) || 1))
          const p = prefix.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 12)
          const width = Math.max(2, String(n).length)
          const list = Array.from({ length: n }, (_, i) => p + String(i + 1).padStart(width, '0'))
          names.value = (names.value.trim() ? names.value.trim() + '\n' : '') + list.join('\n')
        }
      }, tr('Добавить в список'))))

  // microsoft
  const msaArea = h('div', { class: 'stack' })
  const msaTab = h('div', { class: 'stack' },
    h('div', { class: 'muted' }, tr('Официальный вход по коду (device code). Пароль Botify не видит: ты вводишь код на сайте Microsoft, токены сохраняются локально в data/auth-cache.')),
    msaArea)
  function msaIdle () {
    msaArea.replaceChildren(h('button', { class: 'btn primary', onclick: startMsa }, tr('Войти через Microsoft')))
  }
  async function startMsa () {
    let srv
    try { srv = server.value() } catch (e) { toast(e.message, true); return }
    msaArea.replaceChildren(h('div', { class: 'row muted' }, h('span', { class: 'spin' }), tr('Запрашиваю код…')))
    S.msaHandler = (d) => {
      msaArea.replaceChildren(h('div', { class: 'code-box' },
        h('div', { class: 'muted' }, tr('Открой страницу и введи код')),
        h('div', { class: 'code' }, d.code),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => copy(d.code) }, icon('copy'), tr('Скопировать')),
          h('a', { class: 'btn sm primary', href: d.url, target: '_blank', rel: 'noreferrer' }, icon('ext'), d.url.replace(/^https?:\/\//, ''))),
        h('div', { class: 'row muted' }, h('span', { class: 'spin' }), tr('Жду подтверждения…'))))
    }
    try {
      const r = await api.call('accounts.microsoftLogin', { server: srv })
      msaArea.replaceChildren(h('div', { class: 'code-box' }, h('div', { class: 'code', style: { fontSize: '20px', letterSpacing: '0' } }, `✓ ${r.name}`), h('div', { class: 'muted' }, tr('Аккаунт добавлен')),
        h('button', { class: 'btn sm', onclick: msaIdle }, tr('Добавить ещё один'))))
    } catch (e) {
      if (!/отменено/.test(e.message)) toast(e.message, true)
      msaIdle()
    } finally {
      S.msaHandler = null
    }
  }
  msaIdle()

  // tokens
  const tokens = h('textarea', { class: 'input', rows: 7, placeholder: tr('eyJhbGciOi...            ← access token (JWT)\nM.C5xx_BAY.0.U.-Cg...     ← refresh token\nM.C5xx...|client_id       ← refresh token + свой client id\n{"accessToken":"...","refreshToken":"..."}\n__Host-MSAAUTHP=...; ...  ← куки login.live.com (весь блок)') })
  const clientId = h('input', { class: 'input', placeholder: tr('необязательно — по умолчанию перебираются стандартные') })
  const results = h('div', { class: 'result-list' })
  const tokenTab = h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('span', null, tr('Токены / куки')), tokens,
      h('div', { class: 'hint' }, tr('Тип определяется сам: по строке на токен, либо вставь целиком куки login.live.com (заголовок Cookie или Netscape-файл — нужен __Host-MSAAUTH(P)). Куки меняются на refresh token при импорте и сами не сохраняются. Access token живёт ~24 ч, refresh обновляется автоматически. Всё проверяется у Mojang и хранится в data/accounts.json.'))),
    h('div', { class: 'field' }, h('span', null, tr('Client ID для refresh-токенов')), clientId),
    results)

  const TABS = {
    offline: { label: tr('Оффлайн'), el: offlineTab, btn: tr('Добавить') },
    microsoft: { label: 'Microsoft', el: msaTab, btn: null },
    tokens: { label: tr('Токены'), el: tokenTab, btn: tr('Проверить и добавить') }
  }
  function show (t) {
    tab = t
    ls.set('addTab', t)
    tabsEl.replaceChildren(...Object.entries(TABS).map(([k, v]) => h('button', { type: 'button', class: k === t ? 'on' : '', onclick: () => show(k) }, v.label)))
    content.replaceChildren(TABS[t].el)
    footBtn.textContent = TABS[t].btn || ''
    footBtn.classList.toggle('hidden', !TABS[t].btn)
  }

  footBtn.onclick = async () => {
    let srv
    try { srv = server.value() } catch (e) { toast(e.message, true); return }
    if (tab === 'offline') {
      const list = names.value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
      if (!list.length) { toast(tr('Впиши хотя бы один ник'), true); return }
      footBtn.disabled = true
      try {
        const r = await act('accounts.addOffline', { names: list, server: srv })
        if (r.errors.length) toast(tr('Добавлено {0}. Пропущено: {1}', r.added, r.errors.join('; ')), true)
        else { toast(tr('Добавлено ботов: {0}', r.added)); m.close() }
        if (r.added) names.value = ''
      } finally { footBtn.disabled = false }
    } else if (tab === 'tokens') {
      if (!tokens.value.trim()) { toast(tr('Вставь токены'), true); return }
      footBtn.disabled = true
      footBtn.textContent = tr('Проверяю…')
      results.replaceChildren()
      try {
        const r = await act('accounts.importTokens', { text: tokens.value, clientId: clientId.value.trim() || null, server: srv })
        results.replaceChildren(...r.map(x => h('div', { class: x.ok ? 'ok' : 'bad' }, x.ok ? `${x.name}${x.updated ? tr(' — обновлён') : tr(' — добавлен')}` : `${x.raw ? x.raw + ' — ' : ''}${x.error}`)))
        const ok = r.filter(x => x.ok).length
        if (ok) toast(tr('Готово: {0} из {1}', ok, r.length))
        if (ok === r.length) tokens.value = ''
      } catch {} finally {
        footBtn.disabled = false
        footBtn.textContent = TABS.tokens.btn
      }
    }
  }

  body.append(tabsEl, content, h('div', { class: 'divider' }), h('div', { class: 'sub-h' }, tr('Сервер')), server.el)
  const m = openModal({
    title: tr('Добавить ботов'),
    wide: true,
    body,
    foot: [h('button', { class: 'btn ghost', onclick: () => m.close() }, tr('Закрыть')), footBtn],
    onClose: () => { if (S.msaHandler) { api.call('accounts.cancelMicrosoft').catch(() => {}); S.msaHandler = null } cleanup() }
  })
  show(TABS[tab] ? tab : 'offline')
}

function settingsModal () {
  const s = S.settings
  const language = h('select', { class: 'input', id: 'settings-language', style: { width: '180px' } },
    h('option', { value: 'ru', selected: getLanguage() === 'ru' }, 'Русский'),
    h('option', { value: 'en', selected: getLanguage() === 'en' }, 'English'))
  const host = h('input', { class: 'input', value: serverStr(s.server), placeholder: tr('mc.example.com  или  1.2.3.4:25565') })
  const ver = versionSelect(s.server.version || 'auto')
  const autoRe = h('input', { type: 'checkbox', checked: !!s.behavior.autoReconnect })
  const delay = h('input', { class: 'input', type: 'number', min: 1, value: Math.round((s.behavior.reconnectDelay || 5000) / 1000), style: { width: '90px' } })
  const stagger = h('input', { class: 'input', type: 'number', min: 0, step: 100, value: s.behavior.joinStagger ?? 1500, style: { width: '90px' } })
  const view = h('select', { class: 'input', style: { width: '150px' } }, [['tiny', tr('Крошечная (2)')], ['short', tr('Малая (4)')], ['normal', tr('Средняя (8)')], ['far', tr('Далёкая (12)')]].map(([v, t]) => h('option', { value: v, selected: v === s.behavior.viewDistance }, t)))
  let theme = s.ui?.theme || 'dark'
  const themeSeg = h('div', { class: 'seg' })
  const drawTheme = () => themeSeg.replaceChildren(...[['dark', tr('Тёмная')], ['light', tr('Светлая')]].map(([k, t]) => h('button', { type: 'button', class: k === theme ? 'on' : '', onclick: () => { theme = k; applyTheme(k); drawTheme() } }, t)))
  drawTheme()

  const body = h('div', { class: 'stack' },
    h('div', { class: 'sub-h' }, tr('Глобальный сервер')),
    h('div', { class: 'field' }, h('span', null, tr('Адрес сервера')), host,
      h('div', { class: 'hint' }, tr('Порт не обязателен: без него — 25565 или SRV-запись домена (как в обычном клиенте).'))),
    h('div', { class: 'field' }, h('span', null, tr('Версия')), ver,
      h('div', { class: 'hint' }, tr('Авто — бот спросит версию у сервера. Боты без своего сервера заходят сюда.'))),
    h('div', { class: 'divider' }),
    h('div', { class: 'sub-h' }, tr('Поведение')),
    h('label', { class: 'toggle-row' }, h('div', { class: 't' }, tr('Автопереподключение'), h('small', null, tr('после кика или обрыва, с нарастающей паузой'))), h('span', { class: 'switch' }, autoRe, h('i'))),
    h('div', { class: 'toggle-row' }, h('div', { class: 't' }, tr('Пауза перед переподключением, с')), delay),
    h('div', { class: 'toggle-row' }, h('div', { class: 't' }, tr('Пауза между входами аккаунтов, мс'), h('small', null, tr('аккаунты входят по одному; следующий — после входа или ошибки предыдущего'))), stagger),
    h('div', { class: 'toggle-row' }, h('div', { class: 't' }, tr('Дальность прорисовки'), h('small', null, tr('меньше — меньше памяти на бота'))), view),
    h('div', { class: 'divider' }),
    h('div', { class: 'sub-h' }, tr('Вид')),
    h('label', { class: 'toggle-row', for: 'settings-language' }, h('div', { class: 't' }, tr('Язык')), language),
    h('div', { class: 'toggle-row' }, h('div', { class: 't' }, tr('Тема')), themeSeg),
    h('div', { class: 'divider' }),
    h('div', { class: 'sub-h' }, tr('Данные')),
    h('div', { class: 'field' }, h('div', { class: 'hint' }, tr('Всё хранится локально, обычным JSON:')),
      h('div', { class: 'row' }, h('code', { class: 'mono', style: { fontSize: '12px', userSelect: 'text', overflowWrap: 'anywhere' } }, S.dataDir),
        h('button', { class: 'icon-btn sm', title: tr('Скопировать путь'), onclick: () => copy(S.dataDir) }, icon('copy'))),
      h('div', { class: 'hint' }, tr('settings.json — настройки · accounts.json — боты и токены · auth-cache/ — кэш входа Microsoft')))
  )
  const m = openModal({
    title: tr('Настройки'),
    body,
    foot: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, tr('Отмена')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!host.value.trim()) { toast(tr('Укажи адрес сервера'), true); return }
          await act('settings.update', {
            patch: {
              server: { host: host.value.trim(), port: null, version: ver.value },
              behavior: { autoReconnect: autoRe.checked, reconnectDelay: Math.max(1, Number(delay.value) || 5) * 1000, joinStagger: Math.max(0, Number(stagger.value) || 0), viewDistance: view.value },
              ui: { theme, language: language.value }
            }
          })
          toast(tr('Сохранено'))
          m.close()
        }
      }, tr('Сохранить'))
    ],
    onClose: () => applyTheme(S.settings.ui?.theme || 'dark')
  })
}

function botSettingsModal (id) {
  const b = S.bots.get(id)
  if (!b) return
  const server = serverPicker(b.server.custom ? b.server : null)
  const nick = h('input', { class: 'input', value: b.username })
  const note = h('input', { class: 'input', value: b.note || '', placeholder: tr('например: фармит железо') })
  let ar = b.autoReconnect == null ? 'inherit' : (b.autoReconnect ? 'on' : 'off')
  const arSeg = h('div', { class: 'seg' })
  const drawAr = () => arSeg.replaceChildren(...[['inherit', tr('Как в настройках')], ['on', tr('Вкл')], ['off', tr('Выкл')]].map(([k, t]) => h('button', { type: 'button', class: k === ar ? 'on' : '', onclick: () => { ar = k; drawAr() } }, t)))
  drawAr()

  const body = h('div', { class: 'stack' },
    b.type === 'offline' ? h('div', { class: 'field' }, h('span', null, tr('Ник')), nick) : null,
    h('div', { class: 'sub-h' }, tr('Сервер')),
    server.el,
    h('div', { class: 'divider' }),
    h('div', { class: 'toggle-row' }, h('div', { class: 't' }, tr('Автопереподключение')), arSeg),
    h('div', { class: 'field' }, h('span', null, tr('Заметка')), note),
    h('div', { class: 'divider' }),
    h('dl', { class: 'kv', style: { padding: 0 } },
      h('dt', null, tr('Тип')), h('dd', null, TYPE_LABEL()[b.type] || b.type),
      h('dt', null, 'UUID'), h('dd', { class: 'copy', onclick: () => b.uuid && copy(b.uuid) }, b.uuid || '—'),
      b.tokenExpiresAt ? [h('dt', null, tr('Токен истекает')), h('dd', null, new Date(b.tokenExpiresAt).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'ru-RU'))] : null,
      h('dt', null, 'ID'), h('dd', { class: 'mono' }, b.id))
  )
  const m = openModal({
    title: tr('Настройки бота'),
    head: headImg(b, 'sm'),
    body,
    foot: [
      h('button', { class: 'btn ghost left danger', onclick: () => { m.close(); removeBot(id) } }, icon('trash'), tr('Удалить')),
      h('button', { class: 'btn ghost', onclick: () => m.close() }, tr('Отмена')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          let srv
          try { srv = server.value() } catch (e) { toast(e.message, true); return }
          const patch = { server: srv, note: note.value, autoReconnect: ar === 'inherit' ? null : ar === 'on' }
          if (b.type === 'offline' && nick.value.trim() !== b.username) patch.username = nick.value.trim()
          await act('bot.update', { id, patch }, tr('Сохранено'))
          m.close()
          const cur = S.bots.get(id)
          const before = b.server.custom ? `${serverStr(b.server)}|${b.server.version}` : ''
          const after = srv ? `${srv.host}|${srv.version}` : ''
          if (cur && isActive(cur) && (patch.username || before !== after)) {
            toast(tr('Переподключи бота, чтобы применить'))
          }
        }
      }, tr('Сохранить'))
    ]
  })
}

// ============================================================
// Keyboard
// ============================================================
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    $('#search').focus()
    $('#search').select()
    return
  }
  if (e.key === 'Escape') {
    if ($('#menu-root .menu')) { closeMenu(); return }
    if (modals.length) { modals[modals.length - 1].close(); return }
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    const ids = ['global', ...[...rows.keys()]]
    const i = ids.indexOf(S.selected)
    const n = ids[(i + (e.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length]
    select(n)
    rows.get(n)?.scrollIntoView({ block: 'nearest' })
    return
  }
  const tag = document.activeElement?.tagName
  if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && !modals.length) {
    e.preventDefault()
    V?.console?.focus()
  }
})
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const first = rows.keys().next().value
    if (first) { select(first); e.target.blur() }
  }
  if (e.key === 'Escape') { e.target.value = ''; S.filter = ''; renderSidebar(); e.target.blur() }
})
window.addEventListener('blur', hideTip)

// ============================================================
if (window.botifyShell?.platform) document.body.classList.add('platform-' + window.botifyShell.platform)
setLanguage(ls.get('language', 'ru'))
translateStatic()
api.connect()
