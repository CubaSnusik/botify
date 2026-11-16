'use strict'
require('../scripts/patch-physics')()
require('../scripts/patch-pathfinder')()
require('../scripts/patch-digging')()
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { performance } = require('node:perf_hooks')
const { Vec3 } = require('vec3')
const { PlayerState } = require('prismarine-physics')
const { attachVanillaTick } = require('../src/vanilla')

function fixture (version = '26.1', patched = true, smoothLook = false) {
  const bot = new EventEmitter()
  bot.version = version
  bot.registry = require('prismarine-registry')(version)
  bot.supportFeature = bot.registry.supportFeature
  bot._client = new EventEmitter()
  bot._client.state = 'play'
  bot._client.version = version
  const packets = []
  bot._client.write = (name, params) => packets.push({ name, params: structuredClone(params) })
  bot.entity = {
    id: 1, position: new Vec3(0.5, 1, 0.5), velocity: new Vec3(0, 0, 0),
    yaw: 0, pitch: 0, onGround: true, height: 1.8, effects: {}, attributes: {}
  }
  bot.inventory = { slots: [] }
  bot.game = { gameMode: 'survival' }
  bot.food = 20
  bot.isAlive = true
  const Block = require('prismarine-block')(bot.registry)
  bot.blockAt = pos => {
    const block = Block.fromStateId(pos.y < 1 ? bot.registry.blocksByName.stone.minStateId : 0, 0)
    block.position = pos.floored()
    return block
  }
  // Most tests isolate packet/physics behavior; smooth-turn routes opt into the production controller.
  const hooks = patched ? attachVanillaTick(bot, { smoothLook }) : null
  require('mineflayer/lib/plugins/physics')(bot, {})
  // Exercise the real Mineflayer physics loop deterministically, without sockets or sleeps.
  let run
  const setInterval = global.setInterval
  let now = performance.now() + 25
  global.setInterval = fn => { run = fn; return null }
  try { bot.emit('login') } finally { global.setInterval = setInterval }
  bot.emit('spawn')
  bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, yaw: 180, pitch: 0, flags: {}, teleportId: 1 })
  bot.entity.onGround = true
  packets.length = 0
  function tick () {
    now += 50
    hooks?.before()
    const descriptor = Object.getOwnPropertyDescriptor(performance, 'now')
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
    try { run() } finally {
      if (descriptor) Object.defineProperty(performance, 'now', descriptor)
      else delete performance.now
      hooks?.after()
    }
  }
  return { bot, packets, tick, hooks }
}

function distance (fixture) {
  const start = fixture.bot.entity.position.clone()
  fixture.tick()
  return fixture.bot.entity.position.distanceTo(start)
}

test('26.1 repeated enchanted-axe digs keep START and STOP on separate complete physics ticks', async () => {
  const f = fixture('26.1', true, true)
  const { bot } = f
  require('mineflayer/lib/plugins/digging')(bot)
  require('../src/dig-speed').attachVanillaDigSpeed(bot)
  bot.entity.attributes.mining_efficiency = { value: 26, modifiers: [] }
  bot.heldItem = { type: bot.registry.itemsByName.netherite_axe.id }
  bot.swingArm = () => bot._client.write('arm_animation', { hand: 0 })
  const Block = require('prismarine-block')(bot.registry)
  const log = Block.fromStateId(bot.registry.blocksByName.spruce_log.defaultState, 0)
  log.position = new Vec3(2, 2, 0)
  bot.blockAtCursor = () => log
  const turn = bot.smoothLook.turn(-Math.PI / 2, 0, () => false, 'human')
  for (let i = 0; i < 60; i++) f.tick()
  assert.equal(await turn, true)
  f.packets.length = 0
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = bot.dig(log, 'ignore', 4)
    const offset = f.packets.length
    for (let i = 0; i < 3; i++) {
      const tickOffset = f.packets.length
      f.tick()
      const frame = f.packets.slice(tickOffset)
      assert.equal(frame.at(-1).name, 'tick_end')
      assert.equal(frame.filter(p => p.name === 'arm_animation').length, 1)
      const action = frame.find(p => p.name === 'block_dig')
      assert.equal(action?.params.status, [0, undefined, 2][i])
      if (i === 0) bot._client.emit('acknowledge_player_digging', { sequenceId: action.params.sequence })
    }
    assert.deepEqual(f.packets.slice(offset).filter(p => p.name === 'block_dig').map(p => p.params.sequence),
      [attempt * 2 + 1, attempt * 2 + 2])
    bot.emit(`blockUpdate:${log.position}`, log, { type: 0, position: log.position })
    await pending
    for (let i = 0; i < 6; i++) f.tick()
  }
})

for (const reference of [...require('./reference/walking-26.1.json'), ...require('./reference/walking-26.2.json')]) {
  const version = reference.version || '26.1'
  test(`${version} trajectory matches Java float reference: ${reference.name}`, () => {
    const f = fixture(version)
    const { bot } = f
    const Block = require('prismarine-block')(bot.registry)
    const floor = reference.slip === 0.98 ? 'ice' : reference.slip === 0.989 ? 'blue_ice' : 'stone'
    bot.blockAt = pos => {
      const block = Block.fromStateId(pos.y < 1 ? bot.registry.blocksByName[floor].minStateId : 0, 0)
      block.position = pos.floored()
      return block
    }
    // Establish the same continuous wire angle, including angles beyond one revolution.
    bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, yaw: reference.yaw, pitch: 0, flags: {}, teleportId: 80 })
    bot.entity.onGround = true
    bot.entity.velocity.y = -0.08 * Math.fround(0.98)
    bot.entity.attributes['generic.movement_speed'] = { value: reference.speed, modifiers: [] }
    if (version === '26.2') {
      bot.entity.attributes['minecraft:friction_modifier'] = { value: reference.frictionModifier, modifiers: [] }
      bot.entity.attributes['minecraft:air_drag_modifier'] = { value: reference.airDragModifier, modifiers: [] }
    }
    assert.equal(bot.physics.botifyWalkingProfile, version)
    if (reference.boost) bot.entity.effects[bot.registry.effectsByName.JumpBoost.id] = { amplifier: reference.boost - 1 }
    bot.usingHeldItem = reference.use !== 1
    bot.setControlState('forward', reference.forward > 0)
    bot.setControlState('right', reference.right > 0)
    bot.setControlState('left', reference.right < 0)
    bot.setControlState('sprint', reference.sprint)
    bot.setControlState('sneak', reference.sneak)
    bot.setControlState('jump', reference.jump)
    for (let tick = 1; tick <= 60; tick++) {
      if (tick === 2) bot.setControlState('jump', false)
      if (tick === 41) bot.clearControlStates()
      f.tick()
      const expected = reference.frames.find(frame => frame.tick === tick)
      if (!expected) continue
      for (const [i, axis] of ['x', 'y', 'z'].entries()) {
        assert.ok(Math.abs(bot.entity.position[axis] - expected.position[i]) < 1e-10,
          `${reference.name} position.${axis} tick ${tick}: ${bot.entity.position[axis]} vs ${expected.position[i]}`)
        assert.ok(Math.abs(bot.entity.velocity[axis] - expected.velocity[i]) < 1e-10,
          `${reference.name} velocity.${axis} tick ${tick}: ${bot.entity.velocity[axis]} vs ${expected.velocity[i]}`)
      }
      assert.equal(bot.entity.isCollidedHorizontally, false, 'rounding must not report a wall or cancel sprint')
    }
  })
}

function shapedWorld (bot, select) {
  const Block = require('prismarine-block')(bot.registry)
  bot.blockAt = pos => {
    const at = pos.floored()
    const selected = select(at)
    const block = Block.fromStateId(selected ? bot.registry.blocksByName[selected.name || 'stone'].minStateId : 0, 0)
    block.position = at
    if (selected?.shapes) block.shapes = selected.shapes
    return block
  }
}

for (const zFirst of [false, true]) {
  test(`26.1 corner clips the larger horizontal component first (${zFirst ? 'Z' : 'X'})`, () => {
    const f = fixture()
    shapedWorld(f.bot, p => p.y === 0 || (p.x === 1 && p.z === 1 && p.y <= 3) ? {} : null)
    f.bot.entity.velocity.set(zFirst ? 0.4 : 0.6, -0.0784, zFirst ? 0.6 : 0.4)
    f.tick()
    const stopped = 1 - Math.fround(0.6) / 2
    assert.ok(Math.abs(f.bot.entity.position.x - (zFirst ? stopped : 1.1)) < 1e-12)
    assert.ok(Math.abs(f.bot.entity.position.z - (zFirst ? 1.1 : stopped)) < 1e-12)
    assert.equal(f.bot.entity.isCollidedHorizontally, true)
    assert.equal(f.bot.entity.velocity[zFirst ? 'x' : 'z'], 0)
  })
}

for (const falling of [false, true]) {
  test(`26.1 steps onto a half slab using its actual height${falling ? ' while landing' : ''}`, () => {
    const f = fixture()
    shapedWorld(f.bot, p => p.y === 0 ? {} : p.y === 1 && p.z >= 1 ? { shapes: [[0, 0, 0, 1, 0.5, 1]] } : null)
    if (falling) { f.bot.entity.position.y = 1.1; f.bot.entity.onGround = false }
    f.bot.entity.velocity.set(0, falling ? -0.2 : -0.0784, 0.4)
    f.tick()
    assert.ok(Math.abs(f.bot.entity.position.z - 0.9) < 1e-12)
    assert.ok(Math.abs(f.bot.entity.position.y - 1.5) < 1e-12)
    assert.equal(f.bot.entity.isCollidedHorizontally, false)
    assert.equal(f.bot.entity.onGround, true)
  })
}

test('26.1 refuses a step when the ceiling leaves too little headroom', () => {
  const f = fixture()
  shapedWorld(f.bot, p => p.y === 0 || p.y === 3 ? {} : p.y === 1 && p.z >= 1 ? { shapes: [[0, 0, 0, 1, 0.5, 1]] } : null)
  f.bot.entity.velocity.set(0, -0.0784, 0.4)
  f.tick()
  assert.equal(f.bot.entity.position.y, 1)
  assert.ok(Math.abs(f.bot.entity.position.z - (1 - Math.fround(0.6) / 2)) < 1e-12)
  assert.equal(f.bot.entity.isCollidedHorizontally, true)
})

test('26.1 sneak edge checks collision overlap, not just neighboring block presence', () => {
  const f = fixture()
  shapedWorld(f.bot, p => p.y === 0 && p.x === 0 && p.z === 0 ? {} : null)
  f.bot.setControlState('sneak', true)
  f.bot.entity.velocity.set(0.9, -0.0784, 0)
  f.tick()
  // Reduce by 0.05 until the contracted feet box still overlaps the supporting block.
  assert.ok(Math.abs(f.bot.entity.position.x - 1.25) < 1e-12)
  assert.equal(f.bot.entity.onGround, true)
  assert.equal(f.bot.entity.isCollidedHorizontally, false, 'edge backoff is not a wall collision')
})

