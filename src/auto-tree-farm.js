'use strict'
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { farmSettings } = require('./farm-settings')
const { watchFarmPlayers } = require('./friends')
const { farmTrees, farmRay } = require('./tree-farm')
const { eyePosition, anglesFrom } = require('./eye-raycast')
const { aimPoints } = require('./tree-chopper')
const { createFarmHotbar } = require('./farm-hotbar')
const { signLines } = require('./sign-text')
const { dropFarmWood } = require('./farm-wood')

const SOIL = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mud'])
const AIR = new Set(['air', 'cave_air', 'void_air'])
const CONTAINERS = /^(chest|trapped_chest|ender_chest|barrel|hopper|dispenser|dropper|(?:[a-z_]+_)?shulker_box)$/
const DIRECTIONS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const key = p => `${p.x},${p.y},${p.z}`

function detectPlots (bot, radius) {
  const ids = [...SOIL].map(name => bot.registry.blocksByName[name]?.id).filter(Number.isInteger)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 4096 })
  const plots = new Map()
  for (const p of found) {
    const plot = [p, p.offset(1, 0, 0), p.offset(0, 0, 1), p.offset(1, 0, 1)]
    if (!plot.every(s => SOIL.has(bot.blockAt(s)?.name))) continue
    const members = new Set(plot.map(key))
    if (plot.some(s => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => {
      const n = s.offset(x, 0, z)
      return !members.has(key(n)) && SOIL.has(bot.blockAt(n)?.name)
    }))) continue
    plots.set(key(p), plot)
  }
  return [...plots.values()].sort((a, b) => a[0].offset(1, 1, 1).distanceTo(bot.entity.position) - b[0].offset(1, 1, 1).distanceTo(bot.entity.position))
}

function farmStands (bot, plot) {
  const corner = plot[0]; const result = []
  for (let x = -2; x <= 3; x++) for (let z = -2; z <= 3; z++) for (let dy = -1; dy <= 1; dy++) {
    if (x >= 0 && x <= 1 && z >= 0 && z <= 1) continue
    const p = corner.offset(x, dy, z)
    const floor = bot.blockAt(p.offset(0, -1, 0))
    if (floor?.boundingBox !== 'block' || /leaves|magma|cactus|campfire/.test(floor.name)) continue
    if (![p, p.offset(0, 1, 0)].every(s => AIR.has(bot.blockAt(s)?.name))) continue
    const eye = p.offset(0.5, 1.62, 0.5)
    if (plot.every(s => eye.distanceTo(s.offset(0.5, 1, 0.5)) < 4.2)) result.push(p)
  }
  return result.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(bot.entity.position) - b.offset(0.5, 0, 0.5).distanceTo(bot.entity.position))
}

function signMatches (block, label) {
  return signLines(block).includes(String(label).trim())
}
function signContainer (bot, sign) {
  const at = p => { const b = bot.blockAt(p); return b && CONTAINERS.test(b.name) ? b : null }
  const facing = sign.getProperties?.().facing
  if (/wall_sign$/.test(sign.name)) {
    const support = { north: [0, 0, 1], south: [0, 0, -1], west: [1, 0, 0], east: [-1, 0, 0] }[facing]
    if (support) return at(sign.position.offset(...support))
  }
  const candidates = DIRECTIONS.map(d => at(sign.position.offset(...d))).filter(Boolean)
  return candidates.length === 1 ? candidates[0] : null
}
function supplyContainers (bot, label, radius, report = {}) {
  const ids = bot.registry.blocksArray.filter(b => /_sign$/.test(b.name)).map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 256 })
  const containers = new Map()
  report.signs = found.length
  report.matches = 0
  report.samples = []
  for (const p of found) {
    const sign = bot.blockAt(p)
    if (!sign) continue
    const lines = signLines(sign)
    if (report.samples.length < 8) report.samples.push(`${lines.join(' / ').slice(0, 80) || '(текст ещё не получен или пусто)'} @ ${key(p)}`)
    if (!lines.includes(String(label).trim())) continue
    report.matches++
    const container = signContainer(bot, sign)
    if (container) containers.set(key(container.position), container)
  }
  return [...containers.values()].sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

