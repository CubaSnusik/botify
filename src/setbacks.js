'use strict'
/*
 * Monitor server position corrections. Distance is only a display heuristic: packets do not
 * identify the cause, so a short /tp must not be described as a confirmed anticheat setback.
 *
 * A prediction anticheat (Grim) corrects a player by teleporting them to where the SERVER thinks
 * they should be. "Where the bot was" minus "where the server put it" is a position discrepancy:
 *   ahead/behind (along the look direction) → speed: sprint, attributes, friction, effects
 *   sideways                                → rotation / strafing
 *   up/down                                 → jumping, stepping, gravity, water
 * These components help investigate corrections; they do not measure an anticheat's prediction
 * error or establish why the server sent the packet.
 */
const { Vec3 } = require('vec3')

const TELEPORT_DISTANCE = 6 // large movements are reported separately, regardless of their cause
const DETAIL_WINDOW = 5000 // ms
const DETAIL_LIMIT = 3 // detailed lines per window, the rest are summarized

function attachSetbackMonitor (bot, log, onRateChange = () => {}) {
  const times = [] // timestamps of recent setbacks (for the per-10s rate)
  let before = null
  let spawnedAt = null
  let airTicks = 0
  let sinceJump = 999
  let lastVy = 0
  let detailed = []
  let hidden = { n: 0, ahead: 0, side: 0, up: 0 }
  let flushTimer = null
  let rateTimer = null
  let ended = false

  const expire = () => {
    clearTimeout(rateTimer)
    rateTimer = null
    const old = times.length
    while (times.length && Date.now() - times[0] >= 10_000) times.shift()
    if (old !== times.length) onRateChange()
    if (times.length && !ended) {
      rateTimer = setTimeout(expire, Math.max(1, times[0] + 10_000 - Date.now()))
      rateTimer.unref?.()
    }
  }

  const reset = () => {
    before = null
    spawnedAt = Date.now()
    airTicks = 0
    sinceJump = 999
    lastVy = 0
    detailed = []
    hidden = { n: 0, ahead: 0, side: 0, up: 0 }
    clearTimeout(flushTimer)
    clearTimeout(rateTimer)
    flushTimer = rateTimer = null
    const hadCorrections = times.length > 0
    times.length = 0
    if (hadCorrections) onRateChange()
  }

  bot.once('spawn', reset)
  bot.on('respawn', reset)
  bot._client.on('start_configuration', reset)
  bot.on('physicsTick', () => {
    const e = bot.entity
    if (!e) return
    airTicks = e.onGround ? 0 : airTicks + 1
    sinceJump++
    if (e.velocity.y > 0.3 && lastVy <= 0.1) sinceJump = 0 // took off this tick
    lastVy = e.velocity.y
  })

  const fmt = (n) => (Math.abs(n) < 0.00005 ? '0' : (n > 0 ? '+' : '') + n.toFixed(4))

  const flush = () => {
    flushTimer = null
    if (!hidden.n) return
    const n = hidden.n
    log(`[коррекция] ещё ${n} за ${DETAIL_WINDOW / 1000} с · среднее отклонение бота: вперёд ${fmt(hidden.ahead / n)}, вбок ${fmt(hidden.side / n)}, вверх ${fmt(hidden.up / n)}`)
    hidden = { n: 0, ahead: 0, side: 0, up: 0 }
  }

  bot.once('login', () => {
    const client = bot._client
    client.prependListener('position', () => {
      const e = bot.entity
      if (!e || spawnedAt == null || ended) { before = null; return }
      const c = bot.controlState || {}
      let under = null
      let inBlock = null
      try { under = bot.blockAt(e.position.offset(0, -0.2, 0))?.name; inBlock = bot.blockAt(e.position)?.name } catch {}
      before = {
        pos: e.position.clone(),
        vel: e.velocity.clone(),
        yaw: e.yaw,
        onGround: e.onGround,
        collided: !!e.isCollidedHorizontally,
        water: !!e.isInWater,
        keys: ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].filter(k => c[k]),
        airTicks,
        sinceJump,
        under,
        inBlock
      }
    })
    // registered at login → runs after mineflayer applied the new position
    client.on('position', packet => {
      const b = before
      before = null
      if (!b || !bot.entity) return
      if (Date.now() - spawnedAt < 3000) return // join / respawn / world change placement
      const d = b.pos.minus(bot.entity.position) // how far the bot was from where the server wants it
      const dist = d.norm()
      if (!Number.isFinite(dist)) return
      if (dist > TELEPORT_DISTANCE) { log(`[перемещение] сервер изменил позицию на ${dist.toFixed(1)} бл.`); return }
      if (dist < 1e-4) return // same spot: not a correction of movement

      // decompose in the bot's look frame (mineflayer yaw: 0 = north, counter-clockwise)
      const look = new Vec3(-Math.sin(b.yaw), 0, -Math.cos(b.yaw))
      const right = new Vec3(-look.z, 0, look.x)
      const ahead = d.x * look.x + d.z * look.z
      const side = d.x * right.x + d.z * right.z
      const up = d.y

      const now = Date.now()
      times.push(now)
      expire()
      onRateChange()
      // This is an observed correction, not a claim about its cause. Consumers use the
      // same spawn/distance filtering as the visible counter, before log throttling.
      bot.emit('botifyCorrection', { time: now, distance: dist, keys: b.keys,
        from: b.pos, to: bot.entity.position.clone(), velocityBefore: b.vel,
        velocityAfter: bot.entity.velocity.clone(), teleportId: packet.teleportId,
        flags: packet.flags, motion: { x: packet.dx, y: packet.dy, z: packet.dz } })
      detailed = detailed.filter(t => now - t < DETAIL_WINDOW)
      if (detailed.length >= DETAIL_LIMIT) {
        hidden.n++; hidden.ahead += ahead; hidden.side += side; hidden.up += up
        if (!flushTimer) { flushTimer = setTimeout(flush, DETAIL_WINDOW); flushTimer.unref?.() }
        return
      }
      detailed.push(now)
      const state = [
        b.water ? 'в воде' : b.onGround ? 'на земле' : `в воздухе ${b.airTicks} т.`,
        b.keys.length ? b.keys.join('+') : 'клавиши отпущены',
        b.sinceJump < 40 ? `прыжок ${b.sinceJump} т. назад` : null,
        b.collided ? 'упёрся в стену' : null,
        `скорость ${Math.hypot(b.vel.x, b.vel.z).toFixed(3)}/${b.vel.y.toFixed(3)}`
      ].filter(Boolean).join(', ')
      const blocks = `под ногами ${b.under || '?'}${b.inBlock && b.inBlock !== 'air' ? `, в блоке ${b.inBlock}` : ''}`
      log(`[коррекция] бот был: вперёд ${fmt(ahead)}, вбок ${fmt(side)}, вверх ${fmt(up)} бл. от точки сервера · ${state} · ${blocks}`)
    })
  })
  const stop = () => { ended = true; reset(); spawnedAt = null }
  bot.once('end', stop)
  bot._client.once('end', stop)

  return {
    /** corrections during the last 10 seconds */
    rate () {
      const now = Date.now()
      return times.filter(t => now - t < 10_000).length
    }
  }
}

module.exports = { attachSetbackMonitor }