test('26.1 friction follows the supporting ice block when the center hangs over its edge', () => {
  const f = fixture()
  shapedWorld(f.bot, p => p.y === 0 && p.x === 0 ? { name: 'ice' } : null)
  f.bot.entity.position.x = 1.1
  f.bot.entity.velocity.set(0, -0.0784, 0.2)
  f.tick()
  assert.ok(Math.abs(f.bot.entity.velocity.z - 0.2 * Math.fround(Math.fround(0.98) * Math.fround(0.91))) < 1e-12)
  assert.equal(f.bot.entity.onGround, true)
})

test('26.1 thick snow above ice samples friction half a meter below the feet', () => {
  const f = fixture()
  shapedWorld(f.bot, p => p.y === 0 ? { name: 'ice' } : p.y === 1 ? { name: 'snow', shapes: [[0, 0, 0, 1, 0.875, 1]] } : null)
  f.bot.entity.position.y = 1.875
  f.bot.entity.velocity.set(0, -0.0784, 0.2)
  f.tick()
  assert.ok(Math.abs(f.bot.entity.velocity.z - 0.2 * Math.fround(Math.fround(0.6) * Math.fround(0.91))) < 1e-12)
})

test('26.1 using an item slows movement and stops sprint in simulation and packets', () => {
  const f = fixture()
  f.bot.setControlState('forward', true)
  f.bot.setControlState('sprint', true)
  f.tick()
  f.packets.length = 0
  f.bot.usingHeldItem = true
  f.bot.entity.onGround = true
  f.bot.entity.velocity.set(0, -0.0784, 0)
  const start = f.bot.entity.position.clone()
  f.tick()
  assert.equal(f.packets.find(p => p.name === 'entity_action')?.params.actionId, 'stop_sprinting')
  assert.ok(f.bot.entity.position.distanceTo(start) < 0.021)
  f.bot.heldItem = { components: [{ type: 'use_effects', data: { can_sprint: true, speed_multiplier: 1 } }] }
  f.packets.length = 0
  f.tick()
  assert.equal(f.packets.find(p => p.name === 'entity_action')?.params.actionId, 'start_sprinting')
})

test('26.1 honors the wire movement-speed attribute and keeps the server copy intact', () => {
  const normal = fixture()
  const slow = fixture()
  normal.bot.setControlState('forward', true)
  slow.bot.setControlState('forward', true)
  slow.bot.entity.attributes['generic.movement_speed'] = { value: 0.05, modifiers: [] }
  const saved = structuredClone(slow.bot.entity.attributes)
  assert.ok(Math.abs(distance(slow) / distance(normal) - 0.5) < 1e-9)
  assert.deepEqual(slow.bot.entity.attributes, saved)
})

test('26.1 applies sprint once with a server sprint modifier, including pathfinder predictions', () => {
  const a = fixture()
  const b = fixture()
  for (const f of [a, b]) {
    f.bot.setControlState('forward', true)
    f.bot.setControlState('sprint', true)
    f.bot.entity.attributes['generic.movement_speed'] = { value: 0.1, modifiers: [] }
  }
  b.bot.entity.attributes['generic.movement_speed'].modifiers.push({ uuid: 'minecraft:sprinting', amount: 0.3, operation: 2 })
  const saved = structuredClone(b.bot.entity.attributes)
  const prediction = new PlayerState(b.bot, { forward: true, sprint: false })
  b.bot.physics.simulatePlayer(prediction, { getBlock: b.bot.blockAt })
  assert.deepEqual(b.bot.entity.attributes, saved)
  assert.ok(Math.abs(distance(a) - distance(b)) < 1e-9)
  assert.deepEqual(b.bot.entity.attributes, saved)
})

for (const version of ['1.20.4', '1.21.3', '1.21.5', '26.1', '26.2']) {
  test(`${version}: sprint changes made by pathfinder wait for the corresponding movement tick`, () => {
    const f = fixture(version)
    f.bot.setControlState('forward', true)
    f.bot.once('physicsTick', () => f.bot.setControlState('sprint', true))
    f.tick()
    assert.equal(f.packets.filter(p => p.name === 'entity_action').length, 0)
    f.packets.length = 0
    f.tick()
    const sprint = f.packets.findIndex(p => p.name === 'entity_action')
    const move = f.packets.findIndex(p => p.name === 'position' || p.name === 'position_look')
    assert.ok(sprint >= 0 && sprint < move)
    assert.equal(f.packets[sprint].params.actionId, 'start_sprinting')
    if (version === '26.1') {
      assert.equal(f.packets[0].name, 'player_input')
      assert.equal(f.packets.at(-1).name, 'tick_end')
    }
  })
}

test('26.1 sprint key without forward input does not accelerate strafing or announce sprint', () => {
  const a = fixture()
  const b = fixture()
  a.bot.setControlState('right', true)
  b.bot.setControlState('right', true)
  b.bot.setControlState('sprint', true)
  assert.ok(Math.abs(distance(a) - distance(b)) < 1e-9)
  assert.equal(b.packets.filter(p => p.name === 'entity_action').length, 0)
  assert.equal(b.packets.find(p => p.name === 'player_input').params.inputs.sprint, true)
})

test('26.1 releasing Ctrl keeps sprinting while W is held; releasing W stops it (LocalPlayer.aiStep)', () => {
  const f = fixture()
  const walk = fixture()
  f.bot.setControlState('forward', true)
  f.bot.setControlState('sprint', true)
  walk.bot.setControlState('forward', true)
  for (let i = 0; i < 10; i++) { f.tick(); walk.tick() }
  f.packets.length = 0
  f.bot.setControlState('sprint', false)
  const sprintStep = distance(f)
  const walkStep = distance(walk)
  assert.equal(f.packets.some(p => p.name === 'entity_action'), false, 'no STOP_SPRINTING on Ctrl release')
  assert.equal(f.packets.find(p => p.name === 'player_input').params.inputs.sprint, false)
  assert.ok(sprintStep > walkStep * 1.25, `still sprint speed: ${sprintStep} vs walking ${walkStep}`)
  assert.equal(f.bot.entity.botifySprinting, true)
  f.packets.length = 0
  f.bot.setControlState('forward', false)
  f.tick()
  assert.equal(f.packets.find(p => p.name === 'entity_action')?.params.actionId, 'stop_sprinting')
  f.packets.length = 0
  f.bot.setControlState('forward', true)
  f.tick()
  assert.equal(f.packets.some(p => p.name === 'entity_action'), false, 'W alone does not start sprinting again')
})

function worldOf (f, pick) {
  const Block = require('prismarine-block')(f.bot.registry)
  f.bot.blockAt = pos => {
    const p = pos.floored()
    const name = pick(p.x, p.y, p.z)
    if (name === null) return null
    const block = Block.fromStateId(f.bot.registry.blocksByName[name].minStateId, 0)
    block.position = p
    return block
  }
}

test('26.1 wading in shallow water stops sprinting (isSprintingPossible: !isInShallowWater)', () => {
  const f = fixture()
  worldOf(f, (x, y, z) => y < 1 ? 'stone' : y === 1 && z < -2 ? 'water' : 'air')
  f.bot.setControlState('forward', true)
  f.bot.setControlState('sprint', true)
  for (let i = 0; i < 8; i++) f.tick()
  assert.equal(f.bot.entity.botifySprinting, true, 'sprints on land')
  // The sprint check of a tick sees that tick's fluid state (baseTick runs before aiStep):
  // the tick that travels in water already does it without sprint.
  for (let i = 0; i < 20 && !f.bot.entity.isInWater; i++) {
    f.packets.length = 0
    f.tick()
  }
  assert.equal(f.bot.entity.isInWater, true)
  assert.equal(f.bot.entity.botifySprinting, false, 'head above water: sprint stops in the entering tick')
  assert.equal(f.packets.find(p => p.name === 'entity_action')?.params.actionId, 'stop_sprinting')
})

test('26.1 water: enters with the 0.001-deflated box, sinks at travelInWater speed, swims up with jump', () => {
  // A 2-deep pool north of the start: water at y=0 (surface 0.889) and y=-1.
  const pool = (x, y, z) => z <= -2 && z >= -5 && (y === 0 || y === -1)
  const f = fixture()
  worldOf(f, (x, y, z) => pool(x, y, z) ? 'water' : y < 1 && !(z <= -2 && z >= -5 && y >= -1) ? 'stone' : 'air')
  f.bot.setControlState('forward', true)
  let entered = null
  const trace = []
  for (let i = 0; i < 60; i++) {
    const startY = f.bot.entity.position.y
    f.tick()
    trace.push({ y: f.bot.entity.position.y, vy: f.bot.entity.velocity.y, water: f.bot.entity.isInWater })
    if (entered === null && f.bot.entity.isInWater) entered = { tick: i, startY }
  }
  assert.ok(entered, 'reaches the water')
  // EntityFluidInteraction: in water as soon as the box bottom (+0.001) is below the surface.
  assert.ok(entered.startY + 0.001 >= 0.889 - 0.5, 'not detected late')
  const settled = trace.slice(-10)
  for (const t of settled) assert.ok(t.vy > -0.03 && t.vy < 0, `sinks slowly in water (vy ${t.vy})`)
  // Holding jump in deep water swims up (+0.04 per tick).
  f.bot.setControlState('forward', false)
  f.bot.setControlState('jump', true)
  const before = f.bot.entity.position.y
  for (let i = 0; i < 20; i++) f.tick()
  assert.ok(f.bot.entity.position.y > before + 0.3, `swims up: ${before} -> ${f.bot.entity.position.y}`)
})

test('26.1 flowing water: FlowingFluid.getFlow pushes downstream; solid sides do not count', () => {
  const walking = require('../src/vanilla-walking')
  // A channel at y=0 running west (-x) from a source at x=3, solid ground on both sides.
  const levels = { 3: 0, 2: 1, 1: 2, 0: 3, '-1': 4 }
  const f = fixture()
  const Block = require('prismarine-block')(f.bot.registry)
  f.bot.blockAt = pos => {
    const p = pos.floored()
    let block
    if (p.y === 0 && p.z === 0 && p.x in levels) block = Block.fromStateId(f.bot.registry.blocksByName.water.minStateId + levels[p.x], 0)
    else block = Block.fromStateId(p.y <= 0 ? f.bot.registry.blocksByName.stone.minStateId : 0, 0)
    block.position = p
    return block
  }
  const world = { getBlock: p => f.bot.blockAt(p) }
  const at = new Vec3(1, 0, 0)
  const flow = walking.fluidFlow(world, at, walking.fluidOf(world.getBlock(at)), world.getBlock(at))
  assert.ok(flow.x < -0.99 && Math.abs(flow.z) < 1e-9, `flows west only: ${JSON.stringify(flow)}`)
  f.bot.entity.position.set(1.5, 0, 0.5)
  f.bot.entity.onGround = true
  const startX = f.bot.entity.position.x
  for (let i = 0; i < 20; i++) f.tick()
  assert.ok(f.bot.entity.isInWater)
  assert.ok(f.bot.entity.position.x < startX - 0.05, `carried downstream: ${startX} -> ${f.bot.entity.position.x}`)
  assert.ok(Math.abs(f.bot.entity.position.z - 0.5) < 1e-6, 'no sideways push from the solid banks')
})

