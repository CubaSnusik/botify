'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { chestPartner, storageContainers, storageArea, standCells, fillFromStorage, areaSummary, visiblePoints, openContainerHere, outline } = require('../src/order-chests')

function world (blocks) {
  const map = new Map(blocks.map(b => [`${b.x},${b.y},${b.z}`, b]))
  const blockAt = p => {
    const b = map.get(`${p.x},${p.y},${p.z}`)
    return b && { name: b.name, position: new Vec3(b.x, b.y, b.z), getProperties: () => b.props || {}, signText: b.text || '' }
  }
  return {
    blockAt,
    registry: { blocksArray: [{ name: 'chest', id: 1 }, { name: 'barrel', id: 2 }, { name: 'stone', id: 3 }] },
    findBlocks: () => blocks.filter(b => b.name !== 'stone').map(b => new Vec3(b.x, b.y, b.z))
  }
}

test('a wall of double chests facing north: each pair is one container, neighbours stay separate', () => {
  // Facing north (player stands at -z): LEFT half has its partner to the east (+x).
  const blocks = []
  for (let pair = 0; pair < 3; pair++) {
    blocks.push({ name: 'chest', x: pair * 2, y: 0, z: 0, props: { facing: 'north', type: 'left' } })
    blocks.push({ name: 'chest', x: pair * 2 + 1, y: 0, z: 0, props: { facing: 'north', type: 'right' } })
  }
  blocks.push({ name: 'barrel', x: 10, y: 0, z: 0 })
  const bot = world(blocks)
  assert.equal(chestPartner(bot, bot.blockAt(new Vec3(0, 0, 0))).position.x, 1)
  assert.equal(chestPartner(bot, bot.blockAt(new Vec3(3, 0, 0))).position.x, 2)
  const found = storageContainers(bot, 24)
  assert.equal(found.length, 4)
  assert.deepEqual(found.map(c => c.blocks.length).sort(), [1, 2, 2, 2])
})

test('only containers between the start and end signs are used, walked from start to end', () => {
  // Wall of single chests at z=0, x=0..5, y=0..1; wall signs in front (z=-1) facing north.
  const blocks = []
  for (let x = 0; x <= 5; x++) for (let y = 0; y <= 1; y++) blocks.push({ name: 'chest', x, y, z: 0, props: { facing: 'north', type: 'single' } })
  blocks.push({ name: 'chest', x: 20, y: 0, z: 0, props: { facing: 'north', type: 'single' } }) // unrelated
  blocks.push({ name: 'chest', x: 2, y: 0, z: 5, props: { facing: 'north', type: 'single' } }) // behind, unrelated
  blocks.push({ name: 'oak_wall_sign', x: 5, y: 1, z: -1, props: { facing: 'north' }, text: 'start' })
  blocks.push({ name: 'oak_wall_sign', x: 1, y: 0, z: -1, props: { facing: 'north' }, text: 'End' })
  const bot = world(blocks)
  bot.registry.blocksArray.push({ name: 'oak_wall_sign', id: 4 })
  bot.findBlocks = ({ matching }) => blocks.filter(b => matching.includes(b.name === 'oak_wall_sign' ? 4 : b.name === 'chest' ? 1 : 3)).map(b => new Vec3(b.x, b.y, b.z))
  const area = storageArea(bot, 24)
  assert.deepEqual([area.min, area.max], [{ x: 1, y: 0, z: -1 }, { x: 5, y: 1, z: 0 }])
  const order = storageContainers(bot, 24, area).map(c => `${c.blocks[0].position.x},${c.blocks[0].position.y}`)
  assert.deepEqual(order, ['5,1', '5,0', '4,1', '4,0', '3,1', '3,0', '2,1', '2,0', '1,1', '1,0'])
})

test('missing or duplicated start/end signs are an error, not a fallback to every chest', () => {
  const bot = world([{ name: 'oak_wall_sign', x: 0, y: 0, z: 0, props: { facing: 'north' }, text: 'start' }])
  bot.registry.blocksArray.push({ name: 'oak_wall_sign', id: 4 })
  assert.throws(() => storageArea(bot, 24), /start.*end/)
})

// Real ray stepping over a block map: chests at z=0, floor at y=-1 in front.
function rayWorld (blocks) {
  const { RaycastIterator } = require('prismarine-world/src/iterators')
  const map = new Map()
  for (const b of blocks) map.set(`${b.x},${b.y},${b.z}`, b)
  for (let x = -3; x <= 5; x++) for (let z = -4; z <= -1; z++) map.set(`${x},-1,${z}`, { name: 'spruce_planks', x, y: -1, z, solid: true })
  const blockAt = p => {
    const b = map.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    if (!b) return { name: 'air', boundingBox: 'empty', shapes: [], position }
    return { name: b.name, position, boundingBox: b.shapes?.length === 0 ? 'empty' : 'block', shapes: b.shapes || [[0, 0, 0, 1, 1, 1]], getProperties: () => b.props || {} }
  }
  return {
    blockAt,
    world: {
      raycast (from, dir, range, matcher) {
        const iter = new RaycastIterator(from, dir, range)
        for (let pos = from; pos; pos = iter.next()) { const block = blockAt(new Vec3(pos.x, pos.y, pos.z)); if (matcher(block, iter)) return block }
        return null
      }
    }
  }
}

