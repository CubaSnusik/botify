'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { detectPlots, farmStands, signMatches, signContainer, runAutoTreeFarm, openSupplyContainer, transferSupply } = require('../src/auto-tree-farm')
const { DEFAULT_FARM, farmSettings, friendNames } = require('../src/farm-settings')
const { friendCommand, watchFarmPlayers, isFriend } = require('../src/friends')
const { BotManager } = require('../src/bots')
const { anglesFrom, eyePosition } = require('../src/eye-raycast')
const nbt = require('prismarine-nbt')
const Block = require('prismarine-block')('26.1')
const registry = require('prismarine-registry')('26.1')
const World = require('prismarine-world')(registry)
const Chunk = require('prismarine-chunk')(registry)
const windows = require('prismarine-windows')(registry)
const Item = require('prismarine-item')(registry)
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function fixture () {
  const bot = new EventEmitter()
  Object.assign(bot, { registry, version: '26.1', supportFeature: registry.supportFeature, game: { gameMode: 'survival', dimension: 'overworld' },
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, yaw: 0, pitch: 0 }, entities: {} })
  bot._client = new EventEmitter(); bot._client.state = 'play'; bot._client.write = () => {}
  bot.world = new World(null, null, 0).sync
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) bot.world.setColumn(x, z, new Chunk({ minY: -64, worldHeight: 384 }))
  const positions = new Map()
  bot.blockAt = p => bot.world.getBlock(p)
  const set = (p, name) => {
    const old = bot.blockAt(p)
    bot.world.setBlockStateId(p, registry.blocksByName[name].defaultState)
    positions.set(p.toString(), p)
    bot.emit('blockUpdate', old, bot.blockAt(p))
  }
  bot.findBlocks = ({ matching, maxDistance, count }) => [...positions.values()].filter(p => matching.includes(bot.blockAt(p).type) && p.distanceTo(bot.entity.position) <= maxDistance).slice(0, count)
  for (let x = -3; x <= 14; x++) for (let z = -3; z <= 10; z++) set(new Vec3(x, 63, z), 'stone')
  const plot = [new Vec3(8, 64, 2), new Vec3(9, 64, 2), new Vec3(8, 64, 3), new Vec3(9, 64, 3)]
  for (const p of plot) set(p, 'podzol')
  const stock = [{ name: 'netherite_axe', type: registry.itemsByName.netherite_axe.id, slot: 36, count: 1, customName: 'Shard Axe' }]
  bot.inventory = { items: () => stock, selectedItem: null }
  bot.heldItem = stock[0]; bot.quickBarSlot = 0
  bot.setQuickBarSlot = slot => { bot.quickBarSlot = slot; bot.heldItem = stock.find(i => i.slot === slot + 36) }
  bot.waitForTicks = async () => {}
  bot.swingArm = () => {}
  bot.closeWindow = window => { if (bot.currentWindow === window) bot.currentWindow = null }
  require('mineflayer/lib/plugins/generic_place')(bot)
  const ac = new AbortController()
  const inst = { bot, store: { settings: { farm: { ...DEFAULT_FARM, autoLeave: false, experienceCount: 0, mealCount: 4, saplingCount: 4 }, friends: [] } }, cancelTask: () => ac.abort() }
  class Cancelled extends Error {}
  const walks = []; const replies = []
  const deps = {
    Cancelled, checkCancel: s => { if (s.aborted) throw new Cancelled() }, reply: s => replies.push(s),
    walk: async (goal, target) => { walks.push(target.clone()); bot.entity.position = target.offset(0.5, 0, -1.5) },
    look: async (yaw, pitch, cancelled) => { if (cancelled()) return false; Object.assign(bot.entity, { yaw, pitch }); return true },
    dig: async () => assert.fail('no tree in this fixture')
  }
  return { bot, set, plot, stock, ac, inst, deps, walks, replies }
}

