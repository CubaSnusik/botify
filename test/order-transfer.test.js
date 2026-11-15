'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { runTransfer } = require('../src/order-transfer')
const { matchesOrder, verifyReview, findOrder, parseCount, ownBigOrder, openListing, openBuyerOrder } = require('../src/order-transfer-ui')

function setup ({ order = { amount: 512000, delivered: 41100, priceTenths: 52 } } = {}) {
  const stock = { Buyer: 0, SellerA: 64, SellerB: 5, Elsewhere: 100 }
  const make = (username, host = 'example.test') => ({
    acc: { username }, state: 'online', task: null, holds: new Map(), update () {},
    commands: [],
    command (line) { this.commands.push(line) },
    cancelTask () { this.task?.ac.abort(); this.task = null }, server: () => ({ host }),
    bot: { registry: { itemsByName: { spruce_log: { displayName: 'Spruce Log' } } },
      entity: { position: new Vec3(10, 64, 10) },
      inventory: { items: () => stock[username] ? [{ name: 'spruce_log', count: stock[username] }] : [] } }
  })
  const bots = ['Buyer', 'SellerA', 'SellerB'].map(n => make(n)).concat(make('Elsewhere', 'other.test'))
  const manager = { bots: new Map(bots.map(i => [i.acc.username, i])) }
  const [buyer, a, b] = bots
  const calls = []; const logs = []
  const state = { order: order && { item: 'spruce_log', ...order } }
  const deps = {
    makeUI: (inst, signal, check) => ({ inst, signal, check, pause: async () => {}, wait: async p => { for (let i = 0; i < 5; i++) await Promise.resolve(); check(); assert.ok(p()) } }),
    closeScreens: async () => {},
    createOrder: async (ui, o) => { calls.push(['create', ui.inst.acc.username, { ...o }]); state.order = { ...o } },
    openBuyerOrder: async (ui, buyerName, item) => {
      ui.check(); calls.push(['open', ui.inst.acc.username, buyerName, item])
      return state.order ? { screen: {}, order: { ...state.order } } : null
    },
    deliver: async (ui, item, display, count) => {
      ui.check(); calls.push(['deliver', ui.inst.acc.username, count])
      stock[ui.inst.acc.username] -= count
      if (state.order) state.order.delivered += count
    },
    storageArea: () => ({ start: { x: 0, y: 0, z: 0 }, end: { x: 9, y: 4, z: 0 }, min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 4, z: 1 } })
  }
  return { manager, buyer, a, b, calls, logs, deps, stock, state }
}

test('existing order from /orders <buyer>: every seller delivers everything at once, no probe, no new order', async () => {
  const s = setup()
  await runTransfer(s.manager, ['spruce_log', 'Buyer'], t => s.logs.push(t), s.deps)
  assert.deepEqual(s.calls.filter(c => c[0] === 'deliver'), [['deliver', 'SellerA', 64], ['deliver', 'SellerB', 5]])
  assert.deepEqual(s.calls.filter(c => c[0] === 'open').map(c => c.slice(1)), [['SellerA', 'Buyer', 'spruce_log'], ['SellerB', 'Buyer', 'spruce_log']])
  assert.equal(s.calls.filter(c => c[0] === 'create').length, 0)
  assert.equal(s.buyer.task, null) // the buyer is not touched at all
  assert.ok(s.logs.some(t => /готово: сдано 69/.test(t)), s.logs.join('\n'))
})

test('no open order: the buyer bot creates one once, then the sellers deliver', async () => {
  const s = setup({ order: null })
  await runTransfer(s.manager, ['spruce_log', 'Buyer'], t => s.logs.push(t), s.deps)
  const created = s.calls.filter(c => c[0] === 'create')
  assert.equal(created.length, 1)
  assert.equal(created[0][1], 'Buyer')
  assert.equal(created[0][2].amount, 69)
  assert.ok(created[0][2].priceTenths >= 50 && created[0][2].priceTenths <= 59)
  assert.deepEqual(s.calls.filter(c => c[0] === 'deliver'), [['deliver', 'SellerA', 64], ['deliver', 'SellerB', 5]])
})

