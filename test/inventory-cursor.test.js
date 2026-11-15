'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { clearCursor } = require('../src/inventory-cursor')

function fakeBot ({ full = false } = {}) {
  const slots = Array(46).fill(null)
  if (full) for (let s = 9; s <= 44; s++) slots[s] = { type: 2, name: 'dirt', count: 64, stackSize: 64, slot: s }
  const inventory = { slots, selectedItem: { type: 1, name: 'spruce_log', count: 64, stackSize: 64 } }
  const calls = []
  const bot = {
    inventory,
    currentWindow: null,
    waitForTicks: async () => {},
    _syncWindow: async () => { calls.push('sync') },
    clickWindow: async slot => {
      calls.push(`click ${slot}`)
      if (!slots[slot]) { slots[slot] = { ...inventory.selectedItem, slot }; inventory.selectedItem = null }
    },
    closeWindow: async () => {
      calls.push('close')
      if (full) inventory.selectedItem = null // server drops/places it back
    }
  }
  return { bot, calls }
}

test('cursor stack goes back into its original slot', async () => {
  const { bot, calls } = fakeBot()
  assert.strictEqual(await clearCursor(bot, { preferSlot: 20 }), true)
  assert.strictEqual(bot.inventory.slots[20].name, 'spruce_log')
  assert.deepStrictEqual(calls, ['sync', 'click 20', 'close'])
})

test('full inventory falls back to closing it so the server takes the cursor', async () => {
  const { bot, calls } = fakeBot({ full: true })
  assert.strictEqual(await clearCursor(bot, { preferSlot: 20 }), true)
  assert.ok(calls.includes('close'))
  assert.ok(!calls.some(c => c.startsWith('click')))
})

test('an open container window is never touched', async () => {
  const { bot, calls } = fakeBot()
  bot.currentWindow = { id: 3 }
  assert.strictEqual(await clearCursor(bot), false)
  assert.deepStrictEqual(calls, [])
})

test('26.1 window_click writes empty stacks as absent, like the vanilla client', () => {
  const { vanillaClick } = require('../src/vanilla')
  const mc = require('minecraft-protocol')
  const ser = mc.createSerializer({ state: 'play', isServer: false, version: '26.1' })
  const empty = { itemCount: 0, components: [], removeComponents: [] }
  const log = { itemId: 1, itemCount: 3, components: [], removeComponents: [] }
  const packet = vanillaClick({ windowId: 0, stateId: 5, slot: 40, mouseButton: 1, mode: 4,
    changedSlots: [{ location: 40, item: empty }, { location: 9, item: log }], cursorItem: empty })
  assert.strictEqual(packet.changedSlots[0].item, undefined)
  assert.deepStrictEqual(packet.changedSlots[1].item, log)
  assert.strictEqual(packet.cursorItem, undefined)
  const hex = ser.createPacketBuffer({ name: 'window_click', params: packet }).toString('hex')
  // ... slot 40 absent (0028 00), slot 9 present (0009 01 ...), cursor absent (00)
  assert.ok(hex.includes('002800000901'), hex)
  assert.ok(hex.endsWith('00'), hex)
})

test('inventory clicks carry the inventory menu stateId, not the last container one (vanilla per-menu)', () => {
  const { EventEmitter } = require('node:events')
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.state = 'play'
  bot.version = '26.1'
  bot.game = { gameMode: 'survival' }
  const sent = []
  bot._client.write = (name, params) => sent.push({ name, params })
  require('../src/vanilla').attachVanillaTick(bot, { perTick: false, smoothLook: false })
  const c = bot._client
  c.emit('window_items', { windowId: 0, stateId: 7, items: [] })
  c.emit('open_window', { windowId: 3 })
  c.emit('window_items', { windowId: 3, stateId: 1, items: [] })
  c.emit('set_slot', { windowId: 3, stateId: 2, slot: 0 })
  c.emit('set_slot', { windowId: 5, stateId: 40, slot: 0 }) // not the open menu: ignored
  c.write('window_click', { windowId: 3, stateId: 99, slot: 0, mouseButton: 0, mode: 0, changedSlots: [] })
  c.write('close_window', { windowId: 3 })
  c.write('window_click', { windowId: 0, stateId: 2, slot: 13, mouseButton: 1, mode: 4, changedSlots: [] })
  const clicks = sent.filter(p => p.name === 'window_click').map(p => [p.params.windowId, p.params.stateId])
  assert.deepStrictEqual(clicks, [[3, 2], [0, 7]])
})
