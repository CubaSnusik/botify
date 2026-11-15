'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { transferSupply, shuffledSupplies } = require('../src/auto-tree-farm')
const registry = require('prismarine-registry')('26.1')
const Item = require('prismarine-item')(registry)
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }

function fixture (t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const bot = new EventEmitter()
  Object.assign(bot, { version: '26.1', registry, supportFeature: registry.supportFeature, QUICK_BAR_START: 36,
    entity: {}, game: { gameMode: 'survival' }, _client: new EventEmitter() })
  const packets = []
  bot._client.write = (name, packet) => packets.push({ name, packet, time: Date.now() })
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true })
  const items = Array.from({ length: 63 }, () => Item.toNotch(null))
  for (const slot of [0, 7, 20]) items[slot] = Item.toNotch(new Item(registry.itemsByName.bone_meal.id, 64))
  items[5] = Item.toNotch(new Item(registry.itemsByName.diamond.id, 64))
  bot._client.emit('open_window', { windowId: 3, inventoryType: 2, windowTitle: 'Barrel' })
  bot._client.emit('window_items', { windowId: 3, stateId: 1, items, carriedItem: Item.toNotch(null) })
  return { bot, window: bot.currentWindow, packets, ac: new AbortController() }
}

async function finish (t, promise) {
  let done = false
  const observed = promise.finally(() => { done = true })
  observed.catch(() => {})
  for (let i = 0; i < 400 && !done; i++) { await flush(); t.mock.timers.tick(50); await flush() }
  assert.ok(done, 'operation must finish within the simulated time budget')
  return observed
}

test('real inventory plugin: random source stacks, correct click packets and >=200ms spacing', async t => {
  const f = fixture(t)
  t.mock.method(Math, 'random', () => 0)
  assert.equal(typeof f.window.inventoryItems, 'undefined', 'regression: this method does not exist')
  const selected = shuffledSupplies(f.window, 'bone_meal')
  const sourceSlots = selected.map(i => i.slot)
  assert.deepEqual(sourceSlots, [7, 20, 0])
  await finish(t, (async () => {
    for (const item of selected.slice(0, 2)) await transferSupply(f.bot, f.window, item, 64, f.ac.signal)
  })())
  const clicks = f.packets.filter(p => p.name === 'window_click')
  assert.deepEqual(clicks.map(p => p.packet.slot), sourceSlots.slice(0, 2))
  assert.ok(clicks.every(p => p.packet.mode === 1 && p.packet.windowId === 3))
  assert.ok(clicks[0].time - 1000 >= 200)
  assert.ok(clicks[1].time - clicks[0].time >= 200)
  assert.equal(f.window.items().filter(i => i.name === 'bone_meal').reduce((n, i) => n + i.count, 0), 128)
  assert.equal(f.window.slots[5].name, 'diamond')
  assert.equal(f.window.selectedItem, null)
})

test('partial stack uses paced clicks, exact amount and returns the cursor remainder', async t => {
  const f = fixture(t)
  let random = 0
  t.mock.method(Math, 'random', () => { random = random ? 0 : 0.999; return random })
  await finish(t, transferSupply(f.bot, f.window, f.window.slots[7], 16, f.ac.signal))
  const clicks = f.packets.filter(p => p.name === 'window_click')
  for (let i = 1; i < clicks.length; i++) assert.ok(clicks[i].time - clicks[i - 1].time >= 200)
  assert.ok(new Set(clicks.slice(1).map((p, i) => p.time - clicks[i].time)).size > 1)
  assert.equal(f.window.items().reduce((n, i) => n + i.count, 0), 16)
  assert.equal(f.window.slots[7].count, 48)
  assert.equal(f.window.selectedItem, null)
})

test('cancellation during the opening pause sends no inventory clicks', async t => {
  const f = fixture(t)
  const run = transferSupply(f.bot, f.window, f.window.slots[7], 64, f.ac.signal)
  const rejected = assert.rejects(run, /отменена/)
  await flush(); t.mock.timers.tick(100); f.ac.abort()
  await rejected; t.mock.timers.tick(1000); await flush()
  assert.equal(f.packets.filter(p => p.name === 'window_click').length, 0)
})

test('server reverting a transfer is reported instead of counted as supplies', async t => {
  const f = fixture(t)
  const write = f.bot._client.write
  f.bot._client.write = (name, packet) => {
    write(name, packet)
    if (name === 'window_click') {
      const items = Array.from({ length: 63 }, () => Item.toNotch(null))
      items[7] = Item.toNotch(new Item(registry.itemsByName.bone_meal.id, 64))
      f.bot._client.emit('window_items', { windowId: 3, stateId: 2, items, carriedItem: Item.toNotch(null) })
    }
  }
  const rejected = assert.rejects(transferSupply(f.bot, f.window, f.window.slots[7], 64, f.ac.signal), /не появились/)
  await finish(t, rejected)
  assert.equal(f.window.items().length, 0)
})
