'use strict'

const TAU = Math.PI * 2
const groupsByManager = new WeakMap()

// Only active circles around the same player, on the same server/dimension and
// at the same radius share spacing. Membership ends with the navigation task.
function joinCircleFormation (scope, server, bot, target, radius) {
  let groups = groupsByManager.get(scope)
  if (!groups) { groups = new Map(); groupsByManager.set(scope, groups) }
  const key = JSON.stringify([String(server.host).toLowerCase(), server.port || 25565,
    bot.game?.dimension, String(target.username || target.uuid || target.id).toLowerCase(), radius])
  let members = groups.get(key)
  if (!members) { members = new Set(); groups.set(key, members) }
  const member = { bot, target }
  members.add(member)
  return {
    pace () {
      const nearby = []
      for (const other of members) {
        const p = other.bot.entity?.position
        if (!p || other.bot._client.state !== 'play') continue
        const center = other.target.position
        const dx = p.x - center.x; const dz = p.z - center.z
        // Bots still approaching the ring must not hold up the whole group.
        if (Math.abs(p.y - center.y) > 1 || Math.abs(Math.hypot(dx, dz) - radius) > 1) continue
        nearby.push({ member: other, angle: (Math.atan2(dz, dx) + TAU) % TAU })
      }
      if (nearby.length < 2) return 1
      // Stable sorting gives coincident arrivals distinct places in the queue;
      // exactly one gets the open arc, rather than all waiting or all advancing.
      nearby.sort((a, b) => a.angle - b.angle)
      const index = nearby.findIndex(entry => entry.member === member)
      if (index < 0) return 1
      const next = (index + 1) % nearby.length
      const gap = nearby[next].angle - nearby[index].angle + (next === 0 ? TAU : 0)
      const spacing = TAU / nearby.length
      if (gap < Math.min(0.25, spacing * 0.2)) return 0
      // Leave some speed in reserve so a lagging member can close its gap. Ordinary
      // key releases regulate walking speed without crouching or editing velocity.
      return Math.min(1, 0.8 * gap / spacing)
    },
    stop () {
      members.delete(member)
      if (!members.size) groups.delete(key)
    }
  }
}

module.exports = { joinCircleFormation }
