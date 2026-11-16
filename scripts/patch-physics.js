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

function patchBlockFactors (source) {
  const marker = '// Botify: Entity.getBlockSpeedFactor / getBlockJumpFactor (26.x).'
  if (source.includes(marker)) return source
  const changes = [
    // prismarine only slows on soul sand/honey for its listed (older) versions, and jumps 0.4 off honey
    ['walking.jump(entity, (blockBelow && blockBelow.type === honeyblockId) ? physics.honeyblockJumpSpeed : 1)',
      'walking.jump(entity, walking.jumpFactor(entity, world, physics.playerHalfWidth))'],
    ["            if (supportFeature('velocityBlocksOnCollision')) {", "            if (!vanillaWalking && supportFeature('velocityBlocksOnCollision')) {"],
    ["    if (supportFeature('velocityBlocksOnTop')) {", `    ${marker}
    if (vanillaWalking) {
      const factor = walking.speedFactor(entity, world, physics.playerHalfWidth)
      vel.x *= factor
      vel.z *= factor
    }
    if (!vanillaWalking && supportFeature('velocityBlocksOnTop')) {`]
  ]
  for (const [from, to] of changes) {
    if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics block factor site: ' + from)
    source = source.replace(from, to)
  }
  return source
}

// Further Entity.move / LivingEntity.travelInAir details (26.x bytecode):
//  - gravity from the minecraft:gravity attribute, slow falling caps it at 0.01 while falling,
//    an unloaded chunk below replaces it with a -0.1 drift;
//  - boats, minecarts and shulkers are solid (Level.getEntityCollisions);
//  - sweet berry bushes slow like cobwebs (makeStuckInBlock 0.8, 0.75, 0.8);
//  - a collided movement shorter than 1e-7 that lost more than 1e-7 does not move the player.
function patchEntityMove (source) {
  const marker = '// Botify: Entity.move details (gravity attribute, entity collisions, stuck blocks).'
  if (source.includes(marker)) return source
  const changes = [
    ['  function getSurroundingBBs (world, queryBB) {\n    const surroundingBBs = []', `  ${marker}
  function getSurroundingBBs (world, queryBB) {
    const surroundingBBs = []
    if (vanillaWalking && world.botifyEntityBoxes) {
      for (const b of world.botifyEntityBoxes(queryBB)) surroundingBBs.push(new AABB(b[0], b[1], b[2], b[3], b[4], b[5]))
    }`],
    ['    if (entity.isInWeb) {\n      dx *= 0.25\n      dy *= 0.05\n      dz *= 0.25', `    if (vanillaWalking && entity.botifyStuck) {
      dx *= entity.botifyStuck[0]
      dy *= entity.botifyStuck[1]
      dz *= entity.botifyStuck[2]
      vel.x = 0
      vel.y = 0
      vel.z = 0
      entity.botifyStuck = null
      entity.isInWeb = false
    } else if (entity.isInWeb) {
      dx *= 0.25
      dy *= 0.05
      dz *= 0.25`],
    ['            if (block.type === webId) {\n              entity.isInWeb = true\n            }', `            if (block.type === webId) {
              entity.isInWeb = true
              if (vanillaWalking) entity.botifyStuck = [0.25, Math.fround(0.05), 0.25]
            } else if (vanillaWalking && block.name === 'sweet_berry_bush') {
              entity.botifyStuck = [Math.fround(0.8), 0.75, Math.fround(0.8)]
            }`],
    ['      const result = walking.move(entity, playerBB, box => getSurroundingBBs(world, box), dx, dy, dz, stepHeight)\n      dx = result.dx\n      dy = result.dy\n      dz = result.dz\n      playerBB = result.box',
      `      const result = walking.move(entity, playerBB, box => getSurroundingBBs(world, box), dx, dy, dz, stepHeight)
      const collidedSq = result.dx * result.dx + result.dy * result.dy + result.dz * result.dz
      const wantedSq = dx * dx + dy * dy + dz * dz
      dx = result.dx
      dy = result.dy
      dz = result.dz
      // Entity.move: the position only changes when the collided movement is not negligible.
      if (collidedSq > 1e-7 || wantedSq - collidedSq < 1e-7) playerBB = result.box`],
    ['        vel.y -= physics.gravity * gravityMultiplier\n', `        if (vanillaWalking) {
          const below = world.getBlock(pos.offset(0, -Math.fround(0.500001), 0))
          if (below == null) {
            vel.y = -0.1
          } else {
            let gravity = walking.attributeValue(entity.attributes, 'gravity', 0.08)
            if (vel.y <= 0 && entity.slowFalling > 0) gravity = Math.min(gravity, 0.01)
            vel.y -= gravity
          }
        } else {
          vel.y -= physics.gravity * gravityMultiplier
        }
`]
  ]
  for (const [from, to] of changes) {
    if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics Entity.move site: ' + from.slice(0, 90))
    source = source.replace(from, to)
  }
  return source
}

