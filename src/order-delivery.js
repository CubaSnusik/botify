'use strict'
const { clean, parseCount, countIs } = require('./order-transfer-ui')

function receiptMatches (message, seller, amount, displayName) {
  // Match a server receipt as a whole, not a player quoting one in chat.
  const match = clean(message).match(/^([A-Za-z0-9_]{1,16}) delivered you (\d[\d,]*(?:\.\d+)?[km]?) (.+)$/i)
  if (!match) return false
  // Bulk receipts use the plural ("72 Spruce Logs") and big ones are rounded
  // ("1.8K Spruce Logs" for 1855); the exact count was already verified in
  // the Deliver Items window before confirming.
  const item = match[3].toLowerCase(); const name = displayName.toLowerCase()
  return match[1].toLowerCase() === seller.toLowerCase() &&
    countIs(parseCount(match[2]), amount) && (item === name || item === name + 's' || item === name + 'es')
}

async function deliver (ui, buyer, itemName, displayName, amount) {
  const bot = ui.inst.bot
  const screen = await ui.wait(s => s?.kind === 'window' && /^Orders\s*(?:->|→)\s*Deliver Items$/i.test(clean(s.title)), 'Deliver Items')
  const window = screen.ref
  if (window.containerItems().length || window.selectedItem) throw new Error('окно сдачи не пустое')
  const sources = window.items().filter(i => i.name === itemName).map(i => i.slot)
  for (let i = sources.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); [sources[i], sources[j]] = [sources[j], sources[i]]
  }
  const click = async (slot, button = 0) => {
    await ui.pause()
    if (bot.currentWindow !== window) throw new Error('окно сдачи сменилось')
    // Avoid Mineflayer's delayed hotbar click selecting a different window.
    if (slot >= 36 && bot.lastDigTime != null) {
      const remaining = 501 - (Date.now() - bot.lastDigTime)
      if (remaining > 0) await ui.pause(remaining)
    }
    ui.check()
    if (bot.currentWindow !== window) throw new Error('окно сдачи сменилось')
    await bot.clickWindow(slot, button, 0)
  }
  let left = amount
  for (const slot of sources) {
    if (!left) break
    const source = window.slots[slot]
    if (source?.name !== itemName) continue
    const dest = window.firstEmptyContainerSlot()
    if (dest === null) throw new Error('окно сдачи заполнено')
    const take = Math.min(source.count, left)
    await click(slot)
    if (window.selectedItem?.name !== itemName) throw new Error('сервер не подтвердил взятие предмета')
    if (take === window.selectedItem.count) await click(dest)
    else {
      for (let n = 0; n < take; n++) {
        if (window.selectedItem?.name !== itemName) throw new Error('предмет на курсоре изменился')
        await click(dest, 1)
      }
      if (window.selectedItem) await click(slot)
    }
    left -= take
  }
  await ui.pause()
  const deposited = window.containerItems()
  if (left || window.selectedItem || deposited.some(i => i.name !== itemName) || deposited.reduce((n, i) => n + i.count, 0) !== amount) {
    throw new Error('содержимое окна сдачи не совпадает с ожидаемым количеством')
  }
  // Escape is close_window; only then does the server show Confirm Delivery.
  await bot.closeWindow(window)
  const confirm = await ui.wait(s => s?.kind === 'window' && /^Orders\s*(?:->|→)\s*Confirm Delivery$/i.test(clean(s.title)), 'Confirm Delivery')
  const buttons = confirm.slots.filter(s => s && /^(lime|green)_stained_glass_pane$/.test(s.name))
  if (buttons.length !== 1 || !confirm.slots.some(s => s?.name === itemName)) throw new Error('неоднозначное подтверждение сдачи')
  let received = false
  const listener = (message, position) => {
    if (position === 'chat' || position === 'game_info') return
    if (receiptMatches(message, ui.inst.acc.username, amount, displayName)) received = true
  }
  // The probe (1 item) must be confirmed by the buyer — that proves the order
  // is really theirs. Later batches go to the same order, so the seller's own
  // "You delivered … and received $…" is accepted too if the buyer's lags.
  const sellerListener = (message, position) => {
    if (position === 'chat' || position === 'game_info' || amount <= 1) return
    if (sellerReceiptMatches(message, amount, displayName)) received = true
  }
  const receiver = buyer.bot
  receiver.on('messagestr', listener)
  bot.on('messagestr', sellerListener)
  try {
    await ui.click(confirm, buttons[0].slot)
    await ui.wait(() => received, `сообщение о получении ${amount} ${displayName}`, 20000)
  } finally { receiver.off('messagestr', listener); bot.off('messagestr', sellerListener) }
  return amount
}

function sellerReceiptMatches (message, amount, displayName) {
  const match = clean(message).match(/^You delivered (\d[\d,]*(?:\.\d+)?[km]?) (.+?) and received \$\s*[\d,.]+[km]?$/i)
  if (!match) return false
  const item = match[2].toLowerCase(); const name = displayName.toLowerCase()
  return countIs(parseCount(match[1]), amount) && (item === name || item === name + 's' || item === name + 'es')
}

module.exports = { deliver, receiptMatches, sellerReceiptMatches }
