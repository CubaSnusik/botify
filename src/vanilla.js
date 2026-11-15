'use strict'
/*
 * Make the per-tick packet stream look like the vanilla 1.21.2+ / 26.x client, which is what
 * prediction anticheats (Grim) simulate against. Vanilla order inside one client tick:
 *
 *   1. player_input            — full key state (W/A/S/D/jump/shift/sprint), sent when it changed
 *   2. entity_action sprinting — right before the movement packet of the tick that uses it
 *   3. movement packet         — with the real "horizontal collision" flag
 *   4. tick_end                — every tick
 *
 * mineflayer differs:
 *   - sends player_input only on sneak changes, and then with ONLY `shift` set (forward=false
 *     while walking), never for movement keys;
 *   - sends START/STOP_SPRINTING the moment code (pathfinder) flips the control — one tick before
 *     the physics tick that actually sprints, so the server applies sprint to a walking tick;
 *   - always reports hasHorizontalCollision=false;
 *   - never sends tick_end.
 *
 * The before/after hooks are driven by ticker.js around each bot's physics tick.
 */
const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'flying'])
const SPRINT_ACTIONS = new Set(['start_sprinting', 'stop_sprinting'])
const { attachMovementPhysics, canSprint } = require('./movement-physics')
const { attachTeleportMotion } = require('./teleport-motion')
const { attachSmoothLook } = require('./smooth-look')

// mineflayer's numeric entity_action ids (the ≤1.21.5 enum). In 1.21.6 Mojang removed the two
// shift entries, every id moved down by 2, and mineflayer's "is it a string mapper" feature flag
// doesn't exist in minecraft-data — so on 1.21.6+/26.x it sends 3 ("start sprinting") which the
// server reads as START_RIDING_JUMP. The server never learns the bot sprints → anticheats see
// sprint speed while the player "walks". Translate to names; the protocol mapper encodes them right.
const LEGACY_ACTIONS = ['start_sneaking', 'stop_sneaking', 'stop_sleeping', 'start_sprinting', 'stop_sprinting',
  'start_riding_jump', 'stop_riding_jump', 'open_inventory', 'start_fall_flying']

/**
 * @param {object} opts.perTick  true when ticker.js drives physics: enables player_input, sprint timing, tick_end
 */
