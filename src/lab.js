'use strict'
/*
 * Movement lab: a local HTTP API for live movement tests on a running bot.
 *
 * Off by default; `.lab on` starts it on 127.0.0.1 (random port) and writes the port and a
 * random token to data/lab.json. Every request needs the token (header x-lab-token or ?token=).
 * It only uses what a player has: keys, head rotation, Botify commands. No raw packets.
 *
 *   GET  /bots                                   bots and their state
 *   GET  /state?bot=NAME                         position, velocity, flags, keys, blocks around the feet
 *   GET  /blocks?bot=NAME&r=3&down=2&up=3        non-air blocks around the bot (relative to its block)
 *   GET  /trace?bot=NAME&n=100                   last movement records (state per tick, packets, corrections)
 *   GET  /find?bot=NAME&name=water&r=64&n=200    nearest blocks of a kind (up to 96 blocks away)
 *   GET  /logs?bot=NAME&n=50                     last console lines
 *   POST /command {bot, line, wait}              run a dot command (.goto 10 64 5, .stop, ...)
 *   POST /keys {bot, keys, ticks, yaw, pitch, keep}
 *        hold keys (forward/back/left/right/jump/sneak/sprint) for N ticks and return a per-tick
 *        trace and the corrections that happened; yaw/pitch are F3 degrees, turned smoothly first
 *   POST /look {bot, yaw, pitch}                 smooth head turn (F3 degrees)
 *   POST /stop {bot}                             release everything (same as .stop)
 *   GET/POST /flags {flags, reset}               physics variants for experiments (vanilla-walking.js)
 */
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')

const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
const DEG = Math.PI / 180
const r4 = n => Math.round(n * 1e4) / 1e4

let running = null // { server, port, token, file }

function findBot (manager, name) {
  const all = [...manager.bots.values()]
  const key = String(name || '').toLowerCase()
  const inst = !key && all.filter(b => b.state === 'online').length === 1
    ? all.find(b => b.state === 'online')
    : all.find(b => b.id.toLowerCase() === key || b.bot?.username?.toLowerCase() === key ||
      String(b.snapshot().name || '').toLowerCase() === key)
  if (!inst) throw new LabError(404, 'бот не найден: ' + name)
  return inst
}

function online (inst) {
  const bot = inst.bot
  if (!bot?.entity || inst.state !== 'online') throw new LabError(409, 'бот не в сети')
  return bot
}

class LabError extends Error {
  constructor (status, message) { super(message); this.status = status }
}

function blockInfo (block) {
  if (!block) return null
  const props = block.getProperties?.() || {}
  return { name: block.name, shapes: block.shapes?.length ? block.shapes.map(s => s.map(r4)) : [], props }
}

function stateOf (inst) {
  const bot = online(inst)
  const e = bot.entity
  const c = bot.controlState
  const feet = e.position.floored()
  return {
    bot: bot.username,
    tick: inst.movementRecovery?.tick?.() ?? null,
    pos: { x: e.position.x, y: e.position.y, z: e.position.z },
    vel: { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z },
    f3: { yaw: r4(((180 - e.yaw / DEG) % 360 + 540) % 360 - 180), pitch: r4(-e.pitch / DEG) },
    onGround: e.onGround,
    inWater: !!e.isInWater,
    inLava: !!e.isInLava,
    collided: !!e.isCollidedHorizontally,
    minorCollision: !!e.minorHorizontalCollision,
    sprinting: !!e.botifySprinting,
    oxygen: bot.oxygenLevel ?? null, // 20 = full air
    health: bot.health,
    keys: KEYS.filter(k => c[k]),
    food: bot.food,
    effects: Object.values(e.effects || {}).map(x => ({ id: x.id, amplifier: x.amplifier })),
    attributes: e.attributes,
    corrections10s: inst.setbacks?.rate?.() ?? null,
    route: bot.pathfinder?.goal ? { nodes: bot.pathfinder.getPath?.().length ?? null, decision: bot.pathfinder.debugState ?? null } : null,
    blocks: {
      feet: blockInfo(bot.blockAt(feet)),
      below: blockInfo(bot.blockAt(feet.offset(0, -1, 0))),
      head: blockInfo(bot.blockAt(feet.offset(0, 1, 0)))
    }
  }
}