test('buyer that is not our bot: deliver into its order; without an order nobody can create one', async () => {
  const s = setup()
  await runTransfer(s.manager, ['spruce_log', 'SomePlayer'], t => s.logs.push(t), s.deps)
  assert.deepEqual(s.calls.filter(c => c[0] === 'open').map(c => c[2]), ['SomePlayer', 'SomePlayer', 'SomePlayer'])
  assert.equal(s.calls.filter(c => c[0] === 'deliver').length, 3) // SellerA, SellerB, Elsewhere
  const t = setup({ order: null })
  await runTransfer(t.manager, ['spruce_log', 'SomePlayer'], x => t.logs.push(x), t.deps)
  assert.ok(t.logs.some(x => /не наш бот — создать ордер некому/.test(x)), t.logs.join('\n'))
})

test('a batch never exceeds what is left in the order; a full order ends the run', async () => {
  const s = setup({ order: { amount: 512000, delivered: 511990, priceTenths: 52 } })
  await runTransfer(s.manager, ['spruce_log', 'Buyer'], t => s.logs.push(t), s.deps)
  assert.deepEqual(s.calls.filter(c => c[0] === 'deliver'), [['deliver', 'SellerA', 10]])
  assert.ok(s.logs.some(t => /заполнен целиком/.test(t)))
})

test('chest mode: deliver per full inventory until every chest in the rectangle was checked, then walk home and resume the farm', async () => {
  const s = setup()
  s.stock.SellerB = 0
  s.a.task = { name: 'autotree', ac: new AbortController(), done: Promise.resolve() }
  const trips = [2304, 2304, 500]
  const walks = []
  s.deps.walk = async (inst, goal) => { walks.push([inst.acc.username, goal.x, goal.y, goal.z]); inst.bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5) }
  s.deps.fill = async ({ inst, emptied }) => {
    if (inst.acc.username !== 'SellerA' || !trips.length) return { taken: 0, exhausted: true }
    inst.bot.entity.position = new Vec3(0, 64, 3) // walked along the wall
    const taken = trips.shift(); s.stock.SellerA += taken
    if (!trips.length) emptied.add('last')
    return { taken, exhausted: !trips.length }
  }
  await runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests', '16'], t => s.logs.push(t), s.deps)
  assert.deepEqual(s.calls.filter(c => c[0] === 'deliver'), [
    ['deliver', 'SellerA', 64], ['deliver', 'SellerA', 2304], ['deliver', 'SellerA', 2304], ['deliver', 'SellerA', 500]
  ])
  assert.equal(s.calls.filter(c => c[0] === 'create').length, 0)
  assert.deepEqual(walks, [['SellerA', 10, 64, 10]])
  assert.deepEqual(s.a.commands, ['.autotree'])
  assert.deepEqual(s.b.commands, [])
  assert.ok(s.logs.some(t => /возвращаюсь на 10,64,10/.test(t)), s.logs.join('\n'))
})

test('stop by hand: no walk home and no farm restart', async () => {
  const s = setup()
  s.a.task = { name: 'autotree', ac: new AbortController(), done: Promise.resolve() }
  const walks = []
  s.deps.walk = async (...x) => { walks.push(x) }
  s.deps.fill = async ({ inst }) => { inst.cancelTask(); inst.task = null; throw new Error('cancelled') }
  await runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests'], t => s.logs.push(t), s.deps)
  assert.ok(s.logs.some(t => /остановлен/.test(t)), s.logs.join('\n'))
  assert.equal(walks.length, 0)
  assert.deepEqual(s.a.commands, [])
})

