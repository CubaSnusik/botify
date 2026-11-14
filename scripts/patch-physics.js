'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Keep this at the original threshold site: fluid pushing must happen BEFORE the cutoff,
// and jump/input acceleration AFTER it. A pre/post simulatePlayer wrapper changes that order.
const OLD_THRESHOLD = `    if (Math.abs(vel.x) < physics.negligeableVelocity) vel.x = 0
    if (Math.abs(vel.y) < physics.negligeableVelocity) vel.y = 0
    if (Math.abs(vel.z) < physics.negligeableVelocity) vel.z = 0`

const NEW_THRESHOLD = `    // Botify: vanilla 1.21.5+ uses horizontal vector length, not individual X/Z components.
    if (mcData.version['>=']('1.21.5')) {
      if (vel.x * vel.x + vel.z * vel.z < 9.0e-6) {
        vel.x = 0
        vel.z = 0
      }
    } else {
      if (Math.abs(vel.x) < physics.negligeableVelocity) vel.x = 0
      if (Math.abs(vel.z) < physics.negligeableVelocity) vel.z = 0
    }
    if (Math.abs(vel.y) < physics.negligeableVelocity) vel.y = 0`

function patchWalking (source, file) {
  const marker = '// Botify: official 26.1 walking arithmetic and collisions.'
  if (source.includes(marker)) return source
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics walking site: ' + from.slice(0, 90))
    source = source.replace(from, to)
  }
  const helper = './' + path.relative(path.dirname(file), path.join(__dirname, '../src/vanilla-walking')).replace(/\\/g, '/')
  replace('  const supportFeature = makeSupportFeature(mcData)',
    `  ${marker}\n  const walking = require(${JSON.stringify(helper)})\n  const vanillaWalking = walking.supported(mcData.version)\n  const supportFeature = makeSupportFeature(mcData)`)
  replace("  if (supportFeature('independentLiquidGravity')) {", `  if (vanillaWalking) {
    physics.playerHalfWidth = Math.fround(0.6) / 2
    physics.playerHeight = Math.fround(1.8)
    physics.stepHeight = Math.fround(0.6)
  }

  if (supportFeature('independentLiquidGravity')) {`)
  replace('    pos.x = bb.minX + physics.playerHalfWidth', '    pos.x = vanillaWalking ? (bb.minX + bb.maxX) / 2 : bb.minX + physics.playerHalfWidth')
  replace('    pos.z = bb.minZ + physics.playerHalfWidth', '    pos.z = vanillaWalking ? (bb.minZ + bb.maxZ) / 2 : bb.minZ + physics.playerHalfWidth')
  replace('  function applyHeading (entity, strafe, forward, multiplier) {', `  function applyHeading (entity, strafe, forward, multiplier) {
    if (vanillaWalking) return walking.heading(entity, strafe, forward, multiplier)`)
  replace('      const blockUnder = world.getBlock(pos.offset(0, -1, 0))',
    '      const blockUnder = world.getBlock(pos.offset(0, vanillaWalking ? -Math.fround(0.500001) : -1, 0))')
  replace('        if (acceleration < 0) acceleration = 0 // acceleration should not be negative', `        if (vanillaWalking) {
          const motion = walking.groundMotion(attributeSpeed, blockSlipperiness[blockUnder.type] || physics.defaultSlipperiness)
          inertia = motion.inertia
          acceleration = motion.acceleration
        }
        if (acceleration < 0) acceleration = 0 // acceleration should not be negative`)
  replace('          acceleration += airSprintFactor\n        }', `          acceleration += airSprintFactor
        }
        if (vanillaWalking) {
          acceleration = Math.fround(entity.control.sprint ? 0.025999999 : 0.02)
          inertia = Math.fround(0.91)
        }`)
  const jumpStart = '        vel.y = Math.fround(0.42)'
  const jumpEnd = '        entity.jumpTicks = physics.autojumpCooldown'
  const start = source.indexOf(jumpStart)
  const end = source.indexOf(jumpEnd, start)
  if (start < 0 || end < 0) throw new Error('Unsupported prismarine-physics jump implementation')
  const oldJump = source.slice(start, end)
  replace(oldJump, `        if (vanillaWalking) {
          walking.jump(entity, (blockBelow && blockBelow.type === honeyblockId) ? physics.honeyblockJumpSpeed : 1)
        } else {
${oldJump}        }
`)
  replace('    entity.elytraFlying = entity.elytraFlying && entity.elytraEquipped', `    if (vanillaWalking) [strafe, forward] = walking.input(entity)

    entity.elytraFlying = entity.elytraFlying && entity.elytraEquipped`)
  const collisionStart = source.indexOf('    let playerBB = getPlayerBB(pos)')
  const collisionEnd = source.indexOf('    // Update flags', collisionStart)
  if (collisionStart < 0 || collisionEnd < 0) throw new Error('Unsupported prismarine-physics collision implementation')
  const oldCollision = source.slice(collisionStart, collisionEnd)
  replace(oldCollision, `    let playerBB = getPlayerBB(pos)
    if (vanillaWalking) {
      const stepHeight = Math.fround(walking.attributeValue(entity.attributes, 'step_height', physics.stepHeight))
      const result = walking.move(entity, playerBB, box => getSurroundingBBs(world, box), dx, dy, dz, stepHeight)
      dx = result.dx
      dy = result.dy
      dz = result.dz
      playerBB = result.box
    } else {
${oldCollision.replace('    let playerBB = getPlayerBB(pos)\n', '')}    }

`)
  return source
}

