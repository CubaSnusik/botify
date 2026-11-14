'use strict'
// Local wire smoke test. This server deliberately has no anticheat or movement simulation.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { Store } = require('../../src/store')
const { BotManager } = require('../../src/bots')
const { SkinService } = require('../../src/assets')
const { startServer } = require('../../src/server')
const mc = require('minecraft-protocol')
const { Vec3 } = require('vec3')

async function until (predicate, message, timeout = 10_000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < end, message)
    await delay(25)
  }
}

for (const version of ['26.1', '26.2']) {
  test(`auto selects ${version}: backend, icons, walking, server corrections and idle expiry`, { timeout: 35_000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botify-wire-test-'))
    const store = new Store(dir)
    const manager = new BotManager(store)
    const skins = new SkinService(store.path('skins'))
    let backend; let server
    t.after(async () => {
      if (backend) await backend.close()
      else { await manager.disconnectAll(); store.flush() }
      if (server?.socketServer?.listening) {
        const closed = once(server, 'close', { signal: AbortSignal.timeout(4000) })
        server.close()
        await closed
      }
      await until(() => [...manager.bots.values()].every(b => !b.bot), 'bot disconnect', 4000)
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const registry = require('prismarine-registry')(version)
    const Chunk = require('prismarine-chunk')(registry)
    const data = require('minecraft-data')(version)
    const chunk = new Chunk({ minY: -64, worldHeight: 384 })
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        chunk.setBlockStateId(new Vec3(x, -61, z), registry.blocksByName.stone.defaultState)
      }
    }
    chunk.setBlockStateId(new Vec3(0, -61, 2), registry.blocksByName.glass.defaultState)
    const chunkPacket = { heightmaps: [], chunkData: chunk.dump(), blockEntities: [], ...chunk.dumpLight() }
    server = mc.createServer({
      'online-mode': false, host: '127.0.0.1', port: 0, version,
      registryCodec: data.loginPacket.dimensionCodec, enforceSecureProfile: false
    })
    // The installed protocol server omits the 26.2 login-success sessionId.
    server.on('connection', client => {
      const write = client.write.bind(client)
      client.write = (name, params) => write(name, name === 'success' ? { sessionId: randomUUID(), ...params } : params)
    })
    let peer
    const packets = new Map()
    const digPackets = []
    const turns = []
    let lastLook = null
    let sawBreak = false; let sawSwing = false
    const missingSwings = []
    server.on('playerJoin', client => {
      peer = client
      client.on('packet', (_, meta) => packets.set(meta.name, (packets.get(meta.name) || 0) + 1))
      client.on('packet', (p, meta) => {
        if (meta.name === 'block_dig' && p.status !== 1) sawBreak = true
        if (meta.name === 'arm_animation') sawSwing = true
        if (['position', 'position_look', 'look', 'flying', 'tick_end'].includes(meta.name)) {
          if (sawBreak && !sawSwing) missingSwings.push(meta.name)
          sawBreak = sawSwing = false
        }
        if (meta.name === 'look' || meta.name === 'position_look') {
          lastLook = { yaw: p.yaw, pitch: p.pitch }
          turns.push(lastLook)
        }
        if (meta.name === 'block_dig') {
          digPackets.push({ ...p, look: lastLook, tick: packets.get('tick_end') || 0 })
          if (p.status === 2) client.write('block_change', { location: p.location, type: registry.blocksByName.air.defaultState })
        }
      })
      client.write('login', {
        ...data.loginPacket, entityId: client.id,
        worldState: { ...data.loginPacket.worldState, gamemode: 'survival' }
      })
      client.write('game_state_change', { reason: 'level_chunks_load_start', gameMode: 0 })
      for (let x = -1; x <= 1; x++) {
        for (let z = -1; z <= 1; z++) client.write('map_chunk', { ...chunkPacket, x, z })
      }
      client.write('position', { teleportId: 1, x: 0.5, y: -60, z: 0.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {} })
      client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
    })
    await once(server, 'listening', { signal: AbortSignal.timeout(5000) })
    store.updateSettings({ behavior: { autoReconnect: false }, server: { host: '127.0.0.1', port: server.socketServer.address().port, version: 'auto' } })
    const acc = store.addAccount({ username: 'BotifyTest', type: 'offline' })
    backend = await startServer({ port: 0, app: { store, manager, skins } })
    for (const route of ['', `icon/${version}/diamond_axe.png`, `skin/${acc.id}`]) {
      const response = await fetch(backend.url + route, { signal: AbortSignal.timeout(3000) })
      assert.equal(response.status, 200, route)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (route) assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    }
    const inst = manager.get(acc.id)
    await inst.connect()
    try {
      await until(() => inst.state === 'online' && inst.bot.entity.onGround, `spawn: ${version}`)
    } catch (error) {
      t.diagnostic(JSON.stringify({ state: inst.state, logs: inst.logs, position: inst.bot?.entity?.position, onGround: inst.bot?.entity?.onGround, block: inst.bot?.blockAt(inst.bot.entity.position)?.name, packets: [...packets] }))
      throw error
    }
    const bot = inst.bot
    assert.equal(bot.version, version)
    assert.equal(bot.physics.botifyWalkingProfile, version, 'auto must enable the profile for the negotiated protocol')
    assert.ok(inst.logs.some(l => l.text.includes(`[движение] протокол ${version}; физика vanilla ${version}`)))
    const replies = []
    await inst.command('.break 0 -61 2', text => replies.push(text))
    assert.ok(replies.includes('готово'), replies.join('; '))
    assert.deepEqual(digPackets.map(p => p.status), [0, 2])
    assert.deepEqual(digPackets.map(p => p.sequence), [1, 2])
    assert.deepEqual(missingSwings, [], 'each break action has a swing before the next movement/tick boundary')
    assert.equal(digPackets[0].face, 1, 'crosshair hits the top of the floor block')
    assert.ok(digPackets[0].look.pitch > 20, 'server receives downward aim before START')
    // START is sent after the preceding tick_end; STOP precedes its own tick_end.
    assert.ok(digPackets[1].tick - digPackets[0].tick + 1 >= 9, 'glass mining spans at least nine client tick intervals')
    for (let i = 1; i < turns.length; i++) assert.ok(Math.abs(turns[i].yaw - turns[i - 1].yaw) <= 12.151, 'no head snap before digging')
    assert.equal(bot.blockAt(new Vec3(0, -61, 2)).name, 'air', 'world changed only on server confirmation')
    const start = bot.entity.position.clone()
    bot.setControlState('forward', true)
    await delay(500)
    bot.clearControlStates()
    assert.ok(bot.entity.position.distanceTo(start) > 0.1, 'bot walks via physics')
    await delay(3100) // finish spawn grace period and let horizontal inertia settle
    assert.equal(inst.setbacks.rate(), 0)
    assert.ok(packets.get('tick_end') > 0, 'tick packets reach server')
    assert.ok(packets.get('player_input') > 0, 'input packets reach server')

    let teleportId = 1
    async function correct (x, z = 0) {
      const e = bot.entity
      const ack = once(peer, 'teleport_confirm', { signal: AbortSignal.timeout(3000) })
      peer.write('position', {
        teleportId: ++teleportId, x: e.position.x + x, y: e.position.y, z: e.position.z + z,
        dx: e.velocity.x, dy: e.velocity.y, dz: e.velocity.z, yaw: 0, pitch: 0, flags: {}
      })
      assert.equal((await ack)[0].teleportId, teleportId)
    }
    for (let i = 0; i < 12; i++) await correct(0.0014)
    assert.equal(inst.snapshot().live.setbacks, 12)
    const corrections = () => inst.logs.filter(l => l.text.startsWith('[коррекция]'))
    assert.equal(corrections().length, 3)
    assert.match(corrections()[0].text, /0\.0014/)
    await correct(10)
    assert.equal(inst.setbacks.rate(), 12, 'large teleport has a separate log')
    assert.ok(inst.logs.some(l => l.text.startsWith('[перемещение]')))
    await until(() => inst.setbacks.rate() === 0, 'counter expires without further corrections', 11_000)
    assert.equal(corrections().length, 4)
    assert.match(corrections()[3].text, /ещё 9/)
    assert.equal(inst.snapshot().live.setbacks, 0)
    // Reproduce a correction loop while actively walking: halt inputs and preserve a
    // trace of the actual wire stream, including packets generated by the vanilla adapter.
    // The earlier walk can end in the deliberately mined floor hole. Place the next
    // scenario on intact floor rather than translating that low Y inside a solid block.
    const placed = once(peer, 'teleport_confirm', { signal: AbortSignal.timeout(3000) })
    peer.write('position', { teleportId: ++teleportId, x: 10.5, y: -60, z: 0.5,
      dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {} })
    await placed
    await delay(150)
    const navigation = inst.command('.goto 10 -60 20')
    navigation.catch(() => {})
    try { await until(() => bot.controlState.forward, 'route starts walking') } catch (error) {
      t.diagnostic(JSON.stringify({ position: bot.entity.position, logs: inst.logs.slice(-12) }))
      throw error
    }
    for (let i = 0; i < 4; i++) { await delay(80); await correct(0, -0.05) }
    try {
      await until(() => inst.logs.some(l => l.text.includes('остановлено после 4 коррекций')), 'active route halted', 1500)
    } catch (error) {
      t.diagnostic(JSON.stringify(inst.logs.slice(-12)))
      throw error
    }
    await navigation
    assert.equal(inst.task, null, 'correction loop cancels the active route')
    assert.equal(bot.pathfinder.goal, null)
    assert.equal(bot.controlState.forward, false, 'correction loop releases movement')
    await until(() => inst.logs.some(l => l.text.includes('диагностика сохранена:')), 'movement trace written')
    const trace = JSON.parse(fs.readFileSync(store.path('movement', acc.id + '.json'), 'utf8'))
    assert.equal(trace.physics, version)
    assert.ok(trace.records.some(r => r.type === 'packet' && r.name === 'player_input' && r.fields.inputs.forward), 'record the adapter input packet, not the suppressed Mineflayer packet')
    assert.ok(trace.records.some(r => r.type === 'packet' && r.name === 'tick_end'))
    await delay(150)
    assert.equal(bot.controlState.forward, false, 'movement never restarts automatically')
    assert.equal(inst.state, 'online')
    assert.equal(inst.logs.filter(l => l.kind === 'err').length, 0)
    t.diagnostic('HTTP/PNG, TCP login, smooth aim and survival block digging, walking, 12 corrections and expiry passed')
  })
}
