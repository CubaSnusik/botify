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
    bot.emit('blockUpdate', old, current)
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

function sequenced (f) {
  f.bot.version = '26.1'
  require('../src/vanilla').attachVanillaTick(f.bot, { perTick: false, smoothLook: false })
  return sequenceId => f.bot._client.emit('acknowledge_player_digging', { sequenceId })
}

test('prediction acknowledgements do not delay or accelerate a fast tool mining clock', async t => {
  const f = fixture(t, { waitTime: 100 })
  const ack = sequenced(f)
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick(2)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0])
  f.tick()
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2])
  ack(2) // Server may acknowledge both predictions together, after STOP.
  assert.equal(f.bot.targetDigBlock, f.block, 'ACK is not block destruction')
  f.serverUpdate()
  await digging
})

test('a delayed acknowledgement from the previous attempt cannot complete a new dig', async t => {
  const f = fixture(t, { waitTime: 100 })
  const ack = sequenced(f)
  const first = f.bot.dig(f.block, 'ignore')
  f.tick()
  ack(1)
  f.tick(2)
  f.serverUpdate()
  await first
  f.serverUpdate(f.block.type)
  const second = f.bot.dig(f.block, 'ignore')
  f.tick()
  ack(2) // delayed ACK for the preceding STOP, not the current START (sequence 3).
  f.tick()
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2, 0])
  ack(3)
  ack(1)
  f.tick()
  assert.equal(f.bot.targetDigBlock, f.block)
  f.serverUpdate()
  await second
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.sequence), [1, 2, 3, 4])
})

test('missing acknowledgements never stall damage; unconfirmed STOP times out and releases the block', async t => {
  const f = fixture(t, { waitTime: 100 })
  const ack = sequenced(f)
  const digging = f.bot.dig(f.block, 'ignore')
  const rejected = assert.rejects(digging, /не подтвердил разрушение/)
  f.tick(3)
  t.mock.timers.tick(5000)
  await rejected
  ack(1)
  f.tick(20)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2, 1])
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.bot.targetDigBlock, null)
})

test('instant breaks on a sequenced protocol need only START and an authoritative block change', async t => {
  const f = fixture(t, { waitTime: 0 })
  sequenced(f)
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick(3)
  f.serverUpdate()
  await digging
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0])
})

test('survival finish has a hand swing in its own movement tick', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick() // START is sent on its own client tick.
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
  f.tick() // START is sent on its own client tick.
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
  f.tick() // START is sent on its own client tick.
  const rejected = assert.rejects(digging, /повторно прислал этот блок/i)
  f.tick(8)
  f.serverUpdate(f.block.type)
  t.mock.timers.tick(5000)
  await rejected
  assert.equal(f.bot.listenerCount(`blockUpdate:${f.block.position}`), 0)
  assert.equal(f.bot.targetDigBlock, null)
  assert.equal(f.localChanges(), 0)
})

test('a same-state update does not reject a later authoritative destroy after one second', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick(9)
  f.serverUpdate(f.block.type)
  t.mock.timers.tick(1500)
  assert.equal(f.bot.targetDigBlock, f.block)
  f.serverUpdate()
  await digging
  assert.equal(f.bot.targetDigBlock, null)
})

test('server silence after STOP still times out after 5 seconds', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick() // START is sent on its own client tick.
  const rejected = assert.rejects(digging, /не подтвердил/)
  f.tick(8)
  t.mock.timers.tick(4900)
  assert.equal(f.bot.targetDigBlock, f.block, 'still waiting for a delayed destroy')
  t.mock.timers.tick(200)
  await rejected
})

test('creative sends a start and swing, without a survival finish packet', async t => {
  const f = fixture(t, { waitTime: 0, mode: 'creative' })
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick() // START is sent on its own client tick.
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
  f.tick() // START is sent on its own client tick.
  const rejected = assert.rejects(digging, /aborted/i)
  f.tick(8)
  f.bot.stopDigging()
  await rejected
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2, 1])
  const sent = f.packets.length
  t.mock.timers.tick(6000)
  assert.equal(f.packets.length, sent)
  assert.equal(f.bot.listenerCount(`blockUpdate:${f.block.position}`), 0)
})

test('disconnect during digging rejects without writing another packet', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick() // START is sent on its own client tick.
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
  f.tick() // START is sent on its own client tick.
  t.mock.timers.tick(50)
  f.serverUpdate()
  await digging
  t.mock.timers.tick(6000)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0])
})

