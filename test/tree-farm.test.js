'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { farmTrees, plotFromCursor, selectFarmPlot, chooseSpecies, farmRay, plantingOrder, plantingAim, placeSapling, nearestSapling, growSaplings, headroomTarget } = require('../src/tree-farm')
const { attachVanillaTick } = require('../src/vanilla')
const { humanPlan, humanPoint } = require('../src/smooth-look')
const { anglesFrom, eyePosition, viewDirection, attachEyeRaycast } = require('../src/eye-raycast')

const registry = require('prismarine-registry')('26.1')
const World = require('prismarine-world')(registry)
const Chunk = require('prismarine-chunk')(registry)
const Block = require('prismarine-block')(registry)
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

function fixture () {
  const bot = new EventEmitter()
  bot.registry = registry
  bot.version = '26.1'
  bot.supportFeature = registry.supportFeature
  bot.game = { gameMode: 'survival' }
  bot._client = new EventEmitter()
  bot._client.state = 'play'
  bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, eyeHeight: 1.62 }
  bot.world = new World(null, null, 0).sync
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) bot.world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }))
  bot.blockAt = p => bot.world.getBlock(p)
  const set = (p, name) => {
    const old = bot.blockAt(p)
    bot.world.setBlockStateId(p, registry.blocksByName[name].defaultState)
    const block = bot.blockAt(p)
    bot.emit('blockUpdate', old, block)
    bot.emit(`blockUpdate:${p}`, old, block)
  }
  for (let x = -2; x <= 5; x++) for (let z = -2; z <= 5; z++) set(new Vec3(x, 63, z), 'dirt')
  const plot = [new Vec3(1, 63, 1), new Vec3(2, 63, 1), new Vec3(1, 63, 2), new Vec3(2, 63, 2)]
  const sapling = { name: 'spruce_sapling', type: registry.itemsByName.spruce_sapling.id, count: 64, slot: 36 }
  const axe = { name: 'netherite_axe', type: registry.itemsByName.netherite_axe.id, customName: 'Shard Axe', slot: 37, count: 1 }
  bot.heldItem = sapling
  bot.quickBarSlot = 0
  bot.inventory = { selectedItem: null, items: () => [sapling, axe] }
  bot.equip = async item => { bot.heldItem = item; bot.quickBarSlot = item.slot - 36 }
  bot.setQuickBarSlot = slot => { bot.quickBarSlot = slot; bot.heldItem = bot.inventory.items().find(i => i.slot === slot + 36) }
  bot.waitForTicks = async () => {}
  const packets = []
  bot._client.write = (name, params) => packets.push({ name, params: structuredClone(params) })
  bot.swingArm = () => bot._client.write('arm_animation', { hand: 0 })
  attachVanillaTick(bot, { perTick: false, smoothLook: false })
  require('mineflayer/lib/plugins/generic_place')(bot)
  bot.blockAtCursor = () => bot.blockAt(plot[0])
  const aim = p => {
    const angles = plantingAim(bot, p, () => 0.5)
    assert.ok(angles)
    Object.assign(bot.entity, angles)
  }
  return { bot, plot, sapling, axe, packets, set, aim }
}

test('plot uses the aimed soil corner, validates all four supports and chooses a consistent species', () => {
  const f = fixture()
  assert.deepEqual(plotFromCursor(f.bot), f.plot)
  assert.equal(chooseSpecies(f.bot, f.plot), 'spruce')
  f.set(f.plot[3], 'stone')
  assert.throws(() => plotFromCursor(f.bot), /четырёх/)
  f.set(f.plot[3], 'dirt')
  f.set(f.plot[0].offset(0, 1, 0), 'dark_oak_sapling')
  assert.throws(() => chooseSpecies(f.bot, f.plot, 'spruce'), /не совпадает/)
  f.bot.entity.position = new Vec3(10, 64, 10)
  assert.throws(() => plotFromCursor(f.bot), /досягаемости/)
})

