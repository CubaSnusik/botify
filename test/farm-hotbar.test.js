'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createFarmHotbar } = require('../src/farm-hotbar')

function fixture () {
  const slots = Array(46).fill(null)
  const put = (slot, name, type, extra = {}) => { slots[slot] = { slot, name, type, count: 64, ...extra }; return slots[slot] }
  const axe = put(36, 'netherite_axe', 1, { customName: 'Shard Axe', count: 1 })
  for (let s = 37; s < 45; s++) put(s, 'dirt', 2)
  put(10, 'spruce_sapling', 3)
  put(11, 'bone_meal', 4)
  const moves = []; const packets = []; const waits = []; const messages = []
  const bot = {
    quickBarSlot: 0, heldItem: axe, currentWindow: null,
    supportFeature: () => false,
    inventory: { slots, selectedItem: null, items: () => slots.filter(Boolean) },
    _client: { write: (name, params) => packets.push({ name, params }) },
    updateHeldItem () { bot.heldItem = slots[36 + bot.quickBarSlot] },
    async moveSlotItem (from, to) {
      moves.push([from, to])
      const a = slots[from]; const b = slots[to]
      slots[to] = a; if (a) a.slot = to
      slots[from] = b; if (b) b.slot = from
      bot.updateHeldItem()
    },
    async closeWindow () {}
  }
  require('mineflayer/lib/plugins/simple_inventory')(bot)
  bot.equip = async () => assert.fail('farm must not use rotating equip eviction')
  const options = { checkCancel: () => {}, wait: async n => { waits.push(n) }, reply: text => messages.push(text) }
  return { bot, slots, axe, moves, packets, waits, messages, options, put }
}

test('a full hotbar reserves three roles without evicting the axe and switches by held_item_slot only', async () => {
  const f = fixture()
  const bar = createFarmHotbar(f.bot, 'spruce', f.options)
  await bar.select('sapling')
  await bar.select('meal')
  assert.equal(f.moves.length, 2)
  assert.equal(f.slots[36], f.axe)
  const saplingSlot = f.bot.inventory.items().find(i => i.name === 'spruce_sapling').slot
  const mealSlot = f.bot.inventory.items().find(i => i.name === 'bone_meal').slot
  assert.notEqual(saplingSlot, mealSlot)
  f.waits.length = 0; f.packets.length = 0
  for (const role of ['axe', 'sapling', 'meal', 'axe']) { await bar.select(role); assert.equal(bar.ready(role), true) }
  assert.equal(f.moves.length, 2, 'no inventory moves during the cycle')
  assert.deepEqual(f.waits, [1, 1, 1, 1], 'one tick per hotbar switch')
  assert.ok(f.packets.every(p => p.name === 'held_item_slot'))
  assert.equal(f.packets.length, 4)
  await bar.select('axe')
  assert.equal(f.packets.length, 4, 'already selected tool is not re-equipped')
  assert.equal(f.slots[36], f.axe)
})

test('refilling bone meal uses its reserved slot while the axe stays selected and in the hotbar', async () => {
  const f = fixture()
  const bar = createFarmHotbar(f.bot, 'spruce', f.options)
  await bar.select('meal')
  const reserved = f.bot.heldItem.slot
  await bar.select('axe')
  f.slots[reserved] = null
  f.put(15, 'bone_meal', 4)
  await bar.select('meal')
  assert.equal(f.bot.heldItem.slot, reserved)
  assert.equal(f.slots[36], f.axe)
  assert.deepEqual(f.moves.at(-1), [15, reserved])
})

test('a server slot correction is retried and a permanently wrong hand never becomes ready', async () => {
  for (const persistent of [false, true]) {
    const f = fixture()
    f.bot.setQuickBarSlot(1)
    let corrections = 0
    f.options.wait = async n => {
      if (n === 1 && (persistent || corrections === 0)) { corrections++; f.bot.setQuickBarSlot(1) }
    }
    const bar = createFarmHotbar(f.bot, 'spruce', f.options)
    if (persistent) {
      await assert.rejects(bar.select('axe'), /после 5 повторов/)
      assert.equal(bar.ready('axe'), false)
      assert.equal(f.messages.length, 5)
    } else {
      await bar.select('axe')
      assert.equal(bar.ready('axe'), true)
      assert.equal(f.messages.length, 1)
    }
    assert.equal(f.moves.length, 0)
  }
})

test('cancellation during slot settling stops before another selection or transfer', async () => {
  const f = fixture()
  f.bot.setQuickBarSlot(1)
  let cancelled = false
  f.options.checkCancel = () => { if (cancelled) throw new Error('cancelled') }
  f.options.wait = async () => { cancelled = true }
  const bar = createFarmHotbar(f.bot, 'spruce', f.options)
  await assert.rejects(bar.select('axe'), /cancelled/)
  assert.equal(f.moves.length, 0)
  assert.equal(f.messages.length, 0)
})
