'use strict'
/*
 * Port of the vanilla 1.21+/26.x mining speed, used for every client tick of digging:
 *
 *   BlockBehaviour#getDestroyProgress = player.getDestroySpeed(state) / hardness / (correctTool ? 30 : 100)
 *   Player#getDestroySpeed:
 *     f = held item's tool speed for this block (1 when it is not the right tool)
 *     if (f > 1) f += attribute mining_efficiency          ← Efficiency lives HERE since 1.21
 *     haste / conduit power: f *= 1 + (amplifier + 1) * 0.2
 *     mining fatigue:        f *= 0.3 / 0.09 / 0.0027 / 0.00081
 *     f *= attribute block_break_speed
 *     eyes in water:         f *= attribute submerged_mining_speed   ← Aqua Affinity lives here
 *     not on ground:         f /= 5
 *
 * The attributes come from the server (entity_update_attributes), so the client counts with
 * the same numbers the server checks the STOP_DESTROY_BLOCK against. Guessing Efficiency
 * from enchantment ids is only a fallback for servers that never sent the attribute.
 */
const F = Math.fround
const { attachEnchantmentRegistry, itemEnchantments } = require('./item-enchantments')

const OPERATIONS = { add_value: 0, addition: 0, add_multiplied_base: 1, multiply_base: 1, add_multiplied_total: 2, multiply_total: 2 }
const operation = m => typeof m.operation === 'number' ? m.operation : OPERATIONS[m.operation] ?? 0

/** AttributeInstance#calculateValue; null when the server never sent the attribute. */
function attributeValue (entity, name) {
  const attrs = entity?.attributes
  if (!attrs) return null
  const key = Object.keys(attrs).find(k => k === name || k.endsWith('.' + name) || k.endsWith(':' + name))
  if (!key) return null
  const a = attrs[key]
  const mods = a.modifiers || []
  let base = Number(a.value)
  for (const m of mods) if (operation(m) === 0) base += m.amount
  let value = base
  for (const m of mods) if (operation(m) === 1) value += base * m.amount
  for (const m of mods) if (operation(m) === 2) value *= 1 + m.amount
  return value
}

function enchantLevel (bot, item, name) {
  return itemEnchantments(bot, item).find(e => e.name?.replace(/^minecraft:/, '') === name)?.level ?? 0
}

function effectAmplifier (bot, ...names) {
  let best = -1
  for (const name of names) {
    const id = bot.registry.effectsByName?.[name]?.id
    const e = id != null ? bot.entity.effects?.[id] : null
    if (e) best = Math.max(best, e.amplifier ?? 0)
  }
  return best
}

/** Component rules override the item's ordinary material/tier, including custom axes. */
function toolData (bot, block, item) {
  const harvest = block.canHarvest ? block.canHarvest(item?.type ?? null) : true
  const removed = item?.removedComponents?.some(c => (c.type ?? c).replace?.(/^minecraft:/, '') === 'tool')
  const component = item?.components?.find(c => c.type.replace(/^minecraft:/, '') === 'tool')
  if (removed || component) {
    const data = removed ? null : component.data
    const matches = rule => rule.blocks?.ids
      ? rule.blocks.ids.includes(block.type)
      : bot._botifyBlockTags?.get(rule.blocks?.name?.replace(/^minecraft:/, ''))?.has(block.type)
    // Speed and correct-tool rules are independent, ordered lookups in vanilla.
    const rules = data?.rules || []
    const speedRule = rules.find(r => r.speed != null && matches(r))
    const dropRule = rules.find(r => r.correctDropForBlocks != null && matches(r))
    return {
      speed: speedRule?.speed ?? data?.defaultMiningSpeed ?? 1,
      correct: !block.harvestTools || dropRule?.correctDropForBlocks === true,
      source: removed ? 'removed' : 'component'
    }
  }
  const multipliers = bot.registry.materials?.[block.material]
  return { speed: (item && multipliers?.[item.type]) || 1, correct: harvest, source: 'material' }
}

