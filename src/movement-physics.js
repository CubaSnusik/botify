'use strict'

const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
const SPRINT_IDS = new Set(['minecraft:sprinting', 'sprinting', '662a6b8d-da3e-4c1c-8813-96ea6097278d'])
const COLLISION_APPLY = Symbol('botifyCollisionApply')
const walking = require('./vanilla-walking')
const WALK_STATE = ['botifySupport', 'botifyOnGroundNoBlocks', 'botifyFallDistance', 'botifyStuck',
  'botifyEyeInWater', 'botifyWaterHeight', 'botifyLavaHeight']

function itemUse (bot) {
  if (!bot.usingHeldItem || bot.vehicle) return null
  const item = bot._botifyUseHand === 1 ? bot.inventory?.slots[45] : bot.heldItem
  const effects = item?.componentMap?.get('use_effects')?.data ??
    item?.components?.find(component => component.type === 'use_effects')?.data
  return { speed: Math.fround(effects?.speed_multiplier ?? 0.2), canSprint: effects?.can_sprint ?? false }
}

function snapshotControls (controls) {
  // Mineflayer's controlState properties are non-enumerable: spreading it loses every key.
  return Object.fromEntries(CONTROL_KEYS.map(key => [key, !!controls[key]]))
}

// LocalPlayer.aiStep (26.x): the sprint key only STARTS sprinting. Once sprinting, the player
// keeps sprinting without it until shouldStopRunSprinting(): no forward impulse, a non-minor
// wall hit or not enough food. A client that stops sprinting on Ctrl release while W is still
// held sends STOP_SPRINTING and walk-speed moves that the vanilla client never produces.
// isSprintingPossible(false) also requires !isInShallowWater() = !(isInWater && !isUnderWater):
// wading with the head above water stops sprinting. Crouching (isMovingSlowly) only prevents
// STARTING to sprint; it is not in shouldStopRunSprinting.
function canSprint (bot, controls, state = bot.entity) {
  const vanilla = !!bot.registry?.version && walking.supported(bot.registry.version)
  const unlimited = bot.game?.gameMode === 'creative' || bot.game?.gameMode === 'spectator'
  const minorAllowed = bot.registry?.version?.['>=']('1.18') && state?.minorHorizontalCollision
  const hitWall = state?.isCollidedHorizontally && !minorAllowed
  const usingItem = vanilla && itemUse(bot)
  const latched = vanilla && !!state?.botifySprinting
  // LocalPlayer.aiStep runs after this tick's Entity.baseTick fluid update: probe the current position.
  const probe = vanilla && fluidNow(bot, state)
  const shallowWater = probe ? probe.inWater && !probe.eyesInWater : false
  const crouchBlocks = controls.sneak && (!vanilla || !latched)
  return !!((controls.sprint || latched) && controls.forward && !controls.back && !crouchBlocks &&
    !hitWall && !shallowWater && (!usingItem || usingItem.canSprint) && (unlimited || bot.food == null || bot.food > 6))
}

function fluidNow (bot, state) {
  const pos = state?.pos ?? state?.position
  if (!pos || !bot.blockAt) return null
  return walking.fluidProbe({ getBlock: p => bot.blockAt(p, false) }, pos, !!state?.control?.sneak)
}

// Level.getEntityCollisions for a player: boats, minecarts and shulkers are solid.
const SOLID_ENTITY = /(^|_)(boat|raft|minecart)$|^shulker$/
function entityBoxes (bot, query) {
  const boxes = []
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity === bot.entity || entity === bot.vehicle || !SOLID_ENTITY.test(entity.name || '')) continue
    const w = (entity.width || 0) / 2
    const h = entity.height || 0
    const p = entity.position
    if (!p || !w || !h) continue
    const box = [p.x - w, p.y, p.z - w, p.x + w, p.y + h, p.z + w]
    if (box[3] < query.minX || box[0] > query.maxX || box[4] < query.minY || box[1] > query.maxY ||
      box[5] < query.minZ || box[2] > query.maxZ) continue
    boxes.push(box)
  }
  return boxes
}

/**
 * Keys that stop sprinting the way a player does: Ctrl release alone keeps a vanilla player
 * sprinting, so a "walk" request while sprinting releases W for one tick. Mutates `controls`.
 */
function releaseSprint (bot, controls) {
  if (controls.forward && !controls.sprint && bot.entity?.botifySprinting && canSprint(bot, controls)) {
    controls.forward = false
  }
  return controls
}

