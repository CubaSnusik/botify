'use strict'
// Entering flowing water: LivingEntity.checkFallDamage (26.x) re-runs the fluid update at the end of
// the last dry tick, so the current is added once more before the friction. Numbers come from a
// live run on a Grim server (26.1 client): the setback after three water ticks carried this velocity.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const Block = require('prismarine-block')(registry)
const { Physics } = require('prismarine-physics')

// A shallow stream (y=63) flowing towards -x/+z, dirt below, grass banks, open corner at the west end.
const LEVELS = {
  '35679,188999': 7, '35678,189000': 7, '35679,189000': 6, '35680,189000': 5, '35681,189000': 4, '35682,189000': 3, '35683,189000': 2, '35684,189000': 1, '35685,189000': 0,
  '35679,189001': 7, '35680,189001': 6, '35681,189001': 5, '35682,189001': 4, '35683,189001': 3, '35684,189001': 2, '35685,189001': 1,
  '35680,189002': 7, '35681,189002': 6, '35682,189002': 5, '35683,189002': 4, '35684,189002': 3, '35685,189002': 2
}
const world = {
  getBlock (p) {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    let id = 0
    if (y <= 62) id = registry.blocksByName.dirt.minStateId
    else if (y === 63) {
      const level = LEVELS[`${x},${z}`]
      if (level !== undefined) id = registry.blocksByName.water.minStateId + level
      else if ((z >= 189003 && x >= 35681) || (z <= 188999 && x >= 35680)) id = registry.blocksByName.grass_block.minStateId
    }
    const block = Block.fromStateId(id, 0)
    block.position = new Vec3(x, y, z)
    return block
  }
}

test('26.1 walking into flowing water matches the server after the entry tick', () => {
  const physics = Physics(registry, world)
  const yaw = 269.915283203125
  const state = {
    pos: new Vec3(35678.6587274089, 63, 189002.29088058148), vel: new Vec3(0.11786, -0.0784, -0.00018),
    onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: true,
    elytraFlying: false, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    yaw: Math.PI - yaw * Math.PI / 180, botifyYaw: Math.fround(yaw), pitch: 0,
    control: { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    attributes: { 'minecraft:movement_speed': { value: 0.10000000149011612, modifiers: [] } },
    jumpBoost: 0, speed: 0, slowness: 0, dolphinsGrace: 0, slowFalling: 0, levitation: 0, depthStrider: 0, elytraEquipped: false
  }
  physics.simulatePlayer(state, world) // last dry tick: ends touching the water
  assert.equal(state.isInWater, true, 'in water after the move of the dry tick')
  for (let i = 0; i < 3; i++) physics.simulatePlayer(state, world)
  // Server velocity: 0.09614834506859828, 0.0023033269848921154 (start velocity above is rounded to 1e-5).
  assert.ok(Math.abs(state.vel.x - 0.09614834506859828) < 2e-6, `vx ${state.vel.x}`)
  assert.ok(Math.abs(state.vel.z - 0.0023033269848921154) < 2e-6, `vz ${state.vel.z}`)
})
