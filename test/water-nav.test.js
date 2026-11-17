'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { swimJump } = require('../src/water-nav')

// pick(x, y, z) -> block name; water blocks report no collision box.
function botAt (pos, { onGround = true, air = 20, pick }) {
  return {
    oxygenLevel: air,
    entity: { position: new Vec3(pos.x, pos.y, pos.z), onGround, isInWater: true, isInLava: false, control: {} },
    blockAt: p => {
      const name = pick(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      return { name, boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block', getProperties: () => ({}) }
    }
  }
}

// A 40-block wall of falling water standing on the ground at y=63.
const wall = (x, y, z) => y < 63 ? 'dirt' : y < 103 ? 'water' : 'air'
// A lake 4 deep (y=59..62), air above.
const lake = (x, y, z) => y < 59 ? 'dirt' : y < 63 ? 'water' : 'air'

test('waterfall wall: walks through along the ground, never swims up it', () => {
  const node = new Vec3(10, 63, 0)
  assert.equal(swimJump(botAt({ x: 0.5, y: 63, z: 0.5 }, { pick: wall }), node), false)
  // Even short of air: the surface is 40 blocks up, climbing would drown or drop the bot.
  assert.equal(swimJump(botAt({ x: 0.5, y: 63, z: 0.5 }, { air: 3, pick: wall }), node), false)
  // Lifted a little off the ground: no climbing above the node's height.
  assert.equal(swimJump(botAt({ x: 0.5, y: 63.6, z: 0.5 }, { onGround: false, pick: wall }), node), false)
})

test('swimming across a lake keeps the surface node height; climbs out onto a bank', () => {
  const surfaceNode = new Vec3(5, 62, 0)
  assert.equal(swimJump(botAt({ x: 0.5, y: 61.7, z: 0.5 }, { onGround: false, pick: lake }), surfaceNode), true)
  assert.equal(swimJump(botAt({ x: 0.5, y: 62.5, z: 0.5 }, { onGround: false, pick: lake }), surfaceNode), false)
  assert.equal(swimJump(botAt({ x: 0.5, y: 62.2, z: 0.5 }, { onGround: false, pick: lake }), new Vec3(1, 63, 0)), true)
})

test('on a lake bottom: surfaces for air only when the surface is close', () => {
  const bottomNode = new Vec3(5, 59, 0)
  assert.equal(swimJump(botAt({ x: 0.5, y: 59, z: 0.5 }, { air: 20, pick: lake }), bottomNode), false)
  assert.equal(swimJump(botAt({ x: 0.5, y: 59, z: 0.5 }, { air: 6, pick: lake }), bottomNode), true)
})