test('raised 2x2 bed is recognized from every soil block or sapling without including the lower floor', () => {
  const f = fixture()
  const raised = f.plot.map(p => p.offset(0, 1, 0))
  for (const p of raised) f.set(p, 'podzol')
  for (const selected of raised) {
    f.bot.blockAtCursor = () => ({ ...f.bot.blockAt(selected), face: 2 })
    assert.deepEqual(plotFromCursor(f.bot), raised)
    f.set(selected.offset(0, 1, 0), 'spruce_sapling')
    f.bot.blockAtCursor = () => f.bot.blockAt(selected.offset(0, 1, 0))
    assert.deepEqual(plotFromCursor(f.bot), raised)
  }
  f.set(raised[3], 'air')
  f.bot.blockAtCursor = () => f.bot.blockAt(raised[0])
  assert.throws(() => plotFromCursor(f.bot), /четырёх блоков/)
})

test('farm remembers covered soil and can identify a unique raised bed through its canopy', () => {
  const f = fixture()
  assert.deepEqual(selectFarmPlot(f.bot), f.plot)
  f.bot.blockAtCursor = () => f.bot.blockAt(new Vec3(0, 65, 0))
  f.set(new Vec3(0, 65, 0), 'spruce_leaves')
  assert.deepEqual(selectFarmPlot(f.bot), f.plot)
  f.bot.game.dimension = 'the_nether'
  assert.throws(() => selectFarmPlot(f.bot), /однозначно/)
  const raised = f.plot.map(p => p.offset(0, 1, 0))
  for (const p of raised) f.set(p, 'podzol')
  assert.deepEqual(selectFarmPlot(f.bot), raised)
})

test('farm clears leaves from the planting bed with the axe, then selects saplings', async () => {
  const f = fixture()
  const ac = new AbortController()
  class Cancelled extends Error {}
  const leaf = f.plot[3].offset(0, 1, 0)
  f.set(leaf, 'spruce_leaves')
  let digs = 0; let corrected = false
  const run = farmTrees(f.bot, ac.signal, { plot: f.plot, species: 'spruce', random: () => 0.5 }, {
    checkCancel: s => { if (s.aborted) throw new Cancelled() }, Cancelled, reply: () => {},
    look: async (yaw, pitch) => {
      Object.assign(f.bot.entity, { yaw, pitch })
      // Late server correction while turning must not make it dig with saplings.
      if (!corrected) { corrected = true; f.bot.setQuickBarSlot(0) }
      return true
    },
    dig: async block => {
      assert.equal(f.bot.heldItem.name, 'netherite_axe')
      assert.equal(block.name, 'spruce_leaves')
      digs++
      f.set(block.position, 'air')
    }
  })
  const rejected = assert.rejects(run, Cancelled)
  for (let i = 0; i < 60 && !f.packets.some(p => p.name === 'block_place'); i++) { f.bot.emit('physicsTick'); await flush() }
  assert.equal(digs, 1)
  assert.ok(f.packets.some(p => p.name === 'block_place'))
  assert.equal(f.bot.heldItem.name, 'spruce_sapling')
  ac.abort()
  await rejected
})

test('raised bed receives four saplings on its top faces, far-first, viewed from any side', async () => {
  for (const feet of [new Vec3(1.5, 64, -0.5), new Vec3(4.5, 64, 1.5), new Vec3(1.5, 64, 4.5), new Vec3(-0.5, 64, 1.5)]) {
    const f = fixture()
    const raised = f.plot.map(p => p.offset(0, 1, 0))
    for (const p of raised) f.set(p, 'podzol')
    f.bot.entity.position = feet
    const view = anglesFrom(eyePosition(f.bot.entity), new Vec3(2, 64.4, 2))
    f.bot.blockAtCursor = () => f.bot.world.raycast(eyePosition(f.bot.entity), viewDirection(view.yaw, view.pitch), 4.5)
    const selected = f.bot.blockAtCursor()
    assert.ok(selected && selected.face !== 1, 'initial crosshair selects a side face like the screenshot')
    const plot = plotFromCursor(f.bot)
    assert.deepEqual(plot, raised)
    for (const ground of plantingOrder(f.bot, plot, () => 0.5)) {
      f.aim(ground)
      const placing = placeSapling(f.bot, ground, 'spruce', new AbortController().signal)
      f.bot.emit('physicsTick')
      const packet = f.packets.filter(p => p.name === 'block_place').at(-1).params
      assert.deepEqual(packet.location, { x: ground.x, y: 64, z: ground.z })
      assert.equal(packet.direction, 1, 'placement clicks the top even though selection clicked a side')
      f.set(ground.offset(0, 1, 0), 'spruce_sapling')
      await placing
    }
    assert.equal(f.packets.filter(p => p.name === 'block_place').length, 4)
    assert.ok(raised.every(p => f.bot.blockAt(p.offset(0, 1, 0)).name === 'spruce_sapling'))
  }
})