function blocksAround (inst, r, down, up) {
  const bot = online(inst)
  const base = bot.entity.position.floored()
  const out = []
  for (let dy = -down; dy <= up; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const b = bot.blockAt(base.offset(dx, dy, dz))
        if (!b) { out.push({ dx, dy, dz, name: null }); continue }
        if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue
        const info = blockInfo(b)
        out.push({ dx, dy, dz, ...info })
      }
    }
  }
  return { origin: { x: base.x, y: base.y, z: base.z }, blocks: out }
}

function fromF3 (yaw, pitch, e) {
  return {
    yaw: Number.isFinite(yaw) ? Math.PI - yaw * DEG : e.yaw,
    pitch: Number.isFinite(pitch) ? -Math.max(-90, Math.min(90, pitch)) * DEG : e.pitch
  }
}

async function look (bot, yaw, pitch) {
  const target = fromF3(Number(yaw), Number(pitch), bot.entity)
  if (bot.smoothLook) await bot.smoothLook.turn(target.yaw, target.pitch, () => false, 'human-fast')
  else await bot.look(target.yaw, target.pitch, false)
}

async function holdKeys (inst, body) {
  const bot = online(inst)
  if (bot.pathfinder?.goal) throw new LabError(409, 'сначала остановите маршрут (.stop)')
  // Never drown a bot in an experiment: refuse to start low on air; a run aborts at 8/20 air
  // and holds only jump until the bot has air again.
  if (bot.oxygenLevel != null && bot.oxygenLevel <= 8) {
    await surface(bot)
    throw new LabError(409, 'мало воздуха: бот всплывает, повторите позже')
  }
  const ticks = Math.max(1, Math.min(400, Number(body.ticks) || 20))
  const keys = body.keys || {}
  for (const k of Object.keys(keys)) if (!KEYS.includes(k)) throw new LabError(400, 'неизвестная клавиша: ' + k)
  if (body.yaw != null || body.pitch != null) await look(bot, body.yaw, body.pitch)
  const trace = []
  const corrections = []
  let aborted = null
  const onCorrection = c => corrections.push({ tick: trace.length, distance: r4(c.distance), keys: c.keys, from: c.from, to: c.to })
  bot.on('botifyCorrection', onCorrection)
  for (const k of KEYS) bot.setControlState(k, !!keys[k])
  try {
    await new Promise((resolve, reject) => {
      let n = 0
      const timer = setTimeout(() => { cleanup(); reject(new LabError(504, 'тики не идут')) }, ticks * 50 + 5000)
      const onTick = () => {
        const e = bot.entity
        if (!e) return
        trace.push({ t: ++n, x: e.position.x, y: e.position.y, z: e.position.z, vx: r4(e.velocity.x), vy: r4(e.velocity.y), vz: r4(e.velocity.z),
          ground: e.onGround, water: !!e.isInWater, wall: !!e.isCollidedHorizontally, sprint: !!e.botifySprinting })
        if (n >= ticks) { cleanup(); resolve() }
        else if (bot.oxygenLevel != null && bot.oxygenLevel <= 8) { aborted = 'мало воздуха'; cleanup(); resolve() }
      }
      const onEnd = () => { cleanup(); reject(new LabError(409, 'бот отключился')) }
      const cleanup = () => { clearTimeout(timer); bot.off('physicsTick', onTick); bot.off('end', onEnd) }
      bot.on('physicsTick', onTick)
      bot.once('end', onEnd)
    })
  } finally {
    bot.off('botifyCorrection', onCorrection)
    if (!body.keep || aborted) bot.clearControlStates()
  }
  if (aborted) await surface(bot)
  return { ticks: trace.length, aborted, corrections, trace, end: stateOf(inst) }
}

// Hold only jump while the head is under water and air is not full again (max ~30 s).
async function surface (bot) {
  if (!bot.entity?.isInWater) return
  bot.clearControlStates()
  bot.setControlState('jump', true)
  const until = Date.now() + 30000
  while (Date.now() < until && bot.entity && (bot.oxygenLevel ?? 20) < 20) await new Promise(resolve => setTimeout(resolve, 250))
  bot.setControlState('jump', false)
}

