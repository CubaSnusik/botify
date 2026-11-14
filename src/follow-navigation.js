'use strict'
const { PlayerState } = require('prismarine-physics')
const { goals } = require('mineflayer-pathfinder')
const { joinCircleFormation } = require('./circle-formation')
const DEG = Math.PI / 180
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle))
const HAZARDS = /^(water|lava|fire|soul_fire|cobweb|powder_snow|sweet_berry_bush|cactus|magma_block)$/
const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']

function blockReader (bot) {
  const cache = new Map()
  return pos => {
    const at = pos.floored()
    const key = `${at.x},${at.y},${at.z}`
    if (!cache.has(key)) cache.set(key, bot.blockAt(at, false))
    return cache.get(key)
  }
}

// Conservative flat-ground corridor for the whole body and both feet. Unknown chunks,
// stairs, drops and fluids go through A*, rather than treating a clear eye ray as a path.
function clearGroundLine (bot, from, to, getBlock = blockReader(bot)) {
  if (Math.abs(to.y - from.y) > 0.05) return false
  const length = Math.hypot(to.x - from.x, to.z - from.z)
  if (length > 24) return false
  const width = (bot.physics?.playerHalfWidth || 0.3) + 0.02
  const height = bot.physics?.playerHeight || 1.8
  const steps = Math.max(1, Math.ceil(length / 0.2))
  for (let i = 0; i <= steps; i++) {
    const p = from.plus(to.minus(from).scaled(i / steps))
    for (let x = Math.floor(p.x - width); x <= Math.floor(p.x + width); x++) {
      for (let z = Math.floor(p.z - width); z <= Math.floor(p.z + width); z++) {
        for (let y = Math.floor(p.y); y <= Math.floor(p.y + height); y++) {
          const b = getBlock(p.clone().set(x, y, z))
          if (!b || HAZARDS.test(b.name) || bot.pathfinder?.movements?.blocksToAvoid?.has(b.type)) return false
          if (b.shapes.some(s => x + s[3] > p.x - width && x + s[0] < p.x + width &&
            z + s[5] > p.z - width && z + s[2] < p.z + width &&
            y + s[4] > p.y + 1e-6 && y + s[1] < p.y + height - 1e-6)) return false
        }
      }
    }
    for (const ox of [-0.25, 0.25]) for (const oz of [-0.25, 0.25]) {
      const foot = p.offset(ox, -1e-4, oz)
      const b = getBlock(foot)
      if (!b || HAZARDS.test(b.name) || bot.pathfinder?.movements?.blocksToAvoid?.has(b.type)) return false
      const at = foot.floored()
      if (!b.shapes.some(s => foot.x >= at.x + s[0] && foot.x <= at.x + s[3] &&
        foot.z >= at.z + s[2] && foot.z <= at.z + s[5] && Math.abs(at.y + s[4] - p.y) <= 0.05)) return false
    }
  }
  return true
}

function steering (yaw, desired, sprint, spin = false) {
  const delta = wrap(desired - yaw)
  if (spin) {
    const sector = (Math.round(delta / (Math.PI / 4)) + 8) % 8
    const forward = [7, 0, 1].includes(sector)
    return { forward, back: [3, 4, 5].includes(sector), left: [1, 2, 3].includes(sector),
      right: [5, 6, 7].includes(sector), jump: false, sneak: false, sprint: sprint && forward }
  }
  // W, W+A, W+D. Turn on the spot for a target behind us instead of running away.
  if (Math.abs(delta) > 67.5 * DEG) return null
  return { forward: true, back: false, left: delta > 22.5 * DEG, right: delta < -22.5 * DEG,
    jump: false, sneak: false, sprint }
}