test('planting order is far to near for different viewing sides and random seeds', () => {
  const f = fixture()
  for (const pos of [new Vec3(0.5, 64, 0.5), new Vec3(4.5, 64, 1.5), new Vec3(1.5, 64, 4.5)]) {
    f.bot.entity.position = pos
    for (const seed of [0.1, 0.9]) {
      const order = plantingOrder(f.bot, f.plot, () => seed)
      const distances = order.map(p => p.offset(0.5, 1, 0.5).distanceTo(pos.offset(0, 1.62, 0)))
      assert.ok(distances.every((d, i) => !i || d <= distances[i - 1]))
    }
  }
})

test('a nearer sapling or solid block blocks the placement ray despite having no collision shape', () => {
  const f = fixture()
  f.bot.entity.position = new Vec3(0.5, 63.3, 0.5)
  const ground = new Vec3(2, 63, 0)
  const aim = plantingAim(f.bot, ground, () => 0.5)
  assert.ok(aim)
  f.set(new Vec3(1, 64, 0), 'spruce_sapling')
  assert.equal(Block.fromStateId(registry.blocksByName.spruce_sapling.defaultState).shapes.length, 0)
  assert.equal(plantingAim(f.bot, ground, () => 0.5), null)
  f.set(new Vec3(1, 64, 0), 'stone')
  assert.equal(plantingAim(f.bot, ground, () => 0.5), null)
})

test('placement uses actual face coordinates, one sequenced packet and only server confirmation', async () => {
  const f = fixture()
  const ground = f.plot[3]
  f.aim(ground)
  const ac = new AbortController()
  let done = false
  const placing = placeSapling(f.bot, ground, 'spruce', ac.signal).then(() => { done = true })
  f.bot.emit('physicsTick')
  for (let i = 0; i < 8; i++) f.bot.emit('physicsTick')
  await flush()
  assert.equal(done, false)
  const packets = f.packets.filter(p => p.name === 'block_place')
  assert.equal(packets.length, 1)
  assert.equal(packets[0].params.direction, 1)
  assert.equal(packets[0].params.sequence, 1)
  assert.equal(packets[0].params.cursorY, 1)
  assert.ok(packets[0].params.cursorX > 0 && packets[0].params.cursorX < 1)
  assert.equal(f.bot.blockAt(ground.offset(0, 1, 0)).name, 'air')
  f.set(ground.offset(0, 1, 0), 'spruce_sapling')
  await placing
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.bot.listenerCount('blockUpdate'), 0)
})

for (const when of ['before send', 'after send', 'world reset']) {
  test(`placement cancellation ${when} removes listeners and prevents further writes`, async () => {
    const f = fixture()
    f.aim(f.plot[3])
    const ac = new AbortController()
    const placing = placeSapling(f.bot, f.plot[3], 'spruce', ac.signal)
    const rejected = assert.rejects(placing)
    if (when !== 'before send') f.bot.emit('physicsTick')
    if (when === 'world reset') f.bot.emit('botifyDigReset')
    else ac.abort()
    await rejected
    const count = f.packets.length
    f.bot.emit('physicsTick')
    assert.equal(f.packets.length, count)
    assert.equal(f.bot.listenerCount('blockUpdate'), 0)
    assert.equal(f.bot.listenerCount('botifyDigReset'), 0)
  })
}

test('placement rechecks visibility on the sending tick and accepts immediate server-grown logs', async () => {
  const f = fixture()
  f.aim(f.plot[3])
  const ac = new AbortController()
  const first = placeSapling(f.bot, f.plot[3], 'spruce', ac.signal)
  const rejected = assert.rejects(first, /перекрыто/)
  f.bot.entity.yaw += Math.PI
  f.bot.emit('physicsTick')
  await rejected
  assert.equal(f.packets.length, 0)
  f.aim(f.plot[3])
  const second = placeSapling(f.bot, f.plot[3], 'spruce', ac.signal)
  f.bot.emit('physicsTick')
  f.set(f.plot[3].offset(0, 1, 0), 'spruce_log')
  await second
})

