'use strict'
const { findAxe } = require('./tree-chopper')

// Farm roles keep separate hotbar slots. Never use equip()'s rotating eviction
// policy: a full hotbar would otherwise swap the axe back into the inventory.
function createFarmHotbar (bot, species, { checkCancel, wait, reply }) {
  const start = bot.QUICK_BAR_START ?? 36
  const roles = {
    axe: item => !!item && !!findAxe({ registry: bot.registry, heldItem: item, inventory: { items: () => [] } }),
    sapling: item => item?.name === `${species}_sapling`,
    meal: item => item?.name === 'bone_meal'
  }
  const slots = new Map()
  const labels = { axe: 'топор', sapling: `${species}_sapling`, meal: 'костная мука' }
  const items = () => bot.inventory.items().filter(i => i.count > 0)
  const inBar = item => item.slot >= start && item.slot < start + 9
  for (const [role, matches] of Object.entries(roles)) {
    const item = items().find(i => matches(i) && inBar(i))
    if (item) slots.set(role, item.slot)
  }
  const ready = role => {
    const slot = slots.get(role)
    const item = items().find(i => i.slot === slot)
    return !bot.currentWindow && !bot.inventory.selectedItem &&
      bot.quickBarSlot === slot - start && roles[role](item) &&
      roles[role](bot.heldItem) && bot.heldItem.count > 0 && bot.heldItem.type === item.type
  }
  async function select (role) {
    for (let attempt = 0; attempt <= 5; attempt++) {
      checkCancel()
      try {
        if (ready(role)) return
        if (bot.currentWindow || bot.inventory.selectedItem) throw new Error('открыто окно или предмет остался на курсоре')
        const available = items()
        const matches = roles[role]
        const item = available.find(i => i.slot === slots.get(role) && matches(i)) ||
          available.find(i => inBar(i) && matches(i)) || available.find(matches)
        if (!item) throw new Error(`нет предмета: ${labels[role]}`)
        let destination = item.slot
        if (!inBar(item)) {
          const protectedSlot = slot => [...slots].some(([r, s]) => r !== role && s === slot) ||
            available.some(i => i.slot === slot && Object.values(roles).some(match => match(i)))
          destination = slots.get(role)
          if (destination == null || protectedSlot(destination)) {
            const candidates = Array.from({ length: 9 }, (_, i) => start + i).filter(s => !protectedSlot(s))
            destination = candidates.find(s => !available.some(i => i.slot === s)) ?? candidates[0]
          }
          if (destination == null) throw new Error('нет отдельного слота хотбара')
          slots.set(role, destination)
          try { await bot.moveSlotItem(item.slot, destination) } finally {
            if (!bot.currentWindow && !bot.inventory.selectedItem) await bot.closeWindow(bot.inventory)
          }
          checkCancel()
          await wait(2)
          checkCancel()
          if (!matches(items().find(i => i.slot === destination))) throw new Error('сервер не подтвердил перенос в хотбар')
        }
        slots.set(role, destination)
        bot.setQuickBarSlot(destination - start)
        await wait(1)
        checkCancel()
        if (!ready(role)) throw new Error('сервер изменил выбранный слот или предмет')
        return
      } catch (error) {
        checkCancel()
        if (attempt === 5) throw new Error(`не удалось выбрать ${labels[role]} после 5 повторов — ферма остановлена: ${error.message}`)
        reply(`[инвентарь] ${labels[role]}: ${error.message}; повтор ${attempt + 1}/5`)
        await wait(4)
      }
    }
  }
  return { select, ready }
}

module.exports = { createFarmHotbar }