function fillBot (extra = {}) {
  const blocks = [0, 2].map(x => ({ name: 'chest', x, y: 0, z: 0, props: { facing: 'north', type: 'single' } }))
  const bot = world(blocks)
  Object.assign(bot, rayWorld(blocks))
  const events = []
  Object.assign(bot, {
    entity: { position: new Vec3(-2.5, 0, -7.5), yaw: 0, pitch: 0 }, // out of reach: must walk
    inventory: { emptySlotCount: () => 36, items: () => [], selectedItem: null },
    currentWindow: { id: 7, items: () => [], emptySlotCount: () => 36 }, // "Deliver Items" left open
    async closeWindow () { events.push('close'); bot.currentWindow = null },
    ...extra
  })
  const area = { min: { x: 0, y: 0, z: -1 }, max: { x: 2, y: 0, z: 0 }, start: { x: 0, y: 0, z: -1 }, end: { x: 2, y: 0, z: -1 } }
  return { bot, events, area }
}

test('fill: a stuck bot stops the transfer instead of skipping every chest; menus are closed before walking', async () => {
  const { bot, events, area } = fillBot()
  const skipped = new Map()
  await assert.rejects(fillFromStorage({
    inst: { bot }, item: 'spruce_log', radius: 24, area, emptied: new Set(), skipped,
    signal: new AbortController().signal, check () {}, reply () {}, look: async () => true,
    walk: async () => { events.push('walk'); throw new Error('остановлено после 4 коррекций') }
  }), /не дошёл до сундука 0,0,0/)
  assert.deepEqual(events, ['close', 'walk'])
  assert.equal(skipped.size, 0)
})

test('fill: an unreachable chest gets one retry after the others, then is reported, never remembered empty', async () => {
  const { bot, area } = fillBot({ currentWindow: null })
  const walks = []; const skipped = new Map(); const emptied = new Set()
  const result = await fillFromStorage({
    inst: { bot }, item: 'spruce_log', radius: 24, area, emptied, skipped,
    signal: new AbortController().signal, check () {}, reply () {}, look: async () => true,
    walk: async (goal, target) => { walks.push(target.x); throw new Error('путь не найден') }
  })
  assert.equal(result.exhausted, true)
  // Up to 3 viewing spots per chest; chest 0 then 2, then each once more.
  assert.equal(walks.length, 12)
  const nearest = x => walks.slice(x, x + 3).every(w => Math.abs(w - walks[x]) <= 4)
  assert.ok(nearest(0) && nearest(3) && nearest(6) && nearest(9))
  assert.equal(emptied.size, 0)
  assert.deepEqual(areaSummary(bot, area, 24, emptied, skipped), { total: 2, emptied: 0, unchecked: 0, failed: ['0,0,0', '2,0,0'] })
})

test('stand cells: only floor spots from which the opener\'s ray reaches the chest', () => {
  const { RaycastIterator } = require('prismarine-world/src/iterators')
  const map = new Map()
  const put = (x, y, z, name, boundingBox, shapes) => map.set(`${x},${y},${z}`, { name, boundingBox, shapes, position: new Vec3(x, y, z) })
  for (let x = -3; x <= 6; x++) for (let z = -4; z <= 0; z++) put(x, 0, z, 'spruce_planks', 'block', [[0, 0, 0, 1, 1, 1]])
  for (let x = 0; x <= 3; x++) for (let y = 1; y <= 3; y++) put(x, y, 1, 'chest', 'block', [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]])
  for (let y = 1; y <= 3; y++) for (let z = -4; z <= 0; z++) for (const x of [4, 5, 6]) put(x, y, z, 'stone', 'block', [[0, 0, 0, 1, 1, 1]])
  put(3, 1, 0, 'stone', 'block', [[0, 0, 0, 1, 1, 1]]) // walls off the front of chest 3,1,1
  put(3, 2, 0, 'stone', 'block', [[0, 0, 0, 1, 1, 1]])
  const blockAt = p => map.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || { name: 'air', boundingBox: 'empty', shapes: [], position: p.floored() }
  const bot = {
    blockAt,
    world: {
      raycast (from, dir, range, matcher) {
        const iter = new RaycastIterator(from, dir, range)
        for (let pos = from; pos; pos = iter.next()) {
          const block = blockAt(new Vec3(pos.x, pos.y, pos.z))
          if (matcher(block, iter)) return block
        }
        return null
      }
    }
  }
  const from = new Vec3(1.5, 1, -1.5)
  const cells = standCells(bot, [blockAt(new Vec3(1, 3, 1))], from)
  assert.ok(cells.length > 0)
  // Solid floor that is not the storage wall; never on top of the chests.
  assert.ok(cells.every(c => blockAt(c.offset(0, -1, 0)).boundingBox === 'block' && blockAt(c.offset(0, -1, 0)).name !== 'chest'))
  assert.ok(cells.every(c => c.z <= 0))
  assert.equal(cells[0].distanceTo(new Vec3(1, 1, -2)) <= 1.5, true) // nearest to the bot first
  // A chest encased in stone on all six sides can't be clicked from anywhere.
  put(-2, 2, -3, 'chest', 'block', [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]])
  for (const [x, y, z] of [[-1, 2, -3], [-3, 2, -3], [-2, 3, -3], [-2, 1, -3], [-2, 2, -2], [-2, 2, -4]]) put(x, y, z, 'stone', 'block', [[0, 0, 0, 1, 1, 1]])
  assert.deepEqual(standCells(bot, [blockAt(new Vec3(-2, 2, -3))], from), [])
})

