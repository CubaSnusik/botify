'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { runTransfer } = require('../src/order-transfer')
const { matchesOrder, verifyReview, findOrder, parseCount, ownBigOrder } = require('../src/order-transfer-ui')

function setup () {
  const make = (username, count, host = 'example.test') => ({
    acc: { username }, state: 'online', task: null, holds: new Map(), update () {},
    cancelTask () { this.task?.ac.abort(); this.task = null }, server: () => ({ host }),
    bot: { registry: { itemsByName: { spruce_log: { displayName: 'Spruce Log' } } },
      inventory: { items: () => count ? [{ name: 'spruce_log', count }] : [] } }
  })
  const buyer = make('Buyer', 0)
  const a = make('SellerA', 64)
  const b = make('SellerB', 5)
  const manager = { bots: new Map([buyer, a, b, make('Elsewhere', 100, 'other.test')].map(i => [i.acc.username, i])) }
  const calls = []; const logs = []
  const deps = {
    makeUI: (inst, signal, check) => ({ inst, signal, check, wait: async p => { await Promise.resolve(); await Promise.resolve(); check(); assert.ok(p()) } }),
    createOrder: async (ui, order) => { calls.push(['create', { ...order }]) },
    findOwnOrder: async () => null,
    storageArea: () => ({ start: { x: 0, y: 0, z: 0 }, end: { x: 9, y: 4, z: 0 }, min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 4, z: 1 } }),
    findOrder: async (ui, order) => { ui.check(); calls.push(['find', order.delivered]) },
    deliver: async (ui, receiver, item, display, count) => { ui.check(); calls.push(['deliver', ui.inst.acc.username, count]) }
  }
  return { manager, buyer, a, calls, logs, deps }
}

test('one order for same-server sellers, individual probes precede bulk delivery', async () => {
  const s = setup()
  await runTransfer(s.manager, ['spruce_log', 'Buyer'], t => s.logs.push(t), s.deps)
  assert.equal(s.calls[0][1].amount, 69)
  assert.ok(s.calls[0][1].priceTenths >= 50 && s.calls[0][1].priceTenths <= 59)
  assert.deepEqual(s.calls.filter(c => c[0] === 'deliver'), [
    ['deliver', 'SellerA', 1], ['deliver', 'SellerA', 63], ['deliver', 'SellerB', 1], ['deliver', 'SellerB', 4]
  ])
  assert.deepEqual(s.calls.filter(c => c[0] === 'find').map(c => c[1]), [0, 1, 64, 65])
  assert.equal(s.buyer.task, null)
})

test('missing probe receipt prevents bulk delivery and releases all tasks', async () => {
  const s = setup()
  s.deps.deliver = async () => { s.calls.push(['probe']); throw new Error('receipt timeout') }
  await runTransfer(s.manager, ['spruce_log', 'Buyer'], t => s.logs.push(t), s.deps)
  assert.equal(s.calls.filter(c => c[0] === 'probe').length, 1)
  assert.ok(s.logs.some(t => t.includes('receipt timeout')))
  for (const inst of s.manager.bots.values()) assert.equal(inst.task, null)
})

test('stop on a seller cancels the shared operation before bulk', async () => {
  const s = setup()
  s.deps.deliver = async ui => { s.calls.push(['probe']); s.a.cancelTask(); ui.check() }
  await runTransfer(s.manager, ['spruce_log', 'Buyer'], t => s.logs.push(t), s.deps)
  assert.equal(s.calls.filter(c => c[0] === 'probe').length, 1)
  assert.equal(s.buyer.task, null)
})

test('order matching checks price, total, progress and known owner', () => {
  const order = { item: 'spruce_log', amount: 69, delivered: 1, priceTenths: 56 }
  const slot = { name: 'spruce_log', lore: ['$ 5.6 each', '1/69 Delivered', 'Owner: Buyer'] }
  assert.equal(matchesOrder(slot, order, 'Buyer'), true)
  for (const lore of [ ['$ 5.64 each', '1/69 Delivered'], ['$ 5.6 each', '0/69 Delivered'], ['$ 5.6 each', '1/70 Delivered'], ['$ 5.6 each', '1/69 Delivered', 'Owner: Other'] ]) {
    assert.equal(matchesOrder({ ...slot, lore }, order, 'Buyer'), false)
  }
  const screen = { kind: 'dialog', title: 'Review Order', body: 'Item: Spruce Log Amount: 69 Price: $ 5.6 each Total: $ 386.4' }
  verifyReview(screen, order, 'Spruce Log')
  assert.throws(() => verifyReview({ ...screen, body: screen.body.replace('69', '690') }, order, 'Spruce Log'))
})

