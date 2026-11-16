'use strict'

// Arithmetic and block collision order audited against the official 26.1 and 26.2 clients.
// See docs/walking-26.1.md. Keep Java float operations explicit; positions remain doubles.
const { Vec3 } = require('vec3')
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

// Block.getSpeedFactor / Block.getJumpFactor values that differ from 1.
const SPEED_FACTORS = { soul_sand: f(0.4), honey_block: f(0.4) }
const JUMP_FACTORS = { honey_block: f(0.5) }

// Entity.getBlockSpeedFactor / getBlockJumpFactor: the block at blockPosition() first; when it
// is neutral (1.0), the block below that affects movement (getOnPos(0.500001f)).
function blockFactor (entity, world, halfWidth, table, fluidsOwnFactor) {
  const at = world.getBlock(entity.pos.floored())
  const own = at ? (table[at.name] ?? 1) : 1
  if (fluidsOwnFactor && (at?.name === 'water' || at?.name === 'bubble_column')) return own
  if (own !== 1) return own
  const below = groundBlock(entity, world, halfWidth)
  return below ? (table[below.name] ?? 1) : 1
}

// LivingEntity.getBlockSpeedFactor: Mth.lerp(movement_efficiency, Entity factor, 1f).
// Entity.move multiplies the horizontal motion by it after collisions.
function speedFactor (entity, world, halfWidth) {
  const base = blockFactor(entity, world, halfWidth, SPEED_FACTORS, true)
  const efficiency = f(attributeValue(entity.attributes, 'movement_efficiency', 0))
  return f(base + f(efficiency * f(1 - base)))
}

function jumpFactor (entity, world, halfWidth) {
  return blockFactor(entity, world, halfWidth, JUMP_FACTORS, false)
}

// ---- fluids (EntityFluidInteraction, FlowingFluid, LivingEntity.travelInWater; 26.2 bytecode) ----