test('placement refusal times out without duplicating packets or changing the local world', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.aim(f.plot[3])
  const placing = placeSapling(f.bot, f.plot[3], 'spruce', new AbortController().signal)
  const rejected = assert.rejects(placing, /не подтвердил/)
  f.bot.emit('physicsTick')
  f.set(f.plot[3].offset(0, 1, 0), 'air')
  t.mock.timers.tick(5000)
  await rejected
  assert.equal(f.packets.filter(p => p.name === 'block_place').length, 1)
  assert.equal(f.bot.blockAt(f.plot[3].offset(0, 1, 0)).name, 'air')
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

for (const blocked of [false, true]) {
  test(blocked ? 'farm leaves an occupied plot and mechanism untouched' : 'farm pauses for missing saplings and resumes after refill', async () => {
    const f = fixture()
    let stock = false
    f.bot.inventory.items = () => stock ? [f.sapling, f.axe] : [f.axe]
    if (blocked) f.set(f.plot[0].offset(0, 1, 0), 'dispenser')
    const ac = new AbortController()
    class Cancelled extends Error {}
    const replies = []
    const run = farmTrees(f.bot, ac.signal, { plot: f.plot, species: 'spruce', random: () => 0.5 }, {
      checkCancel: s => { if (s.aborted) throw new Cancelled() }, Cancelled,
      reply: t => replies.push(t),
      look: async (yaw, pitch) => { Object.assign(f.bot.entity, { yaw, pitch }); return true },
      dig: async () => assert.fail('must not dig the dispenser or empty space')
    })
    const rejected = assert.rejects(run, Cancelled)
    for (let i = 0; i < 40; i++) { f.bot.emit('physicsTick'); await flush() }
    assert.equal(f.packets.length, 0)
    assert.ok(replies.some(t => t.includes(blocked ? 'площадка занята' : 'жду пополнения')))
    stock = true
    for (let i = 0; i < 40; i++) { f.bot.emit('physicsTick'); await flush() }
    assert.equal(f.packets.filter(p => p.name === 'block_place').length, blocked ? 0 : 1)
    ac.abort()
    await rejected
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
  })
}

for (const useMeal of [false, true]) test(`farm plants, grows ${useMeal ? 'with bone meal after refill' : 'naturally'}, chops and replants`, async () => {
  const f = fixture()
  const ac = new AbortController()
  class Cancelled extends Error {}
  const planted = []; const replies = []
  let digs = 0; let grew = false; let waitingTicks = 0; let uses = 0
  const meal = { name: 'bone_meal', type: registry.itemsByName.bone_meal.id, count: 64, slot: 38 }
  const write = f.bot._client.write.bind(f.bot._client)
  f.bot._client.write = (name, params) => {
    write(name, params)
    if (name !== 'block_place') return
    if (f.bot.heldItem.name === 'bone_meal') {
      assert.equal(planted.length, 4, 'all four saplings must be planted before using meal')
      assert.equal(grew, false, 'no use after server confirms growth')
      assert.ok(params.location.equals(f.plot[0].offset(0, 1, 0)), 'nearest sapling')
      if (++uses === 3) {
        for (const p of f.plot) f.set(p.offset(0, 1, 0), 'spruce_log')
        grew = true
      }
      return
    }
    assert.equal(f.bot.heldItem.name, 'spruce_sapling')
    const hit = farmRay(f.bot, f.bot.entity.yaw, f.bot.entity.pitch)
    assert.ok(hit.position.equals(params.location))
    planted.push(params.location.clone())
    f.set(params.location.offset(0, 1, 0), 'spruce_sapling')
  }
  const run = farmTrees(f.bot, ac.signal, { plot: f.plot, species: 'spruce', random: () => 0.5 }, {
    checkCancel: s => { if (s.aborted) throw new Cancelled() }, Cancelled,
    reply: text => replies.push(text),
    look: async (yaw, pitch, cancelled) => { if (cancelled()) return false; Object.assign(f.bot.entity, { yaw, pitch }); return true },
    dig: async block => {
      assert.equal(f.bot.heldItem.name, 'netherite_axe')
      assert.ok(f.plot.some(p => p.offset(0, 1, 0).equals(block.position)))
      digs++
      for (const p of f.plot) f.set(p.offset(0, 1, 0), 'air')
    }
  })
  const rejected = assert.rejects(run, Cancelled)
  for (let tick = 0; tick < 250 && planted.length < 8; tick++) {
    f.bot.emit('physicsTick')
    await flush()
    if (planted.length === 4 && !grew && ++waitingTicks >= 20) {
      assert.equal(digs, 0, 'no chopping while only saplings are present')
      if (useMeal) f.bot.inventory.items = () => [f.sapling, f.axe, meal]
      else {
        for (const p of f.plot) f.set(p.offset(0, 1, 0), 'spruce_log')
        grew = true
      }
    }
  }
  ac.abort()
  await rejected
  assert.equal(planted.length, 8)
  assert.equal(digs, 1)
  assert.deepEqual(planted.slice(0, 4), plantingOrder(f.bot, f.plot, () => 0.5))
  assert.deepEqual(planted.slice(4), planted.slice(0, 4))
  assert.ok(replies.some(s => s.includes('жду пополнения или роста')))
  assert.equal(uses, useMeal ? 3 : 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.bot.listenerCount('botifyDigReset'), 0)
})

function growthFixture () {
  const f = fixture()
  for (const p of f.plot) f.set(p.offset(0, 1, 0), 'spruce_sapling')
  f.bot.heldItem = { name: 'bone_meal', count: 64 }
  f.target = nearestSapling(f.bot, f.plot, 'spruce', () => 0.5)
  assert.ok(f.target.position.equals(f.plot[0].offset(0, 1, 0)))
  Object.assign(f.bot.entity, { yaw: f.target.yaw, pitch: f.target.pitch })
  return f
}

for (const recover of [true, false]) test(`farm equipment ${recover ? 'recovers on retry five' : 'stops after retry five'} before attempting placement`, async () => {
  const f = fixture()
  f.bot.heldItem = f.axe
  let attempts = 0
  const select = f.bot.setQuickBarSlot
  f.bot.setQuickBarSlot = slot => {
    attempts++
    if (!recover || attempts < 6) throw new Error('inventory correction')
    select(slot)
  }
  const ac = new AbortController()
  class Cancelled extends Error {}
  const messages = []
  const run = farmTrees(f.bot, ac.signal, { plot: f.plot, species: 'spruce', random: () => 0.5 }, {
    checkCancel: s => { if (s.aborted) throw new Cancelled() }, Cancelled,
    reply: text => messages.push(text),
    look: async (yaw, pitch) => { Object.assign(f.bot.entity, { yaw, pitch }); return true },
    dig: async () => assert.fail('no tree yet')
  })
  const rejected = assert.rejects(run, recover ? Cancelled : /после 5 повторов.*ферма остановлена/)
  for (let i = 0; i < 80; i++) { f.bot.emit('physicsTick'); await flush() }
  assert.equal(attempts, 6)
  assert.equal(messages.filter(s => s.startsWith('[инвентарь]')).length, 5)
  assert.equal(f.packets.filter(p => p.name === 'block_place').length, recover ? 1 : 0)
  ac.abort()
  await rejected
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('holding bone meal uses the sapling outline every four ticks until authoritative growth', async () => {
  const f = growthFixture()
  const run = growSaplings(f.bot, f.plot, 'spruce', f.target.position, new AbortController().signal)
  const sentAt = []
  for (let tick = 1; tick <= 12; tick++) {
    const before = f.packets.length
    f.bot.emit('physicsTick')
    await flush()
    if (f.packets.length > before) sentAt.push(tick)
    if (tick === 2) {
      const old = f.bot.blockAt(f.target.position)
      const stage1 = Block.fromProperties(old.type, { stage: 1 }, 0)
      f.bot.world.setBlockStateId(f.target.position, stage1.stateId)
      f.bot.emit('blockUpdate', old, f.bot.blockAt(f.target.position))
    }
  }
  assert.deepEqual(sentAt, [1, 5, 9])
  const packets = f.packets.filter(p => p.name === 'block_place')
  assert.deepEqual(packets.map(p => p.params.sequence), [1, 2, 3])
  for (const { params } of packets) {
    assert.deepEqual(params.location, { x: 1, y: 64, z: 1 })
    assert.ok(params.cursorY >= 0 && params.cursorY <= 0.75)
    assert.ok(params.cursorX >= 0.125 && params.cursorX <= 0.875)
    assert.ok(params.cursorZ >= 0.125 && params.cursorZ <= 0.875)
    assert.equal(params.hand, 0)
  }
  assert.equal(f.packets.filter(p => p.name === 'arm_animation').length, 3)
  assert.equal(f.bot.blockAt(f.target.position).name, 'spruce_sapling')
  // Growth can first arrive for another block of the 2x2 trunk.
  f.set(f.plot[3].offset(0, 1, 0), 'spruce_log')
  assert.equal(await run, 'grown')
  for (let tick = 0; tick < 8; tick++) f.bot.emit('physicsTick')
  assert.equal(f.packets.filter(p => p.name === 'block_place').length, 3)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.bot.listenerCount('blockUpdate'), 0)
})

for (const when of ['before send', 'after send', 'world reset']) test(`bone meal cancellation ${when} stops immediately`, async () => {
  const f = growthFixture()
  const ac = new AbortController()
  const run = growSaplings(f.bot, f.plot, 'spruce', f.target.position, ac.signal)
  const rejected = assert.rejects(run)
  if (when !== 'before send') f.bot.emit('physicsTick')
  if (when === 'world reset') f.bot.emit('botifyDigReset')
  else ac.abort()
  await rejected
  const count = f.packets.length
  for (let i = 0; i < 10; i++) f.bot.emit('physicsTick')
  assert.equal(f.packets.length, count)
  for (const event of ['physicsTick', 'blockUpdate', 'botifyDigReset']) assert.equal(f.bot.listenerCount(event), 0)
})

for (const reason of ['empty', 'aim', 'changed']) test(`bone meal stops on ${reason} without using it on another block`, async () => {
  const f = growthFixture()
  const run = growSaplings(f.bot, f.plot, 'spruce', f.target.position, new AbortController().signal)
  f.bot.emit('physicsTick')
  if (reason === 'empty') f.bot.heldItem.count = 0
  if (reason === 'aim') f.bot.entity.yaw += Math.PI
  if (reason === 'changed') f.set(f.target.position, 'air')
  for (let i = 0; i < 10; i++) f.bot.emit('physicsTick')
  assert.equal(await run, reason)
  assert.equal(f.packets.filter(p => p.name === 'block_place').length, 1)
})

test('bone meal cannot target saplings behind solid blocks', () => {
  const f = growthFixture()
  for (let x = -1; x <= 4; x++) for (let y = 64; y <= 67; y++) f.set(new Vec3(x, y, 0), 'stone')
  f.bot.entity.position = new Vec3(1.5, 64, -0.5)
  assert.equal(nearestSapling(f.bot, f.plot, 'spruce', () => 0.5), null)
})

test('bone meal reports a missing transport write and stops even if physics stalls', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const f = growthFixture()
  const warnings = []
  f.bot._genericPlace = async () => {} // Regression: animation/helper success without packet.
  const run = growSaplings(f.bot, f.plot, 'spruce', f.target.position, new AbortController().signal, text => warnings.push(text))
  const rejected = assert.rejects(run, /не передаётся/)
  f.bot.emit('physicsTick')
  await flush()
  t.mock.timers.tick(5000)
  await rejected
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /сбой отправки/)
  assert.equal(f.bot.listenerCount('botifyPlacePacket'), 0)
  t.mock.timers.tick(10000)
  assert.equal(warnings.length, 1)
})

