'use strict'
// When a navigating bot holds jump in water.
//
// Holding jump in water is LivingEntity.jumpInLiquid: +0.04 per tick, also inside falling water.
// Holding it all the time makes the bot climb waterfalls: on DonutSMP the tall walls of falling
// water carry it up dozens of blocks, where it drowns or falls to death. A player walks through
// such a wall along the ground and only swims up to reach a higher node or to breathe.

const FLUID_PLANTS = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/

function isWater (block) {
  if (!block) return false
  if (FLUID_PLANTS.test(block.name)) return true
  try { return block.getProperties?.().waterlogged === true } catch { return false }
}

// Air within `blocks` above the eyes: surfacing is short and safe.
function surfaceNear (bot, blocks) {
  const e = bot.entity
  const eyes = e.position.offset(0, e.control?.sneak ? 1.27 : 1.62, 0).floored()
  for (let i = 0; i <= blocks; i++) {
    const block = bot.blockAt(eyes.offset(0, i, 0), false)
    if (!block) return false
    if (!isWater(block)) return block.boundingBox !== 'block'
  }
  return false
}

/**
 * Jump key for a bot in a liquid that is moving towards `next` (a path node, or null).
 * Lava keeps the old behaviour (always up).
 */
function swimJump (bot, next) {
  const e = bot.entity
  if (!e) return false
  if (e.isInLava) return true
  if (!e.isInWater) return false
  const p = e.position
  // Climb out onto a bank or up to a higher node.
  if (next && next.y > p.y + 0.5) return true
  // Floating: hold the node's height (swimming across deep water), never climb above it.
  if (!e.onGround) return !next || p.y < next.y + 0.4
  // On the bottom (shallow water, inside a waterfall): walk on. Only surface for air when the
  // surface is close — never up a tall water column.
  const air = bot.oxygenLevel
  return air != null && air < 12 && surfaceNear(bot, 3)
}

module.exports = { swimJump, surfaceNear }