function eyeInWater (bot) {
  const b = bot._getBlockAtEyeLevel?.()
  if (!b) return false
  if (/^(water|bubble_column)$/.test(b.name)) return true
  try { return b.getProperties?.().waterlogged === true } catch { return false }
}

function destroySpeed (bot, block) {
  const item = bot.heldItem
  let f = F(toolData(bot, block, item).speed)
  let efficiency = null
  if (f > 1) {
    efficiency = attributeValue(bot.entity, 'mining_efficiency')
    const level = efficiency == null ? enchantLevel(bot, item, 'efficiency') : 0
    if (efficiency == null) efficiency = level > 0 ? level * level + 1 : 0
    f = F(f + F(efficiency))
  }
  const haste = effectAmplifier(bot, 'Haste', 'haste', 'ConduitPower', 'conduit_power')
  if (haste >= 0) f = F(f * F(1 + F((haste + 1) * 0.2)))
  const fatigue = effectAmplifier(bot, 'MiningFatigue', 'mining_fatigue')
  if (fatigue >= 0) f = F(f * F([0.3, 0.09, 0.0027][fatigue] ?? 8.1e-4))
  f = F(f * F(attributeValue(bot.entity, 'block_break_speed') ?? 1))
  if (eyeInWater(bot)) {
    const submerged = attributeValue(bot.entity, 'submerged_mining_speed') ??
      (enchantLevel(bot, bot.inventory?.slots?.[5], 'aqua_affinity') > 0 ? 1 : 0.2)
    f = F(f * F(submerged))
  }
  if (!bot.entity.onGround) f = F(f / 5)
  return { speed: f, efficiency }
}

/** Damage added to the block on one client tick (vanilla destroyProgress increment). */
function destroyProgress (bot, block) {
  const hardness = block.hardness
  if (hardness == null || hardness < 0) return 0
  if (hardness === 0) return 1
  const { correct } = toolData(bot, block, bot.heldItem)
  return F(F(destroySpeed(bot, block).speed / hardness) / (correct ? 30 : 100))
}

/** Replaces Mineflayer's guess. asProgress → per-tick damage; otherwise milliseconds. */
function attachVanillaDigSpeed (bot) {
  attachEnchantmentRegistry(bot)
  bot._botifyBlockTags = new Map()
  bot._client?.on('tags', packet => {
    for (const group of packet.tags || []) {
      if (group.tagType !== 'minecraft:block') continue
      bot._botifyBlockTags = new Map(group.tags.map(tag =>
        [tag.tagName.replace(/^minecraft:/, ''), new Set(tag.entries)]))
    }
  })
  bot._client?.on('start_configuration', () => bot._botifyBlockTags.clear())
  bot.digTime = (block, asProgress = false) => {
    if (bot.game?.gameMode === 'creative') return asProgress ? 1 : 0
    const p = destroyProgress(bot, block)
    if (asProgress) return p
    if (p <= 0) return Infinity
    if (p >= 1) return 0
    return ticksToBreak(p) * 50
  }
}

/** Ticks of continueDestroyBlock until the float sum reaches 1, as the client counts. */
function ticksToBreak (p) {
  if (p >= 1) return 0
  if (p <= 0) return Infinity
  let sum = 0; let n = 0
  while (sum < 1 && n < 100000) { sum = F(sum + p); n++ }
  return n
}

function describeDigSpeed (bot, block) {
  const { speed, efficiency } = destroySpeed(bot, block)
  const p = destroyProgress(bot, block)
  const fromServer = attributeValue(bot.entity, 'mining_efficiency') != null
  return { speed, progress: p, ticks: ticksToBreak(p), efficiency, efficiencySource: fromServer ? 'сервер' : 'зачарование' }
}

module.exports = { attachVanillaDigSpeed, destroyProgress, destroySpeed, attributeValue, ticksToBreak, describeDigSpeed, toolData }
