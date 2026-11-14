'use strict'
const DEG = Math.PI / 180
const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
const clamp = (v, limit) => Math.max(-limit, Math.min(limit, v))
const EPS = 0.151 * DEG // Mineflayer rounds rotations to 0.15 degree mouse steps

// ---- "human" mode: one hand movement per target ----
// Minimum-jerk profile (the shape of real point-to-point arm/mouse motions): zero speed and
// acceleration at both ends, a single smooth peak. The duration follows the angle (longer
// flicks take longer, Fitts-like), the path bows slightly to one side as a wrist pivot does,
// and the peak comes a little early. Every random choice is fixed once per movement.
const minJerk = t => t * t * t * (10 + t * (-15 + 6 * t))

function humanPlan (y0, p0, y1, p1, random = Math.random) {
  const dy = wrap(y1 - y0)
  const dp = p1 - p0
  const dist = Math.hypot(dy, dp)
  const deg = dist / DEG
  const ticks = deg < 0.5
    ? 2
    : Math.max(4, Math.min(40, Math.round((4 + deg * 0.16 + Math.sqrt(deg) * 0.9) * (0.85 + random() * 0.35))))
  const side = random() < 0.5 ? -1 : 1
  return {
    y0,
    p0,
    dy,
    dp,
    ticks,
    k: 0,
    warp: 0.8 + random() * 0.15,
    arc: side * Math.min(4 * DEG, dist * (0.03 + random() * 0.06)),
    tremor: Math.min(0.2 * DEG, dist * 0.01),
    phase: random() * Math.PI * 2
  }
}

function humanPoint (plan) {
  const t = Math.min(1, plan.k / plan.ticks)
  const s = t >= 1 ? 1 : minJerk(Math.pow(t, plan.warp))
  const len = Math.hypot(plan.dy, plan.dp)
  const ny = len ? -plan.dp / len : 0
  const np = len ? plan.dy / len : 0
  const side = Math.sin(Math.PI * s) * (plan.arc + plan.tremor * Math.sin(plan.k * 1.7 + plan.phase))
  return {
    yaw: plan.y0 + plan.dy * s + ny * side,
    pitch: clamp(plan.p0 + plan.dp * s + np * side, Math.PI / 2)
  }
}

