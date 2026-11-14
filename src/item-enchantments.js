'use strict'

function attachEnchantmentRegistry (bot) {
  bot._botifyEnchantments = null
  bot._client?.on('registry_data', packet => {
    if (packet.id !== 'minecraft:enchantment') return
    // Numeric enchantment IDs belong to this connection's registry, not minecraft-data.
    bot._botifyEnchantments = packet.entries.map(entry => entry.key)
  })
  bot._client?.on('start_configuration', () => { bot._botifyEnchantments = null })
}

function itemEnchantments (bot, item) {
  let list
  try { list = item?.enchants } catch { return [] }
  if (list && !Array.isArray(list)) list = list.enchantments ?? list.levels ?? []
  if (!Array.isArray(list)) return []
  return list.map(e => {
    const name = typeof e.name === 'string' ? e.name
      : bot._botifyEnchantments != null ? bot._botifyEnchantments[e.id]
        : bot.registry.enchantments?.[e.id]?.name
    return { id: e.id, name: name ?? null, level: e.lvl ?? e.level ?? 0 }
  })
}

module.exports = { attachEnchantmentRegistry, itemEnchantments }
