'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { itemEnchantments } = require('../src/item-enchantments')
const { destroyProgress, ticksToBreak, attributeValue, attachVanillaDigSpeed } = require('../src/dig-speed')

const registry = require('prismarine-registry')('26.1')
const Block = require('prismarine-block')(registry)
const block = name => Block.fromStateId(registry.blocksByName[name].defaultState, 0)
const item = (name, extra = {}) => ({ name, type: registry.itemsByName[name].id, ...extra })

function bot ({ held = null, attributes = undefined, onGround = true, effects = {}, eye = null } = {}) {
  return {
    registry,
    game: { gameMode: 'survival' },
    heldItem: held,
    inventory: { slots: [] },
    entity: { onGround, effects, attributes },
    _getBlockAtEyeLevel: () => eye
  }
}

const ticks = (b, name) => ticksToBreak(destroyProgress(b, block(name)))

test('vanilla break times: hand, axe, pickaxe', () => {
  assert.equal(ticks(bot({ held: item('netherite_axe') }), 'oak_log'), 7) // 9 / 2 / 30 = 0.15 per tick
  assert.equal(ticks(bot({ held: item('diamond_pickaxe') }), 'stone'), 6) // 8 / 1.5 / 30
  assert.equal(ticks(bot({ held: item('wooden_pickaxe') }), 'stone'), 23) // 2 / 1.5 / 30
  assert.equal(ticks(bot(), 'oak_log'), 61) // bare hand: 1 / 2 / 30, float32 sum of 60 steps is just under 1
  assert.equal(ticks(bot(), 'stone'), 151) // wrong tool: 1 / 1.5 / 100, float32 again
  assert.equal(ticks(bot({ held: item('netherite_axe'), onGround: false }), 'oak_log'), 34) // airborne / 5
})

test('Efficiency comes from the server attribute, not from guessed enchantment ids', () => {
  const eff5 = { enchants: { enchantments: [{ id: registry.enchantmentsByName.efficiency.id, level: 5 }] } }
  // attribute sent by the server (Efficiency V → +26) — what the server itself checks
  const synced = { mining_efficiency: { value: 0, modifiers: [{ uuid: 'minecraft:enchantment.efficiency/mainhand', amount: 26, operation: 0 }] } }
  assert.equal(ticks(bot({ held: item('netherite_axe', eff5), attributes: synced }), 'oak_log'), 2) // 35 / 2 / 30
  // the server says there is no efficiency bonus → none, whatever the item data claims
  assert.equal(ticks(bot({ held: item('netherite_axe', eff5), attributes: { mining_efficiency: { value: 0, modifiers: [] } } }), 'oak_log'), 7)
  // no attribute at all (old server) → fall back to the enchantment
  assert.equal(ticks(bot({ held: item('netherite_axe', eff5) }), 'oak_log'), 2)
  // efficiency never applies to a wrong tool
  assert.equal(ticks(bot({ held: item('stick'), attributes: synced }), 'oak_log'), 61)
})

test('block_break_speed, haste, fatigue and water follow Player#getDestroySpeed', () => {
  const held = item('netherite_axe')
  assert.equal(ticks(bot({ held, attributes: { 'player.block_break_speed': { value: 1, modifiers: [{ amount: -0.5, operation: 2 }] } } }), 'oak_log'), 14)
  const haste = registry.effectsByName.Haste.id
  assert.equal(ticks(bot({ held, effects: { [haste]: { amplifier: 1 } } }), 'oak_log'), 5) // 9 * 1.4 / 60
  const fatigue = registry.effectsByName.MiningFatigue.id
  assert.equal(ticks(bot({ held, effects: { [fatigue]: { amplifier: 0 } } }), 'oak_log'), 23) // 9 * 0.3 / 60
  const water = block('water')
  assert.equal(ticks(bot({ held, eye: water }), 'oak_log'), 34) // submerged default 0.2
  assert.equal(ticks(bot({ held, eye: water, attributes: { submerged_mining_speed: { value: 0.2, modifiers: [{ amount: 0.8, operation: 0 }] } } }), 'oak_log'), 7)
})

test('attribute modifiers combine like AttributeInstance#calculateValue', () => {
  const entity = { attributes: { 'minecraft:mining_efficiency': { value: 1, modifiers: [{ amount: 2, operation: 0 }, { amount: 0.5, operation: 1 }, { amount: 1, operation: 'add_multiplied_total' }] } } }
  assert.equal(attributeValue(entity, 'mining_efficiency'), (3 + 1.5) * 2)
  assert.equal(attributeValue({ attributes: {} }, 'mining_efficiency'), null)
})