function patchSupport (source) {
  const marker = '// Botify: 26.1 supporting blocks and sneak edges.'
  if (source.includes(marker)) return source
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics support site: ' + from.slice(0, 90))
    source = source.replace(from, to)
  }
  replace('    if (entity.control.sneak && entity.onGround) {', `    ${marker}
    if (vanillaWalking) {
      const stepHeight = Math.fround(walking.attributeValue(entity.attributes, 'step_height', physics.stepHeight))
      ;[dx, dz] = walking.backOff(entity, getPlayerBB(pos), box => getSurroundingBBs(world, box), dx, dy, dz, stepHeight)
      oldVelX = dx
      oldVelZ = dz
    } else if (entity.control.sneak && entity.onGround) {`)
  replace('      const blockUnder = world.getBlock(pos.offset(0, vanillaWalking ? -Math.fround(0.500001) : -1, 0))',
    '      const blockUnder = vanillaWalking ? walking.groundBlock(entity, world, physics.playerHalfWidth) : world.getBlock(pos.offset(0, -1, 0))')
  replace('    entity.onGround = entity.isCollidedVertically && oldVelY < 0', `    entity.onGround = entity.isCollidedVertically && oldVelY < 0
    if (vanillaWalking) walking.updateSupport(entity, world, physics.playerHalfWidth, dx, dy, dz)`)
  return source
}

function patchCollisionFlags (source) {
  const marker = '// Botify: horizontal collision tolerance matches Mth.equal(double, double).'
  if (source.includes(marker)) return source
  const changes = [
    ['    entity.isCollidedHorizontally = dx !== oldVelX || dz !== oldVelZ', `    ${marker}
    const hitX = vanillaWalking ? Math.abs(dx - oldVelX) >= Math.fround(1e-5) : dx !== oldVelX
    const hitZ = vanillaWalking ? Math.abs(dz - oldVelZ) >= Math.fround(1e-5) : dz !== oldVelZ
    entity.isCollidedHorizontally = hitX || hitZ`],
    ['    if (dx !== oldVelX) vel.x = 0', '    if (hitX) vel.x = 0'],
    ['    if (dz !== oldVelZ) vel.z = 0', '    if (hitZ) vel.z = 0']
  ]
  for (const [from, to] of changes) {
    if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics collision flags: ' + from)
    source = source.replace(from, to)
  }
  return source
}

function patchPhysics () {
  const file = require.resolve('prismarine-physics')
  const source = fs.readFileSync(file, 'utf8')
  const normalized = source.replace(/\r\n/g, '\n')
  if (!normalized.includes(NEW_THRESHOLD) && normalized.split(OLD_THRESHOLD).length !== 2) {
    throw new Error('Unsupported prismarine-physics movement threshold: review scripts/patch-physics.js for this dependency version')
  }
  const patched = patchVersionedFriction(patchCollisionFlags(patchSupport(patchWalking(normalized.includes(NEW_THRESHOLD) ? normalized : normalized.replace(OLD_THRESHOLD, NEW_THRESHOLD), file))))
  if (patched === normalized) return
  if (require.cache[file]) throw new Error('Apply the physics patch before loading Mineflayer/prismarine-physics; restart Botify')
  fs.writeFileSync(file, source.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched)
}

function patchVersionedFriction (source) {
  const marker = '// Botify: 26.2 friction and air drag attributes (26.1 keeps its own formulas).'
  if (source.includes(marker)) return source
  const changes = [
    ['  const vanillaWalking = walking.supported(mcData.version)', `  const vanillaWalking = walking.supported(mcData.version)
  ${marker}
  const modernFriction = walking.profile(mcData.version) === '26.2'`],
    ["  if (vanillaWalking) {\n    physics.playerHalfWidth", "  physics.botifyWalkingProfile = walking.profile(mcData.version)\n  if (vanillaWalking) {\n    physics.playerHalfWidth"],
    ['walking.groundMotion(attributeSpeed, blockSlipperiness[blockUnder.type] || physics.defaultSlipperiness)',
      'walking.groundMotion(attributeSpeed, blockSlipperiness[blockUnder.type] || physics.defaultSlipperiness, entity.attributes, modernFriction)'],
    ['          inertia = Math.fround(0.91)', '          inertia = walking.airDrag(0.91, entity.attributes, modernFriction)'],
    ['      vel.y *= physics.airdrag\n      vel.x *= inertia',
      '      vel.y *= vanillaWalking ? walking.airDrag(0.98, entity.attributes, modernFriction) : physics.airdrag\n      vel.x *= inertia']
  ]
  for (const [from, to] of changes) {
    if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics versioned friction site: ' + from)
    source = source.replace(from, to)
  }
  return source
}

module.exports = patchPhysics
if (require.main === module) patchPhysics()
