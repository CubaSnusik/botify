'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { equipDigTool } = require('../src/dig-tool')

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
