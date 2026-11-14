'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { humanPlan, humanPoint } = require('../src/smooth-look')
const { attachEyeRaycast } = require('../src/eye-raycast')
const { chopTrees, findAxe, pickTarget, treeAt } = require('../src/tree-chopper')

const DEG = Math.PI / 180
const registry = require('prismarine-registry')('26.1')
const Block = require('prismarine-block')(registry)
const World = require('prismarine-world')(registry)
const Chunk = require('prismarine-chunk')(registry)

const state = (name, props = {}) => props && Object.keys(props).length
  ? Block.fromProperties(name, props, 0).stateId
  : registry.blocksByName[name].defaultState
const NATURAL_LEAVES = () => state('oak_leaves', { persistent: false, waterlogged: false, distance: 1 })
const PLACED_LEAVES = () => state('oak_leaves', { persistent: true, waterlogged: false, distance: 1 })

function fixture ({ leaves = NATURAL_LEAVES } = {}) {
  const world = new World(null, null, 0).sync
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }))
  const set = (x, y, z, name, props) => world.setBlockStateId(new Vec3(x, y, z), typeof name === 'number' ? name : state(name, props))
  for (let x = -4; x <= 8; x++) for (let z = -4; z <= 8; z++) set(x, 63, z, 'grass_block')
  // oak: trunk at (3, 64..68, 0), a crown of leaves around the top
  for (let y = 64; y <= 68; y++) set(3, y, 0, 'oak_log')
  for (let x = 2; x <= 4; x++) for (let z = -1; z <= 1; z++) for (let y = 67; y <= 69; y++) {
    if (!(x === 3 && z === 0 && y <= 68)) set(x, y, z, leaves())
  }
  const bot = {
    registry,
    world,
    game: { gameMode: 'survival' },
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8 },
    blockAt: pos => world.getBlock(pos),
    findBlocks ({ matching, maxDistance }) {
      const out = []
      const c = bot.entity.position.floored()
      for (let x = -maxDistance; x <= maxDistance; x++) {
        for (let y = -maxDistance; y <= maxDistance; y++) {
          for (let z = -maxDistance; z <= maxDistance; z++) {
            const p = c.offset(x, y, z)
            if (matching.includes(world.getBlock(p)?.type)) out.push(p)
          }
        }
      }
      return out.sort((a, b) => a.distanceTo(c) - b.distanceTo(c))
    },
    blockAtCursor: max => bot.blockAtEntityCursor(bot.entity, max),
    waitForTicks: async () => {},
    inventory: { items: () => bot._items },
    _items: [],
    heldItem: null,
    async equip (item) { bot.heldItem = item },
    stopDigging () {}
  }
  attachEyeRaycast(bot)
  return { bot, world, set }
}

const axe = (name, extra = {}) => ({ name, type: registry.itemsByName[name].id, displayName: name, slot: 36, ...extra })

test('humanized turn: starts still, peaks once, lands exactly on the target', () => {
  const rand = (() => { let s = 1; return () => (s = (s * 16807) % 2147483647) / 2147483647 })()
  for (const [dy, dp] of [[90, 10], [-35, -20], [4, 1], [170, 0]]) {
    const plan = humanPlan(0, 0, dy * DEG, dp * DEG, rand)
    assert.ok(plan.ticks >= 4 && plan.ticks <= 40)
    const points = [{ yaw: 0, pitch: 0 }]
    for (plan.k = 1; plan.k < plan.ticks; plan.k++) points.push(humanPoint(plan))
    points.push({ yaw: dy * DEG, pitch: dp * DEG })
    const steps = points.slice(1).map((p, i) => Math.hypot(p.yaw - points[i].yaw, p.pitch - points[i].pitch) / DEG)
    const peak = Math.max(...steps)
    const peakAt = steps.indexOf(peak)
    // smooth start and stop: the first and last steps are small next to the peak
    assert.ok(steps[0] < peak * 0.35, `start ${steps[0]} vs peak ${peak}`)
    assert.ok(steps[steps.length - 1] < peak * 0.35, `end ${steps.at(-1)} vs peak ${peak}`)
    // one hump: speed rises to the peak and then falls
    for (let i = 1; i <= peakAt; i++) assert.ok(steps[i] >= steps[i - 1] - 0.05, `rising at ${i}`)
    for (let i = peakAt + 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1] + 0.05, `falling at ${i}`)
    // no single tick turns more than a hand reasonably can at this distance
    assert.ok(peak < 12, `peak ${peak}°/tick for ${dy}°`)
  }
})

