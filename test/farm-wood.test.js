'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { dropFarmWood, woodDropTarget } = require('../src/farm-wood')
const registry = require('prismarine-registry')('26.1')
const Item = require('prismarine-item')(registry)
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture (t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const bot = new EventEmitter()
  Object.assign(bot, { registry, version: '26.1', supportFeature: registry.supportFeature,
    entity: { id: 42, position: new Vec3(0, 64, 0), eyeHeight: 1.62 }, game: { gameMode: 'survival' }, QUICK_BAR_START: 36, _client: new EventEmitter() })
  const packets = []; const replies = []
  bot._client.write = (name, packet) => packets.push({ name, ...packet, time: Date.now() })
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true })
  bot.waitForTicks = async () => {}
  const World = require('prismarine-world')(registry)
  const Chunk = require('prismarine-chunk')(registry)
  bot.world = new World(null, null, 0).sync
  for (let x = -1; x <= 0; x++) for (let z = -1; z <= 0; z++) bot.world.setColumn(x, z, new Chunk({ minY: 0, worldHeight: 256 }))
  bot.blockAt = p => bot.world.getBlock(p)
  for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) bot.world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.stone.defaultState)
  const set = (slot, name, count = 64) => bot.inventory.updateSlot(slot, new Item(registry.itemsByName[name].id, count))
  set(9, 'spruce_log'); set(37, 'spruce_log', 12)
  set(36, 'netherite_axe', 1); set(38, 'bone_meal'); set(39, 'spruce_sapling'); set(40, 'experience_bottle'); set(41, 'oak_log'); set(45, 'totem_of_undying', 1)
  const ac = new AbortController()
  const options = { species: 'spruce', plot: [new Vec3(2, 63, 2)], reply: m => replies.push(m),
    checkCancel: s => { if (s.aborted) throw new Error('cancelled') },
    look: async (yaw, pitch) => { Object.assign(bot.entity, { yaw, pitch }); return true } }
  return { bot, set, packets, replies, ac, options }
}
async function finish (t, promise) {
  let done = false
  const observed = promise.finally(() => { done = true }); observed.catch(() => {})
  for (let i = 0; i < 1000 && !done; i++) { await flush(); t.mock.timers.tick(50); await flush() }
  assert.ok(done)
  return observed
}
test('drops full log stacks from inventory and hotbar using real inventory packets; protects supplies', async t => {
  const f = fixture(t)
  assert.equal(await finish(t, dropFarmWood(f.bot, f.ac.signal, f.options)), 76)
  const clicks = f.packets.filter(p => p.name === 'window_click')
  assert.deepEqual(clicks.map(p => [p.windowId, p.slot, p.mode, p.mouseButton]), [[0, 9, 0, 0], [0, -999, 0, 0], [0, 37, 0, 0], [0, -999, 0, 0]])
  assert.equal(f.packets.filter(p => p.name === 'close_window').length, 2)
  assert.ok(clicks[1].time - clicks[0].time >= 200)
  assert.equal(f.bot.inventory.selectedItem, null)
  for (const slot of [36, 38, 39, 40, 41, 45]) assert.ok(f.bot.inventory.slots[slot])
  assert.ok(f.replies.some(m => /выброшено.*76/.test(m)))
})
test('rechecks a hotbar slot after the recent-dig wait and never drops a replacement axe', async t => {
  const f = fixture(t)
  f.bot.inventory.updateSlot(9, null); f.bot.lastDigTime = Date.now()
  const run = dropFarmWood(f.bot, f.ac.signal, f.options)
  await flush(); t.mock.timers.tick(400); await flush()
  f.set(37, 'netherite_axe', 1)
  await finish(t, run)
  assert.equal(f.packets.filter(p => p.name === 'window_click').length, 0)
})