test('autodetect finds an isolated mixed-soil bed at distance, ignores flat fields and chooses standing positions', () => {
  const f = fixture()
  f.set(f.plot[0], 'dirt'); f.set(f.plot[1], 'mud')
  assert.deepEqual(detectPlots(f.bot, 32), [f.plot])
  const stands = farmStands(f.bot, f.plot)
  assert.ok(stands.length)
  assert.ok(stands.every(p => !f.plot.some(s => s.x === p.x && s.z === p.z)))
  f.set(f.plot[0].offset(-1, 0, 0), 'dirt')
  assert.equal(detectPlots(f.bot, 32).length, 0, 'a five-block patch is not a four-block bed')
})

test('sign labels match full lines on either side and bind to attached containers', () => {
  for (const name of ['barrel', 'chest', 'red_shulker_box', 'hopper', 'dropper', 'dispenser']) {
    const f = fixture()
    const p = new Vec3(0, 64, 3)
    f.set(p, name)
    const sign = { name: 'oak_wall_sign', position: p.offset(0, 0, -1), getProperties: () => ({ facing: 'north' }), getSignText: () => ['supplies\n§a1', '2'] }
    assert.equal(signMatches(sign, '1'), true)
    assert.equal(signMatches(sign, '2'), true)
    assert.equal(signMatches(sign, 'sup'), false)
    assert.equal(signContainer(f.bot, sign).name, name)
    f.set(p, 'stone')
    assert.equal(signContainer(f.bot, sign), null)
  }
})

for (const emptyMeal of [false, true]) test(`auto farm refills real barrel; meal empty=${emptyMeal} alerts only on container contents`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const alerts = []
  f.inst.alerts = { notify: async (...args) => { alerts.push(args) } }
  const barrel = new Vec3(0, 64, 3)
  f.set(barrel, 'barrel')
  const signP = [barrel.offset(0, 0, -1), barrel.offset(-1, 0, 0)]
  signP.forEach((p, index) => {
    f.set(p, 'oak_wall_sign')
    const sign = Block.fromProperties('oak_wall_sign', { facing: index === 0 ? 'north' : 'west', waterlogged: false }, 0)
    f.bot.world.setBlockStateId(p, sign.stateId)
    const tag = nbt.comp({ front_text: nbt.comp({ messages: nbt.list(nbt.comp([
      { '': nbt.string('') }, { translate: nbt.string(index === 0 ? '1' : '3'), color: nbt.string('black') }
    ])) }) })
    f.bot.world.getColumn(p.x >> 4, p.z >> 4).setBlockEntity(new Vec3(p.x & 15, p.y, p.z & 15), tag)
    assert.match(f.bot.blockAt(p).getSignText()[0], /\[object Object\]/, 'real dependency reproduces the old unreadable text')
  })
  const transfers = []; let plants = 0
  const supplies = emptyMeal ? ['spruce_sapling', 'diamond'] : ['bone_meal', 'spruce_sapling', 'diamond']
  f.bot.clickWindow = async (slot, mouseButton, mode) => {
    const window = f.bot.currentWindow
    window.acceptClick({ slot, mouseButton, mode, item: window.slots[slot] })
  }
  f.bot.closeWindow = window => {
    if (window !== f.bot.currentWindow) return
    const items = window.items().map(i => ({ ...i, customName: i.customName, slot: i.slot - window.inventoryStart + 9 }))
    for (const i of items.filter(i => i.name !== 'netherite_axe')) {
      const prev = f.stock.filter(s => s.name === i.name).reduce((n, s) => n + s.count, 0)
      if (i.count > prev) transfers.push([i.name, i.count - prev])
    }
    f.stock.splice(0, f.stock.length, ...items)
    f.bot.currentWindow = null
  }
  f.bot._client.write = (name, packet) => {
    if (name !== 'block_place') return
    if (packet.location.equals(barrel)) {
      assert.equal(f.bot.heldItem.name, 'netherite_axe')
      const window = windows.createWindow(1, 'minecraft:generic_9x3', 'Barrel')
      supplies.forEach((name, slot) => window.updateSlot(slot, new Item(registry.itemsByName[name].id, 64)))
      f.stock.forEach(i => window.updateSlot(i.slot - 9 + window.inventoryStart, Object.assign(new Item(i.type, i.count), { customName: i.customName })))
      f.bot.currentWindow = window
      f.bot.emit('windowOpen', window)
    } else {
      assert.equal(f.bot.heldItem.name, 'spruce_sapling')
      plants++; f.ac.abort()
    }
  }
  // Simulate walking to an exposed side, not through the attached sign.
  f.deps.walk = async (goal, target) => {
    f.walks.push(target.clone())
    f.bot.entity.position = target.equals(barrel) ? barrel.offset(2.5, 0, 0.5) : target.offset(0.5, 0, 0.5)
  }
  const run = runAutoTreeFarm(f.inst, f.ac.signal, f.deps)
  const rejected = assert.rejects(run, f.deps.Cancelled)
  for (let tick = 0; tick < 300 && !f.ac.signal.aborted; tick++) { f.bot.emit('physicsTick'); await flush(); t.mock.timers.tick(50); await flush() }
  f.ac.abort(); await rejected
  assert.deepEqual(transfers, emptyMeal ? [['spruce_sapling', 4]] : [['spruce_sapling', 4], ['bone_meal', 4]], JSON.stringify(f.replies))
  assert.equal(alerts.length, emptyMeal ? 1 : 0)
  if (emptyMeal) {
    assert.match(alerts[0][0], /^empty-container:bone_meal:/)
    assert.match(alerts[0][2], /barrel.*нет bone_meal/)
  }
  assert.equal(plants, 1)
  assert.ok(f.walks.filter(p => p.equals(barrel)).length === 2)
  assert.equal(f.bot.currentWindow, null)
  assert.equal(f.bot.listenerCount('windowOpen'), 0)
  assert.equal(f.bot.listenerCount('botifyDigReset'), 0)
})