test('elapsed wall time cannot finish a block without client ticks', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore', 0)
  f.tick() // START is sent on its own client tick.
  t.mock.timers.tick(4000)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0])
  assert.equal(f.packets[0].params.face, 0, 'bottom face is not replaced by the top face')
  for (let i = 0; i < 8; i++) {
    f.packets.length = 0
    f.tick()
    assert.equal(f.packets.filter(p => p.name === 'arm_animation').length, 1, 'swing on every mining tick')
  }
  assert.equal(f.packets.find(p => p.name === 'block_dig').params.status, 2)
  assert.equal(f.bot.listenerCount('physicsTick'), 1, 'keep swinging while awaiting confirmation')
  f.serverUpdate()
  await digging
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('confirmation wait keeps one swing per tick but never repeats START or STOP', async t => {
  const f = fixture(t, { waitTime: 100 })
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick(53)
  assert.equal(f.packets.filter(p => p.name === 'arm_animation').length, 53)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2])
  f.serverUpdate()
  await digging
  const count = f.packets.length
  f.tick(20)
  assert.equal(f.packets.length, count, 'confirmation releases the held animation')
})

const { digUntilChanged } = require('../src/held-dig')
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function heldFixture (t) {
  const f = fixture(t, { waitTime: 100 })
  f.bot.blockAtCursor = () => f.block
  f.ac = new AbortController()
  f.retries = []
  f.hold = () => digUntilChanged(f.bot, f.block, 2, f.ac.signal, n => f.retries.push(n))
  return f
}

test('held mining retries a corrected STOP after five ticks without another five-second timeout or ABORT', async t => {
  const f = heldFixture(t)
  const ack = sequenced(f)
  const digging = f.hold()
  f.tick(3)
  f.serverUpdate(f.block.type)
  ack(2)
  f.tick(4)
  await flush()
  assert.deepEqual(f.retries, [])
  f.tick()
  await flush()
  assert.deepEqual(f.retries, [1])
  f.tick(3)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2, 0, 2])
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.sequence), [1, 2, 3, 4])
  f.serverUpdate()
  await digging
  assert.equal(f.bot.listenerCount('botifyDigPacket'), 0)
  assert.equal(f.bot.listenerCount('blockUpdate'), 0)
  assert.equal(f.bot._client.listenerCount('acknowledge_player_digging'), 0)
})

for (const evidence of ['only ACK', 'old ACK', 'only correction']) {
  test(`held mining does not restart on ${evidence}`, async t => {
    const f = heldFixture(t)
    const ack = sequenced(f)
    const digging = f.hold()
    f.tick(3)
    if (evidence !== 'only ACK') f.serverUpdate(f.block.type)
    if (evidence !== 'only correction') ack(evidence === 'old ACK' ? 1 : 2)
    f.tick(20)
    await flush()
    assert.deepEqual(f.retries, [])
    assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2])
    f.serverUpdate()
    await digging
  })
}

test('held digging waits out a rejected attempt, pauses five ticks, then completes only on server change', async t => {
  const f = heldFixture(t)
  const digging = f.hold()
  let done = false
  digging.then(() => { done = true })
  f.tick(3)
  f.serverUpdate(f.block.type)
  f.tick(99)
  await flush()
  assert.equal(done, false)
  assert.deepEqual(f.retries, [1])
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2, 1])
  f.tick(4)
  await flush()
  assert.equal(f.packets.filter(p => p.name === 'block_dig').length, 3)
  f.tick()
  await flush()
  f.tick(3)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2, 1, 0, 2])
  assert.equal(done, false)
  f.serverUpdate()
  await digging
  assert.equal(f.localChanges(), 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

for (const phase of ['mining', 'confirmation', 'retry delay']) {
  test(`releasing held digging during ${phase} stops packets and settles immediately`, async t => {
    const f = heldFixture(t)
    const digging = f.hold()
    const rejected = assert.rejects(digging, /aborted/i)
    f.tick(phase === 'mining' ? 1 : 3)
    if (phase === 'retry delay') { t.mock.timers.tick(5000); await flush() }
    f.ac.abort()
    await rejected
    const count = f.packets.length
    f.tick(200)
    await flush()
    assert.equal(f.packets.length, count)
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
  })
}

test('disconnect during held retry delay settles even without any more physics ticks', async t => {
  const f = heldFixture(t)
  const digging = f.hold()
  const rejected = assert.rejects(digging, /соединение/)
  f.tick(3)
  t.mock.timers.tick(5000)
  await flush()
  f.bot.emit('end')
  await rejected
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('server destruction in the retry gap finishes without another START', async t => {
  const f = heldFixture(t)
  const digging = f.hold()
  f.tick(3)
  t.mock.timers.tick(5000)
  await flush()
  f.serverUpdate()
  f.tick(5)
  await digging
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2, 1])
})

for (const change of ['aim', 'tool', 'window']) {
  test(`changing ${change} during confirmation cancels held digging instead of retrying`, async t => {
    const f = heldFixture(t)
    const digging = f.hold()
    const rejected = assert.rejects(digging)
    f.tick(3)
    if (change === 'aim') f.bot.blockAtCursor = () => null
    if (change === 'tool') f.bot.heldItem = { type: 9 }
    if (change === 'window') f.bot.currentWindow = { id: 1 }
    f.tick()
    await rejected
    assert.deepEqual(f.retries, [])
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
  })
}

test('mining recomputes damage after a change in water/ground speed', async t => {
  const f = fixture(t)
  let progress = 0.25
  f.bot.digTime = (_block, asProgress) => asProgress ? progress : 200
  const digging = f.bot.dig(f.block, 'ignore')
  f.tick() // START is sent on its own client tick.
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
  f.bot.blockAtCursor = () => f.block
  const digging = f.bot.dig(f.block, 'ignore', 3)
  f.tick() // START is sent on its own client tick.
  f.bot.blockAtCursor = () => null
  const rejected = assert.rejects(digging, /прицел/)
  f.tick(10)
  await rejected
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 1])
  assert.equal(f.packets.find(p => p.name === 'block_dig' && p.params.status === 1).params.face, 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('a request between ticks starts on the next tick and gets no partial-tick damage', async t => {
  const f = fixture(t, { waitTime: 100 })
  const digging = f.bot.dig(f.block, 'ignore', 4)
  assert.equal(f.packets.length, 0)
  t.mock.timers.tick(49)
  f.tick()
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0])
  f.tick()
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0])
  f.tick()
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2])
  f.serverUpdate()
  await digging
})

