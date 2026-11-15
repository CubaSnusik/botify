'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { equipDigTool, equipWithRetries } = require('../src/dig-tool')

function fixture () {
  const actions = []
  const item = { type: 945, slot: 10 }
  const bot = {
    inventory: { id: 0, selectedItem: null }, quickBarSlot: 0,
    async equip (tool) { actions.push('equip'); bot.heldItem = tool },
    async closeWindow (window) { assert.equal(window, bot.inventory); actions.push('close') },
    async waitForTicks (n) { actions.push(`ticks:${n}`) }
  }
  return { bot, item, actions }
}

test('mining equip closes inventory clicks before waiting for the held item', async () => {
  const { bot, item, actions } = fixture()
  await equipDigTool(bot, item)
  assert.deepEqual(actions, ['equip', 'close', 'ticks:2'])
})

test('hotbar switching does not manufacture an inventory close', async () => {
  const { bot, item, actions } = fixture()
  item.slot = 38
  await equipDigTool(bot, item)
  assert.deepEqual(actions, ['equip', 'ticks:2'])
})

test('a server slot correction during equip prevents mining with the wrong item', async () => {
  const { bot, item } = fixture()
  bot.waitForTicks = async () => { bot.quickBarSlot = 4; bot.heldItem = null }
  await assert.rejects(equipDigTool(bot, item), /копание не начато/)
})

test('an open container or carried stack is left untouched', async () => {
  const { bot, item, actions } = fixture()
  bot.currentWindow = { id: 1 }
  await assert.rejects(equipDigTool(bot, item), /закрой/)
  bot.currentWindow = null
  bot.inventory.selectedItem = item
  await assert.rejects(equipDigTool(bot, item), /курсор/)
  assert.deepEqual(actions, [])
})

test('equipment retries refresh moved stacks and recover on the fifth retry', async () => {
  const { bot, item } = fixture()
  let attempts = 0; let waits = 0; let current = item
  const retries = []
  bot.equip = async tool => {
    assert.equal(tool, current)
    attempts++
    bot.heldItem = attempts < 6 ? null : tool
  }
  await equipWithRetries(bot, () => current, {
    checkCancel: () => {},
    wait: async () => { waits++; current = { ...item, slot: 36 + waits } },
    onRetry: (n, total) => retries.push([n, total])
  })
  assert.equal(attempts, 6)
  assert.equal(waits, 5)
  assert.deepEqual(retries, [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]])
})

test('equipment gives up after initial attempt plus five retries', async () => {
  const { bot, item } = fixture()
  let attempts = 0
  bot.equip = async () => { attempts++; throw new Error('slot rejected') }
  await assert.rejects(equipWithRetries(bot, () => item, {
    checkCancel: () => {}, wait: async () => {}, onRetry: () => {}
  }), /после 5 повторов.*slot rejected/)
  assert.equal(attempts, 6)
})

test('cancelling equipment retries prevents the next inventory action', async () => {
  const { bot, item } = fixture()
  let cancelled = false; let attempts = 0
  bot.equip = async () => { attempts++; throw new Error('slot rejected') }
  await assert.rejects(equipWithRetries(bot, () => item, {
    checkCancel: () => { if (cancelled) throw new Error('cancelled') },
    wait: async () => { cancelled = true }, onRetry: () => {}
  }), /cancelled/)
  assert.equal(attempts, 1)
})