// Real server: every sort mode shows the same «▪» bullet; the mode cycles
// Most Paid → Recently Listed → Most Per Item. The fresh order appears on page 1.
function sortedScreens (withOrder) {
  const filter = { slot: 47, name: 'hopper', displayName: 'Filter', lore: ['Click to change', '▪ Most Per Item', '▪ Most Paid', '▪ Recently Listed'] }
  const listing = (slot, lore) => ({ slot, name: 'spruce_log', displayName: 'Spruce Logs', lore })
  const page = rows => ({ kind: 'window', title: 'Orders (Page 1)', slots: [...rows.map((l, i) => listing(i, l)), filter] })
  return [
    page([['$ 96.1 each', '3.5m/5m Delivered'], ['$ 1 each', '192k/9.9m Delivered']]),
    page([withOrder ? ['$ 5.3 each', '0/73 Delivered'] : ['$ 9 each', '0/64 Delivered'], ['$ 100 each', '0/100k Delivered']]),
    page([['$ 112 each', '57.5k/100k Delivered'], ['$ 110 each', '19k/20k Delivered']])
  ].map(s => ({ ...s, ref: s }))
}

function fakeListUI (screens) {
  let i = 0; const clicks = []
  return {
    clicks,
    command: async text => { if (text.startsWith('/orders ')) throw new Error('unknown command'); return screens[0] },
    pause: async () => {},
    check () {},
    click: async (screen, slot) => {
      clicks.push(slot)
      if (slot === 47) i = (i + 1) % screens.length
      else screens[i] = { kind: 'window', title: 'Orders -> Deliver Items', slots: [], ref: {} }
      return JSON.stringify(screen)
    },
    wait: async p => { const v = p(screens[i]); assert.ok(v); return v === true ? screens[i] : v },
    advance: async () => { throw new Error('no next page') }
  }
}

test('findOrder cycles sort modes until the fresh order is on page 1', async () => {
  const ui = fakeListUI(sortedScreens(true))
  const order = { item: 'spruce_log', amount: 73, delivered: 0, priceTenths: 53 }
  const screen = await findOrder(ui, order, 'Buyer')
  assert.equal(screen.title, 'Orders -> Deliver Items')
  assert.deepEqual(ui.clicks, [47, 0])
})

test('findOrder stops cycling after all sort modes repeat', async () => {
  const ui = fakeListUI(sortedScreens(false))
  const order = { item: 'spruce_log', amount: 73, delivered: 0, priceTenths: 53 }
  await assert.rejects(findOrder(ui, order, 'Buyer'), /no next page/)
  // Three attempts (listing may lag), each cycling all three sort modes, then paging.
  assert.deepEqual(ui.clicks, Array(9).fill(47))
})

test('findOrder uses /orders <buyer> first: no sort cycling, retries while the listing lags', async () => {
  const listing = progress => ({ kind: 'window', title: 'Orders (Page 1)', ref: {}, slots: [
    { slot: 0, name: 'spruce_log', displayName: 'Spruce Logs', lore: ['$ 5.3 each', '0/73 Delivered'] },
    { slot: 1, name: 'spruce_log', displayName: 'Spruce Logs', lore: ['$ 5.4 each', `${progress}/512k Delivered`] }
  ] })
  const pages = [listing('1.8k'), listing('4.1k')] // first reply is stale
  const commands = []; const clicks = []
  const ui = {
    check () {}, pause: async () => {},
    command: async text => { commands.push(text); return pages.shift() },
    click: async (screen, slot) => { clicks.push(slot); return 'before' },
    wait: async () => ({ kind: 'window', title: 'Orders -> Deliver Items' })
  }
  const order = { item: 'spruce_log', amount: 512000, delivered: 4104, priceTenths: 54 }
  const screen = await findOrder(ui, order, 'Dan13lCBT')
  assert.equal(screen.title, 'Orders -> Deliver Items')
  assert.deepEqual(commands, ['/orders Dan13lCBT', '/orders Dan13lCBT'])
  assert.deepEqual(clicks, [1])
})

test('abbreviated counts: big chest-mode order matches, stale progress does not', () => {
  assert.deepEqual(parseCount('512k'), { value: 512000, tolerance: 1000 })
  assert.deepEqual(parseCount('2.3k'), { value: 2300, tolerance: 100 })
  assert.deepEqual(parseCount('1,234'), { value: 1234, tolerance: 0 })
  const order = { item: 'spruce_log', amount: 512000, delivered: 2305, priceTenths: 54 }
  const slot = lore => ({ name: 'spruce_log', lore: ['$ 5.4 each', lore, 'Click to deliver items'] })
  assert.equal(matchesOrder(slot('2.3k/512k Delivered'), order, 'Buyer'), true)
  assert.equal(matchesOrder(slot('1/512k Delivered'), order, 'Buyer'), false) // page from before the batch
  assert.equal(matchesOrder(slot('2.3k/513k Delivered'), order, 'Buyer'), false)
  assert.equal(matchesOrder(slot('2.3k/512k Delivered'), { ...order, priceTenths: 55 }, 'Buyer'), false)
  const review = { kind: 'dialog', title: 'Review Order', body: 'Item: Spruce Log Amount: 512,000 Price: $ 5.4 each Total: $ 2.7m' }
  verifyReview(review, order, 'Spruce Log')
})

