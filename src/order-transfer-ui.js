'use strict'
const timers = require('node:timers/promises')
const screens = require('./screens')

const clean = value => String(value || '').replace(/§./g, '').replace(/\s+/g, ' ').trim()
const norm = value => clean(value).toLowerCase()
const itemName = value => norm(value).replace(/^minecraft:/, '').replace(/ /g, '_')
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function inventoryCount (inst, name) {
  return (inst.bot.currentWindow || inst.bot.inventory).items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
}

function currentScreen (inst) {
  if (inst.dialog && !inst.dialog.waiting) return { kind: 'dialog', ref: inst.dialog, title: inst.dialog.title,
    body: inst.dialog.body.join('\n'), buttons: inst.dialog.buttons.map((b, index) => ({ index, label: b.label })), inputs: inst.dialog.inputs }
  const view = screens.windowView(inst.bot)
  return view && { kind: 'window', ref: inst.bot.currentWindow, ...view }
}

function fingerprint (screen) {
  return screen ? JSON.stringify([screen.kind, screen.title, screen.kind === 'dialog' ? [screen.ref.seq, screen.buttons, screen.body] : screen.slots]) : ''
}

function makeUI (inst, signal, check) {
  const pause = async (ms = 300 + Math.floor(Math.random() * 401)) => {
    check(); await timers.setTimeout(ms, undefined, { signal }); check()
  }
  const wait = async (predicate, description, timeout = 12000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      check()
      const screen = currentScreen(inst)
      const value = predicate(screen)
      if (value) return value === true ? screen : value
      await pause(50)
    }
    throw new Error(`${inst.acc.username}: таймаут — ${description}; экран: ${currentScreen(inst)?.title || 'закрыт'}`)
  }
  const command = async text => {
    check()
    if (inst.bot.currentWindow) await inst.bot.closeWindow(inst.bot.currentWindow)
    if (inst.dialog) inst.dialogClose()
    await pause()
    inst.bot.chat(text)
    return wait(s => !!s, `ответ на ${text}`)
  }
  const click = async (screen, index, values) => {
    const previous = fingerprint(screen)
    await pause()
    if (currentScreen(inst)?.ref !== screen.ref) throw new Error('экран сменился до нажатия')
    if (screen.kind === 'dialog') {
      // Validate inputs ourselves: the manual UI helper can truncate/clamp them.
      for (const [key, value] of Object.entries(values || {})) {
        const field = screen.inputs.find(i => i.key === key)
        if (!field || (field.maxLength && String(value).length > field.maxLength)) throw new Error('значение не помещается в поле диалога')
        if (field.type === 'number' && (Number(value) < field.start || Number(value) > field.end)) throw new Error('значение вне диапазона диалога')
      }
      inst.dialogClick(index, values)
    } else {
      const remaining = 501 - (Date.now() - (inst.bot.lastDigTime || 0))
      if (index >= 36 && remaining > 0) await pause(remaining)
      check()
      if (currentScreen(inst)?.ref !== screen.ref) throw new Error('окно сменилось до клика')
      await inst.bot.clickWindow(index, 0, 0)
    }
    await pause()
    return previous
  }
  const button = (screen, pattern) => {
    const choices = screen.kind === 'dialog' ? screen.buttons.map(b => ({ index: b.index, label: b.label }))
      : screen.slots.filter(Boolean).map(s => ({ index: s.slot, label: s.displayName }))
    const found = choices.filter(b => pattern.test(clean(b.label)))
    if (found.length !== 1) throw new Error(`в «${screen.title}» нет единственной кнопки ${pattern}`)
    return found[0].index
  }
  const advance = async (screen, pattern, values) => {
    const previous = await click(screen, button(screen, pattern), values)
    return wait(s => s && fingerprint(s) !== previous, 'следующий экран')
  }
  return { inst, signal, check, pause, wait, command, click, button, advance }
}