test('bone meal distinguishes sent uses without growth from missing packets and limits warnings', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const f = growthFixture()
  const warnings = []
  const ac = new AbortController()
  const run = growSaplings(f.bot, f.plot, 'spruce', f.target.position, ac.signal, text => warnings.push(text))
  const rejected = assert.rejects(run)
  for (let i = 0; i < 300; i++) {
    f.bot.emit('physicsTick')
    await flush()
    t.mock.timers.tick(50)
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /сервер ещё не показал рост/)
  assert.doesNotMatch(warnings[0], /сбой отправки/)
  ac.abort()
  await rejected
  t.mock.timers.tick(60000)
  assert.equal(warnings.length, 1)
})

test('bone meal targets a visible nearest sapling on the raised bed from all four sides', async () => {
  for (const feet of [new Vec3(1.5, 64, -0.5), new Vec3(4.5, 64, 1.5), new Vec3(1.5, 64, 4.5), new Vec3(-0.5, 64, 1.5)]) {
    const f = fixture()
    const raised = f.plot.map(p => p.offset(0, 1, 0))
    for (const p of raised) { f.set(p, 'podzol'); f.set(p.offset(0, 1, 0), 'spruce_sapling') }
    f.bot.entity.position = feet
    f.bot.heldItem = { name: 'bone_meal', count: 64 }
    const target = nearestSapling(f.bot, raised, 'spruce', () => 0.5)
    assert.ok(target)
    const distances = raised.map(p => p.offset(0.5, 1.375, 0.5).distanceTo(eyePosition(f.bot.entity)))
    assert.equal(target.position.offset(0.5, 0.375, 0.5).distanceTo(eyePosition(f.bot.entity)), Math.min(...distances))
    Object.assign(f.bot.entity, { yaw: target.yaw, pitch: target.pitch })
    const run = growSaplings(f.bot, raised, 'spruce', target.position, new AbortController().signal)
    f.bot.emit('physicsTick')
    const packet = f.packets.find(p => p.name === 'block_place').params
    assert.equal(packet.location.y, 65, 'use targets the sapling above the raised soil')
    f.set(target.position, 'spruce_log')
    assert.equal(await run, 'grown')
  }
})

