'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { describeDigSpeed, toolData } = require('./dig-speed')
const { Vec3 } = require('vec3')
const { viewDirection } = require('./eye-raycast')
const { itemEnchantments } = require('./item-enchantments')

const MINING_ATTRIBUTES = /(?:mining_efficiency|block_break_speed|submerged_mining_speed|block_interaction_range)$/
const vector = v => v && { x: v.x, y: v.y, z: v.z }
const angles = entity => entity && { yaw: (Math.PI - entity.yaw) * 180 / Math.PI, pitch: -entity.pitch * 180 / Math.PI }
const MINING_COMPONENTS = new Set(['enchantments', 'tool', 'attribute_modifiers', 'can_break', 'damage', 'max_damage', 'unbreakable'])
function miningItem (bot, item) {
  if (!item) return null
  return {
    name: item.name, type: item.type, slot: item.slot, count: item.count,
    enchantmentRegistry: bot._botifyEnchantments == null ? 'static' : 'server',
    enchantments: itemEnchantments(bot, item),
    componentTypes: (item.components || []).map(c => c.type),
    components: structuredClone((item.components || []).filter(c => MINING_COMPONENTS.has(c.type.replace(/^minecraft:/, '')))),
    removedComponents: structuredClone(item.removedComponents || [])
  }
}