test('26.1 crouching keeps an existing sprint but does not start one (isMovingSlowly)', () => {
  const f = fixture()
  f.bot.setControlState('forward', true)
  f.bot.setControlState('sprint', true)
  for (let i = 0; i < 5; i++) f.tick()
  f.packets.length = 0
  f.bot.setControlState('sneak', true)
  f.tick()
  assert.equal(f.packets.some(p => p.name === 'entity_action' && /sprinting/.test(p.params.actionId)), false)
  assert.equal(f.bot.entity.botifySprinting, true)
  const g = fixture()
  g.bot.setControlState('forward', true)
  g.bot.setControlState('sneak', true)
  g.bot.setControlState('sprint', true)
  g.tick()
  assert.equal(g.bot.entity.botifySprinting, false, 'cannot start sprinting while crouching')
})

test('26.1 gravity comes from the minecraft:gravity attribute', () => {
  const f = fixture()
  f.bot.entity.position.set(0.5, 10, 0.5)
  f.bot.entity.onGround = false
  f.bot.entity.attributes['minecraft:gravity'] = { value: 0.04, modifiers: [] }
  f.tick()
  assert.ok(Math.abs(f.bot.entity.velocity.y - (0 - 0.04) * Math.fround(0.98)) < 1e-9, `vy ${f.bot.entity.velocity.y}`)
})

test('26.1 above an unloaded chunk the player drifts at -0.1 instead of falling', () => {
  const f = fixture()
  worldOf(f, (x, y) => y > 5 ? 'air' : null)
  f.bot.entity.position.set(0.5, 6, 0.5)
  f.bot.entity.onGround = false
  f.tick()
  assert.ok(Math.abs(f.bot.entity.velocity.y - -0.1 * Math.fround(0.98)) < 1e-9, `vy ${f.bot.entity.velocity.y}`)
})

test('26.1 minecarts are solid; a boat is low enough to step onto', () => {
  const f = fixture()
  f.bot.entities = { 2: { id: 2, name: 'minecart', position: new Vec3(0.5, 1, -1.5), width: 0.98, height: 0.7 } }
  f.bot.setControlState('forward', true)
  for (let i = 0; i < 20; i++) f.tick()
  assert.ok(f.bot.entity.position.z >= -1.01 + 0.3 - 1e-6, `stopped at the minecart, z ${f.bot.entity.position.z}`)
  assert.equal(f.bot.entity.position.y, 1)
  const g = fixture()
  g.bot.entities = { 2: { id: 2, name: 'oak_boat', position: new Vec3(0.5, 1, -1.5), width: 1.375, height: 0.5625 } }
  g.bot.setControlState('forward', true)
  let top = 0
  for (let i = 0; i < 20; i++) { g.tick(); top = Math.max(top, g.bot.entity.position.y) }
  assert.ok(Math.abs(top - 1.5625) < 1e-6, `stepped onto the boat, highest y ${top}`)
})

test('26.1 leaving a cobweb: the move that left it still counts (swept checkInsideBlocks)', () => {
  const f = fixture()
  // Cobweb in the block north of the start (z = -1); the bot starts touching it and walks south.
  worldOf(f, (x, y, z) => y < 1 ? 'stone' : y === 1 && x === 0 && z === -1 ? 'cobweb' : 'air')
  f.bot.entity.position.set(0.5, 1, 0.2)
  f.bot.entity.yaw = Math.PI // south (+z)
  f.bot.setControlState('forward', true)
  let left = null
  for (let i = 0; i < 40 && left === null; i++) {
    const start = f.bot.entity.position.z
    f.tick()
    // the tick whose START box touched the web but whose END box no longer does
    if (start - 0.3 < 0 - 9.999999747378752e-6 && f.bot.entity.position.z - 0.3 >= 0) left = i
  }
  assert.notEqual(left, null, 'walked out of the cobweb')
  const before = f.bot.entity.position.z
  f.tick()
  const step = f.bot.entity.position.z - before
  assert.ok(step < 0.05, `the next move is still slowed by the web (moved ${step.toFixed(4)})`)
})

test('26.1 sweet berry bushes slow the player like makeStuckInBlock(0.8, 0.75, 0.8)', () => {
  const plain = fixture()
  const bush = fixture()
  worldOf(bush, (x, y) => y < 1 ? 'stone' : y === 1 ? 'sweet_berry_bush' : 'air')
  for (const f of [plain, bush]) {
    f.bot.setControlState('forward', true)
    for (let i = 0; i < 10; i++) f.tick()
  }
  const free = 0.5 - plain.bot.entity.position.z
  const slowed = 0.5 - bush.bot.entity.position.z
  assert.ok(slowed < free * 0.8, `bush ${slowed.toFixed(3)} vs free ${free.toFixed(3)}`)
})

test('26.1 losing hunger stops sprint in both simulation and packets', () => {
  const f = fixture()
  f.bot.setControlState('forward', true)
  f.bot.setControlState('sprint', true)
  f.tick()
  f.packets.length = 0
  f.bot.food = 6
  f.tick()
  assert.equal(f.packets.find(p => p.name === 'entity_action').params.actionId, 'stop_sprinting')
})

test('26.1 pathfinder turns are sent with the movement that used that yaw', () => {
  const f = fixture()
  f.bot.setControlState('forward', true)
  f.bot.once('physicsTick', () => { f.bot.look(Math.PI / 2, 0, true) })
  const start = f.bot.entity.position.clone()
  f.tick()
  assert.ok(Math.abs(f.bot.entity.position.x - start.x) < 1e-9)
  const first = f.packets.find(p => p.name === 'position' || p.name === 'position_look')
  assert.equal(first.params.yaw, 180)
  f.packets.length = 0
  f.tick()
  assert.equal(f.packets.find(p => p.name === 'position_look').params.yaw, 90)
})

test('26.1 respawn resends held inputs and sprint state', () => {
  const f = fixture()
  f.bot.setControlState('forward', true)
  f.bot.setControlState('sprint', true)
  f.tick()
  f.packets.length = 0
  f.bot.emit('respawn')
  f.hooks.before()
  assert.equal(f.packets[0].name, 'player_input')
  assert.equal(f.packets[1].params.actionId, 'start_sprinting')
})

test('26.1 corrections use independent velocity flags, not position flags', () => {
  const f = fixture()
  f.bot.entity.velocity.set(0.25, 0.5, -0.75)
  f.bot._client.emit('position', {
    x: 2, y: 3, z: 4, dx: 0.1, dy: 0.2, dz: 0.3,
    yaw: 0, pitch: 0, flags: { x: true, z: true, dy: true }, teleportId: 2
  })
  assert.deepEqual(f.bot.entity.velocity, new Vec3(0.1, 0.7, 0.3))
  assert.deepEqual(f.bot.entity.position, new Vec3(2.5, 3, 4.5))
  assert.equal(f.packets[0].name, 'teleport_confirm')
})

test('26.1 correction rotates retained velocity when ROTATE_DELTA is set', () => {
  const f = fixture()
  f.bot.entity.velocity.set(0, 0, 1)
  f.bot._client.emit('position', {
    x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0,
    yaw: 90, pitch: 0,
    flags: { x: true, y: true, z: true, yaw: true, dx: true, dy: true, dz: true, yawDelta: true },
    teleportId: 3
  })
  assert.ok(Math.abs(f.bot.entity.velocity.x + 1) < 1e-6)
  assert.ok(Math.abs(f.bot.entity.velocity.z) < 1e-6)
})

// An anticheat setback: an absolute correction to (roughly) where the player already is.
// `motion: true` carries the velocity the server predicted (what a prediction anticheat sends,
// including the resting -0.0784 that keeps a standing player colliding with the ground).
function setback (f, id, { motion = false } = {}) {
  const p = f.bot.entity.position
  const v = f.bot.entity.velocity
  f.bot._client.emit('position', {
    x: p.x, y: p.y, z: p.z,
    dx: motion ? v.x : 0, dy: motion ? v.y : 0, dz: motion ? v.z : 0,
    yaw: 180, pitch: 0, flags: {}, teleportId: id
  })
}

test('26.1 a correction keeps the ground state: the next tick accelerates on the ground, not in the air', () => {
  const f = fixture()
  f.bot.setControlState('forward', true)
  for (let i = 0; i < 12; i++) f.tick()
  assert.equal(f.bot.entity.onGround, true)
  setback(f, 20)
  assert.equal(f.bot.entity.onGround, true, 'vanilla does not clear onGround on a position correction')
  const ack = f.packets.findLast(p => p.name === 'position_look')
  assert.equal(ack.params.flags.onGround, false, 'the acknowledging packet itself reports onGround=false like vanilla')
  const first = distance(f)
  // from rest on the ground: 0.1 speed * 0.98 input = 0.098; airborne would be 0.02 * 0.98 = 0.0196
  assert.ok(Math.abs(first - 0.098) < 1e-6, `ground acceleration expected, moved ${first}`)
})

test('26.1 being corrected on every tick does not collapse into an air-acceleration crawl', () => {
  const corrected = fixture()
  const free = fixture()
  for (const f of [corrected, free]) {
    f.bot.setControlState('forward', true)
    for (let i = 0; i < 12; i++) f.tick()
  }
  const start = corrected.bot.entity.position.clone()
  const freeStart = free.bot.entity.position.clone()
  for (let i = 0; i < 20; i++) {
    setback(corrected, 30 + i, { motion: true })
    assert.equal(corrected.bot.entity.onGround, true)
    corrected.tick()
    free.tick()
  }
  const moved = corrected.bot.entity.position.distanceTo(start)
  const expected = free.bot.entity.position.distanceTo(freeStart)
  // a correction that confirms the predicted state must be invisible to the movement
  assert.ok(Math.abs(moved - expected) < 1e-9, `corrected bot moved ${moved}, uncorrected ${expected}`)
})

test('26.1 a correction keeps the jump cooldown, a respawn starts with a fresh entity', () => {
  const f = fixture()
  f.bot.jumpTicks = 7
  setback(f, 50)
  assert.equal(f.bot.jumpTicks, 7)
  f.bot.emit('respawn')
  setback(f, 51)
  assert.equal(f.bot.entity.onGround, false, 'new entity after respawn: not on ground until physics says so')
})

test('26.1 keeps a small lateral velocity while moving along the other axis', () => {
  const f = fixture()
  f.bot.entity.velocity.set(0.0027, 0, 0.12)
  const start = f.bot.entity.position.clone()
  f.tick()
  assert.ok(Math.abs(f.bot.entity.position.x - start.x - 0.0027) < 1e-12)
  assert.ok(Math.abs(f.bot.entity.position.z - start.z - 0.12) < 1e-12)
})