test('fast human turns are quicker than the original profile with smooth bounded ends and varied paths', () => {
  const radians = Math.PI / 180
  for (const degrees of [5, 45, 90, 179]) {
    const slow = humanPlan(0, 0, degrees * radians, 0, () => 0.5)
    const fast = humanPlan(0, 0, degrees * radians, 0, () => 0.5, true)
    assert.ok(fast.ticks < slow.ticks)
    const points = [{ yaw: 0, pitch: 0 }]
    for (fast.k = 1; fast.k <= fast.ticks; fast.k++) points.push(humanPoint(fast))
    const steps = points.slice(1).map((p, i) => Math.hypot(p.yaw - points[i].yaw, p.pitch - points[i].pitch) / radians)
    const peak = Math.max(...steps)
    assert.ok(peak < 30)
    assert.ok(steps[0] < peak * 0.6 && steps.at(-1) < peak * 0.6)
    assert.ok(Math.abs(points.at(-1).yaw - degrees * radians) < 1e-8)
  }
  assert.notDeepEqual(humanPlan(0, 0, 1, 0, () => 0.1, true), humanPlan(0, 0, 1, 0, () => 0.9, true))
})

test('server crawling pose lowers the eye ray and standing restores it', () => {
  const f = fixture()
  f.bot.entity.id = 1
  attachEyeRaycast(f.bot)
  const pose = value => f.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 6, type: 'pose', value }] })
  pose(3)
  assert.equal(f.bot.entity.eyeHeight, 0.4)
  assert.equal(eyePosition(f.bot.entity).y, 64.4)
  // A shared-flags update must not lift the ray while the pose is still crawling.
  f.bot.entity.eyeHeight = 1.62
  assert.equal(eyePosition(f.bot.entity).y, 64.4)
  pose(0)
  assert.equal(eyePosition(f.bot.entity).y, 65.62)
  pose(3)
  pose(5)
  assert.equal(f.bot.entity.eyeHeight, 1.27)
  pose(3)
  f.bot.emit('botifyDigReset')
  assert.equal(eyePosition(f.bot.entity).y, 65.62)
})