async function runCommand (inst, line, wait) {
  if (typeof line !== 'string' || !line.startsWith('.')) throw new LabError(400, 'нужна команда вида .goto x y z')
  const replies = []
  const started = Date.now()
  const done = Promise.resolve(inst.command(line, (text, kind) => { replies.push({ kind: kind || 'out', text }); inst.log(kind || 'out', text) }))
    .catch(e => replies.push({ kind: 'err', text: String(e?.message || e) }))
  await Promise.race([done, new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(60000, Number(wait) || 500))))])
  return { replies, logs: inst.logs.filter(l => l.t >= started).map(l => ({ kind: l.kind, text: l.text })) }
}

async function readBody (req) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > 65536) throw new LabError(413, 'слишком большой запрос')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new LabError(400, 'некорректный JSON') }
}

function start (manager, file) {
  if (running) return running
  const token = crypto.randomBytes(24).toString('hex')
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data))
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '') || req.headers.origin) throw new LabError(403, 'forbidden')
      const given = String(req.headers['x-lab-token'] || url.searchParams.get('token') || '')
      if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) throw new LabError(401, 'нужен токен')
      const q = url.searchParams
      const route = `${req.method} ${url.pathname}`
      if (route === 'GET /bots') return send(200, [...manager.bots.values()].map(b => ({ id: b.id, name: b.bot?.username ?? b.snapshot().name, state: b.state })))
      // Physics variants for live experiments (vanilla-walking.js flags); {} restores vanilla.
      if (route === 'GET /flags') return send(200, require('./vanilla-walking').flags)
      if (route === 'POST /flags') {
        const flags = require('./vanilla-walking').flags
        const body = await readBody(req)
        if (body.reset) for (const k of Object.keys(flags)) delete flags[k]
        Object.assign(flags, body.flags || {})
        return send(200, flags)
      }
      const body = req.method === 'POST' ? await readBody(req) : {}
      const inst = findBot(manager, body.bot ?? q.get('bot'))
      switch (route) {
        case 'GET /state': return send(200, stateOf(inst))
        case 'GET /blocks': return send(200, blocksAround(inst, Math.min(8, Number(q.get('r') ?? 3)), Math.min(8, Number(q.get('down') ?? 2)), Math.min(8, Number(q.get('up') ?? 3))))
        case 'GET /trace': return send(200, inst.movementRecovery?.recent(Number(q.get('n') || 100)) ?? [])
        case 'GET /find': {
          // Nearest blocks by name (e.g. ?name=water&r=64&n=200): to locate rivers, ladders, ...
          const bot = online(inst)
          const ids = String(q.get('name') || '').split(',').map(n => bot.registry.blocksByName[n.trim()]?.id).filter(id => id != null)
          if (!ids.length) throw new LabError(400, 'неизвестный блок')
          const found = bot.findBlocks({ matching: ids, maxDistance: Math.min(96, Number(q.get('r') || 48)), count: Math.min(2000, Number(q.get('n') || 200)) })
          return send(200, found.map(p => { const b = bot.blockAt(p); return { x: p.x, y: p.y, z: p.z, name: b?.name, level: b?.getProperties?.().level } }))
        }
        case 'GET /logs': return send(200, inst.logs.slice(-Math.min(500, Number(q.get('n') || 50))))
        case 'POST /command': return send(200, await runCommand(inst, body.line, body.wait))
        case 'POST /keys': return send(200, await holdKeys(inst, body))
        case 'POST /look': await look(online(inst), body.yaw, body.pitch); return send(200, stateOf(inst))
        case 'POST /stop': return send(200, await runCommand(inst, '.stop', 200))
        default: throw new LabError(404, 'нет такого метода')
      }
    } catch (e) {
      send(e.status || 500, { error: String(e.message || e) })
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${port}`, token }, null, 2))
      running = { server, port, token, file }
      resolve(running)
    })
  })
}

function stop () {
  if (!running) return false
  running.server.close()
  try { fs.unlinkSync(running.file) } catch {}
  running = null
  return true
}

module.exports = { start, stop, status: () => running && { port: running.port, file: running.file } }