test('26.1 stopping retains diagonal inertia until the whole horizontal vector is small', () => {
  const f = fixture()
  f.bot.setControlState('forward', true)
  f.tick()
  f.bot.clearControlStates()
  f.bot.entity.onGround = true
  f.bot.entity.velocity.set(0.0025, -0.0784, 0.03)
  let expectedX = 0.0025
  let expectedZ = 0.03
  for (let tick = 0; tick < 8; tick++) {
    const start = f.bot.entity.position.clone()
    if (Math.hypot(expectedX, expectedZ) < 0.003) { expectedX = 0; expectedZ = 0 }
    f.tick()
    assert.ok(Math.abs(f.bot.entity.position.x - start.x - expectedX) < 1e-12, `lateral displacement at tick ${tick}`)
    assert.ok(Math.abs(f.bot.entity.position.z - start.z - expectedZ) < 1e-12, `forward displacement at tick ${tick}`)
    expectedX *= Math.fround(Math.fround(0.6) * Math.fround(0.91))
    expectedZ *= Math.fround(Math.fround(0.6) * Math.fround(0.91))
  }
})

test('26.1 retains diagonal components individually below 0.003 when their length exceeds it', () => {
  const f = fixture()
  f.bot.entity.velocity.set(0.0025, 0.002, -0.0025)
  const start = f.bot.entity.position.clone()
  f.tick()
  assert.ok(Math.abs(f.bot.entity.position.x - start.x - 0.0025) < 1e-12)
  assert.ok(Math.abs(f.bot.entity.position.z - start.z + 0.0025) < 1e-12)
  assert.equal(f.bot.entity.position.y, start.y)
})

test('1.21.4 preserves the old component-wise movement threshold', () => {
  const f = fixture('1.21.4')
  f.bot.entity.velocity.set(0.0025, 0, 0.12)
  const start = f.bot.entity.position.clone()
  f.tick()
  assert.equal(f.bot.entity.position.x, start.x)
})

test('26.1 forced turns cross 360 degrees continuously in both directions', () => {
  const f = fixture()
  let lastYaw
  for (const degrees of [350, 359, 1, 10, 1, 359, 350]) {
    f.bot.look((180 - degrees) * Math.PI / 180, 0, true)
    f.packets.length = 0
    f.tick()
    const yaw = f.packets.find(p => p.name === 'look' || p.name === 'position_look')?.params.yaw
    assert.ok(Number.isFinite(yaw), 'rotation sent')
    if (lastYaw != null) assert.ok(Math.abs(yaw - lastYaw) < 11, `${lastYaw} -> ${yaw}`)
    lastYaw = yaw
  }
})

test('26.1 keeps yaw continuous across multiple full rotations and a server correction', () => {
  const f = fixture()
  let lastYaw = 180
  for (let degrees = 190; degrees <= 1450; degrees += 10) {
    f.bot.look((180 - degrees % 360) * Math.PI / 180, 0, true)
    f.packets.length = 0
    f.tick()
    const yaw = f.packets.find(p => p.name === 'look' || p.name === 'position_look').params.yaw
    assert.ok(Math.abs(yaw - lastYaw - 10) < 0.16, `${lastYaw} -> ${yaw}`)
    lastYaw = yaw
  }
  f.bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, yaw: 725, pitch: 0, flags: {}, teleportId: 4 })
  f.bot.look((180 - 15) * Math.PI / 180, 0, true)
  f.packets.length = 0
  f.tick()
  const yaw = f.packets.find(p => p.name === 'look' || p.name === 'position_look').params.yaw
  assert.ok(Math.abs(yaw - 735) < 0.16, `post-correction yaw ${yaw}`)
})

function withWall (f) {
  const floor = f.bot.blockAt
  const Block = require('prismarine-block')(f.bot.registry)
  f.bot.blockAt = pos => {
    if (pos.z < 0 && pos.y >= 1 && pos.y < 4) {
      const block = Block.fromStateId(f.bot.registry.blocksByName.stone.minStateId, 0)
      block.position = pos.floored()
      return block
    }
    return floor(pos)
  }
}

test('26.1 hard wall collision stops sprint before the next movement, and resumes after leaving the wall', () => {
  const f = fixture()
  withWall(f)
  f.bot.entity.yaw = Math.PI / 4
  f.bot.setControlState('forward', true)
  f.bot.setControlState('sprint', true)
  for (let i = 0; i < 10 && !f.bot.entity.isCollidedHorizontally; i++) f.tick()
  assert.equal(f.bot.entity.isCollidedHorizontally, true)
  const prediction = new PlayerState(f.bot, { forward: true, sprint: false })
  f.bot.physics.simulatePlayer(prediction, { getBlock: f.bot.blockAt })
  f.packets.length = 0
  f.tick()
  const stop = f.packets.findIndex(p => p.name === 'entity_action' && p.params.actionId === 'stop_sprinting')
  const move = f.packets.findIndex(p => p.name === 'position' || p.name === 'position_look')
  assert.ok(stop >= 0 && stop < move, 'STOP_SPRINTING before the following movement')
  assert.ok(f.bot.entity.position.distanceTo(prediction.pos) < 1e-9, 'simulation uses walking acceleration')
  assert.equal(f.bot.controlState.sprint, true, 'held key is preserved')
  f.bot.entity.yaw = Math.PI
  f.tick()
  assert.equal(f.bot.entity.isCollidedHorizontally, false)
  f.packets.length = 0
  f.tick()
  assert.equal(f.packets.find(p => p.name === 'entity_action')?.params.actionId, 'start_sprinting')
})

test('pathfinder reaching a goal preserves the position and velocity produced by physics', () => {
  const f = fixture()
  const { pathfinder, goals } = require('mineflayer-pathfinder')
  let simulatedPosition, simulatedVelocity
  f.bot.on('physicsTick', () => {
    simulatedPosition = f.bot.entity.position.clone()
    simulatedVelocity = f.bot.entity.velocity.clone()
  })
  pathfinder(f.bot)
  f.bot.entity.position.set(0.75, 1, 0.75)
  f.bot.entity.velocity.set(0.1, -0.0784, 0.05)
  f.bot.entity.onGround = true
  f.bot.pathfinder.setGoal(new goals.GoalBlock(0, 1, 0))
  f.tick()
  assert.deepEqual(f.bot.entity.position, simulatedPosition, 'no recenter teleport')
  assert.deepEqual(f.bot.entity.velocity, simulatedVelocity, 'no deletion of inertia')
  const position = f.bot.entity.position.clone()
  f.tick()
  assert.ok(f.bot.entity.position.x > position.x, 'friction slows residual movement after arrival')
})

for (const [label, yaw, right] of [['forward', Math.PI / 2 - 0.05, false], ['diagonal', -Math.PI / 4 + 0.05, true]]) {
  test(`26.1 keeps sprint during a minor wall brush with ${label} input`, () => {
    const f = fixture()
    withWall(f)
    f.bot.entity.position.z = 0.3001
    f.bot.entity.velocity.y = -0.0784
    f.bot.entity.yaw = yaw
    f.bot.setControlState('forward', true)
    f.bot.setControlState('right', right)
    f.bot.setControlState('sprint', true)
    f.tick()
    assert.equal(f.bot.entity.isCollidedHorizontally, true)
    assert.equal(f.bot.entity.minorHorizontalCollision, true)
    f.packets.length = 0
    f.tick()
    assert.equal(f.packets.some(p => p.name === 'entity_action' && p.params.actionId === 'stop_sprinting'), false)
  })
}

