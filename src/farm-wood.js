'use strict'
const timers = require('node:timers/promises')
const { performance } = require('node:perf_hooks')
const { eyePosition, anglesFrom, viewDirection } = require('./eye-raycast')
const { clearCursor } = require('./inventory-cursor')

const retryAfter = new WeakMap()
const BAD_FLOOR = /chest|barrel|shulker|hopper|dispenser|dropper|leaves|furnace|campfire|cactus|magma/

function woodDropTarget (bot, plot) {
  const origin = bot.entity.position
  const eye = eyePosition(bot.entity)
  const center = plot[0].offset(1, 0, 1)
  // Use the side of the square bed, not a diagonal to its center. A diagonal
  // side heading can point back toward storage when standing near a corner.
  const forward = center.minus(origin); forward.y = 0
  if (forward.norm() < 0.1) return null
  const fx = Math.abs(forward.x) > Math.abs(forward.z) ? Math.sign(forward.x) : 0
  const fz = fx === 0 ? Math.sign(forward.z) : 0
  for (const side of [1, -1]) {
    const dx = -fz * side; const dz = fx * side
    for (const distance of [3, 3.5, 2.5]) {
      const point = origin.offset(dx * distance, 0, dz * distance)
      const floorPos = point.floored().offset(0, -1, 0)
      const floor = bot.blockAt(floorPos)
      if (!floor || floor.boundingBox !== 'block' || BAD_FLOOR.test(floor.name)) continue
      // Require a flat landing area, not a single block top beside a chest or ledge.
      let flat = true
      for (const x of [-0.65, 0, 0.65]) for (const z of [-0.65, 0, 0.65]) {
        const p = point.offset(x, 0, z).floored().offset(0, -1, 0)
        const below = bot.blockAt(p)
        const above = bot.blockAt(p.offset(0, 1, 0))
        const fullTop = below?.shapes?.some(s => s[0] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1)
        if (!fullTop || BAD_FLOOR.test(below.name) || !above || above.boundingBox === 'block' || BAD_FLOOR.test(above.name) || /water|lava/.test(above.name)) flat = false
      }
      if (!flat) continue
      // Leave a clear corridor for the thrown stack, not just a ray over a chest.
      let clear = true
      for (let d = 0.5; d <= distance; d += 0.25) {
        for (const height of [0.25, 0.75, 1.25]) {
          const block = bot.blockAt(origin.offset(dx * d, height, dz * d))
          if (!block || block.boundingBox === 'block' || BAD_FLOOR.test(block.name) || /water|lava/.test(block.name)) clear = false
        }
      }
      if (!clear) continue
      // Aim inside the face, not at an integer block edge where round-off can
      // make the sent yaw ray hit the neighbouring floor block instead.
      const target = floorPos.offset(0.5, 0.99, 0.5)
      const direction = target.minus(eye).normalize()
      const hit = bot.world.raycast(eye, direction, eye.distanceTo(target) + 0.05)
      if (!hit?.position.equals(floorPos) || hit.face !== 1) continue
      return { ...anglesFrom(eye, target), target, floorPos, side: side === 1 ? 'справа' : 'слева', origin: origin.clone() }
    }
  }
  return null
}

function dropAimValid (bot, aim) {
  if (bot.entity.position.distanceTo(aim.origin) > 0.15) return false
  const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle))
  if (Math.abs(wrap(bot.entity.yaw - aim.yaw)) > 0.02 || Math.abs(bot.entity.pitch - aim.pitch) > 0.02) return false
  const eye = eyePosition(bot.entity)
  const hit = bot.world.raycast(eye, viewDirection(bot.entity.yaw, bot.entity.pitch), eye.distanceTo(aim.target) + 0.1)
  return !!hit?.position.equals(aim.floorPos) && hit.face === 1 && !BAD_FLOOR.test(hit.name)
}

// What the server answered after a throw click: slot corrections, setbacks
// and its chat lines, with times relative to the click.
function traceDrop (bot, slot) {
  let start = null
  const events = []
  const at = () => start == null ? 'до клика' : `${Math.round(performance.now() - start)} мс`
  const count = item => item?.itemCount ?? item?.count ?? 0
  const handlers = {
    set_slot: p => { if (p.windowId === 0 && p.slot === slot) events.push(`set_slot ${slot}=${count(p.item)} через ${at()}`) },
    window_items: p => { if (p.windowId === 0) events.push(`window_items stateId ${p.stateId}, слот ${slot}=${count(p.items?.[slot])} через ${at()}`) },
    position: () => events.push(`откат позиции через ${at()}`)
  }
  const onChat = text => { if (start != null && events.length < 8) events.push(`чат «${String(text).slice(0, 80)}»`) }
  const onClick = p => { if (p.windowId === 0 && (p.slot === slot || p.slot === -999)) events.push(`клик ${p.slot} со stateId ${p.stateId}`) }
  for (const [name, fn] of Object.entries(handlers)) bot._client.on(name, fn)
  bot.on('messagestr', onChat)
  bot.on('botifyClickPacket', onClick)
  return {
    mark: () => { start = performance.now() },
    describe: () => events.length ? events.slice(0, 8).join('; ') : 'без пакетов от сервера по этому слоту',
    stop: () => {
      for (const [name, fn] of Object.entries(handlers)) bot._client.off(name, fn)
      bot.off?.('messagestr', onChat)
      bot.off?.('botifyClickPacket', onClick)
    }
  }
}