function inputValue (screen, label, value) {
  if (screen.kind !== 'dialog') throw new Error('ожидался диалог с полем ввода')
  const fields = screen.inputs.filter(i => label.test(clean(i.label)))
  if (fields.length !== 1) throw new Error(`не найдено однозначное поле ${label}`)
  return { [fields[0].key]: String(value) }
}

// Server counts: "73", "512,000", "2.3k", "1.1m". Abbreviated values are
// rounded, so return the precision the text actually carries.
const COUNT = /(\d[\d,]*(?:\.\d+)?)\s*([km])?/i
function parseCount (text) {
  const m = String(text || '').trim().match(new RegExp(`^${COUNT.source}$`, 'i'))
  if (!m) return null
  const unit = { k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] || 1
  const decimals = m[1].split('.')[1]?.length || 0
  return { value: Math.round(Number(m[1].replace(/,/g, '')) * unit), tolerance: unit === 1 ? 0 : unit / 10 ** decimals }
}
// Rounding or truncation is off by less than one unit of the last digit shown.
const countIs = (parsed, expected) => !!parsed && (parsed.value === expected || Math.abs(parsed.value - expected) < parsed.tolerance)

function verifyReview (screen, order, displayName) {
  if (screen.kind !== 'dialog' || !/^review order$/i.test(clean(screen.title))) throw new Error('не получен Review Order')
  const body = clean(screen.body)
  const selected = body.match(/\bItem:\s*(.*?)\s+Amount:/i)?.[1]
  const amount = parseCount(body.match(new RegExp(`\\bAmount:\\s*(${COUNT.source})`, 'i'))?.[1])
  const price = body.match(/\bPrice:\s*\$?\s*(\d+(?:[.,]\d+)?)\s*each/i)?.[1]?.replace(',', '.')
  if (norm(selected) !== norm(displayName) || !countIs(amount, order.amount) || Number(price) !== order.priceTenths / 10) {
    throw new Error('Review Order не совпадает с предметом, количеством или ценой; создание отменено')
  }
}

function newOrderSlot (screen) {
  if (screen?.kind !== 'window' || !/^Orders\s*(?:->|→)\s*Your Orders$/i.test(clean(screen.title))) {
    throw new Error('ожидалось окно Your Orders')
  }
  // Each free order slot is an equivalent button, unlike listings or confirmations.
  const free = screen.slots.filter(s => s && s.name === 'gray_stained_glass_pane' &&
    /^new order$/i.test(clean(s.displayName)) &&
    s.lore?.some(line => /^click to create new order$/i.test(clean(line))))
  if (!free.length) throw new Error('в Your Orders нет свободных слотов New Order')
  return free.reduce((first, s) => s.slot < first.slot ? s : first).slot
}

const YOUR_ORDERS = /^Orders\s*(?:->|→)\s*Your Orders$/i
// Wait for the server's Your Orders window itself: the local click prediction
// already changes the Orders window, which is not the next screen.
async function openYourOrders (ui) {
  const screen = await ui.command('/order')
  if (screen.kind === 'window' && YOUR_ORDERS.test(clean(screen.title))) return screen
  await ui.click(screen, ui.button(screen, /^your orders?$/i))
  return ui.wait(s => s?.kind === 'window' && YOUR_ORDERS.test(clean(s.title)), 'окно Your Orders')
}