test('open listing parsing: only the open order for the item', () => {
  const slot = (lore, name = 'spruce_log') => ({ slot: 3, name, lore })
  assert.deepEqual(openListing(slot(['$ 5.2 each', '41.1k/524k Delivered', 'Click to deliver items']), 'spruce_log'),
    { slot: 3, item: 'spruce_log', amount: 524000, delivered: 41100, priceTenths: 52 })
  assert.equal(openListing(slot(['$ 5.2 each', '524k/524k Delivered']), 'spruce_log'), null)
  assert.equal(openListing(slot(['$ 5.2 each', '1/5 Delivered'], 'oak_log'), 'spruce_log'), null)
})

test('openBuyerOrder: /orders <nick>, clicks the open order, waits for Deliver Items', async () => {
  const listing = { kind: 'window', title: 'Orders (Page 1)', ref: {}, slots: [
    { slot: 0, name: 'spruce_log', displayName: 'Spruce Logs', lore: ['$ 149 each', '576/576 Delivered'] },
    { slot: 1, name: 'spruce_log', displayName: 'Spruce Logs', lore: ['$ 5.2 each', '41.1k/524k Delivered'] },
    { slot: 47, name: 'hopper', displayName: 'Filter', lore: [] }
  ] }
  const commands = []; const clicks = []
  const ui = {
    check () {}, pause: async () => {},
    command: async text => { commands.push(text); return listing },
    click: async (screen, slot) => { clicks.push(slot); return 'before' },
    wait: async p => { const s = { kind: 'window', title: 'Orders -> Deliver Items', slots: [] }; assert.ok(p(s)); return s }
  }
  const found = await openBuyerOrder(ui, 'Dan13lCBT', 'spruce_log')
  assert.deepEqual(commands, ['/orders Dan13lCBT'])
  assert.deepEqual(clicks, [1])
  assert.equal(found.order.amount, 524000)
  assert.equal(await openBuyerOrder({ ...ui, command: async () => ({ ...listing, slots: [listing.slots[0]] }) }, 'Dan13lCBT', 'spruce_log'), null)
})

test('order matching checks price, total, progress and known owner', () => {
  const order = { item: 'spruce_log', amount: 69, delivered: 1, priceTenths: 56 }
  const slot = { name: 'spruce_log', lore: ['$ 5.6 each', '1/69 Delivered', 'Owner: Buyer'] }
  assert.equal(matchesOrder(slot, order, 'Buyer'), true)
  for (const lore of [['$ 5.64 each', '1/69 Delivered'], ['$ 5.6 each', '0/69 Delivered'], ['$ 5.6 each', '1/70 Delivered'], ['$ 5.6 each', '1/69 Delivered', 'Owner: Other']]) {
    assert.equal(matchesOrder({ ...slot, lore }, order, 'Buyer'), false)
  }
  const screen = { kind: 'dialog', title: 'Review Order', body: 'Item: Spruce Log Amount: 69 Price: $ 5.6 each Total: $ 386.4' }
  verifyReview(screen, order, 'Spruce Log')
  assert.throws(() => verifyReview({ ...screen, body: screen.body.replace('69', '690') }, order, 'Spruce Log'))
})

test('findOrder (full listing fallback) cycles sort modes until the order is on page 1', async () => {
  const filter = { slot: 47, name: 'hopper', displayName: 'Filter', lore: ['Click to change', '▪ Most Per Item', '▪ Most Paid', '▪ Recently Listed'] }
  const listing = (slot, lore) => ({ slot, name: 'spruce_log', displayName: 'Spruce Logs', lore })
  const page = rows => ({ kind: 'window', title: 'Orders (Page 1)', slots: [...rows.map((l, i) => listing(i, l)), filter] })
  const screens = [
    page([['$ 96.1 each', '3.5m/5m Delivered']]),
    page([['$ 5.3 each', '0/73 Delivered']])
  ].map(s => ({ ...s, ref: s }))
  let i = 0; const clicks = []
  const ui = {
    command: async text => { if (text.startsWith('/orders ')) throw new Error('unknown command'); return screens[0] },
    pause: async () => {}, check () {},
    click: async (screen, slot) => {
      clicks.push(slot)
      if (slot === 47) i = (i + 1) % screens.length
      else screens[i] = { kind: 'window', title: 'Orders -> Deliver Items', slots: [], ref: {} }
      return JSON.stringify(screen)
    },
    wait: async p => { const v = p(screens[i]); assert.ok(v); return v === true ? screens[i] : v },
    advance: async () => { throw new Error('no next page') }
  }
  const screen = await findOrder(ui, { item: 'spruce_log', amount: 73, delivered: 0, priceTenths: 53 }, 'Buyer')
  assert.equal(screen.title, 'Orders -> Deliver Items')
  assert.deepEqual(clicks, [47, 0])
})