test('cancelling before the START tick sends neither START nor ABORT', async t => {
  const f = fixture(t)
  const digging = f.bot.dig(f.block, 'ignore')
  const rejected = assert.rejects(digging, /aborted/i)
  f.bot.stopDigging()
  f.tick(20)
  await rejected
  assert.equal(f.packets.length, 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('replacing a pending dig preserves the new face and settles the old promise', async t => {
  const f = fixture(t, { waitTime: 100 })
  const first = f.bot.dig(f.block, 'ignore', 4)
  const rejected = assert.rejects(first, /aborted/i)
  const second = f.bot.dig(f.block, 'ignore', 0)
  f.tick(3)
  await rejected
  const digs = f.packets.filter(p => p.name === 'block_dig')
  assert.deepEqual(digs.map(p => p.params.status), [0, 2])
  assert.ok(digs.every(p => p.params.face === 0))
  f.serverUpdate()
  await second
})

test('timeout releases the previous server dig before starting another attempt on the same block', async t => {
  const f = fixture(t, { waitTime: 100 })
  const first = f.bot.dig(f.block, 'ignore', 4)
  const rejected = assert.rejects(first, /не подтвердил/)
  f.tick(3)
  t.mock.timers.tick(5000)
  await rejected
  const second = f.bot.dig(f.block, 'ignore', 4)
  f.tick(3)
  assert.deepEqual(f.packets.filter(p => p.name === 'block_dig').map(p => p.params.status), [0, 2, 1, 0, 2])
  f.serverUpdate()
  await second
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('component enchantments (26.x) on the tool and helmet do not break digTime; efficiency applies', t => {
  const registry = require('prismarine-registry')('26.1')
  const Block = require('prismarine-block')(registry)
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.game = { gameMode: 'survival' }
  bot.entity = { onGround: true, effects: {} }
  bot.inventory = { slots: [] }
  bot.getEquipmentDestSlot = () => 5
  bot.blockAt = () => null
  require('mineflayer/lib/plugins/digging')(bot)
  bot._getBlockAtEyeLevel = () => null
  const log = Block.fromStateId(registry.blocksByName.oak_log.defaultState, 0)
  const axe = registry.itemsByName.netherite_axe.id
  const efficiency = registry.enchantmentsByName.efficiency.id
  bot.heldItem = { type: axe, enchants: { enchantments: [{ id: efficiency, level: 5 }] } }
  bot.inventory.slots[5] = { type: registry.itemsByName.diamond_helmet.id, enchants: { enchantments: [{ id: registry.enchantmentsByName.aqua_affinity.id, level: 1 }] } }
  const fast = bot.digTime(log, true)
  bot.heldItem = { type: axe, enchants: [] }
  bot.inventory.slots[5] = null
  const plain = bot.digTime(log, true)
  assert.ok(Number.isFinite(fast) && fast > plain, `efficiency V speeds up (${fast} > ${plain})`)
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
