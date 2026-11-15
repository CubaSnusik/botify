'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { receiptMatches, sellerReceiptMatches } = require('../src/order-delivery')
const { deliver } = require('../src/order-delivery')
const { EventEmitter } = require('node:events')

test('real inventory clicks stage exactly one item, Escape precedes confirmation, receipt required', async () => {
  const registry = require('prismarine-registry')('26.1')
  const windows = require('prismarine-windows')(registry)
  const Item = require('prismarine-item')(registry)
  const w = windows.createWindow(1, 'minecraft:generic_9x4', 'Orders -> Deliver Items')
  w.updateSlot(w.inventoryStart, new Item(registry.itemsByName.spruce_log.id, 64))
  w.updateSlot(w.inventoryStart + 1, new Item(registry.itemsByName.diamond.id, 4))
  const buyer = { bot: new EventEmitter() }
  const events = []
  let screen = { kind: 'window', title: w.title, ref: w }
  const bot = Object.assign(new EventEmitter(), {
    currentWindow: w,
    async clickWindow (slot, mouseButton, mode) {
      events.push('move')
      w.acceptClick({ slot, mouseButton, mode, item: w.slots[slot] })
    },
    async closeWindow () {
      events.push('escape')
      assert.equal(w.containerItems().reduce((n, i) => n + i.count, 0), 1)
      assert.equal(w.items().find(i => i.name === 'spruce_log').count, 63)
      assert.equal(w.items().find(i => i.name === 'diamond').count, 4)
      assert.equal(w.selectedItem, null)
      screen = { kind: 'window', title: 'Orders -> Confirm Delivery', slots: [
        { name: 'spruce_log', slot: 13 }, { name: 'lime_stained_glass_pane', slot: 15 }
      ] }
    }
  })
  const ui = {
    inst: { bot, acc: { username: 'Seller' } }, check () {}, pause: async () => {},
    wait: async predicate => { assert.ok(predicate(screen)); return screen },
    click: async (s, slot) => {
      assert.equal(events.at(-1), 'escape'); assert.equal(slot, 15)
      events.push('confirm'); buyer.bot.emit('messagestr', 'Seller delivered you 1 Spruce Log', 'system')
    }
  }
  assert.equal(await deliver(ui, buyer, 'spruce_log', 'Spruce Log', 1), 1)
  assert.equal(buyer.bot.listenerCount('messagestr'), 0)
  assert.equal(bot.listenerCount('messagestr'), 0)
  assert.equal(events.at(-1), 'confirm')
})

test('receipt requires exact seller, quantity and item from the supplied server message', () => {
  assert.equal(receiptMatches('KindaStraw98559 delivered you 1 Spruce Log', 'KindaStraw98559', 1, 'Spruce Log'), true)
  for (const text of ['You ordered 1 Spruce Log', 'Other delivered you 1 Spruce Log', 'KindaStraw98559 delivered you 2 Spruce Log', 'KindaStraw98559 delivered you 1 Oak Log', '<Player> KindaStraw98559 delivered you 1 Spruce Log']) {
    assert.equal(receiptMatches(text, 'KindaStraw98559', 1, 'Spruce Log'), false)
  }
  // Real bulk receipt from the server log uses the plural item name.
  assert.equal(receiptMatches('crzrr delivered you 72 Spruce Logs', 'crzrr', 72, 'Spruce Log'), true)
  assert.equal(receiptMatches('crzrr delivered you 72 Spruce Logs', 'crzrr', 73, 'Spruce Log'), false)
  // Real chest-mode receipt: 1855 logs reported as "1.8K".
  assert.equal(receiptMatches('crzrr delivered you 1.8K Spruce Logs', 'crzrr', 1855, 'Spruce Log'), true)
  assert.equal(receiptMatches('crzrr delivered you 2,304 Spruce Logs', 'crzrr', 2304, 'Spruce Log'), true)
  assert.equal(receiptMatches('crzrr delivered you 1.8K Spruce Logs', 'crzrr', 2304, 'Spruce Log'), false)
  assert.equal(receiptMatches('crzrr delivered you 1.8K Spruce Logs', 'crzrr', 1, 'Spruce Log'), false)
  // Seller-side fallback, real lines from the server log.
  assert.equal(sellerReceiptMatches('You delivered 72 Spruce Logs and received $ 388.8', 72, 'Spruce Log'), true)
  assert.equal(sellerReceiptMatches('You delivered 1.8K Spruce Logs and received $ 9.9K', 1855, 'Spruce Log'), true)
  assert.equal(sellerReceiptMatches('You delivered 72 Spruce Logs and received $ 388.8', 73, 'Spruce Log'), false)
  assert.equal(sellerReceiptMatches('<crzrr> You delivered 72 Spruce Logs and received $ 388.8', 72, 'Spruce Log'), false)
})
