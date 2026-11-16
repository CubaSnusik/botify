'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump']
const PACKETS = new Set(['position', 'position_look', 'look', 'flying', 'player_input', 'entity_action', 'tick_end', 'teleport_confirm'])
const FIELDS = ['x', 'y', 'z', 'yaw', 'pitch', 'onGround', 'flags', 'inputs', 'actionId', 'teleportId']
const ATTRIBUTES = /(?:movement[_.]?speed|friction_modifier|air_drag_modifier|gravity|jump_strength|step_height|sneaking_speed)$/i

// Keep a bounded, movement-only record. No login packets, session data, chat or inventory.
function attachMovementRecovery (bot, { file, stop, log, now = () => performance.now() }) {
  const records = []
  let corrections = []
  let tick = 0
  let ended = false
  let writing = Promise.resolve()
  const start = now()
  const record = (type, data) => {
    if (ended) return
    records.push({ ms: now() - start, tick, type, ...data })
    if (records.length > 400) records.shift()
  }
  const state = () => {
    const e = bot.entity
    if (!e) return {}
    const vector = v => v && { x: v.x, y: v.y, z: v.z }
    return { position: vector(e.position), velocity: vector(e.velocity), yaw: e.yaw, pitch: e.pitch,
      onGround: e.onGround, collision: !!e.isCollidedHorizontally, water: !!e.isInWater,
      controls: Object.fromEntries(KEYS.map(key => [key, !!bot.controlState?.[key]])),
      sprinting: !!e.botifySprinting,
      // Which pathfinder decision produced these keys (null outside of routes).
      nav: bot.pathfinder?.goal ? structuredClone(bot.pathfinder.debugState ?? null) : null,
      attributes: structuredClone(Object.fromEntries(Object.entries(e.attributes || {}).filter(([key]) => ATTRIBUTES.test(key)))) }
  }
  // Every outgoing packet name (plus sequence/teleport ids, nothing else) for kick diagnostics:
  // survives respawns, written to <id>.kick.json when the server kicks the bot.
  const outgoing = []
  const write = bot._client.write
  bot._client.write = function (name, params) {
    outgoing.push({ ms: Math.round(now() - start), name, sequence: params?.sequence, teleportId: params?.teleportId, status: params?.status })
    if (outgoing.length > 200) outgoing.shift()
    if (PACKETS.has(name)) {
      const fields = Object.fromEntries(FIELDS.filter(key => params?.[key] !== undefined).map(key => [key, params[key]]))
      record('packet', { name, fields: structuredClone(fields) })
    }
    return write.call(this, name, params)
  }
  // Every correction (also a single one, e.g. right after .stop) leaves a trace in
  // <id>.last.json: the ticks before it and one second after. At most one per 10 s.
  let lastSnapshot = -Infinity
  const saveSingle = (correction) => {
    const time = now()
    if (time - lastSnapshot < 10_000) return
    lastSnapshot = time
    const timer = setTimeout(() => {
      if (ended) return
      const report = { format: 1, version: bot.version, physics: bot.physics?.botifyWalkingProfile || 'prismarine',
        reason: 'single correction', correction, records: records.slice() }
      const single = file.replace(/\.json$/, '') + '.last.json'
      const json = JSON.stringify(report, null, 2)
      writing = writing.then(async () => {
        await fs.mkdir(path.dirname(single), { recursive: true })
        await fs.writeFile(single + '.tmp', json, 'utf8')
        await fs.rename(single + '.tmp', single)
      }).catch(error => log(`[движение] не удалось сохранить диагностику: ${error.message}`))
    }, 1000)
    timer.unref?.()
  }
  bot.on('botifyCorrection', correction => {
    record('correction', structuredClone(correction))
    saveSingle(structuredClone(correction))
    // A route counts as active even while the pathfinder holds keys released after a correction.
    const active = MOVE_KEYS.some(key => correction.keys.includes(key)) || !!bot.pathfinder?.goal
    if (!active) { corrections = []; return }
    const time = now()
    corrections = corrections.filter(t => time - t < 3000)
    corrections.push(time)
    if (corrections.length < 4) return
    corrections = []
    const report = { format: 1, version: bot.version, physics: bot.physics?.botifyWalkingProfile || 'prismarine',
      reason: 'four movement corrections within three seconds', records: records.slice() }
    // Release inputs/tasks; never edit position, velocity, correction acknowledgements or flags.
    stop()
    log('[движение] остановлено после 4 коррекций за 3 с; повторный запуск — новой командой')
    const json = JSON.stringify(report, null, 2)
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file + '.tmp', json, 'utf8')
      await fs.rename(file + '.tmp', file)
      log(`[движение] диагностика сохранена: ${file}`)
    }).catch(error => log(`[движение] не удалось сохранить диагностику: ${error.message}`))
  })
  bot.on('kicked', reason => {
    const kick = file.replace(/\.json$/, '') + '.kick.json'
    const json = JSON.stringify({ format: 1, version: bot.version, reason: typeof reason === 'string' ? reason : JSON.stringify(reason), atMs: Math.round(now() - start), outgoing: outgoing.slice() }, null, 2)
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(kick), { recursive: true })
      await fs.writeFile(kick, json, 'utf8')
      log(`[движение] пакеты перед киком сохранены: ${kick}`)
    }).catch(error => log(`[движение] не удалось сохранить пакеты перед киком: ${error.message}`))
  })
  const reset = () => { records.length = 0; corrections = [] }
  bot.on('respawn', reset)
  bot._client.on('start_configuration', reset)
  bot.once('end', () => { ended = true; reset() })
  return {
    /** The last `n` records (state per tick, movement packets, corrections) for the lab API. */
    recent (n = 100) { return structuredClone(records.slice(-Math.max(1, Math.min(400, n)))) },
    tick () { return tick },
    before () { tick++; record('before', state()) },
    after () { record('after', state()) },
    flushed () { return writing }
  }
}

module.exports = { attachMovementRecovery }
