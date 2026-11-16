'use strict'
/*
 * Route walking with the .follow controller.
 *
 * The pathfinder still plans the route (A*) and handles everything that needs it: jumps,
 * drops, water, parkour. Wherever the route runs on flat ground through a clear corridor, this
 * walker drives instead, exactly like .follow's direct mode: it heads for the farthest route
 * node it can reach in a straight line (up to 24 blocks), steers with W / W+A / W+D relative to
 * the current head yaw, turns on the spot when the target is behind, keeps sprinting with
 * hysteresis, and checks the next 3 ticks with the real keys and heading before committing.
 * Keys are chosen before physics (botifyNavigationTick), like .follow.
 */
const { PlayerState } = require('prismarine-physics')
const { clearGroundLine, steering, blockReader } = require('./follow-navigation')
const { releaseSprint } = require('./movement-physics')

const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
const MAX_NODES = 16
const MAX_RANGE = 24

function attachRouteWalker (bot) {
  let sprinting = false
  let stopped = false
  const apply = controls => { for (const key of KEYS) bot.setControlState(key, !!controls?.[key]) }

  const update = () => {
    const pf = bot.pathfinder
    if (!pf) return
    pf.driven = null
    if (stopped || !pf.goal || !bot.entity || !bot.smoothLook || bot._botifySpinNavigation) return
    if (pf.recoveryState?.().recovering || pf.isMining?.() || pf.isBuilding?.()) return
    const e = bot.entity
    if (!e.onGround || e.isInWater || e.isInLava) return
    const path = pf.getPath?.() || []
    if (!path.length) return

    const pos = e.position
    const getBlock = blockReader(bot)
    // Farthest node on this level reachable in a clear straight corridor (like .follow's check).
    let best = -1
    for (let k = 0; k < Math.min(path.length, MAX_NODES); k++) {
      const n = path[k]
      if (n.toBreak.length || n.toPlace.length || n.parkour) break
      if (Math.abs(n.y - pos.y) > 0.05) break
      if (Math.hypot(n.x - pos.x, n.z - pos.z) > MAX_RANGE) break
      if (!clearGroundLine(bot, pos, n, getBlock)) break
      best = k
    }
    if (best < 0) { sprinting = false; return } // jump / drop / obstacle: the pathfinder walks it

    const last = best === path.length - 1
    const node = path[best]
    const dx = node.x - pos.x
    const dz = node.z - pos.z
    const range = Math.hypot(dx, dz)
    const speed = Math.hypot(e.velocity.x, e.velocity.z)
    // .follow's stopping rule: release the keys when inertia alone reaches the end.
    const stopping = speed / (1 - Math.fround(0.6 * 0.91))
    // Release at the braking distance so inertia ends on the goal, not past it.
    if (last && range <= Math.max(0.05, stopping)) {
      if (best > 0) pf.skipNodes(best)
      sprinting = false
      apply(null)
      pf.driven = { progress: speed > 0.01 }
      return
    }

    const yaw = Math.atan2(-dx, -dz)
    const human = typeof pf.humanMode === 'function' ? pf.humanMode() : !!pf.humanMode
    if (human) {
      const eye = pos.y + (e.eyeHeight ?? 1.62)
      bot.smoothLook.navigate(yaw, Math.atan2(node.y + 1 - eye, Math.max(Math.min(range, 4), 1)))
    } else {
      bot.smoothLook.navigate(yaw)
    }
    // Sprint hysteresis as in .follow; none right after a server correction.
    if (pf.recoveryState?.().careful) sprinting = false
    else if (!last || range > 3) sprinting = !!pf.movements?.allowSprinting
    else if (range < 1.5) sprinting = false

    const controls = steering(e.yaw, yaw, sprinting)
    if (best > 0) pf.skipNodes(best)
    if (!controls) { // target behind: turn on the spot first
      apply(null)
      pf.driven = { progress: true }
      return
    }
    releaseSprint(bot, controls)

    // The head may lag: check the motion from THESE keys and THIS heading before committing.
    const prediction = new PlayerState(bot, controls)
    let previous = pos
    for (let i = 0; i < 3; i++) {
      bot.physics.simulatePlayer(prediction, { getBlock })
      if (prediction.isCollidedHorizontally || !prediction.onGround ||
        !clearGroundLine(bot, previous, prediction.pos, getBlock)) return // let the pathfinder handle it
      previous = prediction.pos.clone()
    }
    apply(controls)
    pf.driven = { progress: true }
  }

  bot.on('botifyNavigationTick', update)
  return {
    stop () {
      if (stopped) return
      stopped = true
      bot.off('botifyNavigationTick', update)
      if (bot.pathfinder) bot.pathfinder.driven = null
    }
  }
}

module.exports = { attachRouteWalker }
