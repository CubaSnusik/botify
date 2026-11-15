'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { newOrderSlot, createOrder } = require('../src/order-transfer-ui')
const free = slot => ({ slot, name: 'gray_stained_glass_pane', displayName: 'New Order', lore: ['Click to create new order'] })
const menu = slots => ({ kind: 'window', title: 'Orders -> Your Orders', slots })

test('Your Orders accepts 18 equivalent free slots from the server log', () => {
  const screen = menu(Array.from({ length: 18 }, (_, n) => free(n)))
  assert.equal(newOrderSlot(screen), 0)
  assert.equal(newOrderSlot(menu([null, { slot: 0, name: 'spruce_log', displayName: 'Spruce Log' }, free(7), free(2)])), 2)
})

test('occupied, locked and unrelated slots cannot create an order', () => {
  assert.throws(() => newOrderSlot(menu([{ ...free(0), name: 'red_stained_glass_pane', displayName: 'Max Orders' }])), /нет свободных/)
  assert.throws(() => newOrderSlot(menu([{ ...free(0), lore: ['Click to deliver items'] }])), /нет свободных/)
  assert.throws(() => newOrderSlot({ ...menu([free(0)]), title: 'Orders (Page 1)' }), /ожидалось/)
})

test('creation clicks one free slot and waits for Choose Item before proceeding', async () => {
  const yourOrders = menu([free(0), free(1)])
  const choose = { kind: 'dialog', title: 'Choose Item', inputs: [{ key: 'search', label: 'Search' }] }
  const amount = { kind: 'dialog', title: 'How many?', inputs: [{ key: 'amount', label: 'Amount' }] }
  const price = { kind: 'dialog', title: 'Price per item?', inputs: [{ key: 'price', label: 'Price' }] }
  const review = { kind: 'dialog', title: 'Review Order', body: 'Item: Spruce Log Amount: 73 Price: $ 5.6 each' }
  const clicks = []; let current = null
  const bot = new (require('node:events').EventEmitter)()
  const ui = {
    inst: { bot },
    command: async () => ({ kind: 'window', title: 'Orders (Page 1)' }),
    advance: async (screen, pattern) => {
      if (pattern.test('Search')) return choose
      if (pattern.test('Spruce Log')) return amount
      if (pattern.test('Next')) return price
      if (pattern.test('Review Order')) return review
      throw new Error('unexpected advance')
    },
    click: async (screen, slot) => {
      clicks.push([screen.title, slot])
      current = screen.title === 'Orders (Page 1)' ? yourOrders : screen === yourOrders ? choose : null
      if (screen === review && serverAccepts) bot.emit('messagestr', 'You ordered 73 Spruce Logs', 'system')
    },
    wait: async predicate => { assert.ok(predicate(current)); return current },
    button: () => 4
  }
  let serverAccepts = true
  await createOrder(ui, { item: 'spruce_log', amount: 73, priceTenths: 56 }, 'Spruce Log')
  assert.deepEqual(clicks, [['Orders (Page 1)', 4], ['Orders -> Your Orders', 0], ['Review Order', 4]])
  // Dialog closed without "You ordered" (e.g. no money) must not count as created.
  serverAccepts = false
  await assert.rejects(createOrder(ui, { item: 'spruce_log', amount: 73, priceTenths: 56 }, 'Spruce Log'))
  assert.equal(bot.listenerCount('messagestr'), 0)
})