test('cancelling a container open removes its listeners and prevents a late transfer', async () => {
  const f = fixture()
  const p = new Vec3(1, 64, 0); f.set(p, 'barrel')
  const run = openSupplyContainer(f.bot, f.bot.blockAt(p), f.ac.signal, f.deps.look)
  const rejected = assert.rejects(run, /отменена/)
  await flush(); f.ac.abort(); await rejected
  assert.equal(f.bot.listenerCount('windowOpen'), 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('a cancelled transfer cannot send delayed clicks into a closed or replacement window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const window = windows.createWindow(1, 'minecraft:generic_9x3', 'Barrel')
  window.updateSlot(2, new Item(registry.itemsByName.bone_meal.id, 64))
  f.bot.currentWindow = window
  let resume; let writes = 0
  const original = f.bot._client.write = () => writes++
  f.bot.clickWindow = async () => {
    await new Promise(resolve => { resume = resolve })
    f.bot._client.write('window_click', { windowId: 0 })
  }
  const run = transferSupply(f.bot, window, window.slots[2], 64, f.ac.signal)
  const rejected = assert.rejects(run, /отменена/)
  await flush(); t.mock.timers.tick(400); await flush(); f.ac.abort(); f.bot.currentWindow = null
  await rejected
  resume(); await flush()
  assert.equal(writes, 0)
  assert.equal(f.bot._client.write, original)
})

test('friend commands share a case-insensitive list, and auto-leave ignores friends and own bots', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = new EventEmitter()
  store.settings = { farm: { ...DEFAULT_FARM }, friends: [], behavior: { autoReconnect: true, joinStagger: 0 } }
  const accounts = [{ id: 'a', username: 'Farmer', type: 'offline' }, { id: 'b', username: 'OtherBot', type: 'offline' }]
  store.listAccounts = () => accounts; store.getAccount = id => accounts.find(a => a.id === id)
  store.updateSettings = patch => { Object.assign(store.settings, patch); store.emit('settings') }
  const manager = new BotManager(store)
  friendCommand(store, ['add', 'Buddy']); friendCommand(store, ['add', 'buddy'])
  assert.equal(store.settings.friends.length, 1)
  const inst = manager.get('a'); const bot = new EventEmitter(); inst.bot = bot
  inst.manualStop = false
  Object.assign(bot, { username: 'Farmer', entity: { id: 1 }, entities: {}, pathfinder: { setGoal: () => {} }, clearControlStates: () => {}, quit: () => {} })
  manager.get('b').bot = { username: 'OtherBot' }
  assert.equal(isFriend(manager.get('b'), { username: 'BUDDY' }), true)
  const ac = new AbortController(); inst.task = { ac }
  const player = name => ({ type: 'player', username: name, position: new Vec3(1, 64, 1), isValid: true })
  bot.entities = { 2: player('Buddy'), 3: player('OtherBot') }
  const messages = []
  const stop = watchFarmPlayers(inst, ac.signal, text => messages.push(text))
  assert.equal(inst.manualStop, false)
  bot.emit('entitySpawn', player('Stranger'))
  assert.equal(inst.manualStop, true)
  assert.equal(ac.signal.aborted, true)
  assert.equal(inst.reconnectTimer, null)
  inst.scheduleReconnect()
  assert.equal(inst.reconnectTimer, null, 'explicit disconnect suppresses auto reconnect')
  assert.equal(messages.length, 1)
  assert.equal(bot.listenerCount('entitySpawn'), 0)
  stop()
  friendCommand(store, ['remove', 'BUDDY']); assert.deepEqual(store.settings.friends, [])
  friendCommand(store, ['add', 'Buddy']); friendCommand(store, ['clear']); assert.deepEqual(store.settings.friends, [])
})

test('farm settings reject invalid radii and ambiguous labels; friends validate and deduplicate', () => {
  assert.equal(farmSettings({}).mealLabel, '1')
  assert.throws(() => farmSettings({ searchRadius: 999 }), /searchRadius/)
  assert.throws(() => farmSettings({ mealLabel: '2' }), /различаться/)
  assert.deepEqual(friendNames(['Alex', 'alex']), ['alex'])
  assert.throws(() => friendNames(['bad nick']), /неверный/)
})

test('auto-leave detects a player already rendered at startup and responds to live friend changes', async () => {
  for (const initiallyFriend of [false, true]) {
    const ac = new AbortController(); const bot = new EventEmitter()
    bot.entities = { 2: { type: 'player', username: 'Visitor', position: new Vec3(4, 64, 4) } }
    let disconnected = 0
    const inst = { bot, store: { settings: { farm: { autoLeave: true }, friends: initiallyFriend ? ['Visitor'] : [] } },
      disconnect: async () => { disconnected++; ac.abort() } }
    const stop = watchFarmPlayers(inst, ac.signal, () => {})
    assert.equal(disconnected, initiallyFriend ? 0 : 1)
    inst.store.settings.friends = []
    bot.emit('physicsTick')
    assert.equal(disconnected, 1)
    bot.emit('entitySpawn', bot.entities[2])
    assert.equal(disconnected, 1)
    assert.equal(bot.listenerCount('physicsTick'), 0)
    stop()
  }
})

test('farm configuration and friends persist together without accepting an invalid partial update', () => {
  const { Store } = require('../src/store')
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botify-farm-store-'))
  const store = new Store(dir)
  store.updateSettings({ farm: { mealLabel: 'meal', experienceLabel: 'xp', saplingLabel: 'trees' }, friends: ['Trusted'] })
  assert.throws(() => store.updateSettings({ farm: { searchRadius: 16 }, friends: ['bad nick'] }))
  assert.equal(store.settings.farm.searchRadius, 32)
  store.flush()
  const reloaded = new Store(dir)
  assert.equal(reloaded.settings.farm.mealLabel, 'meal')
  assert.deepEqual(reloaded.settings.friends, ['Trusted'])
  reloaded.flush()
})
