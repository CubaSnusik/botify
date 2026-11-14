'use strict'
require('../scripts/patch-digging')()
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')

function fixture (t, { waitTime = 400, mode = 'survival' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.state = 'play'
  bot.game = { gameMode: mode }
  const block = { name: 'black_terracotta', type: 42, stateId: 123, position: new Vec3(-14, 85, -58) }
  let current = block
  const packets = []
  let localChanges = 0
  bot._client.write = (name, params) => packets.push({ name, params: structuredClone(params) })
  bot.swingArm = () => bot._client.write('arm_animation', { hand: 0 })
  bot._updateBlockState = (pos, stateId) => {
    localChanges++
    const old = current
    current = { ...block, name: 'air', type: 0, stateId }
    bot.emit(`blockUpdate:${pos}`, old, current)
  }
  bot.blockAt = () => current
  require('mineflayer/lib/plugins/digging')(bot)
  bot.digTime = (_block, asProgress = false) => asProgress ? (waitTime ? 50 / waitTime : 1) : waitTime
  const serverUpdate = (type = 0) => {
    const old = current
    current = { ...block, type, name: type === 0 ? 'air' : block.name }
    bot.emit(`blockUpdate:${block.position}`, old, current)
  }
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { bot.emit('physicsTick'); t.mock.timers.tick(50) } }
  return { bot, block, packets, serverUpdate, tick, localChanges: () => localChanges }
}

test('idle disconnect and configuration changes do not throw or send dig packets', t => {
  const f = fixture(t)
  assert.doesNotThrow(() => f.bot._client.emit('start_configuration'))
  assert.doesNotThrow(() => f.bot.emit('end'))
  assert.equal(f.packets.length, 0)
})

test('survival finish has a hand swing in its own movement tick', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  digging.catch(() => {})
  for (let tick = 0; tick < 10; tick++) {
    f.tick()
    const breaks = f.packets.filter(p => p.name === 'block_dig' && p.params.status !== 1)
    if (breaks.length) assert.ok(f.packets.some(p => p.name === 'arm_animation'), `missing swing in tick ${tick}`)
    f.packets.length = 0
  }
  f.serverUpdate()
  await digging
})

test('digging does not manufacture air or finish before a server block update', async t => {
  const f = fixture(t)
  let complete = false
  const digging = f.bot.dig(f.block, 'ignore').then(() => { complete = true })
  digging.catch(() => {})
  f.tick(8)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(f.localChanges(), 0)
  assert.equal(complete, false)
  assert.equal(f.bot.blockAt(f.block.position).type, f.block.type)
  f.serverUpdate()
  await digging
  assert.equal(complete, true)
  assert.equal(f.bot.listenerCount(`blockUpdate:${f.block.position}`), 0)
})

test('server rejection times out without reporting success or retaining listeners', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  const rejected = assert.rejects(digging, /не подтвердил|confirm/i)
  f.tick(8)
  f.serverUpdate(f.block.type)
  t.mock.timers.tick(5000)
  await rejected
  assert.equal(f.bot.listenerCount(`blockUpdate:${f.block.position}`), 0)
  assert.equal(f.bot.targetDigBlock, null)
  assert.equal(f.localChanges(), 0)
})

test('creative sends a start and swing, without a survival finish packet', async t => {
  const f = fixture(t, { waitTime: 0, mode: 'creative' })
  const digging = f.bot.dig(f.block, 'ignore')
  digging.catch(() => {})
  t.mock.timers.tick(50)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0])
  assert.ok(f.packets.some(p => p.name === 'arm_animation'))
  f.serverUpdate()
  await digging
})

test('cancellation while waiting for confirmation rejects and removes the confirmation timer', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  const rejected = assert.rejects(digging, /aborted/i)
  f.tick(8)
  f.bot.stopDigging()
  await rejected
  const sent = f.packets.length
  t.mock.timers.tick(6000)
  assert.equal(f.packets.length, sent)
  assert.equal(f.bot.listenerCount(`blockUpdate:${f.block.position}`), 0)
})

test('disconnect during digging rejects without writing another packet', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  const rejected = assert.rejects(digging, /соединение закрыто/)
  const sent = f.packets.length
  f.bot.emit('end')
  await rejected
  t.mock.timers.tick(6000)
  assert.equal(f.packets.length, sent)
  assert.equal(f.bot.listenerCount(`blockUpdate:${f.block.position}`), 0)
})

test('server breaking the block before the local timer does not send a later finish', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  t.mock.timers.tick(50)
  f.serverUpdate()
  await digging
  t.mock.timers.tick(6000)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0])
})

test('elapsed wall time cannot finish a block without client ticks', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore', 0)
  t.mock.timers.tick(4000)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0])
  assert.equal(f.packets[0].params.face, 0, 'bottom face is not replaced by the top face')
  for (let i = 0; i < 8; i++) {
    f.packets.length = 0
    f.tick()
    assert.equal(f.packets.filter(p => p.name === 'arm_animation').length, 1, 'swing on every mining tick')
  }
  assert.equal(f.packets.find(p => p.name === 'block_dig').params.status, 2)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  f.serverUpdate()
  await digging
})

test('mining recomputes damage after a change in water/ground speed', async t => {
  const f = fixture(t)
  let progress = 0.25
  f.bot.digTime = (_block, asProgress) => asProgress ? progress : 200
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick(2)
  progress = 0.05
  f.tick(9)
  assert.equal(f.packets.some(p => p.name === 'block_dig' && p.params.status === 2), false)
  f.tick(2)
  assert.equal(f.packets.some(p => p.name === 'block_dig' && p.params.status === 2), true)
  f.serverUpdate()
  await digging
})

test('leaving the target cancels digging and cannot send a later STOP', async t => {
  const f = fixture(t)
  f.bot.blockAtCursor = () => null
  const digging = f.bot.dig(f.block, 'ignore', 3)
  const rejected = assert.rejects(digging, /прицел/)
  f.tick(10)
  await rejected
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 1])
  assert.equal(f.packets.find(p => p.name === 'block_dig' && p.params.status === 1).params.face, 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('stone damage uses the unrounded tool rate, including water and airborne penalties', () => {
  const registry = require('prismarine-registry')('26.1')
  const Block = require('prismarine-block')(registry)
  const stone = Block.fromStateId(registry.blocksByName.stone.defaultState, 0)
  const tool = registry.itemsByName.diamond_pickaxe.id
  const damage = stone.digTime(tool, false, false, false, [], {}, true)
  assert.ok(Math.abs(damage - 8 / 1.5 / 30) < 1e-9)
  assert.ok(damage > 50 / stone.digTime(tool, false, false, false), 'damage is not derived from rounded milliseconds')
  assert.ok(Math.abs(stone.digTime(tool, false, true, true, [], {}, true) - damage / 25) < 1e-9)
})
