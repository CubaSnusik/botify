'use strict'

// Arithmetic and block collision order audited against the official 26.1 and 26.2 clients.
// See docs/walking-26.1.md. Keep Java float operations explicit; positions remain doubles.
const f = Math.fround
const SIN = Float32Array.from({ length: 65536 }, (_, i) => Math.sin(i * Math.PI * 2 / 65536))
const DEG = 1 / (Math.PI / 180)

function supported (version) {
  return profile(version) !== null
}

function profile (version) {
  return ['26.1', '26.2'].includes(version?.majorVersion) ? version.majorVersion : null
}

function yawDegrees (yaw) { return f((Math.PI - yaw) * DEG) }
function trig (entity) {
  const radians = f((entity.botifyYaw ?? yawDegrees(entity.yaw)) * f(0.017453292))
  return { sin: SIN[Math.trunc(radians * 10430.378350470453) & 65535],
    cos: SIN[Math.trunc(radians * 10430.378350470453 + 16384) & 65535] }
}

function attributeValue (attributes, name, fallback) {
  const entry = attributes?.[`minecraft:${name}`] ?? attributes?.[name] ?? attributes?.[`generic.${name}`]
  if (!entry) return fallback
  let base = entry.value
  for (const mod of entry.modifiers || []) if (mod.operation === 0) base += mod.amount
  let value = base
  for (const mod of entry.modifiers || []) if (mod.operation === 1) value += base * mod.amount
  for (const mod of entry.modifiers || []) if (mod.operation === 2) value *= 1 + mod.amount
  return Number.isFinite(value) ? value : fallback
}

function input (entity) {
  const c = entity.control
  let x = Number(c.right) - Number(c.left)
  let z = Number(c.forward) - Number(c.back)
  let length = f(Math.sqrt(f(f(x * x) + f(z * z))))
  if (!length) return [0, 0]
  x = f(f(x / length) * f(0.98))
  z = f(f(z / length) * f(0.98))
  if (entity.botifyUseItem) {
    x = f(x * entity.botifyUseItem.speed)
    z = f(z * entity.botifyUseItem.speed)
  }
  if (c.sneak) {
    const speed = f(Math.max(0, Math.min(1, attributeValue(entity.attributes, 'sneaking_speed', 0.3))))
    x = f(x * speed)
    z = f(z * speed)
  }
  length = f(Math.sqrt(f(f(x * x) + f(z * z))))
  if (!length) return [0, 0]
  const reciprocal = f(1 / length)
  x = f(x * reciprocal)
  z = f(z * reciprocal)
  const ratio = f(Math.min(Math.abs(x), Math.abs(z)) / Math.max(Math.abs(x), Math.abs(z)))
  const distance = f(Math.sqrt(f(1 + f(ratio * ratio))))
  const scale = Math.min(f(length * distance), 1)
  return [f(x * scale), f(z * scale)]
}

function heading (entity, strafe, forward, acceleration) {
  const squared = strafe * strafe + forward * forward
  if (squared < 1e-7) return
  // Vec3.normalize then scale: preserve the order of double operations.
  const inverse = squared > 1 ? 1 / Math.sqrt(squared) : 1
  const x = -strafe * inverse * f(acceleration)
  const z = forward * inverse * f(acceleration)
  const { sin, cos } = trig(entity)
  entity.vel.x += x * cos - z * sin
  entity.vel.z += z * cos + x * sin
}

function modifiedFriction (base, modifier) {
  return Math.max(0, Math.min(1, f(1 - f(f(1 - f(base)) * f(modifier)))))
}

function groundMotion (speed, slipperiness, attributes, modern = false) {
  const friction = modern ? modifiedFriction(slipperiness, attributeValue(attributes, 'friction_modifier', 1)) : f(slipperiness)
  const drag = modern ? modifiedFriction(0.91, attributeValue(attributes, 'air_drag_modifier', 1)) : f(0.91)
  return { inertia: f(friction * drag),
    acceleration: modern && friction <= 0.6 ? f(speed) :
      f(f(speed) * f(f(0.21600002) / f(f(friction * friction) * friction))) }
}

function airDrag (base, attributes, modern = false) {
  return modern ? modifiedFriction(base, attributeValue(attributes, 'air_drag_modifier', 1)) : f(base)
}

function jump (entity, factor) {
  const strength = f(attributeValue(entity.attributes, 'jump_strength', 0.42))
  const power = f(f(strength * f(factor)) + f(f(0.1) * (entity.jumpBoost || 0)))
  if (power <= f(1e-5)) return
  entity.vel.y = Math.max(entity.vel.y, power)
  if (entity.control.sprint) {
    const { sin, cos } = trig(entity)
    entity.vel.x -= sin * 0.2
    entity.vel.z += cos * 0.2
  }
}

// VoxelShape.collide uses a small tolerance at touching faces, unlike the dependency's AABB.
function clip (box, obstacles, axis, delta) {
  if (Math.abs(delta) < 1e-7) return 0
  const other = ['X', 'Y', 'Z'].filter(a => a !== axis)
  for (const obstacle of obstacles) {
    if (!other.every(a => box[`max${a}`] > obstacle[`min${a}`] + 1e-7 &&
      box[`min${a}`] < obstacle[`max${a}`] - 1e-7)) continue
    const gap = delta > 0 ? obstacle[`min${axis}`] - box[`max${axis}`] : obstacle[`max${axis}`] - box[`min${axis}`]
    if (delta > 0 && gap >= -1e-7) delta = Math.min(delta, gap)
    else if (delta < 0 && gap <= 1e-7) delta = Math.max(delta, gap)
  }
  return delta
}