// A bounded trace of one mining attempt. Do not record chat, credentials or item NBT/lore.
function attachDigDiagnostics (bot, { file, log, now = () => performance.now() }) {
  let attempt = null
  let writing = Promise.resolve()
  const history = []
  let wire = { position: null, rotation: null, slot: null, onGround: null }
  const attributes = () => structuredClone(Object.fromEntries(
    Object.entries(bot.entity?.attributes || {}).filter(([name]) => MINING_ATTRIBUTES.test(name))))
  const snapshot = () => {
    const entity = bot.entity
    let wireHit = null
    if (wire.position && wire.rotation && bot.world?.raycast) {
      const eye = new Vec3(wire.position.x, wire.position.y + (entity?.eyeHeight ?? 1.62), wire.position.z)
      const dir = viewDirection(Math.PI - wire.rotation.yaw * Math.PI / 180, -wire.rotation.pitch * Math.PI / 180)
      const hit = bot.world.raycast(eye, dir, 4.5)
      if (hit) wireHit = { name: hit.name, position: vector(hit.position), face: hit.face }
    }
    return {
      local: { position: vector(entity?.position), rotation: angles(entity), eyeHeight: entity?.eyeHeight,
        onGround: entity?.onGround,
        controls: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].map(k => [k, !!bot.controlState?.[k]])),
        usingItem: !!bot.usingHeldItem,
        window: bot.currentWindow?.id ?? null, carriedItem: bot.inventory?.selectedItem?.name ?? null },
      wire: structuredClone(wire), wireHit, attributes: attributes(), heldItem: miningItem(bot, bot.heldItem)
    }
  }
  const record = (kind, fields) => {
    const time = now()
    history.push({ time, kind, ...fields })
    if (history.length > 120) history.shift()
    if (!attempt) return
    attempt.records.push({ ms: Math.round(time - attempt.start), kind, ...fields })
    if (attempt.records.length > 240) {
      // Continuous swings must not evict START/STOP or the early server correction.
      const noise = attempt.records.findIndex(r => r.kind === 'arm_animation' || r.kind === 'tick_end')
      attempt.records.splice(noise < 0 ? 0 : noise, 1)
    }
  }
  const write = bot._client.write
  bot._client.write = function (name, params) {
    if (name === 'block_dig' && params.status === 0) {
      const block = bot.blockAt(params.location)
      attempt = { start: now(), block: { name: block?.name, position: { ...params.location } },
        startSequence: params.sequence,
        slot: bot.quickBarSlot, item: bot.heldItem?.name ?? null,
        speed: block ? { ...describeDigSpeed(bot, block), tool: toolData(bot, block, bot.heldItem) } : null,
        atStart: snapshot(),
        records: [] }
      attempt.before = history.filter(r => r.time >= attempt.start - 2000)
        .map(({ time, ...r }) => ({ ms: Math.round(time - attempt.start), ...r }))
    }
    if (name === 'block_dig' && params.status <= 2) {
      if (attempt && params.status === 2) {
        attempt.finishMs = Math.round(now() - attempt.start)
        attempt.atStop = snapshot()
      }
      record(name, { status: params.status, location: vector(params.location), face: params.face, sequence: params.sequence })
    } else if (name === 'held_item_slot') {
      wire.slot = params.slotId
      record(name, { slot: params.slotId })
    }
    else if (name === 'arm_animation' || name === 'tick_end') record(name, {})
    else if (['look', 'position_look', 'position', 'flying'].includes(name)) {
      // Mineflayer reuses an object with stale fields. A position-only packet does NOT
      // transmit the yaw/pitch properties on that object; record only serialized fields.
      const fields = { onGround: params.flags?.onGround ?? params.onGround }
      if (name === 'position' || name === 'position_look') {
        fields.position = vector(params)
        wire.position = fields.position
      }
      if (name === 'look' || name === 'position_look') {
        fields.rotation = { yaw: params.yaw, pitch: params.pitch }
        wire.rotation = fields.rotation
      }
      wire.onGround = fields.onGround
      record(name, fields)
    } else if (name === 'player_input') record(name, { inputs: { ...params.inputs } })
    else if (name === 'close_window' || name === 'window_click') {
      record(name, { windowId: params.windowId, slot: params.slot, mode: params.mode })
    }
    return write.call(this, name, params)
  }
  bot._client.on('acknowledge_player_digging', packet => {
    const sequence = packet.sequenceId ?? packet.sequence
    if (attempt && attempt.startAckMs == null && sequence >= attempt.startSequence) {
      attempt.startAckMs = Math.round(now() - attempt.start)
    }
    record('ack', { sequence })
  })
  bot._client.on('held_item_slot', packet => record('serverSlot', { slot: packet.slot }))
  bot.on('entityAttributes', entity => {
    if (entity === bot.entity) record('miningAttributes', { attributes: attributes() })
  })
  bot.on('blockUpdate', (_old, block) => {
    if (!attempt || !block?.position.equals(attempt.block.position)) return
    record('blockUpdate', { name: block.name, stateId: block.stateId })
  })
  bot.on('heldItemChanged', item => record('heldItemChanged', { item: item?.name ?? null, slot: bot.quickBarSlot,
    heldItem: miningItem(bot, item) }))
  bot.on('botifyDigResult', result => {
    if (!attempt) return
    const report = { format: 2, version: bot.version, ...attempt,
      result: { ok: result.ok, reason: result.reason, started: result.started, finishSent: result.finishSent } }
    attempt = null
    const updates = report.records.filter(r => r.kind === 'blockUpdate').length
    if (!result.ok) log(`[копание] ${report.item ?? 'рука'}; ACK START: ${report.startAckMs != null ? report.startAckMs + ' мс' : 'не получен'}; START→STOP: ${report.finishMs != null ? report.finishMs + ' мс' : 'STOP не отправлен'}; обновлений блока: ${updates}`)
    // Repeated .break cancels the preceding task. Preserve the actual timeout/refusal
    // separately instead of overwriting it with the last manual cancellation.
    const suffix = result.ok ? '.success' : result.reason === 'Digging aborted' ? '.cancelled' : ''
    const output = suffix ? file.replace(/\.json$/, '') + suffix + '.json' : file
    const json = JSON.stringify(report, null, 2)
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(output, json)
      if (!result.ok) log(`[копание] диагностика: ${output}`)
    }).catch(error => log(`[копание] ошибка записи диагностики: ${error.message}`))
  })
  const reset = () => { attempt = null; history.length = 0; wire = { position: null, rotation: null, slot: null, onGround: null } }
  bot.on('respawn', reset)
  bot._client.on('start_configuration', reset)
  bot.on('end', reset)
  return { flushed: () => writing }
}

module.exports = { attachDigDiagnostics }