for (const withLogs of [false, true]) test(`cleans sticks from inventory and hotbar, with logs=${withLogs}`, async t => {
  const f = fixture(t)
  if (!withLogs) { f.bot.inventory.updateSlot(9, null); f.bot.inventory.updateSlot(37, null) }
  f.set(10, 'stick', 64); f.set(42, 'stick', 19)
  assert.equal(await finish(t, dropFarmWood(f.bot, f.ac.signal, f.options)), 83 + (withLogs ? 76 : 0))
  assert.equal(f.bot.inventory.slots[10], null)
  assert.equal(f.bot.inventory.slots[42], null)
  assert.equal(f.bot.inventory.selectedItem, null)
  assert.ok(f.replies.some(m => /выброшено stick: 83/.test(m)))
  for (const slot of [36, 38, 39, 40, 41, 45]) assert.ok(f.bot.inventory.slots[slot])
})
test('does not touch open containers or send clicks after cancellation', async t => {
  const f = fixture(t)
  f.bot.currentWindow = { id: 2 }
  assert.equal(await dropFarmWood(f.bot, f.ac.signal, f.options), 0)
  f.bot.currentWindow = null
  const run = dropFarmWood(f.bot, f.ac.signal, f.options)
  const rejected = assert.rejects(run)
  await flush(); f.ac.abort(); await rejected
  t.mock.timers.tick(1000); await flush()
  assert.equal(f.packets.length, 0)
})

test('server rejecting pickup is retried; outside click requires the expected cursor stack', async t => {
  const f = fixture(t)
  f.bot.inventory.updateSlot(37, null)
  const authoritative = f.bot.inventory.slots.map(i => Item.toNotch(i))
  const write = f.bot._client.write
  let pickups = 0
  f.bot._client.write = (name, packet) => {
    write(name, packet)
    if (name === 'window_click' && packet.slot === 9 && ++pickups <= 5) {
      f.bot._client.emit('window_items', { windowId: 0, stateId: pickups, items: authoritative, carriedItem: Item.toNotch(null) })
    }
  }
  assert.equal(await finish(t, dropFarmWood(f.bot, f.ac.signal, f.options)), 64)
  assert.equal(pickups, 6)
  assert.equal(f.packets.filter(p => p.name === 'window_click' && p.slot === -999).length, 1)
  assert.equal(f.replies.filter(m => /повтор \d\/5/.test(m)).length, 5)
  assert.equal(f.bot._client.listenerCount('collect'), 0)
})

test('repeated server rejection pauses cleanup instead of aborting the farm or spamming clicks', async t => {
  const f = fixture(t)
  f.bot.inventory.updateSlot(37, null)
  const authoritative = f.bot.inventory.slots.map(i => Item.toNotch(i))
  const write = f.bot._client.write
  f.bot._client.write = (name, packet) => {
    write(name, packet)
    if (name === 'window_click') f.bot._client.emit('window_items', { windowId: 0, stateId: 1, items: authoritative, carriedItem: Item.toNotch(null) })
  }
  assert.equal(await finish(t, dropFarmWood(f.bot, f.ac.signal, f.options)), 0)
  const clicks = f.packets.filter(p => p.name === 'window_click').length
  assert.equal(clicks, 6)
  assert.match(f.replies.at(-1), /30 с/)
  assert.equal(await dropFarmWood(f.bot, f.ac.signal, f.options), 0)
  assert.equal(f.packets.filter(p => p.name === 'window_click').length, clicks)
})

test('collecting logs into another slot is not counted as freeing inventory', async t => {
  const f = fixture(t)
  f.bot.inventory.updateSlot(37, null)
  const write = f.bot._client.write
  f.bot._client.write = (name, packet) => {
    write(name, packet)
    if (name === 'window_click' && packet.slot === -999) {
      f.bot._client.emit('collect', { collectorEntityId: 42, collectedEntityId: 90, pickupItemCount: 64 })
      f.set(10, 'spruce_log', 64)
    }
  }
  assert.equal(await finish(t, dropFarmWood(f.bot, f.ac.signal, f.options)), 0)
  assert.ok(f.replies.some(m => /был подбор/.test(m)))
})

