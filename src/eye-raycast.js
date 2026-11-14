'use strict'
const { Vec3 } = require('vec3')

// Mineflayer convention: yaw 0 = north (-Z), counter-clockwise; pitch positive = up.
function viewDirection (yaw, pitch) {
  const cp = Math.cos(pitch)
  return new Vec3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
}

function anglesFrom (eye, point) {
  const d = point.minus(eye)
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z)) }
}

const eyePosition = entity => entity.position.offset(0, entity.eyeHeight ?? 1.62, 0)

/**
 * Vanilla picks blocks from the eyes (1.62, lower while sneaking). Mineflayer's
 * blockAtEntityCursor starts the ray at the top of the hitbox (1.8) and returns null at
 * yaw/pitch exactly 0, so the crosshair it reports is not the one the server sees.
 */
function attachEyeRaycast (bot) {
  bot.blockAtEntityCursor = (entity = bot.entity, maxDistance = 256, matcher = null) => {
    if (!entity?.position || !Number.isFinite(entity.yaw) || !Number.isFinite(entity.pitch)) return null
    return bot.world.raycast(eyePosition(entity), viewDirection(entity.yaw, entity.pitch), maxDistance, matcher)
  }
}

module.exports = { viewDirection, anglesFrom, eyePosition, attachEyeRaycast }