// One target, advanced BEFORE physics. Completion is delivered AFTER its movement packet.
// Pathfinding, commands and interactions therefore share both the actual and transmitted view.
function attachSmoothLook (bot) {
  let target = null; let processed = null; let rawLook = null
  let yawSpeed = 0; let pitchSpeed = 0
  let ended = false
  let spinning = false
  let spinSpeed = 120 * DEG / 20
  let spinRemainder = 0
  const cancel = () => {
    spinning = false
    spinRemainder = 0
    target?.resolve(false)
    target = processed = null
    yawSpeed = pitchSpeed = 0
  }
  function turn (yaw, pitch, cancelled = () => false, mode = 'precise') {
    if (ended || cancelled()) return Promise.resolve(false)
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return Promise.reject(new Error('угол должен быть конечным числом'))
    pitch = clamp(pitch, Math.PI / 2)
    spinning = false
    if (target && target.mode === mode && Math.abs(wrap(yaw - target.yaw)) < 1e-8 && Math.abs(pitch - target.pitch) < 1e-8) return target.promise
    // A hand already moving does not restart for a small correction: it bends its end point.
    if (mode === 'human' && target?.mode === 'human' && target.plan && target.plan.k < target.plan.ticks - 2 &&
        Math.hypot(wrap(yaw - target.yaw), pitch - target.pitch) < 1 * DEG) {
      target.yaw = yaw
      target.pitch = pitch
      target.cancelled = cancelled
      target.plan.dy = wrap(yaw - target.plan.y0)
      target.plan.dp = pitch - target.plan.p0
      return target.promise
    }
    target?.resolve(false)
    const next = { yaw, pitch, cancelled, mode }
    next.promise = new Promise(resolve => { next.resolve = resolve })
    target = next
    return next.promise
  }
  bot.once('login', () => {
    rawLook = bot.look.bind(bot)
    // Even a pathfinder "force" request is a target; server corrections use their own handler.
    bot.look = (yaw, pitch) => turn(yaw, pitch)
  })
  function navigate (yaw) {
    if (spinning) return Promise.resolve(false)
    // Navigation follows a travel heading, not an entity's head. Keep a stable view for
    // small changes in bearing; precise block interaction still uses turn().
    if (target?.mode === 'navigation' && Math.abs(wrap(yaw - target.yaw)) < 6 * DEG) return target.promise
    if (!target && Math.abs(wrap(yaw - bot.entity.yaw)) < 6 * DEG && Math.abs(bot.entity.pitch) < 4 * DEG) return Promise.resolve(true)
    return turn(yaw, 0, () => false, 'navigation')
  }
  function spin (enabled, degreesPerSecond = 120) {
    if (!Number.isFinite(degreesPerSecond) || degreesPerSecond < 1 || degreesPerSecond > 720) {
      throw new RangeError('spin speed must be between 1 and 720 degrees per second')
    }
    spinSpeed = degreesPerSecond * DEG / 20
    if (spinning === enabled) return
    cancel()
    spinning = enabled && !ended
  }
  // Include mouse-step rounding and acceleration in navigation's future headings.
  function spinYaw (ticks = 0) {
    let yaw = bot.entity.yaw; let speed = yawSpeed; let remainder = spinRemainder
    for (let i = 0; i < ticks; i++) {
      speed += clamp(spinSpeed - speed, 1.5 * DEG)
      const wanted = speed + remainder
      const change = Math.round(wanted / (0.15 * DEG)) * 0.15 * DEG
      remainder = wanted - change
      yaw += change
    }
    return yaw
  }
  bot.smoothLook = { turn, navigate, spin, spinYaw, cancel, isAligned: yaw => Math.abs(wrap(yaw - bot.entity.yaw)) <= 10 * DEG }
  bot.on('end', () => { ended = true; cancel() })
  bot.on('death', cancel)
  bot.on('respawn', cancel)
  bot._client.on('start_configuration', cancel)
  bot._client.prependListener('position', cancel)
  bot._client.prependListener('player_rotation', cancel)

  function step (delta, speed, maximum, acceleration) {
    const desired = clamp(delta * 0.4, maximum)
    const next = speed + clamp(desired - speed, acceleration)
    return Math.sign(next) === Math.sign(delta) ? clamp(next, Math.abs(delta)) : 0
  }
  return {
    before () {
      processed = null
      if ((!target && !spinning) || !rawLook || !bot.entity || bot._client.state !== 'play') return
      if (bot.blockAt && !bot.blockAt(bot.entity.position)) return
      if (spinning) {
        // Advance before physics, keeping the actual heading and wire heading identical.
        yawSpeed += clamp(spinSpeed - yawSpeed, 1.5 * DEG)
        pitchSpeed = step(-bot.entity.pitch, pitchSpeed, 4 * DEG, DEG)
        const wanted = bot.entity.yaw + yawSpeed + spinRemainder
        rawLook(wanted, bot.entity.pitch + pitchSpeed, true).catch(() => cancel())
        spinRemainder = wanted - bot.entity.yaw
        return
      }
      if (target.cancelled()) { cancel(); return }
      if (target.mode === 'human') {
        if (!target.plan) target.plan = humanPlan(bot.entity.yaw, bot.entity.pitch, target.yaw, target.pitch)
        const plan = target.plan
        plan.k = Math.min(plan.ticks, plan.k + 1)
        // the last step lands exactly on the target (no snap: minimum-jerk speed is ~0 there)
        const next = plan.k >= plan.ticks ? { yaw: plan.y0 + wrap(target.yaw - plan.y0), pitch: target.pitch } : humanPoint(plan)
        yawSpeed = pitchSpeed = 0
        processed = target
        rawLook(next.yaw, next.pitch, true).catch(() => cancel())
        return
      }
      const dy = wrap(target.yaw - bot.entity.yaw)
      const dp = target.pitch - bot.entity.pitch
      const navigation = target.mode === 'navigation'
      yawSpeed = step(dy, yawSpeed, (navigation ? 9 : 12) * DEG, (navigation ? 1.8 : 3) * DEG)
      pitchSpeed = step(dp, pitchSpeed, (navigation ? 4 : 8) * DEG, (navigation ? 1 : 2) * DEG)
      if (Math.abs(dy) > EPS && Math.abs(yawSpeed) < 0.15 * DEG) yawSpeed = Math.sign(dy) * 0.15 * DEG
      if (Math.abs(dp) > EPS && Math.abs(pitchSpeed) < 0.15 * DEG) pitchSpeed = Math.sign(dp) * 0.15 * DEG
      processed = target
      rawLook(bot.entity.yaw + yawSpeed, bot.entity.pitch + pitchSpeed, true).catch(() => cancel())
    },
    after () {
      if (!target || target !== processed || !bot.entity) return
      const tolerance = target.mode === 'navigation' ? 4 * DEG : EPS
      if (Math.abs(wrap(target.yaw - bot.entity.yaw)) <= tolerance && Math.abs(target.pitch - bot.entity.pitch) <= tolerance) cancelCompleted()
    }
  }
  function cancelCompleted () {
    target.resolve(true)
    target = processed = null
    yawSpeed = pitchSpeed = 0
  }
}

module.exports = { attachSmoothLook, humanPlan, humanPoint }