function cancellable (promise, signal, onLate = () => {}) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true; clearTimeout(timer); signal.removeEventListener('abort', cancel)
      error ? reject(error) : resolve(value)
    }
    const cancel = () => finish(new Error('операция отменена'))
    const timer = setTimeout(() => finish(new Error('контейнер не ответил за 15 секунд')), 15000)
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(value => { if (done) onLate(value); else finish(null, value) }, error => finish(error))
    if (signal.aborted) cancel()
  })
}

function shuffledSupplies (window, name) {
  const items = window.containerItems().filter(i => i.name === name)
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

function transferSupply (bot, window, item, count, signal) {
  const client = bot._client
  const original = client.write
  let active = true
  let stopped = false
  let pendingClick = null
  const sourceSlot = item.slot
  const check = () => {
    if (stopped || signal.aborted || bot.currentWindow !== window) throw new Error('перенос из контейнера отменён')
  }
  const guarded = function (name, packet) {
    // clickWindow can itself wait after recent digging; guard its late write too.
    if (active && name === 'window_click') {
      check()
      if (packet.windowId !== window.id) throw new Error('окно контейнера изменилось')
    }
    return original.call(this, name, packet)
  }
  client.write = guarded
  const pause = async () => {
    check()
    await require('node:timers/promises').setTimeout(200 + Math.floor(Math.random() * 201), undefined, { signal })
    check()
  }
  const click = async (slot, button, mode) => {
    check()
    // Keep the write guard until an internally delayed click has really settled.
    const pending = Promise.resolve().then(() => { check(); return bot.clickWindow(slot, button, mode) })
    pendingClick = pending
    const settled = () => { if (pendingClick === pending) pendingClick = null }
    pending.then(settled, settled)
    try { await cancellable(pending, signal) } catch (error) {
      stopped = true
      throw error
    }
    await pause()
  }
  const transfer = Promise.resolve().then(async () => {
    check()
    await pause() // Allow the open/inventory sync to settle before the first click.
    const source = window.slots[sourceSlot]
    if (!source || source.name !== item.name || window.selectedItem) throw new Error('содержимое контейнера или предмет на курсоре изменились')
    const amount = Math.min(count, source.count)
    if (amount <= 0) return
    const before = window.items().filter(i => i.name === item.name).reduce((n, i) => n + i.count, 0)
    if (amount === source.count) {
      // One shift-click transfers this exact randomly selected stack, without a cursor item.
      await click(sourceSlot, 0, 1)
    } else {
      const dest = window.firstEmptyInventorySlot()
      if (dest === null) throw new Error('нет свободного слота для части стака')
      await click(sourceSlot, 0, 0)
      for (let i = 0; i < amount; i++) {
        if (window.selectedItem?.name !== item.name) throw new Error('сервер изменил предмет на курсоре')
        await click(dest, 1, 0)
      }
      if (window.selectedItem) await click(sourceSlot, 0, 0)
    }
    const after = window.items().filter(i => i.name === item.name).reduce((n, i) => n + i.count, 0)
    if (after - before < amount) throw new Error('предметы не появились в инвентаре после переноса — возможно, сервер отклонил клик')
  }).finally(() => {
    stopped = true
    const restore = () => { active = false; if (client.write === guarded) client.write = original }
    if (pendingClick) pendingClick.finally(restore).catch(() => {})
    else restore()
  })
  // Cancellation returns promptly, but leaves the guard on an unresolved click.
  return new Promise((resolve, reject) => {
    const cancel = () => { stopped = true; reject(new Error('операция отменена')) }
    signal.addEventListener('abort', cancel, { once: true })
    transfer.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
    if (signal.aborted) cancel()
  })
}

async function openSupplyContainer (bot, block, signal, look) {
  for (const point of aimPoints(eyePosition(bot.entity), block.position)) {
    const angles = anglesFrom(eyePosition(bot.entity), point)
    if (!farmRay(bot, angles.yaw, angles.pitch)?.position.equals(block.position)) continue
    if (!await look(angles.yaw, angles.pitch, () => signal.aborted)) continue
    if (signal.aborted) throw new Error('операция отменена')
    return new Promise((resolve, reject) => {
      let sent = false
      const finish = (error, window) => {
        clearTimeout(timer); bot.off('windowOpen', opened); bot.off('physicsTick', send)
        signal.removeEventListener('abort', cancel)
        error ? reject(error) : resolve(window)
      }
      const opened = window => {
        if (!sent) return
        if (!/^minecraft:(generic|container|chest|barrel|shulker_box|hopper|dispenser|dropper)/.test(window.type) || !Number.isInteger(window.inventoryStart)) {
          finish(new Error('сервер открыл неподходящее окно')); return
        }
        finish(null, window)
      }
      const cancel = () => finish(new Error('операция отменена'))
      const send = () => {
        if (sent) return
        if (signal.aborted) return cancel()
        const hit = farmRay(bot, bot.entity.yaw, bot.entity.pitch)
        if (!hit?.position.equals(block.position) || hit.name !== block.name) return finish(new Error('контейнер перекрыт или изменился'))
        sent = true
        const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
        Promise.resolve(bot._genericPlace(hit, faces[hit.face], { forceLook: 'ignore', delta: hit.intersect.minus(hit.position), swingArm: 'right' })).catch(error => finish(error))
      }
      const timer = setTimeout(() => finish(new Error('контейнер не открылся за 15 секунд')), 15000)
      bot.on('windowOpen', opened); bot.on('physicsTick', send)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
  }
  throw new Error('нет видимой грани контейнера — табличка или блок закрывает доступ')
}

async function runAutoTreeFarm (inst, signal, deps) {
  const bot = inst.bot
  const config = farmSettings(inst.store.settings.farm)
  const check = () => { deps.checkCancel(signal); if (inst.bot !== bot || bot._client.state !== 'play') throw new Error('соединение изменилось') }
  const stopGuard = watchFarmPlayers(inst, signal, deps.reply)
  const onReset = () => inst.cancelTask()
  bot.on('botifyDigReset', onReset)
  const hotbar = createFarmHotbar(bot, config.species, { checkCancel: check, wait: n => cancellable(bot.waitForTicks(n), signal), reply: deps.reply })
  let plot; let stand
  const goPlot = async () => {
    check()
    const candidates = farmStands(bot, plot)
    if (stand) candidates.sort((a, b) => a.equals(stand) ? -1 : b.equals(stand) ? 1 : 0)
    for (const position of candidates.slice(0, 8)) {
      check()
      try {
        await deps.walk(new goals.GoalBlock(position.x, position.y, position.z), position)
        check()
        if (!plot.every(p => eyePosition(bot.entity).distanceTo(p.offset(0.5, 1, 0.5)) <= 4.5)) continue
        stand = position
        return
      } catch (error) { check() }
    }
    throw new Error('нет доступного места у площадки 2×2; освободите подход к ней')
  }
  const count = name => (bot.currentWindow || bot.inventory).items().filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0)
  const lastAttempt = new Map()
  const refill = async name => {
    if (!config.restock) return false
    const supply = name === 'bone_meal' ? [config.mealLabel, config.mealCount]
      : name === 'experience_bottle' ? [config.experienceLabel, config.experienceCount]
        : [config.saplingLabel, config.saplingCount]
    if (count(name) >= supply[1] || supply[1] === 0) return false
    if (Date.now() - (lastAttempt.get(name) ?? -Infinity) < 15000) return false
    lastAttempt.set(name, Date.now())
    check()
    const report = {}
    const containers = supplyContainers(bot, supply[0], config.searchRadius, report)
    if (!containers.length) {
      const reason = report.matches ? `табличка «${supply[0]}» прочитана, но контейнер за ней не определён — проверьте крепление`
        : `метка «${supply[0]}» не найдена; табличек в загруженных чанках: ${report.signs}`
      deps.reply(`[запасы] ${name}: ${reason}${report.samples.length ? '. Прочитано: ' + report.samples.join('; ') : ''}`)
      return false
    }
    let travelled = false
    const before = count(name)
    try {
      for (const container of containers) {
        check()
        let window
        const close = w => { if (w && bot.currentWindow === w) Promise.resolve(bot.closeWindow(w)).catch(() => {}) }
        const cancel = () => close(window)
        try {
          travelled = true
          deps.reply(`[запасы] иду к «${supply[0]}»: ${container.name} @ ${key(container.position)}`)
          await deps.walk(new goals.GoalLookAtBlock(container.position, bot.world, { reach: 4 }), container.position)
          check()
          if (bot.currentWindow || bot.inventory.selectedItem) throw new Error('сначала закройте другое окно и уберите предмет с курсора')
          await hotbar.select('axe')
          window = await openSupplyContainer(bot, bot.blockAt(container.position), signal, deps.look)
          signal.addEventListener('abort', cancel, { once: true })
          check()
          const supplies = shuffledSupplies(window, name)
          if (!supplies.length && bot.currentWindow === window) {
            const detail = `В контейнере «${supply[0]}» (${container.name} @ ${key(container.position)}) нет ${name}.`
            deps.reply(`[запасы] ${detail}`)
            void inst.alerts?.notify(`empty-container:${name}:${key(container.position)}`, 'В контейнере закончились расходники', detail)
          }
          for (const item of supplies) {
            check()
            const emptySlots = window.inventoryEnd - window.inventoryStart - window.items().length
            if (emptySlots <= 0) { deps.reply('[запасы] инвентарь заполнен — освободите место'); break }
            const amount = Math.min(item.count, supply[1] - count(name), emptySlots * (item.stackSize || 64))
            if (amount <= 0) break
            await transferSupply(bot, window, item, amount, signal)
          }
        } catch (error) { check(); deps.reply(`[запасы] ${error.message}`) } finally {
          signal.removeEventListener('abort', cancel)
          close(window)
        }
        if (count(name) >= supply[1]) break
      }
    } finally { if (travelled && !signal.aborted) { check(); await goPlot() } }
    deps.reply(`[запасы] ${name}: взято ${Math.max(0, count(name) - before)}, в инвентаре ${count(name)}`)
    return count(name) > before
  }
  try {
    check()
    const plots = detectPlots(bot, config.searchRadius)
    if (!plots.length) throw new Error(`не найдены 4 соседних блока земли, подзола или грязи квадратом 2×2 в радиусе ${config.searchRadius}`)
    for (const candidate of plots.slice(0, 8)) {
      plot = candidate
      try { await goPlot(); break } catch (error) { check(); plot = null }
    }
    if (!plot) throw new Error('найдены площадки 2×2, но нет доступного подхода')
    deps.reply(`[автоферма] площадка ${key(plot[0])}; запасы по табличкам ${config.mealLabel}/${config.experienceLabel}/${config.saplingLabel}`)
    await dropFarmWood(bot, signal, { species: config.species, plot, ...deps })
    await refill('experience_bottle')
    await refill(`${config.species}_sapling`)
    await refill('bone_meal')
    await farmTrees(bot, signal, { plot, species: config.species }, {
      ...deps,
      restock: async name => { await dropFarmWood(bot, signal, { species: config.species, plot, ...deps }); await refill(name) },
      afterHarvest: async () => { await dropFarmWood(bot, signal, { species: config.species, plot, ...deps }); await refill('experience_bottle') }
    })
  } catch (error) { if (signal.aborted) throw new deps.Cancelled(); throw error } finally {
    stopGuard(); bot.off('botifyDigReset', onReset)
  }
}
module.exports = { detectPlots, farmStands, signMatches, signContainer, supplyContainers, runAutoTreeFarm, cancellable, openSupplyContainer, transferSupply, shuffledSupplies }