async function createOrder (ui, order, displayName) {
  let screen = await openYourOrders(ui)
  await ui.click(screen, newOrderSlot(screen))
  screen = await ui.wait(s => s?.kind === 'dialog' && /^choose item$/i.test(clean(s.title)), 'Choose Item')
  screen = await ui.advance(screen, /^search$/i, inputValue(screen, /^search$/i, displayName))
  screen = await ui.advance(screen, new RegExp(`^${escape(displayName)}$`, 'i'))
  if (!/^how many\??$/i.test(clean(screen.title))) throw new Error('ожидался How many?')
  screen = await ui.advance(screen, /^next$/i, inputValue(screen, /^amount$/i, order.amount))
  if (!/^price per item\??$/i.test(clean(screen.title))) throw new Error('ожидался Price per item?')
  screen = await ui.advance(screen, /^review order$/i, inputValue(screen, /^price$/i, (order.priceTenths / 10).toFixed(1)))
  verifyReview(screen, order, displayName)
  // The dialog closes even when the server refuses (e.g. not enough money);
  // only "You ordered …" proves the order exists.
  const bot = ui.inst.bot
  let ordered = false
  const listener = message => { if (/^you ordered\b/i.test(clean(message))) ordered = true }
  bot.on('messagestr', listener)
  try {
    await ui.click(screen, ui.button(screen, /^create order$/i))
    await ui.wait(() => ordered, 'сообщение «You ordered» — ордер не создан (хватает ли денег у покупателя?)', 15000)
  } finally { bot.off('messagestr', listener) }
}

// Our chest-mode order: a round 400k–600k at $5.0–5.9 each, not yet complete.
function ownBigOrder (slot, item) {
  if (slot?.name !== item) return null
  const text = clean((slot.lore || []).join(' '))
  const price = text.match(/\$\s*(\d+(?:\.\d)?)\s*each/i)?.[1]
  const amount = text.match(new RegExp(`(?:^|\\s)${COUNT.source}\\s*\\/\\s*${COUNT.source}\\s*delivered`, 'i'))
  if (!price || !amount) return null
  const priceTenths = Math.round(Number(price) * 10)
  const delivered = parseCount(amount[1] + (amount[2] || ''))
  const total = parseCount(amount[3] + (amount[4] || ''))
  if (priceTenths < 50 || priceTenths > 59) return null
  if (total.value % 1000 || total.value < 400000 || total.value > 600000 || delivered.value >= total.value) return null
  return { item, amount: total.value, priceTenths, delivered: delivered.value }
}

async function findOwnOrder (ui, item) {
  const screen = await openYourOrders(ui)
  const found = screen.slots.map(s => ownBigOrder(s, item)).filter(Boolean)
  if (found.length > 1) throw new Error('у покупателя несколько больших ордеров на этот предмет — оставь один')
  const bot = ui.inst.bot
  if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
  return found[0] || null
}

function matchesOrder (slot, order, buyerName) {
  if (slot.name !== order.item) return false
  const text = clean(slot.lore.join(' '))
  const price = text.match(/\$\s*(\d+(?:[.,]\d+)?)\s*(?:each|per item)/i)?.[1]?.replace(',', '.')
  const amount = text.match(new RegExp(`(?:^|\\s)${COUNT.source}\\s*\\/\\s*${COUNT.source}\\s*delivered`, 'i'))
  if (!amount || Number(price) !== order.priceTenths / 10) return false
  const delivered = parseCount(amount[1] + (amount[2] || ''))
  const total = parseCount(amount[3] + (amount[4] || ''))
  if (!countIs(total, order.amount)) return false
  const owner = text.match(/\b(?:owner|buyer|player|ordered by)\s*:\s*([A-Za-z0-9_]+)/i)?.[1]
  if (owner && norm(owner) !== norm(buyerName)) return false
  // Rounded "2.3k" can't tell 2300 from 2304, but still rejects a stale page
  // from before the previous batch (batches are far larger than the rounding).
  return delivered.value < order.amount && (order.delivered == null || countIs(delivered, order.delivered))
}

const filterSlot = screen => {
  const filters = screen.slots.filter(s => s?.name === 'hopper' && /filter/i.test(s.displayName))
  if (filters.length !== 1) throw new Error('не найден единственный фильтр ордеров')
  return filters[0].slot
}

// Only the order listings: the local click prediction (hopper on the cursor)
// must not count as a new sort mode, only the server's re-sorted page does.
const listingKey = screen => JSON.stringify(screen.slots
  .filter(s => s && s.name !== 'hopper' && s.lore?.some(l => /delivered/i.test(clean(l))))
  .map(s => [s.slot, s.name, s.lore]))