// Water (26.x bytecode): EntityFluidInteraction (box deflated by 0.001, fluid height, eyes,
// averaged current), LivingEntity.aiStep liquid jumps and travelInWater. Lava keeps Prismarine.
function patchFluids (source) {
  const marker = '// Botify: vanilla water (EntityFluidInteraction, travelInWater, jumpInLiquid).'
  if (source.includes(marker)) return source
  const changes = [
    ['    entity.isInWater = isInWaterApplyCurrent(world, waterBB, vel)\n    entity.isInLava = isMaterialInBB(world, lavaBB, lavaIds)\n', `    ${marker}
    if (vanillaWalking) {
      walking.updateFluids(entity, world, getPlayerBB(pos), block => waterIds.includes(block.type) || waterLike.has(block.type) || block.isWaterlogged ? getFlow(world, block) : null)
    } else {
      entity.isInWater = isInWaterApplyCurrent(world, waterBB, vel)
      entity.isInLava = isMaterialInBB(world, lavaBB, lavaIds)
    }
`],
    ['      if (entity.isInWater || entity.isInLava) {\n        vel.y += 0.04\n      } else if (entity.onGround && entity.jumpTicks === 0) {', `      // LivingEntity.aiStep: swim up only when deep enough (or not standing); shallow water jumps.
      const liquidHeight = vanillaWalking ? ((entity.isInLava ? entity.botifyLavaHeight : entity.botifyWaterHeight) || 0) : 0
      const wading = vanillaWalking && entity.isInWater && liquidHeight > 0
      if (vanillaWalking ? (wading && (!entity.onGround || liquidHeight > 0.4)) || (!wading && entity.isInLava && (!entity.onGround || liquidHeight > 0.4)) : (entity.isInWater || entity.isInLava)) {
        vel.y += vanillaWalking ? 0.03999999910593033 : 0.04
      } else if ((entity.onGround || (wading && liquidHeight <= 0.4)) && entity.jumpTicks === 0) {`],
    ['    if (entity.isInWater || entity.isInLava) {\n      // Water / Lava movement', `    if (vanillaWalking && entity.isInWater) {
      const attributeSpeed = walking.attributeValue(entity.attributes, 'movement_speed', physics.playerSpeed) * (entity.control.sprint ? 1.3 : 1)
      walking.travelInWater(entity, strafe, forward, {
        move: () => moveEntity(entity, world, vel.x, vel.y, vel.z),
        onClimbable: () => isOnLadder(world, pos),
        movementSpeed: attributeSpeed,
        isFree: (dx, dy, dz) => {
          const box = getPlayerBB(pos).offset(dx, dy, dz)
          return !getSurroundingBBs(world, box).some(b => b.intersects(box)) && !walking.containsLiquid(world, box)
        }
      })
    } else if (entity.isInWater || entity.isInLava) {
      // Water / Lava movement`]
  ]
  for (const [from, to] of changes) {
    if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics fluid site: ' + from.slice(0, 90))
    source = source.replace(from, to)
  }
  return source
}