test('stop after picking up a stack prevents the outside click', async t => {
  const f = fixture(t)
  const write = f.bot._client.write
  f.bot._client.write = (name, packet) => {
    write(name, packet)
    if (name === 'window_click') f.ac.abort()
  }
  await finish(t, assert.rejects(dropFarmWood(f.bot, f.ac.signal, f.options)))
  assert.equal(f.packets.filter(p => p.name === 'window_click').length, 1)
  assert.equal(f.bot._client.listenerCount('collect'), 0)
})

test('floor target stays to the right of the farm-facing direction for all four sides', t => {
  const f = fixture(t)
  for (const [x, z] of [[0, -3], [0, 3], [-3, 0], [3, 0]]) {
    const plot = [new Vec3(x - 1, 63, z - 1)]
    f.bot.entity.yaw = 2.1
    const aim = woodDropTarget(f.bot, plot)
    assert.ok(aim)
    const delta = aim.target.minus(f.bot.entity.position)
    const right = new Vec3(-z, 0, x).normalize()
    assert.ok(delta.x * right.x + delta.z * right.z >= 2.4)
    assert.ok(aim.pitch < 0, 'aim down to the floor')
    assert.equal(aim.floorPos.y, 63)
    f.bot.entity.yaw = aim.yaw
    assert.deepEqual(woodDropTarget(f.bot, plot).target, aim.target, 'last drop must not rotate the next direction again')
  }
})

test('blocked right side selects clear left floor; both blocked sides prevent throwing', async t => {
  const f = fixture(t)
  f.options.plot = [new Vec3(-1, 63, -4)] // Facing north: right is east.
  for (let x = 1; x <= 5; x++) for (let z = -4; z <= 4; z++) {
    f.bot.world.setBlockStateId(new Vec3(x, 64, z), registry.blocksByName.chest.defaultState)
  }
  const left = woodDropTarget(f.bot, f.options.plot)
  assert.equal(left.side, 'слева')
  assert.ok(left.target.x < 0)
  for (let x = -5; x <= -1; x++) for (let z = -4; z <= 4; z++) {
    f.bot.world.setBlockStateId(new Vec3(x, 64, z), registry.blocksByName.barrel.defaultState)
  }
  assert.equal(woodDropTarget(f.bot, f.options.plot), null)
  assert.equal(await dropFarmWood(f.bot, f.ac.signal, f.options), 0)
  assert.equal(f.packets.length, 0)
  assert.match(f.replies[0], /по бокам нет свободного ровного пола/)
  for (let x = 1; x <= 5; x++) for (let z = -4; z <= 4; z++) {
    f.bot.world.setBlockStateId(new Vec3(x, 64, z), registry.blocksByName.air.defaultState)
    f.bot.world.setBlockStateId(new Vec3(x, 63, z), registry.blocksByName.air.defaultState)
  }
  assert.equal(woodDropTarget(f.bot, f.options.plot), null)
})

test('rotation changed during inventory pauses cannot throw behind the bot', async t => {
  const f = fixture(t)
  f.bot.inventory.updateSlot(37, null)
  f.bot.waitForTicks = async () => { f.bot.entity.yaw += Math.PI }
  assert.equal(await finish(t, dropFarmWood(f.bot, f.ac.signal, f.options)), 0)
  assert.equal(f.packets.filter(p => p.name === 'window_click' && p.slot === -999).length, 0)
  assert.equal(f.bot.inventory.slots[9].count, 64)
  assert.equal(f.bot.inventory.selectedItem, null)
})

test('each stack re-aims after pickup before dropping it', async t => {
  const f = fixture(t)
  let turns = 0
  const look = f.options.look
  f.options.look = async (...args) => { turns++; return look(...args) }
  const write = f.bot._client.write
  f.bot._client.write = (name, packet) => {
    write(name, packet)
    if (name === 'window_click' && packet.slot >= 0) f.bot.entity.yaw += Math.PI
  }
  assert.equal(await finish(t, dropFarmWood(f.bot, f.ac.signal, f.options)), 76)
  assert.equal(turns, 3)
})