function startFollowing (bot, entity, distance, { spin = false, spinSpeed = 120, circle = false, formation = null } = {}) {
  // A point ahead on the orbit shares the same collision checks, route planner and
  // spin steering as following. Its angle follows actual progress, never a timer.
  const target = circle ? { position: entity.position.clone() } : entity
  const followDistance = circle ? 0 : distance
  const goal = new goals.GoalFollow(target, circle ? 0.5 : distance)
  if (!bot.smoothLook) {
    bot.pathfinder.setGoal(goal, true)
    return { stop () { if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null) } }
  }
  let mode = 'idle'
  let stopped = false
  let resting = false
  let sprinting = false
  let route = null
  let orbitCenter = null
  let movementCredit = 0
  const spacing = circle && formation
    ? joinCircleFormation(formation.scope, formation.server, bot, entity, distance)
    : null
  const updateOrbit = getBlock => {
    if (!circle) return
    const pos = bot.entity.position
    const center = entity.position
    // Keep a reachable waypoint during an obstacle detour; do not chase a point
    // that keeps moving around the obstacle as the bot takes the detour.
    if (mode === 'path' && orbitCenter && center.distanceTo(orbitCenter) < 0.75 &&
      pos.distanceTo(target.position) > 0.8 && !goal.isEnd(pos.floored()) &&
      clearGroundLine(bot, target.position, target.position, getBlock)) return
    const dx = pos.x - center.x; const dz = pos.z - center.z
    const range = Math.hypot(dx, dz)
    const angle = (range > 1e-6 ? Math.atan2(dz, dx) : bot.entity.yaw) +
      (range > distance + 2 ? 0 : Math.min(0.6, 1.5 / distance))
    target.position.set(center.x + Math.cos(angle) * distance, center.y, center.z + Math.sin(angle) * distance)
    // The ideal circle may cross a wall or a hole. Pick a supported point farther
    // along the circle so A* can detour instead of searching for an occupied goal.
    const step = Math.min(0.3, 0.75 / distance)
    for (let i = 0; i < 16; i++) {
      const candidate = center.offset(Math.cos(angle + i * step) * distance, 0, Math.sin(angle + i * step) * distance)
      if (clearGroundLine(bot, candidate, candidate, getBlock)) {
        target.position.update(candidate)
        break
      }
    }
    orbitCenter = center.clone()
  }
  const apply = controls => { for (const key of KEYS) bot.setControlState(key, !!controls?.[key]) }
  const clearRoute = () => { route = null }
  const spinNavigation = {
    route (point, path, physics) { route = { point, path, physics } },
    controller (point, jump, sprint, jumpAfter = 0) {
      return (state, tick) => {
        state.yaw = bot.smoothLook.spinYaw(tick)
        state.control = steering(state.yaw, Math.atan2(state.pos.x - point.x, state.pos.z - point.z), sprint, true)
        state.control.jump = jump && tick >= jumpAfter
      }
    }
  }
  if (spin) {
    bot.smoothLook.spin(true, spinSpeed)
    bot._botifySpinNavigation = spinNavigation
    // A search/no-path result must not keep driving toward an obsolete waypoint.
    bot.prependListener('physicsTick', clearRoute)
    bot.on('path_reset', clearRoute)
    bot.on('path_update', clearRoute)
  }
  const followRoute = () => {
    if (!route?.path.length) { apply(null); return }
    const { point, path, physics } = route
    // Walk tight routes: sprint-jump impulses point along the head, which rotates
    // independently of the route. The planner still supplies obstacle/jump nodes.
    let jump = bot.entity.isInWater
    if (!jump && !physics.canStraightLine(path)) {
      if (!physics.canWalkJump(path)) { apply(null); return }
      jump = true
    }
    const controls = steering(bot.entity.yaw, Math.atan2(bot.entity.position.x - point.x,
      bot.entity.position.z - point.z), false, true)
    controls.jump = jump
    apply(controls)
  }
  const switchMode = next => {
    if (mode === next) return
    clearRoute()
    if (next === 'path') bot.pathfinder.setGoal(goal, true)
    else if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null)
    mode = next
  }
  const update = () => {
    if (stopped || !bot.entity || bot._client.state !== 'play') return
    if (spin) bot.smoothLook.spin(true, spinSpeed)
    const getBlock = blockReader(bot)
    updateOrbit(getBlock)
    const pos = bot.entity.position
    const delta = target.position.minus(pos)
    const range = Math.hypot(delta.x, delta.z)
    // Hysteresis prevents repeated starts and tiny turns when the player stands nearby.
    const speed = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z)
    const stopping = speed / (1 - Math.fround(0.6 * 0.91))
    if (!circle && Math.abs(delta.y) < 0.75 && range <= followDistance + (resting ? 0.55 : Math.min(0.6, stopping))) {
      switchMode('direct')
      if (!resting && !spin) bot.smoothLook?.cancel()
      resting = true
      sprinting = false
      apply(null)
      return
    }
    resting = false
    const travel = Math.max(0, range - followDistance + (circle ? 0 : 0.25))
    const destination = pos.offset(delta.x / Math.max(range, 1e-9) * travel, delta.y,
      delta.z / Math.max(range, 1e-9) * travel)
    if (!bot.entity.onGround || bot.entity.isInWater || bot.entity.isInLava ||
      !clearGroundLine(bot, pos, destination, getBlock)) {
      switchMode('path')
      if (spin) followRoute()
      return
    }
    switchMode('direct')
    const yaw = Math.atan2(-delta.x, -delta.z)
    if (!spin) bot.smoothLook.navigate(yaw)
    if (circle) sprinting = false
    else if (range > distance + 1) sprinting = true
    else if (range < distance + 0.45) sprinting = false
    const controls = steering(bot.entity.yaw, yaw, sprinting, spin)
    if (!controls) { apply(null); return }
    const pace = spacing?.pace() ?? 1
    movementCredit = Math.min(2, movementCredit + pace)
    if (movementCredit < 1) { apply(null); return }
    movementCredit -= 1
    // The head is deliberately allowed to lag. Check the motion from THESE keys and
    // THIS heading, including existing inertia, before giving up the obstacle planner.
    const prediction = new PlayerState(bot, controls)
    let previous = pos
    for (let i = 0; i < 3; i++) {
      bot.physics.simulatePlayer(prediction, { getBlock })
      if (prediction.isCollidedHorizontally || !prediction.onGround ||
        !clearGroundLine(bot, previous, prediction.pos, getBlock)) { apply(null); return }
      previous = prediction.pos.clone()
      if (spin) {
        prediction.yaw = bot.smoothLook.spinYaw(i + 1)
        prediction.control = steering(prediction.yaw, Math.atan2(prediction.pos.x - target.position.x, prediction.pos.z - target.position.z), sprinting, true)
      }
    }
    apply(controls)
  }
  // Resolve direct and spin-route keys before physics. Pathfinder supplies obstacle
  // nodes and handles ordinary non-spin routes; its free-motion shortcut stays off.
  bot.on('botifyNavigationTick', update)
  return {
    stop () {
      if (stopped) return
      stopped = true
      spacing?.stop()
      bot.off('botifyNavigationTick', update)
      if (spin) {
        bot.off('physicsTick', clearRoute)
        bot.off('path_reset', clearRoute)
        bot.off('path_update', clearRoute)
        if (bot._botifySpinNavigation === spinNavigation) delete bot._botifySpinNavigation
      }
      if (bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null)
      bot.smoothLook?.cancel()
      apply(null)
    }
  }
}

module.exports = { startFollowing, clearGroundLine, steering }