test('a shard axe is found by its custom name, lore or item data', () => {
  const { bot } = fixture()
  const plain = axe('diamond_axe')
  const shard = axe('netherite_axe', { customName: JSON.stringify({ text: 'Shard Axe', color: 'aqua' }) })
  bot._items = [plain, shard]
  assert.equal(findAxe(bot), shard)
  bot._items = [plain, axe('diamond_axe', { customLore: [JSON.stringify({ text: 'Fells trees with shards' })] })]
  assert.equal(findAxe(bot), bot._items[1])
  bot._items = [plain, axe('iron_axe', { components: [{ type: 'custom_data', data: { id: 'donut:shard_axe' } }] })]
  assert.equal(findAxe(bot), bot._items[1])
  bot._items = [plain]
  assert.equal(findAxe(bot), null)
  assert.equal(findAxe(bot, 'diamond'), plain)
})

test('natural trees are recognised, player builds with persistent leaves are not', () => {
  assert.equal(treeAt(fixture().bot, new Vec3(3, 64, 0)).natural, true)
  assert.equal(treeAt(fixture({ leaves: PLACED_LEAVES }).bot, new Vec3(3, 64, 0)).natural, false)
  const { bot } = fixture({ leaves: PLACED_LEAVES })
  assert.equal(pickTarget(bot), null)
  assert.ok(pickTarget(bot, { requireNatural: false }))
})

test('the eye ray picks a reachable trunk log and the crosshair agrees after turning', () => {
  const { bot } = fixture()
  const t = pickTarget(bot)
  assert.ok(t)
  assert.equal(t.obstacle, false)
  assert.equal(t.block.name, 'oak_log')
  bot.entity.yaw = t.yaw
  bot.entity.pitch = t.pitch
  assert.ok(bot.blockAtCursor(4.5).position.equals(t.block.position))
})

test('a block in the ray is broken first, then the tree', () => {
  const { bot, set } = fixture()
  // wall the trunk off at eye level and below on the bot's side
  for (let y = 64; y <= 67; y++) for (let z = -1; z <= 1; z++) set(2, y, z, 'oak_planks')
  const t = pickTarget(bot)
  assert.ok(t)
  assert.equal(t.obstacle, true)
  assert.equal(t.block.name, 'oak_planks')
})

test('chop loop: equips the shard axe, re-breaks a ghosted log, counts the felled tree', async () => {
  const { bot, world } = fixture()
  const shard = axe('netherite_axe', { customName: 'Shard Axe' })
  bot._items = [axe('stone_axe'), shard]
  const ac = new AbortController()
  class Cancelled extends Error {}
  class CmdError extends Error {}
  const replies = []
  let digs = 0
  const looks = []
  const run = chopTrees(bot, ac.signal, {}, {
    look: async (yaw, pitch) => { looks.push({ yaw, pitch }); bot.entity.yaw = yaw; bot.entity.pitch = pitch; return true },
    dig: async (block) => {
      assert.equal(bot.heldItem, shard, 'digs with the shard axe in hand')
      digs++
      if (digs === 1) throw new Error('сервер не подтвердил разрушение блока за 5 секунд')
      // the shard axe fells the whole tree
      for (let y = 64; y <= 68; y++) world.setBlockStateId(new Vec3(3, y, 0), 0)
    },
    checkCancel: signal => { if (signal.aborted) throw new Cancelled() },
    Cancelled,
    CmdError,
    reply: text => {
      replies.push(text)
      if (/жду/.test(text)) ac.abort()
    }
  })
  await assert.rejects(run, Cancelled)
  assert.equal(digs, 2, 'ghosted block was broken again')
  assert.ok(replies.some(r => /не подтвердил.*повтор 1/.test(r)))
  assert.ok(replies.some(r => /срублено деревьев: 1/.test(r)))
  assert.ok(looks.length >= 2)
})