const CHEST = [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]]
function openerBot (blocks, position) {
  const { EventEmitter } = require('node:events')
  const bot = Object.assign(new EventEmitter(), rayWorld(blocks))
  const packets = []
  bot.entity = { position, yaw: 0, pitch: 0 }
  bot.heldItem = null // empty hand: mineflayer's _genericPlace would refuse
  bot._client = { write: (name, params) => { packets.push([name, params]); if (name === 'block_place') setImmediate(() => bot.emit('windowOpen', { type: 'minecraft:generic_9x3', inventoryStart: 27 })) } }
  bot.swingArm = () => packets.push(['swing'])
  const look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; return true }
  return { bot, packets, look }
}

test('opener: empty hand, a wall sign on the chest face is aimed around, one use-item-on packet then swing', async () => {
  // Chest at 0,1,0 (facing north); a wall sign hangs on its north face at 0,1,-1.
  const blocks = [
    { name: 'chest', x: 0, y: 1, z: 0, shapes: CHEST, props: { facing: 'north', type: 'single' } },
    { name: 'oak_wall_sign', x: 0, y: 1, z: -1, shapes: [], props: { facing: 'north' } }
  ]
  const { bot, packets, look } = openerBot(blocks, new Vec3(0.5, 0, -1.8))
  const chest = bot.blockAt(new Vec3(0, 1, 0))
  const points = visiblePoints(bot, bot.entity.position.offset(0, 1.62, 0), chest)
  assert.ok(points.length > 0)
  // Nothing aimed through the sign plate (y 1.28…1.72 on the north face).
  assert.ok(points.filter(p => p.face === 2).every(p => p.point.y < 1 + 4.5 / 16 || p.point.y > 1 + 12.5 / 16))
  const window = await openContainerHere(bot, [chest], new AbortController().signal, look)
  assert.equal(window.type, 'minecraft:generic_9x3')
  const place = packets.filter(p => p[0] === 'block_place')
  assert.equal(place.length, 1)
  const params = place[0][1]
  assert.deepEqual([params.hand, params.insideBlock, params.worldBorderHit], [0, false, false])
  assert.deepEqual({ ...params.location }, { x: 0, y: 1, z: 0 })
  assert.ok(params.cursorX >= 0 && params.cursorX <= 1 && params.cursorY >= 0 && params.cursorY <= 0.875)
  assert.equal(packets.at(-1)[0], 'swing')
})

test('opener: an interrupted head turn is reported as such, nothing is clicked', async () => {
  const blocks = [{ name: 'chest', x: 0, y: 1, z: 0, shapes: CHEST, props: { facing: 'north', type: 'single' } }]
  const { bot, packets } = openerBot(blocks, new Vec3(0.5, 0, -1.8))
  const result = await openContainerHere(bot, [bot.blockAt(new Vec3(0, 1, 0))], new AbortController().signal, async () => false)
  assert.match(result.reason, /поворот головы прерван/)
  assert.equal(packets.length, 0)
})

test('sign outline: wall sign is a thin plate on the supporting side, not a full cube', () => {
  const sign = { name: 'oak_wall_sign', shapes: [], getProperties: () => ({ facing: 'north' }) }
  assert.deepEqual(outline(sign), [[0, 4.5 / 16, 14 / 16, 1, 12.5 / 16, 1]])
  assert.deepEqual(outline({ name: 'stone', shapes: [] }), [[0, 0, 0, 1, 1, 1]])
})

test('a half that does not point back is a single chest', () => {
  const bot = world([
    { name: 'chest', x: 0, y: 0, z: 0, props: { facing: 'north', type: 'left' } },
    { name: 'chest', x: 1, y: 0, z: 0, props: { facing: 'south', type: 'right' } }
  ])
  assert.equal(chestPartner(bot, bot.blockAt(new Vec3(0, 0, 0))), null)
  assert.equal(storageContainers(bot, 24).length, 2)
})