async function findOrder (ui, order, buyerName, attempts = 3) {
  // "/orders <nick>" lists only that player's orders — no sorting or paging.
  for (let n = 0; n < attempts && !ui.noOwnerList; n++) {
    let found
    try { found = await findByOwner(ui, order, buyerName) } catch (error) {
      ui.check()
      if (error.ambiguous) throw error
      ui.noOwnerList = true // not supported here; use the full listing from now on
      break
    }
    if (found) return found
    await ui.pause(1500 + Math.floor(Math.random() * 1000))
  }
  // Fallback: the full listing. It lags a second or two behind a delivery,
  // so reopen it before paging.
  for (let n = 1; n < attempts; n++) {
    const found = await findOrderOnce(ui, order, buyerName, false)
    if (found) return found
    await ui.pause(1500 + Math.floor(Math.random() * 1000))
  }
  return findOrderOnce(ui, order, buyerName, true)
}

async function findByOwner (ui, order, buyerName) {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(buyerName)) throw new Error('некорректный ник')
  const screen = await ui.command(`/orders ${buyerName}`)
  if (screen.kind !== 'window') throw new Error('/orders <ник> не открыл окно')
  if (/^Orders\s*(?:->|→)\s*Deliver Items$/i.test(clean(screen.title))) return screen
  const matches = screen.slots.filter(s => s && matchesOrder(s, order, buyerName))
  if (matches.length > 1) throw Object.assign(new Error('найдено несколько одинаковых ордеров — сдача отменена'), { ambiguous: true })
  if (!matches.length) return null
  const previous = await ui.click(screen, matches[0].slot)
  return ui.wait(s => s && fingerprint(s) !== previous, 'окно сдачи предметов')
}

async function findOrderOnce (ui, order, buyerName, paging) {
  let screen = await ui.command(`/order ${order.item}`)
  if (screen.kind !== 'window') throw new Error('ожидался список ордеров')
  const pick = s => {
    const matches = s.slots.filter(x => x && matchesOrder(x, order, buyerName))
    if (matches.length > 1) throw new Error('найдено несколько одинаковых ордеров — сдача отменена')
    return matches[0]
  }
  const open = async match => {
    const previous = await ui.click(screen, match.slot)
    return ui.wait(s => s && fingerprint(s) !== previous, 'окно сдачи предметов')
  }
  // The server does not expose the selected sort mode in the lore text (every
  // mode has the same «▪» bullet; selection is only colour). Recently Listed
  // puts our fresh order on page 1, so cycle the hopper until the order shows
  // up on the first page or the modes repeat.
  const seen = new Set()
  for (let n = 0; n < 4; n++) {
    const match = pick(screen)
    if (match) return open(match)
    const key = listingKey(screen)
    if (seen.has(key)) break
    seen.add(key)
    await ui.click(screen, filterSlot(screen))
    screen = await ui.wait(s => {
      if (s?.kind !== 'window' || listingKey(s) === key) return false
      return s.slots.some(x => x?.name === 'hopper' && /filter/i.test(x.displayName))
    }, 'смена сортировки')
  }
  if (!paging) return null
  // Fallback: walk the pages of whatever mode is active now.
  const pages = new Set()
  for (let page = 0; page < 100; page++) {
    const signature = fingerprint(screen)
    if (pages.has(signature)) throw new Error('ордер не найден: список ордеров зациклился')
    pages.add(signature)
    const match = pick(screen)
    if (match) return open(match)
    screen = await ui.advance(screen, /^next page(?:\s*[»→])?$/i)
  }
  throw new Error('ордер не найден за 100 страниц')
}

module.exports = { clean, norm, itemName, inventoryCount, currentScreen, fingerprint, makeUI, inputValue, parseCount, countIs, verifyReview, newOrderSlot, createOrder, ownBigOrder, findOwnOrder, matchesOrder, findOrder }
