'use strict'
const { goals } = require('mineflayer-pathfinder')
const helpers = require('./order-transfer-ui')
const { deliver } = require('./order-delivery')
const chests = require('./order-chests')
const { syncInventory } = require('./inventory-cursor')
const active = new WeakSet()

const USAGE = '.transfer <предмет, например spruce_log> <ник покупателя> [chests [радиус] [reset]]'
const fmt = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

/**
 * Sellers deliver `item` into the buyer's order, found with "/orders <buyer>"
 * (that list holds only the buyer's own orders). With "chests" each seller
 * also empties every container in the box between the "start" and "end"
 * signs, delivering whenever the inventory is full, and finally walks back to
 * where it started (and resumes .autotree if it was farming).
 * The buyer bot is only used to create the order when there is none.
 */
async function runTransfer (manager, args, reply, deps = {}) {
  if (active.has(manager)) throw new Error('transfer уже выполняется; .stop — остановить')
  const chestMode = args.length >= 3 && /^(chests?|сундуки)$/i.test(args[2])
  if (args.length < 2 || args.length > 5 || (args.length >= 3 && !chestMode)) throw new Error(USAGE)
  const extra = args.slice(3)
  const reset = extra.some(a => /^(reset|заново)$/i.test(a))
  const numbers = extra.filter(a => !/^(reset|заново)$/i.test(a))
  if (numbers.length > 1) throw new Error(USAGE)
  const radius = numbers[0] == null ? 24 : Number(numbers[0])
  if (!Number.isInteger(radius) || radius < 4 || radius > 64) throw new Error('радиус сундуков — целое от 4 до 64')
  const item = helpers.itemName(args[0])
  const buyerName = args[1]
  if (!/^[A-Za-z0-9_]{1,16}$/.test(buyerName)) throw new Error('некорректный ник покупателя')
  const online = [...manager.bots.values()].filter(b => b.bot && b.state === 'online')
  // The buyer may be one of our bots (it can then create the order) or anyone else.
  const buyer = online.find(b => b.acc.username.toLowerCase() === buyerName.toLowerCase()) || null
  const serverKey = b => { const s = b.server(); return `${s.host.toLowerCase()}:${s.port || 25565}` }
  const sellers = online.filter(b => b !== buyer && (!buyer || serverKey(b) === serverKey(buyer)) &&
    (chestMode || helpers.inventoryCount(b, item) > 0))
  if (!sellers.length) throw new Error(chestMode ? 'нет подключённых ботов-продавцов' : 'у подключённых ботов нет выбранного предмета')
  if (chestMode && !deps.walk) throw new Error('режим chests недоступен: нет функции ходьбы')
  const displayName = sellers[0].bot.registry.itemsByName[item]?.displayName
  if (!displayName) throw new Error('неизвестный предмет')
  active.add(manager)
  const ac = new AbortController()
  const sessions = sellers.map(inst => ({ inst, bot: inst.bot, previous: inst.task?.done, resume: inst.task?.name }))
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const task = { name: 'transfer', ac, done }
  let created = false
  let confirmed = 0
  let full = false
  const homes = new Map()
  const check = () => {
    ac.signal.throwIfAborted()
    if (sessions.some(s => s.inst.bot !== s.bot || s.inst.state !== 'online' || s.inst.task !== task)) {
      ac.abort(); throw new Error('продавец отключился или его остановили')
    }
  }
  const close = (inst, settle) => (deps.closeScreens || chests.closeScreens)(inst, ac.signal, { settle })
  let stopped = false
  try {
    for (const { inst } of sessions) {
      homes.set(inst, inst.bot.entity?.position?.clone?.() || null)
      inst.cancelTask()
      for (const hold of inst.holds?.values() || []) hold.abort()
      inst.holds?.clear()
      inst.task = task; inst.update()
    }
    const firstUI = (deps.makeUI || helpers.makeUI)(sellers[0], ac.signal, check)
    let settled = false
    Promise.allSettled(sessions.map(s => s.previous)).then(() => { settled = true })
    await firstUI.wait(() => settled, 'завершение предыдущих задач', 10000)

    // Chest mode only uses the box between the "start" and "end" signs.
    const areas = new Map()
    const owner = buyer || sellers[0]
    const memoryFile = deps.memoryFile !== undefined ? deps.memoryFile : owner.store?.path?.('transfer-chests.json') || null
    const memories = new Map()
    const save = (k, ids) => {
      if (!memoryFile) return
      try { (deps.saveEmptied || chests.saveEmptied)(memoryFile, k, ids) } catch (error) { reply(`[transfer] не удалось сохранить память сундуков: ${error.message}`, 'err') }
    }
    const saveAll = () => { for (const [k, ids] of memories) save(k, ids) }
    const memoryKey = (inst, a) => chests.areaKey(serverKey(inst), item, a)
    if (chestMode) {
      for (const inst of sellers) {
        try { areas.set(inst, (deps.storageArea || chests.storageArea)(inst.bot, radius)) } catch (error) {
          if (sellers.length === 1) throw new Error(`${inst.acc.username}: ${error.message}`)
          reply(`[transfer] ${inst.acc.username}: сундуки не беру — ${error.message}`)
        }
      }
      if (!areas.size) throw new Error('ни один продавец не нашёл таблички start/end')
      for (const [inst, a] of areas) {
        const k = memoryKey(inst, a)
        if (!memories.has(k)) {
          if (reset && memoryFile) save(k, null)
          memories.set(k, memoryFile ? (deps.loadEmptied || chests.loadEmptied)(memoryFile, k) : new Set())
        }
        const known = memories.get(k).size
        reply(`[transfer] ${inst.acc.username}: сундуки в прямоугольнике от start ${fmt(a.start)} до end ${fmt(a.end)}` +
          (reset ? '; память пустых сундуков сброшена' : known ? `; ${known} уже проверены пустыми — пропускаю (сбросить: chests reset)` : ''))
      }
    }

    // Create the order through the buyer bot — only when /orders shows none.
    const createOrder = async () => {
      if (!buyer) throw new Error(`у ${buyerName} нет открытого ордера на ${displayName}, а это не наш бот — создать ордер некому`)
      if (created) throw new Error(`ордер создан, но не появился в /orders ${buyerName}`)
      const own = sellers.reduce((n, inst) => n + helpers.inventoryCount(inst, item), 0)
      // In chest mode the total is unknown: one big round order (400k–600k).
      const order = { item, amount: chestMode ? (400 + Math.floor(Math.random() * 201)) * 1000 : own, priceTenths: 50 + Math.floor(Math.random() * 10), delivered: 0 }
      reply(`[transfer] у ${buyerName} нет открытого ордера — создаю: ${chestMode ? order.amount / 1000 + 'k' : order.amount} ${displayName} по ${(order.priceTenths / 10).toFixed(1)}`)
      buyer.cancelTask?.()
      const buyerCheck = () => { ac.signal.throwIfAborted(); if (buyer.state !== 'online') throw new Error('покупатель отключился') }
      const ui = (deps.makeUI || helpers.makeUI)(buyer, ac.signal, buyerCheck)
      await (deps.createOrder || helpers.createOrder)(ui, order, displayName)
      created = true
      await close(buyer, true)
    }

    for (const inst of sellers) {
      if (full) break
      const name = inst.acc.username
      const ui = (deps.makeUI || helpers.makeUI)(inst, ac.signal, check)
      const openOrder = deps.openBuyerOrder || helpers.openBuyerOrder
      // Deliver everything of `item` the seller carries.
      const flush = async () => {
        while (!full && helpers.inventoryCount(inst, item) > 0) {
          check()
          await close(inst, false)
          let found = await openOrder(ui, buyerName, item)
          for (let n = 0; !found && n < 3; n++) {
            await close(inst, true)
            if (!created) await createOrder()
            else await ui.pause(1500 + Math.floor(Math.random() * 1000)) // the new order shows up with a delay
            found = await openOrder(ui, buyerName, item)
          }
          if (!found) throw new Error(`не нашёл ордер ${buyerName} на ${displayName} в /orders ${buyerName}`)
          const order = found.order
          const have = helpers.inventoryCount(inst, item)
          const batch = order ? Math.min(have, order.amount - order.delivered) : have
          if (batch <= 0) { full = true; break }
          await (deps.deliver || deliver)(ui, item, displayName, batch, {
            closeScreens: () => close(inst, true),
            sync: () => syncInventory(inst.bot)
          })
          confirmed += batch
          if (order) {
            order.delivered += batch
            if (order.delivered >= order.amount) full = true
          }
          reply(`[transfer] ${name}: сдано ${batch}; за этот запуск ${confirmed}` +
            (order ? `; в ордере ≈${order.delivered}/${order.amount}` : ''))
          // The server re-opens its menus after a delivery; never walk with one open.
          await close(inst, true)
        }
      }
      await flush()
      const area = areas.get(inst)
      if (!chestMode || !area) continue
      const emptied = memories.get(memoryKey(inst, area))
      const skipped = new Map() // id → failed attempts this run; not remembered as empty
      let trip = 0
      let warnedSlots = false
      while (!full) {
        check()
        let result
        try {
          result = await (deps.fill || chests.fillFromStorage)({
            inst, item, radius, area, emptied, skipped, signal: ac.signal, check, reply,
            walk: (goal, target) => deps.walk(inst, goal, ac.signal, target),
            look: deps.look?.(inst)
          })
        } finally { saveAll() }
        if (result.taken) reply(`[transfer] ${name}: партия ${++trip} — взял из сундуков ${result.taken}`)
        const other = (inst.bot.inventory?.items?.() || []).filter(i => i.name !== item).length
        if (!result.exhausted && other && !warnedSlots) {
          warnedSlots = true
          reply(`[transfer] ${name}: ${other} слотов инвентаря заняты другими предметами — за партию до ${(36 - other) * 64} вместо 2304`)
        }
        await close(inst, true)
        await flush()
        if (result.exhausted) break
        if (!result.taken && !helpers.inventoryCount(inst, item)) throw new Error(`${name}: инвентарь забит другими предметами`)
      }
      if (!deps.fill) {
        const sum = chests.areaSummary(inst.bot, area, radius, emptied, skipped)
        reply(`[transfer] ${name}: сундуков в прямоугольнике ${sum.total}; пустых ${sum.emptied}; не проверено ${sum.unchecked}` +
          (sum.failed.length ? `; не открылись ${sum.failed.length}: ${sum.failed.join(' · ')}` : ''), sum.failed.length || sum.unchecked ? 'err' : 'out')
      }
    }
    if (full) reply('[transfer] ордер заполнен целиком')
    reply(`[transfer] готово: сдано ${confirmed} ${displayName} в ордер ${buyerName}`)
  } catch (error) {
    stopped = ac.signal.aborted
    reply(`[transfer] ${stopped ? 'остановлен' : error.message}; сдано ${confirmed}.`, 'err')
  } finally {
    ac.abort()
    for (const { inst } of sessions) if (inst.task === task) { inst.task = null; inst.update() }
    finish(); active.delete(manager)
  }
  // Back to where each seller started (unless stopped by hand), then resume farming.
  if (stopped || !deps.walk) return
  for (const s of sessions) await goHome(s, homes.get(s.inst), deps, reply)
}

async function goHome ({ inst, bot, resume }, home, deps, reply) {
  if (!home || inst.bot !== bot || inst.state !== 'online') return
  const name = inst.acc.username
  const run = async signal => {
    await (deps.closeScreens || chests.closeScreens)(inst, signal, { settle: true })
    if (inst.bot.entity.position.distanceTo(home) <= 1.5) return
    reply(`[transfer] ${name}: возвращаюсь на ${fmt(home)}`)
    await deps.walk(inst, new goals.GoalBlock(Math.floor(home.x), Math.floor(home.y), Math.floor(home.z)), signal, home)
  }
  try {
    if (inst.runTask) await inst.runTask('transfer-return', run)
    else await run(new AbortController().signal)
  } catch (error) {
    reply(`[transfer] ${name}: не вернулся на место — ${error.message}`, 'err')
    return
  }
  if (resume === 'autotree' && inst.command) {
    reply(`[transfer] ${name}: снова запускаю .autotree`)
    Promise.resolve(inst.command('.autotree')).catch(error => reply(`[transfer] ${name}: .autotree не запустился — ${error.message}`, 'err'))
  }
}

module.exports = { runTransfer }