test('headroom clearing includes boundary overlap but excludes mechanisms and placed leaves', () => {
  const f = fixture()
  f.bot.entity.position = new Vec3(0.85, 64, 0.5)
  f.bot.entity.botifyPose = 3
  const overhead = new Vec3(1, 65, 0)
  for (const name of ['stone', 'dispenser', 'spruce_log', 'oak_leaves']) {
    f.set(overhead, name)
    assert.equal(headroomTarget(f.bot, 'spruce', () => 0.5), null)
  }
  f.set(overhead, 'spruce_leaves')
  assert.ok(headroomTarget(f.bot, 'spruce', () => 0.5).block.position.equals(overhead))
  const placed = Block.fromProperties('spruce_leaves', { persistent: true, distance: 1, waterlogged: false }, 0)
  f.bot.world.setBlockStateId(overhead, placed.stateId)
  assert.equal(headroomTarget(f.bot, 'spruce', () => 0.5), null)
})

test('farm clears overhead leaves from crawling eyes, waits for server change, then chops the raised trunk', async () => {
  const f = fixture()
  f.bot.entity.id = 1
  attachEyeRaycast(f.bot)
  const raised = f.plot.map(p => p.offset(0, 1, 0))
  for (const p of raised) { f.set(p, 'podzol'); f.set(p.offset(0, 1, 0), 'spruce_log') }
  const overhead = new Vec3(0, 65, 0)
  f.set(overhead, 'spruce_leaves')
  f.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 6, type: 'pose', value: 3 }] })
  const ac = new AbortController()
  class Cancelled extends Error {}
  const digs = []; const messages = []
  let confirmLeaf
  const run = farmTrees(f.bot, ac.signal, { plot: raised, species: 'spruce', random: () => 0.5 }, {
    checkCancel: s => { if (s.aborted) throw new Cancelled() }, Cancelled,
    reply: text => messages.push(text),
    look: async (yaw, pitch, cancelled) => { if (cancelled()) return false; Object.assign(f.bot.entity, { yaw, pitch }); return true },
    dig: async block => {
      assert.equal(f.bot.heldItem.name, 'netherite_axe')
      digs.push(block.name)
      if (block.name === 'spruce_leaves') {
        assert.ok(block.position.equals(overhead))
        assert.equal(eyePosition(f.bot.entity).y, 64.4)
        await new Promise(resolve => { confirmLeaf = resolve })
      } else {
        assert.equal(block.name, 'spruce_log')
        for (const p of raised) f.set(p.offset(0, 1, 0), 'air')
        ac.abort()
      }
    }
  })
  const rejected = assert.rejects(run, Cancelled)
  for (let i = 0; i < 15; i++) { f.bot.emit('physicsTick'); await flush() }
  assert.deepEqual(digs, ['spruce_leaves'])
  assert.equal(f.bot.blockAt(overhead).name, 'spruce_leaves', 'no local air prediction')
  f.set(overhead, 'air')
  f.bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 6, type: 'pose', value: 0 }] })
  confirmLeaf()
  for (let i = 0; i < 30 && !ac.signal.aborted; i++) { f.bot.emit('physicsTick'); await flush() }
  ac.abort()
  await rejected
  assert.deepEqual(digs, ['spruce_leaves', 'spruce_log'])
  assert.ok(messages.some(text => text.includes('листва мешает встать')))
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