function attachVanillaTick (bot, { perTick = true, smoothLook = true } = {}) {
  const client = bot._client
  attachTeleportMotion(bot)
  if (perTick) attachMovementPhysics(bot)
  const rotation = perTick && smoothLook ? attachSmoothLook(bot) : null
  // the version is only known after the server ping ("auto"), so detect packet support lazily
  let caps = null
  let sequence = 0
  const getCaps = () => {
    if (caps) return caps
    const v = bot.version || (typeof client.version === 'string' ? client.version : null)
    if (!v) return { input: false, tickEnd: false }
    let types = {}
    try { types = require('minecraft-data')(v).protocol.play.toServer.types } catch {}
    const fields = types.packet?.[1]?.[1]?.type?.[1]?.fields || {}
    const actionMap = types[fields.entity_action]?.[1]?.find(f => f.name === 'actionId')?.type?.[1]?.mappings || {}
    const actionNames = new Set(Object.values(actionMap))
    caps = {
      input: perTick && !!fields.player_input && JSON.stringify(types[fields.player_input] || '').includes('forward'),
      tickEnd: perTick && !!fields.tick_end,
      // Use mapper names on every mapped protocol; this also lets legacy sprint actions
      // go through the same tick scheduling as the renumbered 1.21.6+ actions.
      translateActions: Object.keys(actionMap).length > 0,
      actionNames
    }
    caps.sequenced = new Set(['block_dig', 'block_place', 'use_item'].filter(name =>
      types[fields[name]]?.[1]?.some(field => field.name === 'sequence')))
    return caps
  }

  const rawWrite = client.write.bind(client)
  let own = false
  const send = (name, params) => { own = true; try { rawWrite(name, params) } finally { own = false } }
  let lastSprint = false // the player starts not sprinting
  // vanilla starts from "nothing pressed" and only sends when that changes
  let lastInput = JSON.stringify({ forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false })
  let spawned = false
  let wireYaw = null
  // Share the same float and continuous turn count with the 26.1 movement calculation.
  const encodeYaw = degrees => Math.fround(wireYaw == null ? degrees : degrees + 360 * Math.round((wireYaw - degrees) / 360))
  bot._botifyWireYaw = yaw => encodeYaw(Math.fround((Math.PI - yaw) * (1 / (Math.PI / 180))))
  // A server correction establishes a new absolute rotation; its acknowledgement must not
  // be unwrapped against the old location's yaw. Mineflayer sends that acknowledgement below.
  client.prependListener('position', () => { wireYaw = null })
  client.prependListener('player_rotation', () => { wireYaw = null })
  bot.once('spawn', () => { spawned = true })
  bot.on('respawn', () => { lastSprint = false; lastInput = null })
  client.on('start_configuration', () => { lastSprint = false; lastInput = null })

  client.write = (name, params) => {
    if (!own) {
      if (name === 'use_item') bot._botifyUseHand = params.hand
      if (['block_dig', 'block_place', 'use_item'].includes(name) && getCaps().sequenced?.has(name)) {
        // START/STOP and item interactions share the world's prediction sequence. ABORT is unsequenced.
        const predicted = name !== 'block_dig' || params.status === 0 || params.status === 2
        params = { ...params, sequence: predicted ? ++sequence : 0 }
      }
      // replaced by the full per-tick input packet below
      if (name === 'player_input' && getCaps().input) return
      if (name === 'entity_action' && typeof params?.actionId === 'number' && getCaps().translateActions) {
        const action = LEGACY_ACTIONS[params.actionId]
        if (!action || !caps.actionNames.has(action)) return // sneak is player_input's shift bit on 1.21.6+
        params = { ...params, actionId: action }
      }
      // sprint goes out right before the movement of the tick that uses it
      const action = typeof params?.actionId === 'number' ? LEGACY_ACTIONS[params.actionId] : params?.actionId
      if (perTick && name === 'entity_action' && SPRINT_ACTIONS.has(action)) return
      if (MOVE_PACKETS.has(name) && params?.flags && typeof params.flags === 'object') {
        params.flags = { ...params.flags, hasHorizontalCollision: !!bot.entity?.isCollidedHorizontally }
      }
      if ((name === 'look' || name === 'position_look') && Number.isFinite(params?.yaw)) {
        // look(..., true) resets Mineflayer's accumulator to a bounded atan2 target. Preserve
        // the same direction on the continuous turn count, as vanilla does (359 -> 361).
        // Do not change Mineflayer's shared lastSent object or it will resend idle rotations.
        params = { ...params, yaw: encodeYaw(params.yaw) }
        wireYaw = params.yaw
      }
    }
    if (name === 'block_dig') bot.emit('botifyDigPacket', {
      status: params.status, sequence: params.sequence, location: params.location
    })
    const result = rawWrite(name, params)
    // This means handed to the transport, not acknowledged by the server.
    if (name === 'block_place') bot.emit('botifyPlacePacket', { ...params, itemName: bot.heldItem?.name })
    return result
  }

  const inPlay = () => client.state === 'play' && spawned && bot.entity

  // ---- rotation: send exactly the yaw/pitch the movement of this tick was simulated with ----
  // mineflayer (a) sends a "catching up" rotation limited to ~8.6°/tick while physics already uses
  // the full new yaw, and (b) lets pathfinder turn the head inside 'physicsTick' — after the
  // movement was simulated but before it is sent — so the packet carries a yaw the movement never
  // used. Prediction anticheats simulate with the packet's yaw → no input matches → setback.
  // Fix: no catch-up clamp; pin the head to the simulated rotation while mineflayer builds the
  // packet; the new rotation takes effect (and is sent) with the next tick's movement.
  let sim = null
  let wanted = null
  if (perTick) {
    bot.once('spawn', () => {
      if (bot.physics) { bot.physics.yawSpeed = Infinity; bot.physics.pitchSpeed = Infinity }
    })
    const emit = bot.emit.bind(bot)
    bot.emit = (event, ...args) => {
      const r = emit(event, ...args)
      // all physicsTick listeners (pathfinder…) have run; mineflayer sends the movement next
      if (event === 'physicsTick' && sim && bot.entity) {
        wanted = { yaw: bot.entity.yaw, pitch: bot.entity.pitch }
        bot.entity.yaw = sim.yaw
        bot.entity.pitch = sim.pitch
      }
      return r
    }
  }

  return {
    before () {
      rotation?.before()
      // Navigation chooses keys using the already-smoothed heading, before both physics
      // and player_input. It may request a head target for the following tick.
      if (inPlay()) bot.emit('botifyNavigationTick')
      sim = inPlay() ? { yaw: bot.entity.yaw, pitch: bot.entity.pitch } : null
      if (!inPlay()) return
      if (getCaps().input) {
        const c = bot.controlState
        const inputs = { forward: !!c.forward, backward: !!c.back, left: !!c.left, right: !!c.right, jump: !!c.jump, shift: !!c.sneak, sprint: !!c.sprint }
        const key = JSON.stringify(inputs)
        if (key !== lastInput) { lastInput = key; send('player_input', { inputs }) }
      }
      const sprint = canSprint(bot, bot.controlState)
      if (sprint !== lastSprint) {
        const action = sprint ? 'start_sprinting' : 'stop_sprinting'
        send('entity_action', { entityId: bot.entity.id, actionId: getCaps().translateActions ? action : (sprint ? 3 : 4), jumpBoost: 0 })
        lastSprint = sprint
      }
    },
    after () {
      // the rotation code asked for during this tick becomes the one the next tick simulates with
      if (wanted && bot.entity) { bot.entity.yaw = wanted.yaw; bot.entity.pitch = wanted.pitch }
      wanted = null
      sim = null
      if (getCaps().tickEnd && inPlay()) send('tick_end', {})
      rotation?.after()
    }
  }
}

module.exports = { attachVanillaTick }
