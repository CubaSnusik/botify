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

test('modern block and item interactions share increasing sequences; ABORT uses zero', () => {
  const f = fixture()
  f.bot._client.write('block_dig', { status: 0 })
  f.bot._client.write('use_item', { sequence: 99 })
  f.bot._client.write('block_place', { sequence: 0 })
  f.bot._client.write('block_dig', { status: 2 })
  f.bot._client.write('block_dig', { status: 1 })
  assert.deepEqual(f.packets.map(p => p.params.sequence), [1, 2, 3, 4, 0])
})