function collide (original, obstacles, dx, dy, dz) {
  const box = original.clone()
  dy = clip(box, obstacles, 'Y', dy)
  box.offset(0, dy, 0)
  const zFirst = Math.abs(dx) < Math.abs(dz)
  if (zFirst) { dz = clip(box, obstacles, 'Z', dz); box.offset(0, 0, dz) }
  dx = clip(box, obstacles, 'X', dx)
  box.offset(dx, 0, 0)
  if (!zFirst) { dz = clip(box, obstacles, 'Z', dz); box.offset(0, 0, dz) }
  return { dx, dy, dz, box }
}

function move (entity, box, getBoxes, dx, dy, dz, stepHeight) {
  const result = collide(box, getBoxes(box.clone().extend(dx, dy, dz)), dx, dy, dz)
  const landed = dy !== result.dy && dy < 0
  if (stepHeight <= 0 || !(landed || entity.onGround) || (dx === result.dx && dz === result.dz)) return result
  const base = landed ? box.clone().offset(0, result.dy, 0) : box
  const query = base.clone().extend(dx, stepHeight, dz)
  if (!landed) query.extend(0, -f(1e-5), 0)
  const obstacles = getBoxes(query)
  const heights = new Set()
  for (const obstacle of obstacles) {
    for (const edge of [obstacle.minY, obstacle.maxY]) {
      const height = f(edge - base.minY)
      if (height >= 0 && height <= stepHeight && height !== f(result.dy)) heights.add(height)
    }
  }
  for (const height of [...heights].sort((a, b) => a - b)) {
    const step = collide(base, obstacles, dx, height, dz)
    if (step.dx * step.dx + step.dz * step.dz > result.dx * result.dx + result.dz * result.dz) {
      step.dy -= box.minY - base.minY
      return step
    }
  }
  return result
}

function backOff (entity, box, getBoxes, dx, dy, dz, stepHeight) {
  if (!entity.control.sneak || dy > 0) return [dx, dz]
  const canFall = (x, z, distance) => {
    const query = box.clone().offset(x, 0, z)
    query.minX += 1e-7; query.maxX -= 1e-7
    query.minZ += 1e-7; query.maxZ -= 1e-7
    query.maxY = box.minY
    query.minY = box.minY - distance - 1e-7
    return !getBoxes(query).some(obstacle => obstacle.intersects(query))
  }
  const fallen = entity.botifyFallDistance || 0
  if (!entity.onGround && !(fallen < stepHeight && !canFall(0, 0, stepHeight - fallen))) return [dx, dz]
  const reduce = value => Math.abs(value) <= 0.05 ? 0 : value - Math.sign(value) * 0.05
  while (dx !== 0 && canFall(dx, 0, stepHeight)) dx = reduce(dx)
  while (dz !== 0 && canFall(0, dz, stepHeight)) dz = reduce(dz)
  while (dx !== 0 && dz !== 0 && canFall(dx, dz, stepHeight)) { dx = reduce(dx); dz = reduce(dz) }
  return [dx, dz]
}

function findSupport (entity, world, halfWidth, shiftX = 0, shiftZ = 0) {
  const pos = entity.pos
  const minX = pos.x - halfWidth + shiftX
  const maxX = pos.x + halfWidth + shiftX
  const minZ = pos.z - halfWidth + shiftZ
  const maxZ = pos.z + halfWidth + shiftZ
  let best = null
  let distance = Infinity
  for (let y = Math.floor(pos.y - 1e-6) - 1; y <= Math.floor(pos.y); y++) {
    for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++) {
      for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
        const at = pos.clone().set(x, y, z)
        const block = world.getBlock(at)
        if (!block?.shapes?.some(s => x + s[3] > minX && x + s[0] < maxX &&
          z + s[5] > minZ && z + s[2] < maxZ && y + s[4] > pos.y - 1e-6 && y + s[1] < pos.y)) continue
        const d = (x + 0.5 - pos.x) ** 2 + (y + 0.5 - pos.y) ** 2 + (z + 0.5 - pos.z) ** 2
        const greater = best && (y - best.y || z - best.z || x - best.x) > 0
        if (d < distance || (d === distance && greater)) { best = at; distance = d }
      }
    }
  }
  return best
}

function updateSupport (entity, world, halfWidth, dx, dy, dz) {
  if (entity.onGround) {
    let support = findSupport(entity, world, halfWidth)
    if (!support && !entity.botifyOnGroundNoBlocks) support = findSupport(entity, world, halfWidth, -dx, -dz)
    entity.botifySupport = support
    entity.botifyOnGroundNoBlocks = !support
    entity.botifyFallDistance = 0
  } else {
    entity.botifySupport = null
    entity.botifyOnGroundNoBlocks = false
    if (dy < 0) entity.botifyFallDistance = (entity.botifyFallDistance || 0) - dy
  }
}

function groundBlock (entity, world, halfWidth) {
  const support = entity.botifySupport === undefined && entity.onGround
    ? findSupport(entity, world, halfWidth) : entity.botifySupport
  if (support) {
    const block = world.getBlock(support)
    if (block?.name?.endsWith('_wall') || block?.name?.endsWith('_fence_gate')) return block
    return world.getBlock(support.offset(0, Math.floor(entity.pos.y - f(0.500001)) - support.y, 0))
  }
  return world.getBlock(entity.pos.offset(0, -f(0.500001), 0))
}

module.exports = { supported, profile, yawDegrees, trig, input, heading, groundMotion, airDrag, jump, move, collide,
  attributeValue, backOff, groundBlock, updateSupport }