function minorCollision (state, dx, dz) {
  // LocalPlayer.isHorizontalCollisionMinor: the surviving motion must point within 8 degrees
  // of the input direction. Use Prismarine's strafe convention (right positive, left negative).
  const strafe = Number(state.control.right) - Number(state.control.left)
  const forward = Number(state.control.forward) - Number(state.control.back)
  const yaw = Math.PI - state.yaw
  const x = -(strafe * Math.cos(yaw) + forward * Math.sin(yaw))
  const z = forward * Math.cos(yaw) - strafe * Math.sin(yaw)
  const inputSq = x * x + z * z
  const moveSq = dx * dx + dz * dz
  if (inputSq < 1e-5 || moveSq < 1e-5) return false
  const cosine = Math.max(-1, Math.min(1, (x * dx + z * dz) / Math.sqrt(inputSq * moveSq)))
  return Math.acos(cosine) < Math.fround(0.13962634)
}

function movementAttribute (attributes, resource) {
  // minecraft-data's protocol mapper still uses generic.movement_speed on modern versions,
  // while its attribute registry calls it minecraft:movement_speed.
  return attributes?.[resource] ?? attributes?.['generic.movement_speed'] ??
    attributes?.['minecraft:generic.movement_speed'] ?? attributes?.['minecraft:movement_speed'] ??
    attributes?.movement_speed ?? attributes?.['generic.movementSpeed']
}

function attachMovementPhysics (bot) {
  const install = () => {
    const physics = bot.physics
    if (!physics || physics.botifyMovement) return
    physics.botifyMovement = true
    const simulate = physics.simulatePlayer
    physics.simulatePlayer = (state, world) => {
      const controls = state.control
      const attributes = state.attributes
      const speed = movementAttribute(attributes, physics.movementSpeedAttribute)
      // New PlayerState instances don't copy this field in prismarine-physics 1.11.1.
      // Reused pathfinder predictions keep their own collision result between simulated ticks.
      if (state.minorHorizontalCollision == null) state.minorHorizontalCollision = !!bot.entity.minorHorizontalCollision
      // Sprinting is latched (see canSprint): fresh states start from the bot's current state,
      // reused prediction states carry their own from tick to tick.
      if (state.botifySprinting == null) state.botifySprinting = !!bot.entity.botifySprinting
      state.control = snapshotControls(controls)
      state.control.sprint = canSprint(bot, controls, state)
      state.botifySprinting = state.control.sprint
      if (walking.supported(bot.registry.version)) {
        state.botifyYaw = bot._botifyWireYaw?.(state.yaw) ?? walking.yawDegrees(state.yaw)
        state.botifyUseItem = itemUse(bot)
        for (const key of WALK_STATE) if (!(key in state)) state[key] = bot.entity[key]
      }
      const startX = state.pos.x
      const startZ = state.pos.z
      if (speed) {
        // Physics adds its own sprint modifier. Strip either wire representation first, and
        // isolate it from the server state: pathfinder runs speculative simulations here too.
        state.attributes = {
          ...attributes,
          [physics.movementSpeedAttribute]: {
            ...speed,
            modifiers: (speed.modifiers || []).filter(mod => !SPRINT_IDS.has(mod.uuid ?? mod.id)).map(mod => ({ ...mod }))
          }
        }
      }
      try {
        const solidEntities = walking.supported(bot.registry.version) && bot.entities
          ? { getBlock: pos => world.getBlock(pos), botifyEntityBoxes: query => entityBoxes(bot, query) }
          : world
        const result = simulate(state, solidEntities)
        state.minorHorizontalCollision = !!state.isCollidedHorizontally && minorCollision(state, state.pos.x - startX, state.pos.z - startZ)
        if (!state[COLLISION_APPLY]) {
          const apply = state.apply
          state.apply = function (target) {
            const result = apply.call(this, target)
            target.entity.minorHorizontalCollision = this.minorHorizontalCollision
            target.entity.botifySprinting = this.botifySprinting
            for (const key of WALK_STATE) target.entity[key] = this[key]
            return result
          }
          state[COLLISION_APPLY] = true
        }
        return result
      } finally {
        state.control = controls
        state.attributes = attributes
      }
    }
  }
  // Botify attaches before Mineflayer injects its plugins; physics exists by login.
  bot.on('login', install)
  const resetSupport = () => {
    if (bot.entity) for (const key of WALK_STATE) delete bot.entity[key]
  }
  bot._client.on('position', resetSupport)
  // A teleport keeps the sprint state (vanilla); a new player entity starts without it.
  bot.on('respawn', () => {
    resetSupport()
    if (bot.entity) bot.entity.botifySprinting = false
  })
  install()
}

module.exports = { attachMovementPhysics, canSprint, releaseSprint }