test('chest mode: one big order, probe first, then a full inventory per trip until chests are empty', async () => {
  const s = setup()
  s.manager.bots.get('SellerB').bot.inventory.items = () => [] // still a seller in chest mode
  const stock = { SellerA: 64, SellerB: 0 }
  for (const name of ['SellerA', 'SellerB']) s.manager.bots.get(name).bot.inventory.items = () => stock[name] ? [{ name: 'spruce_log', count: stock[name] }] : []
  const trips = [2304, 2304, 500]
  s.deps.walk = async () => {}
  s.deps.fill = async ({ inst, emptied }) => {
    if (inst.acc.username !== 'SellerA' || !trips.length) return { taken: 0, exhausted: true }
    const taken = trips.shift(); stock.SellerA += taken
    if (!trips.length) emptied.add('last')
    return { taken, exhausted: !trips.length }
  }
  const deliver = s.deps.deliver
  s.deps.deliver = async (ui, receiver, item, display, count) => { await deliver(ui, receiver, item, display, count); stock[ui.inst.acc.username] -= count }
  await runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests', '16'], t => s.logs.push(t), s.deps)
  const order = s.calls[0][1]
  assert.ok(order.amount >= 400000 && order.amount <= 600000 && order.amount % 1000 === 0)
  assert.deepEqual(s.calls.filter(c => c[0] === 'deliver'), [
    ['deliver', 'SellerA', 1], ['deliver', 'SellerA', 63], ['deliver', 'SellerA', 2304], ['deliver', 'SellerA', 2304], ['deliver', 'SellerA', 500]
  ])
  assert.ok(s.logs.some(t => /остаётся открытым/.test(t)), s.logs.join('\n'))
})

test('chest mode continues an already open big order instead of creating a second one', async () => {
  const s = setup()
  s.deps.walk = async () => {}
  s.deps.findOwnOrder = async () => ({ item: 'spruce_log', amount: 512000, priceTenths: 54, delivered: 1800 })
  s.deps.fill = async () => ({ taken: 0, exhausted: true })
  s.deps.findOrder = async (ui, order) => { s.calls.push(['find', order.delivered]) }
  const stock = { SellerA: 64, SellerB: 5 }
  for (const name of ['SellerA', 'SellerB']) s.manager.bots.get(name).bot.inventory.items = () => stock[name] ? [{ name: 'spruce_log', count: stock[name] }] : []
  const deliver = s.deps.deliver
  s.deps.deliver = async (ui, ...rest) => { await deliver(ui, ...rest); stock[ui.inst.acc.username] -= rest.at(-1) }
  await runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests'], t => s.logs.push(t), s.deps)
  assert.equal(s.calls.filter(c => c[0] === 'create').length, 0)
  // SellerA: probe at 1800, rest at 1801; SellerB continues from 1864.
  assert.deepEqual(s.calls.filter(c => c[0] === 'find').map(c => c[1]), [1800, 1801, 1864, 1865])
  assert.ok(s.logs.some(t => /продолжаю открытый ордер 512k/.test(t)))
})

test('own big order is recognised in Your Orders; others are not', () => {
  const slot = lore => ({ name: 'spruce_log', lore })
  assert.deepEqual(ownBigOrder(slot(['512k requested', '$ 5.4 each', '1.8k/512k Delivered']), 'spruce_log'),
    { item: 'spruce_log', amount: 512000, priceTenths: 54, delivered: 1800 })
  for (const lore of [['$ 5.4 each', '0/73 Delivered'], ['$ 95 each', '0/512k Delivered'], ['$ 5.4 each', '512k/512k Delivered'], ['$ 5.45 each', '0/512k Delivered']]) {
    assert.equal(ownBigOrder(slot(lore), 'spruce_log'), null, lore.join(' '))
  }
  assert.equal(ownBigOrder(slot(['$ 5.4 each', '0/512k Delivered']), 'oak_log'), null)
})

test('chest mode without start/end signs stops before creating an order', async () => {
  const s = setup()
  s.deps.walk = async () => {}
  s.deps.storageArea = () => { throw new Error('нужно ровно по одной табличке') }
  await runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests'], t => s.logs.push(t), s.deps)
  assert.equal(s.calls.filter(c => c[0] === 'create').length, 0)
  assert.ok(s.logs.some(t => /start\/end/.test(t)), s.logs.join('\n'))
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

test('chest mode argument validation', async () => {
  const s = setup()
  await assert.rejects(runTransfer(s.manager, ['spruce_log', 'Buyer', 'boxes'], () => {}, s.deps), /usage|\.transfer/)
  await assert.rejects(runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests', '200'], () => {}, s.deps), /радиус/)
  await assert.rejects(runTransfer(s.manager, ['spruce_log', 'Buyer', 'chests'], () => {}, { ...s.deps, walk: undefined }), /ходьбы/)
})
