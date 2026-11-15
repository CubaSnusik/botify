'use strict'

// Ask the server for the real player-inventory state (incl. the cursor).
async function syncInventory (bot, ms = 2000) {
  if (typeof bot._syncWindow !== 'function') return
  let timer
  await Promise.race([
    bot._syncWindow(bot.inventory).catch(() => {}),
    new Promise(resolve => { timer = setTimeout(resolve, ms) })
  ])
  clearTimeout(timer)
}

function cursorTarget (bot, preferSlot) {
  const inv = bot.inventory
  const held = inv.selectedItem
  const fits = slot => {
    const item = inv.slots[slot]
    if (!item) return true
    return item.type === held.type && item.count + held.count <= (item.stackSize || 64) &&
      JSON.stringify(item.nbt ?? null) === JSON.stringify(held.nbt ?? null)
  }
  const order = []
  if (preferSlot != null) order.push(preferSlot)
  for (let s = 9; s <= 35; s++) order.push(s)
  for (let s = 36; s <= 44; s++) order.push(s)
  if (preferSlot != null && fits(preferSlot)) return preferSlot
  return order.find(s => !inv.slots[s]) ?? order.find(fits)
}

// Put whatever is left on the inventory cursor back into the inventory.
// Returns true when the cursor is empty afterwards. Never touches open
// container windows.
async function clearCursor (bot, { preferSlot, pause } = {}) {
  if (bot.currentWindow) return false
  const inv = bot.inventory
  const settle = pause || (() => bot.waitForTicks(3))
  if (!inv.selectedItem) return true
  // The local cursor may be stale (e.g. after a rejected outside click).
  await syncInventory(bot)
  if (bot.currentWindow) return false
  if (!inv.selectedItem) return true
  const target = cursorTarget(bot, preferSlot)
  if (target != null) {
    try { await bot.clickWindow(target, 0, 0) } catch {}
    await settle()
    if (!bot.currentWindow && !inv.selectedItem) {
      await bot.closeWindow(inv)
      return true
    }
  }
  // Closing the inventory makes the server put the carried stack back
  // (or drop it when the inventory is full); then read the result back.
  await bot.closeWindow(inv)
  await settle()
  await syncInventory(bot)
  return !bot.currentWindow && !inv.selectedItem
}

module.exports = { clearCursor, syncInventory }
