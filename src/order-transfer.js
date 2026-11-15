'use strict'
const helpers = require('./order-transfer-ui')
const { deliver } = require('./order-delivery')
const chests = require('./order-chests')
const active = new WeakSet()

const USAGE = '.transfer <предмет, например spruce_log> <ник покупателя> [chests [радиус] [reset]]'

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
  const online = [...manager.bots.values()].filter(b => b.bot && b.state === 'online')
  const buyer = online.find(b => b.acc.username.toLowerCase() === args[1].toLowerCase())
  if (!buyer) throw new Error('бот-покупатель не подключён')
  const serverKey = b => { const s = b.server(); return `${s.host.toLowerCase()}:${s.port || 25565}` }
  const sellers = online.filter(b => b !== buyer && serverKey(b) === serverKey(buyer) &&
    (chestMode || helpers.inventoryCount(b, item) > 0))
  if (!sellers.length) throw new Error(chestMode ? 'нет других подключённых ботов на этом сервере' : 'у других подключённых ботов на этом сервере нет выбранного предмета')
  if (chestMode && !deps.walk) throw new Error('режим chests недоступен: нет функции ходьбы')
  const displayName = buyer.bot.registry.itemsByName[item]?.displayName
  if (!displayName) throw new Error('неизвестный предмет')
  active.add(manager)
  const ac = new AbortController()
  const participants = [buyer, ...sellers]
  const sessions = participants.map(inst => ({ inst, bot: inst.bot, previous: inst.task?.done }))
  let finish
  const done = new Promise(resolve => { finish = resolve })
  const task = { name: 'transfer', ac, done }
  let created = false
  let confirmed = 0
  const check = () => {
    ac.signal.throwIfAborted()
    if (sessions.some(s => s.inst.bot !== s.bot || s.inst.state !== 'online' || s.inst.task !== task)) {
      ac.abort(); throw new Error('участник transfer отключился или сменил задачу')
    }
  }
  try {
    for (const { inst } of sessions) {
      inst.cancelTask()
      for (const hold of inst.holds?.values() || []) hold.abort()
      inst.holds?.clear()
      inst.task = task; inst.update()
    }
    const ui = (deps.makeUI || helpers.makeUI)(buyer, ac.signal, check)
    let settled = false
    Promise.allSettled(sessions.map(s => s.previous)).then(() => { settled = true })
    await ui.wait(() => settled, 'завершение предыдущих задач', 10000)
    const own = sellers.reduce((n, inst) => n + helpers.inventoryCount(inst, item), 0)
    // Chest mode only uses the wall between the "start" and "end" signs.
    // Find it before any money is locked in an order.
    const areas = new Map()
    // Containers found empty are remembered per wall across runs, so a restart
    // goes straight to the ones not looked at yet.
    const memoryFile = deps.memoryFile !== undefined ? deps.memoryFile : buyer.store?.path?.('transfer-chests.json') || null
    const memories = new Map()
    const save = (k, ids) => {
      if (!memoryFile) return
      try { (deps.saveEmptied || chests.saveEmptied)(memoryFile, k, ids) } catch (error) { reply(`[transfer] не удалось сохранить память сундуков: ${error.message}`, 'err') }
    }
    const saveAll = () => { for (const [k, ids] of memories) save(k, ids) }
    if (chestMode) {
      for (const inst of sellers) {
        try { areas.set(inst, (deps.storageArea || chests.storageArea)(inst.bot, radius)) } catch (error) {
          if (sellers.length === 1) throw new Error(`${inst.acc.username}: ${error.message}`)
          reply(`[transfer] ${inst.acc.username}: сундуки не беру — ${error.message}`)
        }
      }
      if (!areas.size) throw new Error('ни один продавец не нашёл таблички start/end')
      for (const [inst, a] of areas) {
        const k = chests.areaKey(serverKey(buyer), item, a)
        if (!memories.has(k)) {
          if (reset && memoryFile) save(k, null)
          memories.set(k, memoryFile ? (deps.loadEmptied || chests.loadEmptied)(memoryFile, k) : new Set())
        }
        const known = memories.get(k).size
        reply(`[transfer] ${inst.acc.username}: сундуки от start ${a.start.x},${a.start.y},${a.start.z} до end ${a.end.x},${a.end.y},${a.end.z}` +
          (reset ? '; память пустых сундуков сброшена' : known ? `; ${known} уже проверены пустыми — пропускаю (сбросить: chests reset)` : ''))
      }
    }
    // Chest mode: keep filling our already open big order instead of locking
    // the money a second time.
    let order = chestMode ? await (deps.findOwnOrder || helpers.findOwnOrder)(ui, item) : null
    if (order) {
      created = true
      reply(`[transfer] продолжаю открытый ордер ${order.amount / 1000}k ${displayName} по ${(order.priceTenths / 10).toFixed(1)}; ` +
        `уже сдано ≈${order.delivered}; беру из сундуков между табличками start и end; фермы остановлены`)
    } else {
      // The total is unknown in advance, so one big, recognisable order
      // (a round 400k–600k) that only we would list at ~$5 each.
      const amount = chestMode ? (400 + Math.floor(Math.random() * 201)) * 1000 : own
      order = { item, amount, priceTenths: 50 + Math.floor(Math.random() * 10), delivered: 0 }
      if (!order.amount) throw new Error('предметы закончились до начала transfer')
      const price = (order.priceTenths / 10).toFixed(1)
      reply(chestMode
        ? `[transfer] ордер ${order.amount / 1000}k ${displayName} → ${buyer.acc.username} по ${price}; беру из сундуков между табличками start и end; фермы остановлены`
        : `[transfer] ${order.amount} ${displayName} → ${buyer.acc.username}; цена ${price} за штуку; фермы остановлены`)
      await (deps.createOrder || helpers.createOrder)(ui, order, displayName)
      created = true
    }
    const skipped = new Map() // id → failed attempts this run; not remembered as empty
    for (const inst of sellers) {
      const emptied = areas.has(inst) ? memories.get(chests.areaKey(serverKey(buyer), item, areas.get(inst))) : new Set()
      const sellerUI = (deps.makeUI || helpers.makeUI)(inst, ac.signal, check)
      let probed = false
      // Each seller's first delivery is a single item; only the buyer's exact
      // receipt for it allows the rest of that seller's stock to follow.
      const flush = async () => {
        let left = Math.min(helpers.inventoryCount(inst, item), order.amount - order.delivered)
        while (left > 0) {
          check()
          const batch = probed ? left : 1
          await (deps.findOrder || helpers.findOrder)(sellerUI, order, buyer.acc.username)
          await (deps.deliver || deliver)(sellerUI, buyer, item, displayName, batch)
          probed = true
          confirmed += batch; order.delivered += batch; left -= batch
          reply(`[transfer] ${inst.acc.username}: подтверждено ${batch}; за этот запуск ${confirmed}` +
            (chestMode ? `; в ордере ≈${order.delivered}/${order.amount}` : ''))
        }
      }
      await flush()
      let warnedSlots = false
      let trip = 0
      while (chestMode && areas.has(inst) && order.delivered < order.amount) {
        check()
        let result
        try {
          result = await (deps.fill || chests.fillFromStorage)({
            inst, item, radius, area: areas.get(inst), emptied, skipped, signal: ac.signal, check, reply,
            walk: (goal, target) => deps.walk(inst, goal, ac.signal, target),
            look: deps.look?.(inst)
          })
        } finally { saveAll() }
        if (result.taken) reply(`[transfer] ${inst.acc.username}: партия ${++trip} — взял из сундуков ${result.taken}`)
        if (result.exhausted && !result.taken && !trip) {
          reply(`[transfer] ${inst.acc.username}: между start и end не осталось непроверенных сундуков с предметом` +
            (emptied.size ? ` (${emptied.size} помечены пустыми; если их снова наполнили — запусти с chests reset)` : ''))
        }
        // Each slot taken by something else is 64 fewer items per trip.
        const other = (inst.bot.inventory?.items?.() || []).filter(i => i.name !== item).length
        if (!result.exhausted && other && !warnedSlots) {
          warnedSlots = true
          reply(`[transfer] ${inst.acc.username}: ${other} слотов инвентаря заняты другими предметами — за партию до ${(36 - other) * 64} вместо 2304. Освободи их, чтобы партии были больше`)
        }
        await flush()
        // Delivery leaves "Deliver Items" open; walking with it open gets the bot set back.
        await (deps.closeScreens || chests.closeScreens)(inst, ac.signal)
        if (result.exhausted) break
        if (!result.taken && !helpers.inventoryCount(inst, item)) throw new Error(`${inst.acc.username}: инвентарь забит другими предметами`)
      }
      if (chestMode && areas.has(inst) && !deps.fill) {
        const sum = chests.areaSummary(inst.bot, areas.get(inst), radius, emptied, skipped)
        reply(`[transfer] ${inst.acc.username}: сундуков между start и end ${sum.total}; пустых ${sum.emptied}; не проверено ${sum.unchecked}` +
          (sum.failed.length ? `; не открылись ${sum.failed.length}: ${sum.failed.join(' · ')}` : ''), sum.failed.length || sum.unchecked ? 'err' : 'out')
      }
    }
    if (chestMode && order.delivered >= order.amount) reply('[transfer] ордер заполнен целиком; в сундуках могли остаться предметы')
    reply(`[transfer] завершено: ${confirmed} ${displayName} сданы в ордер ${buyer.acc.username}` +
      (chestMode && order.delivered < order.amount ? `. Ордер на ${order.amount} остаётся открытым — следующий запуск chests продолжит его; отмени в Your Orders, чтобы вернуть остаток денег` : ''))
  } catch (error) {
    reply(`[transfer] ${ac.signal.aborted ? 'остановлен' : error.message}; подтверждено ${confirmed}.` +
      (created ? ' Ордер может остаться открытым — проверь Your Orders; автоматического повтора нет.' : ''), 'err')
  } finally {
    ac.abort()
    for (const { inst } of sessions) if (inst.task === task) { inst.task = null; inst.update() }
    finish(); active.delete(manager)
  }
}

module.exports = { runTransfer }