for (const version of ['26.1', '26.2']) {
test(`${version}: real pathfinder goto completes a route and brakes without changing simulated positions`, async () => {
  const f = fixture(version, true, true)
  const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
  f.bot.inventory.items = () => []
  f.bot.entities = {}
  let simulatedPosition, simulatedVelocity
  f.bot.on('physicsTick', () => {
    simulatedPosition = f.bot.entity.position.clone()
    simulatedVelocity = f.bot.entity.velocity.clone()
  })
  pathfinder(f.bot)
  const movements = new Movements(f.bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.scafoldingBlocks = []
  f.bot.pathfinder.setMovements(movements)
  let arrived = false
  f.bot.once('goal_reached', () => { arrived = true })
  const goto = f.bot.pathfinder.goto(new goals.GoalBlock(4, 1, -12))
  // Observe rejections immediately, even if an assertion interrupts this test.
  goto.catch(() => {})
  let ticks = 0
  while (!arrived && ticks++ < 180) {
    f.tick()
    assert.deepEqual(f.bot.entity.position, simulatedPosition, `position after pathfinder tick ${ticks}`)
    assert.deepEqual(f.bot.entity.velocity, simulatedVelocity, `velocity after pathfinder tick ${ticks}`)
  }
  assert.equal(arrived, true, 'route completed')
  await goto
  for (let i = 0; i < 20; i++) f.tick()
  assert.equal(f.bot.entity.velocity.x, 0)
  assert.equal(f.bot.entity.velocity.z, 0)
  assert.equal(f.bot.entity.position.floored().x, 4)
  assert.equal(f.bot.entity.position.floored().z, -12)
})
}

// Real pathfinder + production smooth look on a custom block layout.
function routeFixture (solid) {
  const f = fixture('26.1', true, true)
  const { pathfinder, Movements } = require('mineflayer-pathfinder')
  const Block = require('prismarine-block')(f.bot.registry)
  const stone = f.bot.registry.blocksByName.stone.minStateId
  f.bot.blockAt = pos => {
    const p = pos.floored()
    const block = Block.fromStateId(solid(p.x, p.y, p.z) ? stone : 0, 0)
    block.position = p
    return block
  }
  f.bot.inventory.items = () => []
  f.bot.entities = {}
  f.bot.game.minY = -64 // drop-down search scans down to the world bottom
  pathfinder(f.bot)
  const movements = new Movements(f.bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.scafoldingBlocks = []
  movements.allowParkour = true
  movements.allowSprinting = true
  f.bot.pathfinder.setMovements(movements)
  f.bot.pathfinder.enablePathShortcut = true
  return f
}

async function runRoute (f, goal, limit) {
  let arrived = false
  f.bot.once('goal_reached', () => { arrived = true })
  const goto = f.bot.pathfinder.goto(goal)
  let error = null
  goto.catch(e => { error = e })
  const trace = []
  for (let i = 0; i < limit && !arrived && !error; i++) {
    f.tick()
    const c = f.bot.controlState
    const v = f.bot.entity.velocity
    trace.push({ moving: c.forward || c.back || c.left || c.right, speed: Math.hypot(v.x, v.z), pos: f.bot.entity.position.clone() })
  }
  await new Promise(resolve => setImmediate(resolve))
  return { arrived, error, trace }
}

test('pathfinder walks off a 2-block ledge without stopping at the edge', async () => {
  // Floor at y=0 up to z=-3, then a floor two blocks lower.
  const f = routeFixture((x, y, z) => z > -4 ? y < 1 : y < -1)
  const { goals } = require('mineflayer-pathfinder')
  const { arrived, error, trace } = await runRoute(f, new goals.GoalBlock(0, -1, -12), 200)
  assert.equal(error, null)
  assert.equal(arrived, true)
  const start = trace.findIndex(t => t.speed > 0.15)
  const landed = trace.findIndex(t => t.pos.y < -0.9)
  assert.ok(start >= 0 && landed > start, `start ${start}, landed ${landed}`)
  const slowest = Math.min(...trace.slice(start, landed).map(t => t.speed))
  assert.ok(slowest > 0.1,`keeps walking over the edge (slowest ${slowest.toFixed(3)} b/tick)`)
  assert.ok(trace.slice(start, landed).every(t => t.moving), 'movement keys stay pressed up to the landing')
})

test('pathfinder turns a corner while moving and keeps moving', async () => {
  // A wall at z=-3 from x<=4 forces an L-shaped route.
  const f = routeFixture((x, y, z) => y < 1 || (z === -3 && x <= 4 && y <= 2))
  const { goals } = require('mineflayer-pathfinder')
  const { arrived, error, trace } = await runRoute(f, new goals.GoalBlock(8, 1, -8), 200)
  assert.equal(error, null)
  assert.equal(arrived, true)
  const start = trace.findIndex(t => t.speed > 0.15)
  const route = trace.slice(start, -3)
  assert.ok(route.every(t => t.moving), 'no tick with all movement keys released')
  assert.ok(Math.min(...route.map(t => t.speed)) > 0.08, 'no stop to turn')
})

test('pathfinder plans a long route in segments while walking instead of failing on timeout', async () => {
  // Advance a fake clock inside A* so each tick and each segment only expands a few nodes.
  const AStar = require('mineflayer-pathfinder/lib/astar')
  const compute = AStar.prototype.compute
  const segments = new Set()
  AStar.prototype.compute = function () {
    segments.add(this)
    const descriptor = Object.getOwnPropertyDescriptor(performance, 'now')
    let clock = performance.now()
    Object.defineProperty(performance, 'now', { configurable: true, value: () => (clock += 0.05) })
    try { return compute.call(this) } finally {
      if (descriptor) Object.defineProperty(performance, 'now', descriptor)
      else delete performance.now
    }
  }
  try {
    const f = routeFixture((x, y, z) => y < 1 || (z === -10 && x <= 3 && y <= 2) || (z === -25 && x >= -3 && y <= 2))
    f.bot.pathfinder.tickTimeout = 0.3
    f.bot.pathfinder.thinkTimeout = 120
    const { goals } = require('mineflayer-pathfinder')
    const { arrived, error, trace } = await runRoute(f, new goals.GoalBlock(0, 1, -40), 500)
    assert.equal(error, null)
    assert.equal(arrived, true)
    assert.ok(segments.size >= 3, `planned in ${segments.size} segments`)
    const start = trace.findIndex(t => t.speed > 0.15)
    const stops = trace.slice(start, -3).filter(t => t.speed < 0.05).length
    assert.ok(stops <= 2, `${stops} standing ticks while the next segment was planned`)
  } finally {
    AStar.prototype.compute = compute
  }
})

test('pathfinder stops sprinting the vanilla way (W released), never by Ctrl alone with W held', async () => {
  // Flat run, then a 3-block drop: the bot must stop sprinting before the high ledge.
  const f = routeFixture((x, y, z) => z > -8 ? y < 1 : y < -2)
  const { goals } = require('mineflayer-pathfinder')
  const { arrived, error } = await runRoute(f, new goals.GoalBlock(0, -2, -14), 300)
  assert.equal(error, null)
  assert.equal(arrived, true)
  // Replay the packets as the server sees them (flat route: no wall stops sprinting).
  const inputs = { forward: false }
  const stops = []
  for (const p of f.packets) {
    if (p.name === 'player_input') Object.assign(inputs, p.params.inputs)
    if (p.name === 'entity_action' && p.params.actionId === 'stop_sprinting') stops.push(inputs.forward)
  }
  assert.ok(stops.length > 0, 'the route stops sprinting at least once')
  assert.deepEqual(stops.filter(forward => forward), [], 'STOP_SPRINTING while W is held')
})

test('test walking mode: W only, the head faces the route in yaw and pitch, turns on the spot', async () => {
  // L-shaped route around a wall, then a 3-block drop.
  const f = routeFixture((x, y, z) => (x < 4 ? y < 1 : y < -2) || (z === -3 && x <= 2 && y <= 2))
  f.bot.pathfinder.humanMode = () => true
  const { goals } = require('mineflayer-pathfinder')
  const pitches = []
  let strafed = false
  f.bot.on('physicsTick', () => {
    const c = f.bot.controlState
    if (c.left || c.right || c.back) strafed = true
    pitches.push({ x: f.bot.entity.position.x, pitch: f.bot.entity.pitch })
  })
  const { arrived, error } = await runRoute(f, new goals.GoalBlock(8, -2, -6), 300)
  assert.equal(error, null)
  assert.equal(arrived, true)
  assert.equal(strafed, false, 'no A/S/D: walks only forward like a player looking where he goes')
  assert.ok(pitches.every(p => Math.abs(p.pitch) <= Math.PI / 2), 'pitch stays within ±90°')
  const beforeDrop = pitches.filter(p => p.x > 2 && p.x < 3.6)
  assert.ok(beforeDrop.some(p => p.pitch < -20 * Math.PI / 180), 'looks down before the drop')
  // Entity.turn clamps xRot to [-90, 90]: the wire never carries more.
  for (const p of f.packets.filter(p => p.name === 'look' || p.name === 'position_look')) {
    assert.ok(p.params.pitch >= -90 && p.params.pitch <= 90)
  }
})

test('route walker drives flat stretches with the .follow controller; the pathfinder takes the drop', async () => {
  const { attachRouteWalker } = require('../src/route-walker')
  // L-shaped route around a wall, then a 3-block drop.
  const f = routeFixture((x, y, z) => (x < 4 ? y < 1 : y < -2) || (z === -3 && x <= 2 && y <= 2))
  const walker = attachRouteWalker(f.bot)
  const { goals } = require('mineflayer-pathfinder')
  const branches = new Set()
  let backwards = false
  f.bot.on('physicsTick', () => {
    const c = f.bot.controlState
    const branch = f.bot.pathfinder.debugState?.branch
    if (branch === 'walker' && (c.back || ((c.left || c.right) && !c.forward))) backwards = branch
    if (branch) branches.add(branch.split('+')[0])
  })
  try {
    const { arrived, error, trace } = await runRoute(f, new goals.GoalBlock(8, -2, -6), 300)
    assert.equal(error, null)
    assert.equal(arrived, true)
    assert.ok(branches.has('walker'), 'flat ground is driven by the .follow controller')
    assert.ok([...branches].some(b => b !== 'walker' && b !== 'recover'), 'the drop is left to the pathfinder')
    assert.equal(backwards, false, '.follow steering: W, W+A, W+D only')
    const start = trace.findIndex(t => t.speed > 0.15)
    const stops = trace.slice(start, -3).filter(t => t.speed < 0.05).length
    assert.ok(stops <= 3, `${stops} standing ticks on the way`)
  } finally {
    walker.stop()
  }
  assert.equal(f.bot.listenerCount('botifyNavigationTick'), 0)
})

test('pathfinder recovers from a server correction: releases keys, replans, avoids a repeated spot', async () => {
  const f = routeFixture((x, y, z) => y < 1)
  const { goals } = require('mineflayer-pathfinder')
  let arrived = false
  f.bot.once('goal_reached', () => { arrived = true })
  let error = null
  f.bot.pathfinder.goto(new goals.GoalBlock(0, 1, -20)).catch(e => { error = e })
  const correct = (to) => {
    const from = f.bot.entity.position.clone()
    f.bot._client.emit('position', { x: to.x, y: to.y, z: to.z, dx: 0, dy: 0, dz: 0, yaw: 180, pitch: 0, flags: {}, teleportId: 50 })
    f.bot.emit('botifyCorrection', { from, to: f.bot.entity.position.clone(), keys: ['forward', 'sprint'] })
  }
  for (let i = 0; i < 25; i++) f.tick()
  const back = f.bot.entity.position.offset(0, 0, 0.4)
  correct(back)
  const keys = () => ['forward', 'back', 'left', 'right', 'jump', 'sprint'].some(k => f.bot.controlState[k])
  for (let i = 0; i < 4; i++) {
    f.tick()
    assert.equal(keys(), false, `keys released while settling (tick ${i})`)
  }
  for (let i = 0; i < 6; i++) f.tick()
  assert.equal(keys(), true, 'walks again after settling')
  assert.equal(f.bot.controlState.sprint, false, 'no sprint right after a correction')
  assert.equal(f.bot.pathfinder.movements.exclusionAreasStep.length, 0)
  correct(back)
  assert.equal(f.bot.pathfinder.movements.exclusionAreasStep.length, 1, 'a spot corrected twice is avoided')
  for (let i = 0; i < 400 && !arrived && !error; i++) f.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(error, null)
  assert.equal(arrived, true)
  // A new goal starts without the old avoided cells.
  f.bot.pathfinder.setGoal(null)
  assert.equal(f.bot.pathfinder.movements.exclusionAreasStep.length, 0)
})

test('pathfinder gives up with a clear reason when corrections keep undoing the route', async () => {
  const f = routeFixture((x, y, z) => y < 1)
  const { goals } = require('mineflayer-pathfinder')
  let error = null
  f.bot.pathfinder.goto(new goals.GoalBlock(0, 1, -20)).catch(e => { error = e })
  const home = f.bot.entity.position.clone()
  for (let n = 0; n < 6 && !error; n++) {
    for (let i = 0; i < 12; i++) f.tick()
    const from = f.bot.entity.position.clone()
    f.bot._client.emit('position', { x: home.x, y: home.y, z: home.z, dx: 0, dy: 0, dz: 0, yaw: 180, pitch: 0, flags: {}, teleportId: 60 + n })
    f.bot.emit('botifyCorrection', { from, to: home, keys: ['forward'] })
    await new Promise(resolve => setImmediate(resolve))
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(error?.name, 'NoPath')
  assert.equal(f.bot.pathfinder.failureReason, 'corrections')
  assert.equal(['forward', 'back', 'left', 'right', 'sprint'].some(k => f.bot.controlState[k]), false)
})

function followFixture (version = '26.1') {
  const f = fixture(version, true, true)
  const { pathfinder, Movements } = require('mineflayer-pathfinder')
  const { BotInstance } = require('../src/bots')
  const target = { id: 2, username: 'Nick', position: new Vec3(6.5, 1, -8.5), height: 1.8, width: 0.6, type: 'player' }
  f.bot.inventory.items = () => []
  f.bot.entities = { 2: target }
  f.bot.players = { Nick: { entity: target } }
  pathfinder(f.bot)
  const movements = new Movements(f.bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.scafoldingBlocks = []
  f.bot.pathfinder.setMovements(movements)
  f.bot.pathfinder.enablePathShortcut = true
  const inst = Object.assign(Object.create(BotInstance.prototype), {
    bot: f.bot, state: 'online', task: null, holds: new Map(),
    manager: { onlineCount: () => 1 }, server: () => ({ host: 'fixture', port: 25565 }), update () {}
  })
  return { ...f, target, inst }
}

for (const version of ['26.1', '26.2']) {
test(`${version}: .follow nick follows a moving player through real physics and .stop ends the task`, async () => {
  const f = followFixture(version)
  const replies = []
  const following = f.inst.command('.follow nick', message => replies.push(message))
  for (let i = 0; i < 100; i++) f.tick()
  assert.ok(f.bot.entity.position.distanceTo(f.target.position) < 3)
  assert.equal(f.inst.task?.name, 'follow')
  f.target.position.set(12.5, 1, -16.5)
  for (let i = 0; i < 100; i++) f.tick()
  assert.ok(f.bot.entity.position.distanceTo(f.target.position) < 3, 'replans when target moves')
  await f.inst.command('.stop', message => replies.push(message))
  await following
  assert.equal(f.inst.task, null)
  assert.equal(f.bot.pathfinder.goal, null)
  assert.equal(f.bot.controlState.forward, false)
  assert.ok(replies.some(message => message.includes('следую за Nick')))
})
}

test('follow takes an open diagonal directly, runs while turning and stops without tracking small target jitter', async () => {
  const f = followFixture('26.2')
  f.target.position.set(10.5, 1, -9.5)
  f.bot.entity.velocity.y = -0.0784
  const start = f.bot.entity.position.clone()
  let pathUpdates = 0; let diagonalTicks = 0; let walkingWhileTurning = 0; let length = 0
  f.bot.on('path_update', () => pathUpdates++)
  const following = f.inst.command('.follow Nick', () => {})
  let previousYaw = f.bot.entity.yaw
  for (let i = 0; i < 100; i++) {
    const before = f.bot.entity.position.clone()
    f.tick()
    length += before.distanceTo(f.bot.entity.position)
    const c = f.bot.controlState
    if (c.forward && (c.left || c.right)) diagonalTicks++
    if (c.forward && Math.abs(f.bot.entity.yaw + Math.PI / 4) > 10 * Math.PI / 180) walkingWhileTurning++
    const turn = Math.atan2(Math.sin(f.bot.entity.yaw - previousYaw), Math.cos(f.bot.entity.yaw - previousYaw))
    assert.ok(Math.abs(turn) <= 9.151 * Math.PI / 180, 'navigation turn has bounded speed')
    previousYaw = f.bot.entity.yaw
  }
  assert.equal(pathUpdates, 0, 'open ground never follows cell centers or runs A*')
  assert.ok(diagonalTicks > 0, 'W+D is used during the initial turn')
  assert.ok(walkingWhileTurning > 0, 'movement does not wait for exact aim')
  const remaining = f.bot.entity.position.distanceTo(f.target.position)
  assert.ok(remaining >= 1.8 && remaining <= 2.6, `following distance ${remaining}`)
  assert.ok(length <= start.distanceTo(f.target.position) - 2 + 0.7, `unnecessary detour: walked ${length}`)
  assert.ok(f.packets.some(p => p.name === 'player_input' && p.params.inputs.forward && p.params.inputs.right))
  const restingYaw = f.bot.entity.yaw
  const restingPos = f.bot.entity.position.clone()
  for (let i = 0; i < 50; i++) {
    f.target.position.x = 10.5 + (i % 2 ? 0.06 : -0.06)
    f.tick()
    assert.equal(f.bot.entity.yaw, restingYaw, 'no aim tracking near a stationary target')
    assert.equal(f.bot.controlState.forward, false)
  }
  assert.ok(f.bot.entity.position.distanceTo(restingPos) < 1e-9)
  await f.inst.command('.stop', () => {})
  await following
})

test('follow routes around a wall and returns to direct movement when the corridor opens', async () => {
  const f = followFixture('26.2')
  f.target.position.set(0.5, 1, -7.5)
  f.bot.entity.velocity.y = -0.0784
  // A two-block-high wall blocks the direct route. A* must go around either end.
  shapedWorld(f.bot, p => p.y === 0 || (p.z === -3 && Math.abs(p.x) <= 1 && (p.y === 1 || p.y === 2)) ? {} : null)
  let pathUpdates = 0; let movedAside = false
  f.bot.on('path_update', () => pathUpdates++)
  const following = f.inst.command('.follow Nick', () => {})
  for (let i = 0; i < 220; i++) {
    f.tick()
    if (Math.abs(f.bot.entity.position.x - 0.5) > 1.3) movedAside = true
    const p = f.bot.entity.position
    assert.ok(!(p.z < -1.7 && p.z > -3.3 && p.x > -1.3 && p.x < 2.3), 'body cannot cross the wall')
    assert.equal(p.y, 1, 'does not try to cut through a wall by falling')
  }
  assert.ok(pathUpdates > 0, 'obstacle planner was used')
  assert.ok(movedAside, 'went around the wall')
  assert.ok(f.bot.entity.position.distanceTo(f.target.position) < 3)
  assert.equal(f.bot.pathfinder.goal, null, 'direct movement resumes after the obstacle')
  await f.inst.command('.stop', () => {})
  await following
})

test('follow keeps up with a continuously moving target without sprint toggling every tick', async () => {
  const f = followFixture('26.2')
  f.target.position.set(5.5, 1, -6.5)
  f.bot.entity.velocity.y = -0.0784
  const following = f.inst.command('.follow Nick', () => {})
  for (let i = 0; i < 160; i++) {
    f.target.position.x += 0.14
    f.target.position.z -= 0.2
    f.tick()
  }
  assert.ok(f.bot.entity.position.distanceTo(f.target.position) < 4, 'keeps up on an arbitrary diagonal')
  const sprintChanges = f.packets.filter(p => p.name === 'entity_action' && /sprinting/.test(p.params.actionId))
  assert.ok(sprintChanges.length < 15, `sprint changed ${sprintChanges.length} times in 160 ticks`)
  f.bot.emit('respawn')
  await following
  assert.equal(f.inst.task, null)
  assert.equal(f.bot.listenerCount('botifyNavigationTick'), 0)
  assert.equal(f.bot.controlState.forward, false)
})

test('follow spin keeps turning through full revolutions and steers with all WASD keys', async () => {
  const f = followFixture('26.2')
  f.target.position.set(0.5, 1, -12.5)
  f.bot.entity.velocity.y = -0.0784
  const replies = []
  const following = f.inst.command('.follow Nick spin', message => replies.push(message))
  const used = new Set()
  let yaw = f.bot.entity.yaw
  let wireYaw = null
  let totalTurn = 0
  for (let i = 0; i < 220; i++) {
    f.target.position.z -= 0.12
    f.packets.length = 0
    f.tick()
    for (const key of ['forward', 'back', 'left', 'right']) if (f.bot.controlState[key]) used.add(key)
    assert.equal(f.bot.controlState.forward && f.bot.controlState.back, false)
    assert.equal(f.bot.controlState.left && f.bot.controlState.right, false)
    if (f.bot.controlState.back || !f.bot.controlState.forward) assert.equal(f.bot.controlState.sprint, false)
    const turn = f.bot.entity.yaw - yaw
    assert.ok(turn >= -1e-9 && turn <= 6.151 * Math.PI / 180, 'continuous, bounded spin')
    totalTurn += turn
    yaw = f.bot.entity.yaw
    const packet = f.packets.find(p => ['look', 'position_look'].includes(p.name))
    if (packet) {
      assert.ok(Math.abs(packet.params.yaw - (Math.PI - yaw) * 180 / Math.PI) < 0.0002, 'wire angle is the actual physics angle')
      if (wireYaw !== null) assert.ok(Math.abs(packet.params.yaw - wireYaw) < 6.152, 'no modulo-360 packet snap')
      wireYaw = packet.params.yaw
    }
  }
  assert.ok(totalTurn > Math.PI * 6, 'more than three complete turns')
  assert.deepEqual([...used].sort(), ['back', 'forward', 'left', 'right'])
  assert.ok(f.bot.entity.position.distanceTo(f.target.position) < 4, 'spin still follows the moving target')
  assert.ok(replies.some(s => s.includes('режим spin')))
  await f.inst.command('.stop', () => {})
  await following
  const stoppedYaw = f.bot.entity.yaw
  for (let i = 0; i < 10; i++) f.tick()
  assert.equal(f.bot.entity.yaw, stoppedYaw)
  assert.equal(f.bot.listenerCount('botifyNavigationTick'), 0)
})

test('follow spin accepts a distance, spins while waiting and releases rotation when target disappears', async () => {
  for (const args of ['Nick 3 spin', 'Nick spin 3']) {
    const f = followFixture()
    f.target.position.set(0.5, 1, -2.2)
    f.bot.entity.velocity.y = -0.0784
    const following = f.inst.command(`.follow ${args}`, () => {})
    const start = f.bot.entity.position.clone()
    for (let i = 0; i < 80; i++) f.tick()
    assert.ok(f.bot.entity.yaw > Math.PI * 2)
    assert.ok(start.distanceTo(f.bot.entity.position) < 1e-9)
    f.bot.emit('entityGone', f.target)
    await following
    const yaw = f.bot.entity.yaw
    for (let i = 0; i < 5; i++) f.tick()
    assert.equal(f.bot.entity.yaw, yaw)
  }
})

for (const [version, speed] of [['26.1', 60], ['26.2', 360]]) test(`${version}: follow spin never pauses during obstacle routing at ${speed} degrees/s`, async () => {
  const f = followFixture(version)
  f.target.position.set(0.5, 1, -7.5)
  f.bot.entity.velocity.y = -0.0784
  shapedWorld(f.bot, p => p.y === 0 || (p.z === -3 && Math.abs(p.x) <= 1 && (p.y === 1 || p.y === 2)) ? {} : null)
  const following = f.inst.command(`.follow Nick spin speed=${speed}`, () => {})
  let routed = false
  f.bot.on('path_update', () => { routed = true })
  let yaw = f.bot.entity.yaw; let routeTicks = 0
  for (let i = 0; i < 260; i++) {
    if (f.bot.pathfinder.goal) {
      routeTicks++
      if (i % 40 === 0) f.bot.pathfinder.setGoal(f.bot.pathfinder.goal, true)
    }
    f.tick()
    const turn = (f.bot.entity.yaw - yaw) * 180 / Math.PI
    assert.ok(turn > 0 && turn <= speed / 20 + 0.151, `spin paused or snapped on tick ${i}: ${turn}`)
    yaw = f.bot.entity.yaw
    const p = f.bot.entity.position
    assert.ok(!(p.z < -1.7 && p.z > -3.3 && p.x > -1.3 && p.x < 2.3), 'body cannot cross the wall')
    assert.equal(p.y, 1)
  }
  assert.ok(routed)
  assert.ok(routeTicks > 10, 'actually exercised planned movement')
  assert.ok(f.bot.entity.position.distanceTo(f.target.position) < 3)
  await f.inst.command('.stop', () => {})
  await following
  assert.equal(f.bot._botifySpinNavigation, undefined)
})

test('follow spin keeps rotating with no path to the target and stops cleanly', async () => {
  const f = followFixture()
  f.target.position.set(0.5, 1, -7.5)
  f.bot.entity.velocity.y = -0.0784
  shapedWorld(f.bot, p => p.y === 0 || ((p.y === 1 || p.y === 2) &&
    Math.abs(p.x) <= 1 && Math.abs(p.z) <= 1 && (Math.abs(p.x) === 1 || Math.abs(p.z) === 1)) ? {} : null)
  const statuses = []
  f.bot.on('path_update', result => statuses.push(result.status))
  const events = ['physicsTick', 'path_reset', 'path_update', 'botifyNavigationTick']
  const counts = events.map(event => f.bot.listenerCount(event))
  const following = f.inst.command('.follow Nick spin speed=180', () => {})
  const start = f.bot.entity.position.clone()
  let yaw = f.bot.entity.yaw
  for (let i = 0; i < 100; i++) {
    f.tick()
    assert.ok(f.bot.entity.yaw > yaw, 'no-path search cannot stop rotation')
    yaw = f.bot.entity.yaw
  }
  assert.ok(statuses.includes('noPath'))
  assert.ok(start.distanceTo(f.bot.entity.position) < 1e-9)
  await f.inst.command('.stop', () => {})
  await following
  f.tick()
  assert.equal(f.bot.entity.yaw, yaw)
  assert.deepEqual(events.map(event => f.bot.listenerCount(event)), counts)
})

test('follow spin climbs a one-block step without interrupting rotation', async () => {
  const f = followFixture('26.2')
  f.target.position.set(0.5, 2, -7.5)
  f.bot.entity.velocity.y = -0.0784
  shapedWorld(f.bot, p => p.y === 0 || (p.y === 1 && p.z <= -3) ? {} : null)
  const following = f.inst.command('.follow Nick spin speed=180', () => {})
  let yaw = f.bot.entity.yaw; let jumped = false
  for (let i = 0; i < 260; i++) {
    f.tick()
    jumped ||= f.bot.controlState.jump
    assert.ok(f.bot.entity.yaw > yaw, `rotation paused at step on tick ${i}`)
    yaw = f.bot.entity.yaw
  }
  assert.ok(jumped)
  assert.equal(f.bot.entity.position.y, 2)
  assert.ok(f.bot.entity.position.distanceTo(f.target.position) < 3)
  await f.inst.command('.stop', () => {})
  await following
})

test('follow spin speed uses degrees per second including fractional mouse steps', async () => {
  for (const speed of [1, 45.5, 120, 360, 720]) {
    const f = followFixture()
    f.target.position.set(0.5, 1, -1.5)
    f.bot.entity.velocity.y = -0.0784
    const replies = []
    const following = f.inst.command(`.follow Nick 3 spin speed=${speed}`, s => replies.push(s))
    for (let i = 0; i < 30; i++) f.tick()
    const yaw = f.bot.entity.yaw
    for (let i = 0; i < 100; i++) {
      const predictedYaw = f.bot.smoothLook.spinYaw(1)
      f.tick()
      assert.ok(Math.abs(f.bot.entity.yaw - predictedYaw) < 1e-9, 'prediction uses actual spin speed and rounding')
    }
    assert.ok(Math.abs((f.bot.entity.yaw - yaw) * 180 / Math.PI - speed * 5) < 0.151, `configured speed ${speed}`)
    assert.ok(replies.some(s => s.includes(`${speed}°/с`)))
    await f.inst.command('.stop', () => {})
    await following
  }
})

test('follow rejects invalid spin speeds without starting movement or rotation', async () => {
  const f = followFixture()
  for (const args of ['spin speed=0', 'spin speed=-1', 'spin speed=721', 'spin speed=NaN',
    'spin speed=Infinity', 'spin speed=', 'spin speed=60 speed=90', 'speed=180']) {
    const replies = []
    await f.inst.command(`.follow Nick ${args}`, (text, kind) => replies.push({ text, kind }))
    assert.ok(replies.some(reply => reply.kind === 'err'), args)
    const yaw = f.bot.entity.yaw
    f.tick()
    assert.equal(f.bot.entity.yaw, yaw)
    assert.equal(f.bot.listenerCount('botifyNavigationTick'), 0)
    assert.equal(f.bot._botifySpinNavigation, undefined)
    assert.equal(f.inst.task, null)
  }
})

for (const [version, options, radius] of [['26.1', '', 3], ['26.2', '4 spin speed=180', 4], ['26.2', '1 spin speed=360', 1]]) {
  test(`${version}: circle ${options || 'defaults'} completes orbits with a stable radius`, async () => {
    const f = followFixture(version)
    f.target.position.set(0.5, 1, 0.5 - radius)
    f.bot.entity.velocity.y = -0.0784
    const replies = []
    const circling = f.inst.command(`.circle Nick ${options}`, text => replies.push(text))
    let angle = Math.PI / 2; let orbit = 0; let yaw = f.bot.entity.yaw
    for (let i = 0; i < 600; i++) {
      f.tick()
      const delta = f.bot.entity.position.minus(f.target.position)
      const next = Math.atan2(delta.z, delta.x)
      orbit += Math.atan2(Math.sin(next - angle), Math.cos(next - angle))
      angle = next
      if (i > 60) assert.ok(Math.abs(Math.hypot(delta.x, delta.z) - radius) < 0.8, `radius at tick ${i}: ${Math.hypot(delta.x, delta.z)}`)
      if (options.includes('spin')) assert.ok(f.bot.entity.yaw > yaw, 'spin stays continuous while circling')
      else assert.ok(Math.abs(f.bot.entity.yaw - yaw) < 9.151 * Math.PI / 180, 'head turns smoothly')
      yaw = f.bot.entity.yaw
    }
    assert.ok(orbit > Math.PI * 4, `must complete at least two orbits, got ${orbit / (Math.PI * 2)}`)
    assert.ok(replies.some(text => text.includes(`радиус ${radius}`)))
    await f.inst.command('.stop', () => {})
    await circling
    assert.equal(f.bot.listenerCount('botifyNavigationTick'), 0)
    assert.equal(f.bot._botifySpinNavigation, undefined)
    f.tick()
    assert.equal(f.bot.entity.yaw, yaw)
  })
}

test('circle approaches from afar and follows the moving center, then cleans up when the target leaves', async () => {
  const f = followFixture('26.2')
  f.target.position.set(10.5, 1, -8.5)
  f.bot.entity.velocity.y = -0.0784
  const circling = f.inst.command('.circle Nick 3 spin speed=90', () => {})
  for (let i = 0; i < 450; i++) {
    if (i > 150) f.target.position.x += 0.04
    f.tick()
    if (i > 150) assert.ok(Math.abs(f.bot.entity.position.distanceTo(f.target.position) - 3) < 1)
  }
  f.bot.emit('entityGone', f.target)
  await circling
  assert.equal(f.inst.task, null)
  assert.equal(f.bot.pathfinder.goal, null)
  assert.equal(f.bot.listenerCount('botifyNavigationTick'), 0)
  const yaw = f.bot.entity.yaw
  f.tick()
  assert.equal(f.bot.entity.yaw, yaw)
})

test('circle routes to the orbit around a wall while spinning', async () => {
  const f = followFixture('26.2')
  f.target.position.set(0.5, 1, -9.5)
  f.bot.entity.velocity.y = -0.0784
  shapedWorld(f.bot, p => p.y === 0 || (p.z === -3 && Math.abs(p.x) <= 1 && (p.y === 1 || p.y === 2)) ? {} : null)
  let routed = false; let yaw = f.bot.entity.yaw
  f.bot.on('path_update', () => { routed = true })
  const circling = f.inst.command('.circle Nick spin speed=180', () => {})
  for (let i = 0; i < 400; i++) {
    f.tick()
    assert.ok(f.bot.entity.yaw > yaw)
    yaw = f.bot.entity.yaw
    const p = f.bot.entity.position
    assert.ok(!(p.z < -1.7 && p.z > -3.3 && p.x > -1.3 && p.x < 2.3))
  }
  assert.ok(routed)
  assert.ok(Math.abs(f.bot.entity.position.distanceTo(f.target.position) - 3) < 0.8)
  await f.inst.command('.stop', () => {})
  await circling
})

function circleGroup (count) {
  const fixtures = Array.from({ length: count }, () => followFixture('26.2'))
  const manager = { onlineCount: () => count }
  for (const f of fixtures) {
    f.inst.manager = manager
    f.target.position.set(-2.5, 1, 0.5)
    f.bot.entity.velocity.y = -0.0784
  }
  return fixtures
}

function circleGaps (fixtures) {
  const tau = 2 * Math.PI
  const angles = fixtures.map(f => {
    const delta = f.bot.entity.position.minus(f.target.position)
    return (Math.atan2(delta.z, delta.x) + tau) % tau
  }).sort((a, b) => a - b)
  return angles.map((angle, i) => (angles[(i + 1) % angles.length] - angle + tau) % tau)
}

for (const [count, options] of [[2, 'spin speed=180'], [4, ''], [6, 'spin speed=120']]) {
  test(`${count} circling bots spread from one position into an evenly spaced ring (${options || 'no spin'})`, async () => {
    const fixtures = circleGroup(count)
    const tasks = fixtures.map(f => f.inst.command(`.circle Nick 3 ${options}`, () => {}))
    const yaw = fixtures.map(f => f.bot.entity.yaw)
    for (let i = 0; i < 1100; i++) {
      for (const [index, f] of fixtures.entries()) {
        f.tick()
        if (options.includes('spin')) assert.ok(f.bot.entity.yaw > yaw[index], 'spacing must not pause spin')
        assert.equal(f.bot.controlState.sneak, false, 'spacing uses ordinary walking')
        yaw[index] = f.bot.entity.yaw
        if (i > 500) assert.ok(Math.abs(f.bot.entity.position.distanceTo(f.target.position) - 3) < 0.8)
      }
      if (i >= 900 && i % 20 === 0) {
        const gaps = circleGaps(fixtures)
        assert.ok(gaps.every(gap => Math.abs(gap - 2 * Math.PI / count) < 0.4), `uneven ring at ${i}: ${gaps}`)
      }
    }
    await Promise.all(fixtures.map(f => f.inst.command('.stop', () => {})))
    await Promise.all(tasks)
  })
}

test('circle formation adjusts after a member joins and another leaves', async () => {
  const fixtures = circleGroup(3)
  const tasks = fixtures.slice(0, 2).map(f => f.inst.command('.circle Nick 3 spin', () => {}))
  for (let i = 0; i < 500; i++) fixtures.slice(0, 2).forEach(f => f.tick())
  assert.ok(circleGaps(fixtures.slice(0, 2)).every(gap => Math.abs(gap - Math.PI) < 0.4))
  tasks.push(fixtures[2].inst.command('.circle Nick 3 spin', () => {}))
  for (let i = 0; i < 700; i++) fixtures.forEach(f => f.tick())
  assert.ok(circleGaps(fixtures).every(gap => Math.abs(gap - 2 * Math.PI / 3) < 0.4))
  fixtures[1].bot.emit('entityGone', fixtures[1].target)
  await tasks[1]
  const remaining = [fixtures[0], fixtures[2]]
  for (let i = 0; i < 700; i++) remaining.forEach(f => f.tick())
  assert.ok(circleGaps(remaining).every(gap => Math.abs(gap - Math.PI) < 0.4))
  await Promise.all(remaining.map(f => f.inst.command('.stop', () => {})))
  await Promise.all(tasks)
})

test('circle validates its target, radius and spin speed', async () => {
  const f = followFixture()
  for (const args of ['', 'Nobody', 'Nick 0', 'Nick -2', 'Nick NaN', 'Nick Infinity', 'Nick speed=180', 'Nick spin speed=721']) {
    const replies = []
    await f.inst.command(`.circle ${args}`, (text, kind) => replies.push({ text, kind }))
    assert.ok(replies.some(reply => reply.kind === 'err'), args)
    assert.equal(f.bot.listenerCount('botifyNavigationTick'), 0)
    assert.equal(f.inst.task, null)
  }
})

test('circle continues orbiting when a solid block obstructs the circumference', async () => {
  const f = followFixture('26.2')
  f.target.position.set(-2.5, 1, 0.5)
  f.bot.entity.velocity.y = -0.0784
  shapedWorld(f.bot, p => p.y === 0 || (p.x === -3 && p.z === 3 && (p.y === 1 || p.y === 2)) ? {} : null)
  const circling = f.inst.command('.circle Nick 3 spin speed=120', () => {})
  let angle = 0; let orbit = 0
  for (let i = 0; i < 600; i++) {
    f.tick()
    const delta = f.bot.entity.position.minus(f.target.position)
    const next = Math.atan2(delta.z, delta.x)
    orbit += Math.atan2(Math.sin(next - angle), Math.cos(next - angle))
    angle = next
    assert.equal(f.bot.entity.position.y, 1)
  }
  await f.inst.command('.stop', () => {})
  await circling
  assert.ok(orbit > Math.PI * 2, `orbit must continue around obstruction: ${orbit}`)
})

test('direct corridor rejects a narrow eye-only gap, unsupported floor, liquids and unloaded blocks', () => {
  const f = fixture()
  const { clearGroundLine } = require('../src/follow-navigation')
  const start = new Vec3(0.5, 1, 0.5); const end = new Vec3(0.5, 1, -5.5)
  assert.equal(clearGroundLine(f.bot, start, end), true)
  shapedWorld(f.bot, p => p.y === 0 ? {} : p.z === -3 && p.x === 0 && p.y === 1 ? { shapes: [[0, 0, 0, 0.3, 1, 1]] } : null)
  assert.equal(clearGroundLine(f.bot, start, end), false, 'ray is clear but shoulders clip')
  shapedWorld(f.bot, p => p.y === 0 && p.z !== -3 ? {} : null)
  assert.equal(clearGroundLine(f.bot, start, end), false, 'floor has a gap')
  shapedWorld(f.bot, p => p.y === 0 ? {} : p.y === 1 && p.z === -3 ? { name: 'water' } : null)
  assert.equal(clearGroundLine(f.bot, start, end), false)
  const loaded = f.bot.blockAt
  f.bot.blockAt = p => p.z < -2 ? null : loaded(p)
  assert.equal(clearGroundLine(f.bot, start, end), false)
})

test('.follow releases all listeners when the target leaves view', async () => {
  const f = followFixture()
  const replies = []
  const events = ['entityGone', 'end', 'death', 'respawn', 'botifyNavigationTick']
  const counts = events.map(event => f.bot.listenerCount(event))
  const following = f.inst.command('.follow Nick 3', message => replies.push(message))
  f.bot.emit('entityGone', f.target)
  await following
  assert.equal(f.inst.task, null)
  assert.equal(f.bot.pathfinder.goal, null)
  assert.deepEqual(events.map(event => f.bot.listenerCount(event)), counts)
  assert.ok(replies.some(message => message.includes('пропал из виду')))
})

test('smooth 180-degree turn changes physics and packet angles together, with bounded speed', async () => {
  const f = fixture('26.1', true, true)
  let simulatedYaw
  const simulate = f.bot.physics.simulatePlayer
  f.bot.physics.simulatePlayer = (state, world) => { simulatedYaw = state.yaw; return simulate(state, world) }
  f.bot.setControlState('forward', true)
  const turn = f.bot.look(Math.PI, 0.7, true)
  assert.equal(f.bot.entity.yaw, 0, 'request does not snap the entity')
  let previous = 180; let changes = 0
  for (let i = 0; i < 55; i++) {
    f.packets.length = 0
    f.tick()
    const look = f.packets.find(p => p.name === 'look' || p.name === 'position_look')
    if (!look) continue
    const expected = (Math.PI - simulatedYaw) * 180 / Math.PI
    const error = ((look.params.yaw - expected + 180) % 360 + 360) % 360 - 180
    assert.ok(Math.abs(error) < 0.0001, 'wire yaw is the simulated yaw')
    const delta = Math.abs(look.params.yaw - previous)
    assert.ok(delta <= 12.151, `rotation jumped ${delta} degrees`)
    if (delta > 0.01) changes++
    previous = look.params.yaw
  }
  assert.equal(await turn, true)
  assert.ok(changes > 15, 'large turn spans multiple ticks')
  assert.ok(Math.abs(Math.abs(f.bot.entity.yaw) - Math.PI) < 0.003)
})

test('cancelled head turn stops and server correction becomes the new view', async () => {
  const f = fixture('26.1', true, true)
  const turn = f.bot.look(Math.PI, 0)
  f.tick()
  f.bot.smoothLook.cancel()
  assert.equal(await turn, false)
  const yaw = f.bot.entity.yaw
  f.tick()
  assert.equal(f.bot.entity.yaw, yaw)
  const second = f.bot.look(1, 0)
  f.bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, dx: 0, dy: 0, dz: 0, yaw: 90, pitch: 0, flags: {}, teleportId: 2 })
  assert.equal(await second, false)
  f.tick()
  assert.ok(Math.abs(f.bot.entity.yaw - Math.PI / 2) < 1e-6)
})

test('smooth turn crosses the angle boundary along the short arc', async () => {
  const f = fixture('26.1', true, true)
  f.bot._client.emit('position', { x: 0.5, y: 1, z: 0.5, dx: 0, dy: 0, dz: 0, yaw: 1, pitch: 0, flags: {}, teleportId: 2 })
  f.packets.length = 0
  const turn = f.bot.look(Math.PI + Math.PI / 180, 0)
  for (let i = 0; i < 20; i++) f.tick()
  assert.equal(await turn, true)
  const yaws = f.packets.filter(p => p.name === 'look' || p.name === 'position_look').map(p => p.params.yaw)
  assert.ok(yaws.length > 1)
  assert.ok(yaws.every(yaw => Math.abs(yaw) < 2), 'no full revolution or boundary snap')
})

test('human turn eases in and out on the wire and resolves on the exact target', async () => {
  const f = fixture('26.1', true, true)
  const DEG = Math.PI / 180
  f.packets.length = 0
  const start = f.bot.entity.yaw
  const target = { yaw: start + 80 * DEG, pitch: -25 * DEG }
  const turn = f.bot.smoothLook.turn(target.yaw, target.pitch, () => false, 'human')
  let done = false
  turn.then(v => { done = v })
  let ticks = 0
  for (; ticks < 60 && !done; ticks++) { f.tick(); await Promise.resolve() }
  assert.equal(done, true)
  assert.ok(ticks >= 10, `a ${80}° hand turn takes time (${ticks} ticks)`)
  assert.ok(Math.abs(Math.atan2(Math.sin(f.bot.entity.yaw - target.yaw), Math.cos(f.bot.entity.yaw - target.yaw))) < 0.2 * DEG)
  assert.ok(Math.abs(f.bot.entity.pitch - target.pitch) < 0.2 * DEG)
  const yaws = f.packets.filter(p => p.name === 'look' || p.name === 'position_look').map(p => p.params.yaw)
  const steps = yaws.slice(1).map((y, i) => Math.abs(y - yaws[i]))
  const peak = Math.max(...steps)
  assert.ok(peak < 12, `peak ${peak}°/tick`)
  assert.ok(steps[0] < peak * 0.5 && steps.at(-1) < peak * 0.5, 'no snap at the start or end')
})

test('fast human farm turns reach the transmitted target quickly without a single-tick snap', async () => {
  const f = fixture('26.1', true, true)
  const DEG = Math.PI / 180
  const yaw = f.bot.entity.yaw + 90 * DEG
  const pitch = -30 * DEG
  const turn = f.bot.smoothLook.turn(yaw, pitch, () => false, 'human-fast')
  let done = false
  turn.then(value => { done = value })
  let ticks = 0
  for (; ticks < 25 && !done; ticks++) { f.tick(); await Promise.resolve() }
  assert.equal(done, true)
  assert.ok(ticks >= 5 && ticks <= 16, `fast turn took ${ticks} ticks`)
  const packets = f.packets.filter(p => ['look', 'position_look'].includes(p.name))
  const last = packets.at(-1).params
  assert.ok(Math.abs(last.pitch - 30) <= 0.151)
  assert.ok(Math.abs(Math.atan2(Math.sin(f.bot.entity.yaw - yaw), Math.cos(f.bot.entity.yaw - yaw))) < 0.2 * DEG)
  const changes = packets.slice(1).map((p, i) => Math.abs(p.params.yaw - packets[i].params.yaw))
  assert.ok(Math.max(...changes) < 30)
  assert.ok(changes.at(-1) < Math.max(...changes) * 0.6)
})

test('modern block and item interactions share increasing sequences; ABORT uses zero', () => {
  const f = fixture()
  f.bot._client.write('block_dig', { status: 0 })
  f.bot._client.write('use_item', { sequence: 99 })
  f.bot._client.write('block_place', { sequence: 0 })
  f.bot._client.write('block_dig', { status: 2 })
  f.bot._client.write('block_dig', { status: 1 })
  assert.deepEqual(f.packets.map(p => p.params.sequence), [1, 2, 3, 4, 0])
})