test('bot.digTime is replaced with the vanilla calculation', () => {
  const b = bot({ held: item('netherite_axe') })
  attachVanillaDigSpeed(b)
  assert.equal(b.digTime(block('oak_log')), 350)
  assert.ok(Math.abs(b.digTime(block('oak_log'), true) - 0.15) < 1e-6)
  assert.equal(b.digTime(block('bedrock')), Infinity)
  b.game.gameMode = 'creative'
  assert.equal(b.digTime(block('oak_log')), 0)
})

test('a custom axe uses its tool component rather than the ordinary netherite multiplier', () => {
  const custom = item('netherite_axe', { components: [{ type: 'tool', data: {
    defaultMiningSpeed: 1,
    rules: [{ blocks: { ids: [registry.blocksByName.oak_log.id] }, speed: 2 }]
  } }] })
  assert.equal(ticks(bot({ held: custom }), 'oak_log'), 30)
  // No matching rule: default 1, no efficiency bonus on an ineffective tool.
  assert.equal(ticks(bot({ held: custom }), 'spruce_log'), 61)
  custom.components[0].data.rules[0].speed = 0
  assert.equal(ticks(bot({ held: custom }), 'oak_log'), Infinity)
})

test('tool rules resolve server block tags and reset across server configuration', () => {
  const b = bot({ held: item('netherite_axe', { components: [{ type: 'tool', data: {
    defaultMiningSpeed: 1,
    rules: [{ blocks: { name: 'minecraft:mineable/axe' }, speed: 2 }]
  } }] }) })
  b._client = new EventEmitter()
  attachVanillaDigSpeed(b)
  b._client.emit('tags', { tags: [{ tagType: 'minecraft:block', tags: [
    { tagName: 'minecraft:mineable/axe', entries: [registry.blocksByName.oak_log.id] }
  ] }] })
  assert.equal(ticks(b, 'oak_log'), 30)
  b._client.emit('start_configuration')
  assert.equal(ticks(b, 'oak_log'), 61)
})

test('tool speed and correct-drop rules are independent; removed tool means hand speed', () => {
  const b = bot({ held: item('netherite_pickaxe', { components: [{ type: 'tool', data: {
    defaultMiningSpeed: 1,
    rules: [
      { blocks: { ids: [registry.blocksByName.stone.id] }, correctDropForBlocks: false },
      { blocks: { ids: [registry.blocksByName.stone.id] }, speed: 9, correctDropForBlocks: true }
    ]
  } }] }) })
  assert.equal(ticks(b, 'stone'), 17) // 9 / 1.5 / 100, first drop rule wins.
  b.heldItem = item('netherite_axe', { removedComponents: [{ type: 'tool' }] })
  assert.equal(ticks(b, 'oak_log'), 61)
})

test('custom server enchantment IDs do not get mistaken for vanilla Efficiency', () => {
  const efficiencyId = registry.enchantmentsByName.efficiency.id
  const b = bot({ held: item('netherite_axe', { enchants: { enchantments: [{ id: efficiencyId, level: 5 }] } }) })
  b._client = new EventEmitter()
  attachVanillaDigSpeed(b)
  const entries = Array.from({ length: efficiencyId + 2 }, (_, id) => ({ key: `example:custom_${id}`, value: null }))
  entries[efficiencyId].key = 'example:tree_feller'
  entries[efficiencyId + 1].key = 'minecraft:efficiency'
  b._client.emit('registry_data', { id: 'minecraft:enchantment', entries })
  assert.equal(itemEnchantments(b, b.heldItem)[0].name, 'example:tree_feller')
  assert.equal(ticks(b, 'oak_log'), 7, 'tree-felling lore/enchantment alone is not an efficiency bonus')
  b.heldItem.enchants.enchantments.push({ id: efficiencyId + 1, level: 5 })
  assert.equal(ticks(b, 'oak_log'), 2, 'use Efficiency under its server ID')
  b.entity.attributes = { mining_efficiency: { value: 0, modifiers: [] } }
  assert.equal(ticks(b, 'oak_log'), 7, 'explicit server attribute still takes priority')
  b._client.emit('start_configuration')
  assert.equal(b._botifyEnchantments, null)
})

test('unknown server enchantment IDs remain unknown; legacy named enchantments still work', () => {
  const b = bot()
  b._botifyEnchantments = []
  assert.equal(itemEnchantments(b, { enchants: { enchantments: [{ id: 0, level: 1 }] } })[0].name, null)
  b.heldItem = item('netherite_axe', { enchants: [{ name: 'minecraft:efficiency', lvl: 5 }] })
  assert.equal(ticks(b, 'oak_log'), 2)
})