for (const obstruction of ['spruce_leaves', 'dispenser']) test(`farm handles ${obstruction} blocking the trunk without touching mechanisms`, async () => {
  const f = fixture()
  f.bot.entity.position = new Vec3(0.5, 64, -0.5)
  const raised = f.plot.map(p => p.offset(0, 1, 0))
  for (const p of raised) { f.set(p, 'podzol'); f.set(p.offset(0, 1, 0), 'spruce_log') }
  const wall = []
  for (let x = -1; x <= 4; x++) { const p = new Vec3(x, 65, 0); wall.push(p); f.set(p, obstruction) }
  const ac = new AbortController()
  class Cancelled extends Error {}
  const digs = []
  const run = farmTrees(f.bot, ac.signal, { plot: raised, species: 'spruce', random: () => 0.5 }, {
    checkCancel: s => { if (s.aborted) throw new Cancelled() }, Cancelled, reply: () => {},
    look: async (yaw, pitch) => { Object.assign(f.bot.entity, { yaw, pitch }); return true },
    dig: async block => {
      assert.notEqual(block.name, 'dispenser')
      digs.push(block.name)
      if (block.name === 'spruce_leaves') for (const p of wall) f.set(p, 'air')
      else ac.abort()
    }
  })
  const rejected = assert.rejects(run, Cancelled)
  for (let i = 0; i < 60 && !ac.signal.aborted; i++) { f.bot.emit('physicsTick'); await flush() }
  ac.abort()
  await rejected
  assert.deepEqual(digs, obstruction === 'spruce_leaves' ? ['spruce_leaves', 'spruce_log'] : [])
})
