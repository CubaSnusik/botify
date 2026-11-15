'use strict'

async function equipDigTool (bot, item, checkCancel = () => {}) {
  checkCancel()
  if (bot.currentWindow) throw new Error('перед копанием закрой открытое окно')
  if (bot.inventory.selectedItem) throw new Error('перед копанием убери предмет с курсора инвентаря')
  const hotbarStart = bot.QUICK_BAR_START ?? 36
  const needsInventory = item.slot < hotbarStart || item.slot >= hotbarStart + 9
  try {
    await bot.equip(item, 'hand')
  } finally {
    // Moving a stack out of the inventory emits clicks. Finish that interaction before
    // mining, just as closing the inventory screen does; a hotbar change needs no close.
    if (needsInventory && !bot.currentWindow && !bot.inventory.selectedItem) await bot.closeWindow(bot.inventory)
  }
  checkCancel()
  const slot = bot.quickBarSlot
  await bot.waitForTicks(2)
  checkCancel()
  if (bot.currentWindow || bot.inventory.selectedItem || bot.quickBarSlot !== slot || bot.heldItem?.type !== item.type) {
    throw new Error('инструмент не остался в выбранном слоте после экипировки — копание не начато')
  }
}

// Refresh the item on every attempt: a server correction may move the stack.
// The caller supplies an abortable delay and its own inventory selection policy.
async function equipWithRetries (bot, findItem, { checkCancel, wait, onRetry, retries = 5 }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    checkCancel()
    try {
      const item = findItem()
      if (!item) throw new Error('нужный предмет пока не найден в инвентаре')
      await equipDigTool(bot, item, checkCancel)
      return
    } catch (error) {
      checkCancel()
      if (attempt === retries) throw new Error(`не удалось взять предмет после ${retries} повторов — ферма остановлена: ${error.message}`)
      onRetry(attempt + 1, retries, error)
      await wait()
    }
  }
}

module.exports = { equipDigTool, equipWithRetries }