test('abbreviated counts and own big order recognition', () => {
  assert.deepEqual(parseCount('512k'), { value: 512000, tolerance: 1000 })
  assert.deepEqual(parseCount('2.3k'), { value: 2300, tolerance: 100 })
  assert.deepEqual(parseCount('1,234'), { value: 1234, tolerance: 0 })
  const slot = lore => ({ name: 'spruce_log', lore })
  assert.deepEqual(ownBigOrder(slot(['512k requested', '$ 5.4 each', '1.8k/512k Delivered']), 'spruce_log'),
    { item: 'spruce_log', amount: 512000, priceTenths: 54, delivered: 1800 })
  assert.equal(ownBigOrder(slot(['$ 95 each', '0/512k Delivered']), 'spruce_log'), null)
})

test('chest mode without start/end signs stops before anything else', async () => {
  const s = setup()
  s.deps.walk = async () => {}
  s.deps.storageArea = () => { throw new Error('нужно ровно по одной табличке') }
  await runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests'], t => s.logs.push(t), s.deps)
  assert.equal(s.calls.filter(c => c[0] !== 'open').length, 0)
  assert.ok(s.logs.some(t => /табличке/.test(t)), s.logs.join('\n'))
})

test('chest mode remembers emptied containers across runs; reset forgets them', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botify-chests-'))
  const memoryFile = path.join(dir, 'transfer-chests.json')
  try {
    const seen = []
    const run = async (...extra) => {
      const s = setup()
      Object.assign(s.deps, { walk: async () => {}, memoryFile })
      s.deps.fill = async ({ inst, emptied, skipped }) => {
        if (inst.acc.username === 'SellerA') seen.push([...emptied].sort())
        emptied.add('1,0,0'); emptied.add('3,0,0'); skipped.set('5,0,0', 2) // 5 failed to open — not remembered
        return { taken: 0, exhausted: true }
      }
      await runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests', ...extra], t => s.logs.push(t), s.deps)
      return s.logs
    }
    await run()
    const logs = await run()
    await run('reset')
    assert.deepEqual(seen, [[], ['1,0,0', '3,0,0'], []])
    assert.ok(logs.some(t => /2 уже проверены пустыми/.test(t)), logs.join('\n'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('argument validation', async () => {
  const s = setup()
  await assert.rejects(runTransfer(s.manager, ['spruce_log', 'Buyer', 'boxes'], () => {}, s.deps), /\.transfer/)
  await assert.rejects(runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests', '200'], () => {}, s.deps), /радиус/)
  await assert.rejects(runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests'], () => {}, { ...s.deps, walk: undefined }), /ходьбы/)
  await assert.rejects(runTransfer(s.manager, ['spruce_log', 'bad name!'], () => {}, s.deps), /ник/)
})

test('closeScreens keeps closing until the server stops re-opening menus (Orders page after a delivery)', async () => {
  const { closeScreens } = require('../src/order-chests')
  let reopen = 2; const closed = []
  const bot = { currentWindow: { title: 'Deliver Items' } }
  bot.closeWindow = async w => {
    closed.push(w.title); bot.currentWindow = null
    if (reopen-- > 0) setTimeout(() => { bot.currentWindow = { title: 'Orders (Page 1)' } }, 150)
  }
  await closeScreens({ bot }, new AbortController().signal, { quiet: 400 })
  assert.deepEqual(closed, ['Deliver Items', 'Orders (Page 1)', 'Orders (Page 1)'])
  assert.equal(bot.currentWindow, null)
})