// Throw each stack like the GUI's "drop stack", with aiming and retries.
async function dropFarmMaterial (bot, signal, { plot, look, reply, checkCancel }, name) {
  const logs = () => bot.inventory.items().filter(i => i.name === name && i.slot >= 9 && i.slot < 45)
  const total = () => logs().reduce((sum, i) => sum + i.count, 0) + (bot.inventory.selectedItem?.name === name ? bot.inventory.selectedItem.count : 0)
  const check = () => {
    checkCancel(signal)
    if (bot.currentWindow) throw new Error('выброс дерева: открыто другое окно')
    if (bot.inventory.selectedItem && bot.inventory.selectedItem.name !== name) throw new Error('выброс дерева: на курсоре другой предмет')
  }
  if (Date.now() < (retryAfter.get(bot) || 0) || !logs().length || bot.currentWindow || bot.inventory.selectedItem) return 0
  check()
  const aim = woodDropTarget(bot, plot)
  if (!aim) {
    retryAfter.set(bot, Date.now() + 5000)
    reply('[инвентарь] по бокам нет свободного ровного пола — выброс отложен')
    return 0
  }
  if (!await look(aim.yaw, aim.pitch, () => signal.aborted)) return 0
  reply(`[инвентарь] выброс ${aim.side}, на пол ${aim.floorPos.x},${aim.floorPos.y},${aim.floorPos.z}`)
  const pause = async (ms = 200 + Math.floor(Math.random() * 201)) => {
    check(); await timers.setTimeout(ms, undefined, { signal }); check()
  }
  // The same throw as the GUI's "drop stack" (mineflayer tossStack): pick the
  // stack up, click outside the window, close the inventory, back to back.
  // The head is turned before; nothing rotates while the stack is on the cursor.
  const toss = async slot => {
    await pause() // before the pickup only; .stop is honoured here
    if (slot >= 36 && bot.lastDigTime != null) {
      const remaining = 500 - (Date.now() - bot.lastDigTime)
      if (remaining > 0) await pause(remaining + 1)
    }
    check()
    const item = bot.inventory.slots[slot]
    if (bot.inventory.selectedItem || item?.name !== name || !dropAimValid(bot, aim)) return false
    let cancel; let timer
    const pending = bot.tossStack(item)
    const abort = new Promise((resolve, reject) => {
      cancel = () => reject(new Error('выброс дерева отменён'))
      signal.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(() => reject(new Error('выброс дерева: клик не завершился за 5 секунд')), 5000)
      if (signal.aborted) cancel()
    })
    try { await Promise.race([pending, abort]); return true } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel)
      pending.catch(() => {})
    }
  }
  let dropped = 0
  try {
    // Snapshot slots only; read their contents again before every attempt.
    for (const slot of logs().map(i => i.slot)) {
      for (let attempt = 0; attempt <= 5; attempt++) {
        check()
        if (bot.inventory.slots[slot]?.name !== name) break
        const before = total()
        const count = bot.inventory.slots[slot].count
        let collected = false
        const onCollect = packet => { if (packet.collectorEntityId === bot.entity.id) collected = true }
        bot._client.on('collect', onCollect)
        let moved = 0
        let why = null
        const trace = traceDrop(bot, slot)
        try {
          // Inventory pauses and other rotation requests may change the view.
          // Re-aim each stack and let the normal movement tick send the rotation.
          const aligned = await look(aim.yaw, aim.pitch, () => signal.aborted)
          if (aligned) await bot.waitForTicks(2)
          check()
          trace.mark()
          const thrown = aligned && await toss(slot)
          if (!thrown && !aligned) why = 'клик не отправлен: поворот головы прерван'
          else if (!thrown) why = `клик не отправлен: ${dropAimValid(bot, aim) ? 'слот или курсор изменились' : 'взгляд не попадает в пол цели'}`
          await pause(800) // Observe delayed corrections before counting success.
          moved = thrown ? Math.min(count, Math.max(0, before - total())) : 0
          if (thrown && moved === 0) why = `сервер вернул стопку (${trace.describe()})`
        } finally { bot._client.off('collect', onCollect); trace.stop() }
        if (moved > 0) { dropped += moved; break }
        // A rejected outside click can leave the stack on the cursor; put it
        // back before retrying, or every later hotbar action is blocked.
        if (bot.inventory.selectedItem && !bot.currentWindow) {
          checkCancel(signal)
          if (!await clearCursor(bot, { preferSlot: slot })) throw new Error('выброс дерева: не удалось убрать предмет с курсора')
        }
        const where = slot >= 36 ? `хотбар ${slot - 35}${slot - 36 === bot.quickBarSlot ? ', в руке' : ''}` : `слот ${slot}`
        const reason = collected
          ? 'инвентарь не освободился; во время выброса был подбор предметов'
          : `инвентарь не освободился; выброс не подтверждён — ${where}, ${why || 'причина не определена'}`
        if (attempt < 5) {
          reply(`[инвентарь] ${reason} — повтор ${attempt + 1}/5`)
          await pause(800 + Math.floor(Math.random() * 401))
        } else {
          retryAfter.set(bot, Date.now() + 30000)
          reply(`[инвентарь] ${reason} после 5 повторов; очистка на паузе 30 с, ферма продолжает работу при наличии места`)
          return dropped
        }
      }
    }
  } finally {
    if (dropped) reply(`[инвентарь] выброшено ${name}: ${dropped}`)
  }
  return dropped
}

async function dropFarmWood (bot, signal, options) {
  let dropped = 0
  for (const name of [`${options.species}_log`, 'stick']) {
    options.checkCancel(signal)
    dropped += await dropFarmMaterial(bot, signal, options, name)
  }
  return dropped
}

module.exports = { dropFarmWood, woodDropTarget, dropAimValid }