// Entity.checkInsideBlocks (26.x): block effects (cobweb, berry bush, bubble column) come from
// every block the box touched on its way from the start to the end of the move, with the box
// deflated by 1e-5, not only from the final position.
function patchInsideBlocks (source) {
  const marker = '// Botify: swept inside-block checks.'
  if (source.includes(marker)) return source
  const changes = [
    ['    if (vanillaWalking && entity.botifyStuck) {', `    ${marker}
    const botifyStartBB = vanillaWalking ? getPlayerBB(pos) : null
    if (vanillaWalking && entity.botifyStuck) {`],
    ['    playerBB.contract(0.001, 0.001, 0.001)\n', `    if (vanillaWalking) {
      playerBB = new AABB(Math.min(botifyStartBB.minX, playerBB.minX), Math.min(botifyStartBB.minY, playerBB.minY), Math.min(botifyStartBB.minZ, playerBB.minZ),
        Math.max(botifyStartBB.maxX, playerBB.maxX), Math.max(botifyStartBB.maxY, playerBB.maxY), Math.max(botifyStartBB.maxZ, playerBB.maxZ))
      playerBB.contract(9.999999747378752e-6, 9.999999747378752e-6, 9.999999747378752e-6)
    } else {
      playerBB.contract(0.001, 0.001, 0.001)
    }
`]
  ]
  for (const [from, to] of changes) {
    if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics inside-block site: ' + from.slice(0, 90))
    source = source.replace(from, to)
  }
  return source
}

// Water currents from FlowingFluid.getFlow (vanilla-walking.js) instead of Prismarine's getFlow,
// which inverts the open/solid neighbour rule and works in depth levels.
function patchVanillaFlow (source) {
  const marker = '// Botify: vanilla FlowingFluid.getFlow.'
  if (source.includes(marker)) return source
  const from = '      walking.updateFluids(entity, world, getPlayerBB(pos), block => waterIds.includes(block.type) || waterLike.has(block.type) || block.isWaterlogged ? getFlow(world, block) : null)'
  if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics fluid flow site')
  return source.replace(from, `      ${marker}\n      walking.updateFluids(entity, world, getPlayerBB(pos), null)`)
}

// The liquid/ground jump decision lives in vanilla-walking.js (jumpMode) so lab flags can
// switch variants on a running bot.
function patchJumpMode (source) {
  const marker = '// Botify: jump branch from walking.jumpMode.'
  if (source.includes(marker)) return source
  const from = `      const liquidHeight = vanillaWalking ? ((entity.isInLava ? entity.botifyLavaHeight : entity.botifyWaterHeight) || 0) : 0
      const wading = vanillaWalking && entity.isInWater && liquidHeight > 0
      if (vanillaWalking ? (wading && (!entity.onGround || liquidHeight > 0.4)) || (!wading && entity.isInLava && (!entity.onGround || liquidHeight > 0.4)) : (entity.isInWater || entity.isInLava)) {
        vel.y += vanillaWalking ? 0.03999999910593033 : 0.04
      } else if ((entity.onGround || (wading && liquidHeight <= 0.4)) && entity.jumpTicks === 0) {`
  if (source.split(from).length !== 2) throw new Error('Unsupported prismarine-physics jump-mode site')
  return source.replace(from, `      ${marker}
      const botifyJump = vanillaWalking ? walking.jumpMode(entity) : null
      if (vanillaWalking ? botifyJump === 'liquid' : (entity.isInWater || entity.isInLava)) {
        vel.y += vanillaWalking ? 0.03999999910593033 : 0.04
      } else if ((vanillaWalking ? botifyJump === 'ground' : entity.onGround) && entity.jumpTicks === 0) {`)
}

function patchPhysics () {
  const file = require.resolve('prismarine-physics')
  const source = fs.readFileSync(file, 'utf8')
  const normalized = source.replace(/\r\n/g, '\n')
  if (!normalized.includes(NEW_THRESHOLD) && normalized.split(OLD_THRESHOLD).length !== 2) {
    throw new Error('Unsupported prismarine-physics movement threshold: review scripts/patch-physics.js for this dependency version')
  }
  const patched = patchJumpMode(patchVanillaFlow(patchInsideBlocks(patchFluids(patchEntityMove(patchBlockFactors(patchVersionedFriction(patchCollisionFlags(patchSupport(patchWalking(normalized.includes(NEW_THRESHOLD) ? normalized : normalized.replace(OLD_THRESHOLD, NEW_THRESHOLD), file))))))))))
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
