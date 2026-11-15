'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const nbt = require('prismarine-nbt')
const { signLines, componentText } = require('../src/sign-text')
const { signMatches, supplyContainers } = require('../src/auto-tree-farm')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const Block = require('prismarine-block')(registry)

test('modern NBT sign components are decoded on both sides rather than joined as objects', () => {
  const sign = Block.fromProperties('oak_wall_sign', { facing: 'north', waterlogged: false }, 0)
  sign.entity = nbt.comp({
    front_text: nbt.comp({ messages: nbt.list(nbt.comp([{ text: nbt.string('') }, { text: nbt.string('§a1'), bold: nbt.byte(1) }])) }),
    back_text: nbt.comp({ messages: nbt.list(nbt.comp([{ text: nbt.string(''), extra: nbt.list(nbt.comp([{ text: nbt.string('2') }])) }])) })
  })
  assert.match(sign.getSignText()[0], /object Object/)
  assert.deepEqual(signLines(sign), ['1', '2'])
  assert.equal(signMatches(sign, '1'), true)
  assert.equal(signMatches(sign, '12'), false)
})

test('plain modern strings, mixed-list wrappers and legacy JSON sign text remain supported', () => {
  assert.deepEqual(signLines({ entity: nbt.comp({ front_text: nbt.comp({ messages: nbt.list(nbt.string(['', ' 1 ', '', ''])) }) }) }), ['1'])
  assert.deepEqual(signLines({ entity: nbt.comp({ Text1: nbt.string('{"text":"1"}'), Text2: nbt.string('"2"'), Text3: nbt.string('') }) }), ['1', '2'])
  assert.equal(componentText({ '': '1' }), '1')
  assert.equal(componentText([{ text: 'mu' }, { text: 'ka' }]), 'muka')
  assert.deepEqual(signLines({ getSignText () { throw new Error('malformed text') } }), [])
})

test('live server sign format: numeric translation keys mixed with unnamed empty components', () => {
  const World = require('prismarine-world')(registry)
  const Chunk = require('prismarine-chunk')(registry)
  const world = new World(null, null, 0).sync
  const p = new Vec3(-16887, 69, 116092)
  world.setColumn(p.x >> 4, p.z >> 4, new Chunk({ minY: 0, worldHeight: 256 }))
  const sign = Block.fromProperties('spruce_wall_sign', { facing: 'east', waterlogged: false }, 0)
  for (const [label, pos, container] of [['1', p, 'chest'], ['2', p.offset(0, 0, -1), 'purple_shulker_box']]) {
    world.setBlockStateId(pos, sign.stateId)
    world.setBlockStateId(pos.offset(-1, 0, 0), registry.blocksByName[container].defaultState)
    const side = () => nbt.comp({ color: nbt.string('black'), has_glowing_text: nbt.byte(0),
      messages: nbt.list(nbt.comp([{ translate: nbt.string(label) }, ...Array.from({ length: 3 }, () => ({ '': nbt.string('') }))])) })
    world.getColumn(pos.x >> 4, pos.z >> 4).setBlockEntity(new Vec3(pos.x & 15, pos.y, pos.z & 15),
      nbt.comp({ front_text: side(), back_text: side(), is_waxed: nbt.byte(0) }))
    assert.deepEqual(signLines(world.getBlock(pos)), [label, label])
  }
  const bot = { registry, entity: { position: p.offset(2, 0, 0) },
    findBlocks: () => [p, p.offset(0, 0, -1)], blockAt: pos => world.getBlock(pos) }
  assert.equal(supplyContainers(bot, '1', 32)[0].name, 'chest')
  assert.equal(supplyContainers(bot, '2', 32)[0].name, 'purple_shulker_box')
  assert.deepEqual(supplyContainers(bot, '3', 32), [])
})

test('translation fallbacks, arguments and extra text preserve the displayed label', () => {
  assert.equal(componentText({ translate: 'server.stock', fallback: '%2$s%1$s%%', with: [{ text: '2' }, { translate: '1' }], extra: [{ text: '!' }] }), '12%!')
  assert.equal(componentText({ translate: '%s', with: [{ translate: '1' }] }), '1')
  assert.equal(componentText({ translate: 'server.stock', fallback: '' }), '')
  assert.equal(componentText({ translate: '%s' }), '%s')
})

test('scan associates a modern component label with its attached shulker and diagnoses missing labels separately', () => {
  const sign = Block.fromProperties('oak_wall_sign', { facing: 'west', waterlogged: false }, 0)
  sign.position = new Vec3(0, 64, 0)
  sign.entity = nbt.comp({ front_text: nbt.comp({ messages: nbt.list(nbt.comp([{ text: nbt.string('1') }])) }) })
  const shulker = Block.fromStateId(registry.blocksByName.purple_shulker_box.defaultState)
  shulker.position = new Vec3(1, 64, 0)
  const bot = { registry, entity: { position: new Vec3(0, 64, -1) }, findBlocks: () => [sign.position],
    blockAt: p => p.equals(sign.position) ? sign : p.equals(shulker.position) ? shulker : null }
  const report = {}
  assert.deepEqual(supplyContainers(bot, '1', 32, report), [shulker])
  assert.equal(report.matches, 1)
  assert.match(report.samples[0], /^1 @/)
  assert.deepEqual(supplyContainers(bot, '3', 32, report), [])
  assert.equal(report.matches, 0)
  shulker.name = 'stone'
  assert.deepEqual(supplyContainers(bot, '1', 32, report), [])
  assert.equal(report.matches, 1, 'label was decoded but its backing block is not a container')
})