const WATER_PLANTS = new Set(['bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])

// FluidState of a block: type and amount (source and falling fluid 8, flowing level L 8 - L).
function fluidOf (block) {
  if (!block) return null
  if (block.name === 'water' || block.name === 'lava') {
    const level = Number(block.getProperties?.().level ?? 0)
    return { lava: block.name === 'lava', amount: level === 0 || level >= 8 ? 8 : 8 - level }
  }
  if (WATER_PLANTS.has(block.name) || block.getProperties?.().waterlogged === true) return { lava: false, amount: 8 }
  return null
}

// FlowingFluid.getHeight: a full block under the same fluid, otherwise amount / 9.
function fluidHeight (world, pos, fluid) {
  const above = fluidOf(world.getBlock(pos.offset(0, 1, 0)))
  return above && above.lava === fluid.lava ? 1 : f(fluid.amount / f(9))
}

// FlowingFluid.getFlow: height differences to the 4 horizontal neighbours (N, E, S, W), dropping
// through open neighbours to the fluid below them; falling fluid next to a solid face pulls down.
const HORIZONTAL = [[0, -1], [1, 0], [0, 1], [-1, 0]] // Direction.Plane.HORIZONTAL: north, east, south, west
function ownHeight (fluid) { return fluid ? f(fluid.amount / f(9)) : 0 }
function blocksMotion (block) { return !!block && block.boundingBox === 'block' && block.name !== 'cobweb' && block.name !== 'bamboo_sapling' }
function solidFace (world, pos, lava) {
  const block = world.getBlock(pos)
  const fluid = fluidOf(block)
  if (fluid && fluid.lava === lava) return false
  if (!block || /(^|_)ice$/.test(block.name)) return false
  return block.boundingBox === 'block' && block.shapes?.some(s => s[0] <= 0 && s[1] <= 0 && s[2] <= 0 && s[3] >= 1 && s[4] >= 1 && s[5] >= 1)
}
function fluidFlow (world, pos, fluid, block) {
  const affects = other => !other || other.lava === fluid.lava
  let x = 0
  let z = 0
  const own = ownHeight(fluid)
  for (const [dx, dz] of HORIZONTAL) {
    const at = pos.offset(dx, 0, dz)
    const nb = world.getBlock(at)
    const other = fluidOf(nb)
    if (!affects(other)) continue
    let height = ownHeight(other)
    let diff = 0
    if (height === 0) {
      if (!blocksMotion(nb)) {
        const below = fluidOf(world.getBlock(at.offset(0, -1, 0)))
        if (affects(below)) {
          height = ownHeight(below)
          if (height > 0) diff = f(own - f(height - f(0.8888889)))
        }
      }
    } else if (height > 0) {
      diff = f(own - height)
    }
    if (diff !== 0) { x += f(dx * diff); z += f(dz * diff) }
  }
  let y = 0
  const level = Number(block?.getProperties?.().level ?? 0)
  if ((block?.name === 'water' || block?.name === 'lava') && level >= 8) {
    for (const [dx, dz] of HORIZONTAL) {
      const at = pos.offset(dx, 0, dz)
      if (solidFace(world, at, fluid.lava) || solidFace(world, at.offset(0, 1, 0), fluid.lava)) {
        const len = Math.sqrt(x * x + z * z)
        if (len < 1e-5) { x = 0; z = 0 } else { x /= len; z /= len }
        y = -6
        break
      }
    }
  }
  const len = Math.sqrt(x * x + y * y + z * z)
  return len < 1e-5 ? { x: 0, y: 0, z: 0 } : { x: x / len, y: y / len, z: z / len }
}

// Lab switches for live experiments against a server (src/lab.js POST /flags). Defaults = vanilla.
const flags = {}

// Water state at a position, as Entity.baseTick computes it before LocalPlayer.aiStep runs:
// sprint and jump decisions of a tick see THIS tick's fluid state.
function fluidProbe (world, pos, sneak = false) {
  const half = f(0.6) / 2
  const height = f(1.8)
  const bb = { minX: pos.x - half, minY: pos.y, minZ: pos.z - half, maxX: pos.x + half, maxY: pos.y + height, maxZ: pos.z + half }
  const eyeY = pos.y + (sneak ? f(1.27) : f(1.62))
  let water = 0
  let eyes = false
  const cursor = new Vec3(0, 0, 0)
  for (let x = Math.floor(bb.minX + 0.001); x <= Math.ceil(bb.maxX - 0.001) - 1; x++) {
    for (let y = Math.floor(bb.minY + 0.001); y <= Math.ceil(bb.maxY - 0.001) - 1; y++) {
      for (let z = Math.floor(bb.minZ + 0.001); z <= Math.ceil(bb.maxZ - 0.001) - 1; z++) {
        const fluid = fluidOf(world.getBlock(cursor.set(x, y, z)))
        if (!fluid || fluid.lava) continue
        const top = y + fluidHeight(world, cursor, fluid)
        if (top < bb.minY + 0.001) continue
        if (x === Math.floor(pos.x) && z === Math.floor(pos.z) && eyeY >= y && eyeY <= top) eyes = true
        water = Math.max(water, top - bb.minY)
      }
    }
  }
  return { inWater: water > 0, eyesInWater: eyes, height: water }
}

// LivingEntity.aiStep jump branch: 'liquid' (jumpInLiquid +0.04), 'ground' (jumpFromGround) or null.
function jumpMode (entity) {
  const lava = !!entity.isInLava
  const height = (lava ? entity.botifyLavaHeight : entity.botifyWaterHeight) || 0
  const inWater = !!entity.isInWater && height > 0
  const threshold = flags.jumpThreshold ?? 0.4
  if (inWater && (!entity.onGround || height > threshold)) return flags.shallowGroundJump && entity.onGround ? 'ground' : 'liquid'
  if (lava && (!entity.onGround || height > threshold)) return 'liquid'
  if (entity.onGround || (inWater && height <= threshold)) return 'ground'
  return null
}

// Entity.baseTick -> EntityFluidInteraction.update + applyCurrentTo (player: averaged current).
function updateFluids (entity, world, bb, flowOf) {
  const box = { minX: bb.minX + 0.001, minY: bb.minY + 0.001, minZ: bb.minZ + 0.001, maxX: bb.maxX - 0.001, maxY: bb.maxY - 0.001, maxZ: bb.maxZ - 0.001 }
  const trackers = { water: { height: 0, eyes: false, x: 0, y: 0, z: 0, count: 0 }, lava: { height: 0, eyes: false, x: 0, y: 0, z: 0, count: 0 } }
  const pos = entity.pos
  const eyeY = pos.y + (entity.control?.sneak ? f(1.27) : f(1.62))
  const blockX = Math.floor(pos.x)
  const blockZ = Math.floor(pos.z)
  const cursor = pos.clone()
  for (let x = Math.floor(box.minX); x <= Math.ceil(box.maxX) - 1; x++) {
    for (let y = Math.floor(box.minY); y <= Math.ceil(box.maxY) - 1; y++) {
      for (let z = Math.floor(box.minZ); z <= Math.ceil(box.maxZ) - 1; z++) {
        cursor.set(x, y, z)
        const block = world.getBlock(cursor)
        const fluid = fluidOf(block)
        if (!fluid) continue
        const top = y + fluidHeight(world, cursor, fluid)
        if (top < box.minY) continue
        const t = fluid.lava ? trackers.lava : trackers.water
        if (x === blockX && z === blockZ && eyeY >= y && eyeY <= top) t.eyes = true
        t.height = Math.max(top - bb.minY, t.height)
        let flow = flowOf ? (flowOf(block) || { x: 0, y: 0, z: 0 }) : fluidFlow(world, cursor.clone(), fluid, block)
        if (t.height < 0.4) flow = { x: flow.x * t.height, y: flow.y * t.height, z: flow.z * t.height }
        t.x += flow.x; t.y += flow.y; t.z += flow.z
        t.count++
      }
    }
  }
  entity.isInWater = trackers.water.height > 0
  entity.isInLava = trackers.lava.height > 0
  entity.botifyWaterHeight = trackers.water.height
  entity.botifyLavaHeight = trackers.lava.height
  entity.botifyEyeInWater = trackers.water.eyes
  if (!flags.noCurrent) {
    applyCurrent(entity, trackers.water, 0.014)
    applyCurrent(entity, trackers.lava, 0.0023333333333333335)
  }
}

function applyCurrent (entity, t, scale) {
  if (!t.count || t.x * t.x + t.y * t.y + t.z * t.z < 9.999999747378752e-6) return
  let x = t.x * (1 / t.count) * scale
  let y = t.y * (1 / t.count) * scale
  let z = t.z * (1 / t.count) * scale
  const vel = entity.vel
  const length = Math.sqrt(x * x + y * y + z * z)
  if (Math.abs(vel.x) < 0.003 && Math.abs(vel.z) < 0.003 && length < 0.0045000000000000005) {
    x = x / length * 0.0045000000000000005
    y = y / length * 0.0045000000000000005
    z = z / length * 0.0045000000000000005
  }
  vel.x += x; vel.y += y; vel.z += z
}

// Level.containsAnyLiquid over a box.
function containsLiquid (world, box) {
  const cursor = new Vec3(0, 0, 0)
  for (let x = Math.floor(box.minX); x < Math.ceil(box.maxX); x++) {
    for (let y = Math.floor(box.minY); y < Math.ceil(box.maxY); y++) {
      for (let z = Math.floor(box.minZ); z < Math.ceil(box.maxZ); z++) {
        if (fluidOf(world.getBlock(cursor.set(x, y, z)))) return true
      }
    }
  }
  return false
}

// LivingEntity.travelInFluid -> travelInWater, getFluidFallingAdjustedMovement, jumpOutOfFluid.
function travelInWater (entity, strafe, forward, { move, isFree, onClimbable, movementSpeed }) {
  const vel = entity.vel
  const falling = vel.y <= 0
  const oldY = entity.pos.y
  let gravity = attributeValue(entity.attributes, 'gravity', 0.08)
  if (falling && entity.slowFalling > 0) gravity = Math.min(gravity, 0.01)
  const sprinting = !!entity.control.sprint
  let drag = sprinting ? f(0.9) : f(0.8)
  let speed = f(0.02)
  let efficiency = f(attributeValue(entity.attributes, 'water_movement_efficiency', 0))
  if (!entity.onGround) efficiency = f(efficiency * f(0.5))
  if (efficiency > 0) {
    drag = f(drag + f(f(f(0.54600006) - drag) * efficiency))
    speed = f(speed + f(f(f(movementSpeed) - speed) * efficiency))
  }
  if (entity.dolphinsGrace > 0) drag = f(0.96)
  heading(entity, strafe, forward, speed)
  move()
  if (entity.isCollidedHorizontally && onClimbable()) vel.y = 0.2
  vel.x *= drag
  vel.y *= 0.800000011920929
  vel.z *= drag
  if (gravity !== 0 && !sprinting) {
    if (falling && Math.abs(vel.y - 0.005) >= 0.003 && Math.abs(vel.y - gravity / 16) < 0.003) vel.y = -0.003
    else vel.y -= gravity / 16
  }
  if (entity.isCollidedHorizontally && isFree(vel.x, vel.y + 0.6000000238418579 - entity.pos.y + oldY, vel.z)) vel.y = 0.30000001192092896
}

module.exports = { supported, profile, yawDegrees, trig, input, heading, groundMotion, airDrag, jump, move, collide,
  attributeValue, backOff, groundBlock, updateSupport, speedFactor, jumpFactor,
  fluidOf, fluidFlow, updateFluids, containsLiquid, travelInWater, fluidProbe, jumpMode, flags }
