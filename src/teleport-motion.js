'use strict'

// Since 1.21.2, position corrections carry motion and independent relative-motion flags.
// Mineflayer 4.39 still clears/preserves velocity using the POSITION flags and ignores dx/dy/dz.
//
// Mineflayer also forces `onGround = false` and resets the jump delay on every correction. Vanilla's
// handleMovePlayer touches neither: it only reports onGround=false in the acknowledging packet.
// With the forced value the first tick after a correction is simulated as airborne (0.02
// acceleration instead of ~0.1, no ground friction). A prediction anticheat expects the ground
// tick, flags the difference, and — once it is in "set back on every flag" mode — corrects again:
// correction → airborne tick → flag → correction… The bot then only ever moves with air
// acceleration, i.e. crawls at ~0.4 blocks/s. Keep both values across the correction instead.
function attachTeleportMotion (bot) {
  let pending = null
  let keep = null
  let freshEntity = true // after (re)spawn the game has a brand-new player entity: onGround=false
  bot.on('respawn', () => { freshEntity = true })
  bot.once('login', () => {
    const client = bot._client
    client.prependListener('position', packet => {
      keep = bot.entity && !freshEntity ? { onGround: bot.entity.onGround, jumpTicks: bot.jumpTicks } : null
      pending = null
      if (!bot.entity || !['dx', 'dy', 'dz'].every(key => Number.isFinite(packet[key]))) return
      const flags = packet.flags
      if (!flags || typeof flags !== 'object') return
      let { x, y, z } = bot.entity.velocity
      if (flags.yawDelta) { // protocol name for vanilla Relative.ROTATE_DELTA (both pitch and yaw)
        const oldYaw = Math.fround((Math.PI - bot.entity.yaw) * 180 / Math.PI)
        const oldPitch = Math.fround(-bot.entity.pitch * 180 / Math.PI)
        const yaw = Math.fround((flags.yaw ? oldYaw : 0) + packet.yaw)
        const pitch = Math.max(-90, Math.min(90, Math.fround((flags.pitch ? oldPitch : 0) + packet.pitch)))
        const pitchDelta = Math.fround(Math.fround(oldPitch - pitch) * Math.PI / 180)
        const yawDelta = Math.fround(Math.fround(oldYaw - yaw) * Math.PI / 180)
        const cy = Math.fround(Math.cos(yawDelta))
        const sy = Math.fround(Math.sin(yawDelta))
        const cp = Math.fround(Math.cos(pitchDelta))
        const sp = Math.fround(Math.sin(pitchDelta))
        const rotatedY = y * cp + z * sp
        z = z * cp - y * sp
        y = rotatedY
        const rotatedX = x * cy + z * sy
        z = z * cy - x * sy
        x = rotatedX
      }
      pending = {
        x: packet.dx + (flags.dx ? x : 0),
        y: packet.dy + (flags.dy ? y : 0),
        z: packet.dz + (flags.dz ? z : 0)
      }
    })
    // Plugins have been injected by login, so this runs after Mineflayer's position handler.
    client.on('position', () => {
      if (pending && bot.entity) bot.entity.velocity.set(pending.x, pending.y, pending.z)
      pending = null
      if (keep && bot.entity) {
        bot.entity.onGround = keep.onGround
        if (Number.isFinite(keep.jumpTicks)) bot.jumpTicks = keep.jumpTicks
      }
      keep = null
      freshEntity = false
    })
  })
}

module.exports = { attachTeleportMotion }
