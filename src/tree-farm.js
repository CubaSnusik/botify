'use strict'
const { Vec3 } = require('vec3')
const { eyePosition, viewDirection, anglesFrom } = require('./eye-raycast')
const { findAxe, aimPoints, REACH } = require('./tree-chopper')
const { createFarmHotbar } = require('./farm-hotbar')
const { dropFarmWood } = require('./farm-wood')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const SOIL = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mycelium', 'moss_block', 'mud'])
const SPECIES = ['spruce', 'jungle', 'dark_oak', 'pale_oak']
const key = p => `${p.x},${p.y},${p.z}`
const aborted = () => new Error('ферма остановлена')

function plotFromCursor (bot, hit = bot.blockAtCursor(REACH)) {
  if (!hit) throw new Error('наведи прицел на землю площадки 2×2')
  const selected = /_sapling$/.test(hit.name) ? hit.position.offset(0, -1, 0) : hit.position.clone()
  // An isolated raised bed has exactly four connected soil blocks at this Y.
  // Recognize it from any corner/side; never include the lower surrounding floor.
  const connected = []; const seen = new Set(); const queue = [selected]
  while (queue.length && connected.length <= 4) {
    const p = queue.shift()
    if (seen.has(key(p))) continue
    seen.add(key(p))
    if (!SOIL.has(bot.blockAt(p)?.name)) continue
    connected.push(p)
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) queue.push(p.offset(x, 0, z))
  }
  let corner = selected
  if (connected.length <= 4) {
    const xs = connected.map(p => p.x); const zs = connected.map(p => p.z)
    if (connected.length !== 4 || Math.max(...xs) - Math.min(...xs) !== 1 || Math.max(...zs) - Math.min(...zs) !== 1) {
      throw new Error('площадка должна состоять из четырёх блоков земли квадратом 2×2 на одной высоте')
    }
    corner = new Vec3(Math.min(...xs), selected.y, Math.min(...zs))
  }
  // On a continuous flat field retain the explicit +X/+Z corner convention.
  const plot = [corner, corner.offset(1, 0, 0), corner.offset(0, 0, 1), corner.offset(1, 0, 1)]
  for (const p of plot) {
    const ground = bot.blockAt(p)
    if (!ground || !SOIL.has(ground.name)) throw new Error(`для посадки нужна земля во всех четырёх местах; проверь ${key(p)}`)
    if (eyePosition(bot.entity).distanceTo(p.offset(0.5, 1, 0.5)) > REACH) throw new Error(`угол ${key(p)} вне досягаемости — встань ближе к площадке`)
  }
  return plot
}

const rememberedPlots = new WeakMap()
function selectFarmPlot (bot) {
  const hit = bot.blockAtCursor(REACH)
  const usable = plot => plot.every(p => SOIL.has(bot.blockAt(p)?.name) && eyePosition(bot.entity).distanceTo(p.offset(0.5, 1, 0.5)) <= REACH)
  let plot
  if (hit && (SOIL.has(hit.name) || /_sapling$/.test(hit.name))) plot = plotFromCursor(bot, hit)
  else {
    const saved = rememberedPlots.get(bot)
    if (saved?.dimension === bot.game.dimension && usable(saved.plot)) plot = saved.plot
    if (!plot) {
      // A canopy may hide the soil on the very first start. Only infer an
      // unambiguous isolated bed; never pick a random square on a flat field.
      const beds = new Map(); const center = bot.entity.position.floored()
      for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = -3; y <= 2; y++) {
        const p = center.offset(x, y, z)
        if (!SOIL.has(bot.blockAt(p)?.name)) continue
        const square = [p, p.offset(1, 0, 0), p.offset(0, 0, 1), p.offset(1, 0, 1)]
        if (!usable(square)) continue
        const members = new Set(square.map(key))
        if (square.some(s => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
          const n = s.offset(dx, 0, dz)
          return !members.has(key(n)) && SOIL.has(bot.blockAt(n)?.name)
        }))) continue
        beds.set(key(p), square)
      }
      if (beds.size === 1) plot = [...beds.values()][0]
    }
  }
  if (!plot) throw new Error('не удалось однозначно выбрать площадку — наведи прицел на её землю или саженец')
  rememberedPlots.set(bot, { dimension: bot.game.dimension, plot })
  return plot
}

function chooseSpecies (bot, plot, requested = '') {
  const explicit = requested.replace(/^minecraft:/, '').replace(/_sapling$/, '')
  const planted = new Set(plot.map(p => bot.blockAt(p.offset(0, 1, 0))?.name)
    .filter(n => /_(sapling|log)$/.test(n || '')).map(n => n.replace(/_(sapling|log)$/, '')))
  if (planted.size > 1) throw new Error('на площадке смешаны разные виды деревьев')
  const existing = [...planted][0]
  const held = bot.heldItem?.name?.replace(/_sapling$/, '')
  const available = SPECIES.filter(s => bot.inventory.items().some(i => i.name === `${s}_sapling`))
  const species = explicit || existing || (SPECIES.includes(held) ? held : available.length === 1 ? available[0] : null)
  if (!SPECIES.includes(species)) throw new Error('укажи вид: .tree farm spruce|jungle|dark_oak|pale_oak (или возьми нужный саженец в руку)')
  if (existing && existing !== species) throw new Error('вид саженца не совпадает с деревом на площадке')
  return species
}

// Collision shapes omit saplings. For placement, conservatively treat non-air
// blocks without collision as occupied too; never click through a nearby sapling.
function farmRay (bot, yaw, pitch, saplingOutline = false) {
  return bot.world.raycast(eyePosition(bot.entity), viewDirection(yaw, pitch), REACH, (block, ray) => {
    if (AIR.has(block.name)) return false
    // SaplingBlock.getShape in vanilla 26.1 is Block.column(12, 0, 12).
    // Use its outline when applying bone meal, not an imaginary full-cube face.
    const shapes = saplingOutline && /_sapling$/.test(block.name)
      ? [[0.125, 0, 0.125, 0.875, 0.75, 0.875]]
      : block.shapes?.length ? block.shapes : [[0, 0, 0, 1, 1, 1]]
    const hit = ray.intersect(shapes, block.position)
    if (!hit) return false
    block.face = hit.face
    block.intersect = hit.pos
    return true
  })
}

function nearestSapling (bot, plot, species, random = Math.random) {
  const eye = eyePosition(bot.entity)
  const positions = plot.map(p => p.offset(0, 1, 0))
    .sort((a, b) => a.offset(0.5, 0.375, 0.5).distanceTo(eye) - b.offset(0.5, 0.375, 0.5).distanceTo(eye))
  for (const position of positions) {
    if (bot.blockAt(position)?.name !== `${species}_sapling`) continue
    const points = Array.from({ length: 8 }, () => position.offset(0.3 + random() * 0.4, 0.25 + random() * 0.35, 0.3 + random() * 0.4))
    points.push(position.offset(0.5, 0.375, 0.5))
    for (const point of points) {
      const angles = anglesFrom(eye, point)
      const hit = farmRay(bot, angles.yaw, angles.pitch, true)
      if (hit?.position.equals(position)) return { position, ...angles }
    }
  }
  return null
}

const FACE_VECTORS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]

function canopyLeaf (block, species) {
  if (block?.name !== `${species}_leaves` || !block.diggable) return false
  const persistent = block.getProperties?.().persistent
  return persistent !== true && persistent !== 'true'
}

// Only clear natural leaves intersecting the space needed to stand up. Include
// both columns when the player's 0.6-wide body straddles a block boundary.
function headroomTarget (bot, species, random = Math.random) {
  const feet = bot.entity.position
  const eye = eyePosition(bot.entity)
  const candidates = []
  for (let x = Math.floor(feet.x - 0.299); x <= Math.floor(feet.x + 0.299); x++) {
    for (let z = Math.floor(feet.z - 0.299); z <= Math.floor(feet.z + 0.299); z++) {
      for (let y = Math.floor(feet.y + 0.6); y < Math.ceil(feet.y + 1.8); y++) {
        const block = bot.blockAt(new Vec3(x, y, z))
        if (canopyLeaf(block, species)) candidates.push(block)
      }
    }
  }
  candidates.sort((a, b) => a.position.distanceTo(eye) - b.position.distanceTo(eye))
  for (const block of candidates) {
    for (const point of aimPoints(eye, block.position, random)) {
      const angles = anglesFrom(eye, point)
      const hit = farmRay(bot, angles.yaw, angles.pitch)
      if (hit?.position.equals(block.position)) return { block, ...angles }
    }
  }
  return null
}

function leafOnRay (bot, points, species) {
  for (const point of points) {
    const angles = anglesFrom(eyePosition(bot.entity), point)
    const hit = farmRay(bot, angles.yaw, angles.pitch)
    if (canopyLeaf(hit, species)) return { block: hit, ...angles }
  }
  return null
}

// Minecraft.startUseItem sets rightClickDelay=4. Bone meal is a repeated use-on-
// block action, not a charged item that activateItem/deactivateItem can hold.
function growSaplings (bot, plot, species, target, signal, warn = () => {}) {
  return new Promise((resolve, reject) => {
    const positions = plot.map(p => p.offset(0, 1, 0))
    const keys = new Set(positions.map(key))
    let cooldown = 0; let done = false; let pending = false
    let lastSent = Date.now(); let nextGrowthWarning = lastSent + 10000; let packets = 0
    const finish = (error, result) => {
      if (done) return
      done = true
      clearInterval(watchdog)
      bot.off('physicsTick', tick)
      bot.off('blockUpdate', update)
      bot.off('botifyDigReset', reset)
      bot.off('botifyPlacePacket', sent)
      signal.removeEventListener('abort', cancel)
      error ? reject(error) : resolve(result)
    }
    const checkPlot = () => {
      const blocks = positions.map(p => bot.blockAt(p))
      if (blocks.some(b => b?.name === `${species}_log`)) { finish(null, 'grown'); return false }
      if (blocks.some(b => b?.name !== `${species}_sapling`)) { finish(null, 'changed'); return false }
      return true
    }
    const update = (_old, block) => { if (block && keys.has(key(block.position))) checkPlot() }
    const cancel = () => finish(aborted())
    const reset = () => finish(new Error('соединение или мир изменились'))
    const sent = packet => {
      if (packet.itemName === 'bone_meal' && target.equals(packet.location)) {
        packets++
        lastSent = Date.now()
      }
    }
    const failed = error => {
      if (done) return
      warn(`[проверка] костная мука: ошибка отправки применения — ${error.message}`)
      finish(error)
    }
    const watchdog = setInterval(() => {
      if (done) return
      if (Date.now() - lastSent >= 5000) {
        const error = new Error('применение костной муки не передаётся в транспорт уже 5 секунд — ферма остановлена')
        warn(`[проверка] ${error.message}; это сбой отправки, не подтверждённый флаг сервера`)
        finish(error)
      } else if (Date.now() >= nextGrowthWarning) {
        warn(`[проверка] костная мука: отправлено применений ${packets}, но сервер ещё не показал рост. Возможны условия роста, задержка или защита; флаг не подтверждён`)
        nextGrowthWarning = Date.now() + 30000
      }
    }, 1000)
    const tick = () => {
      if (done) return
      try {
        if (signal.aborted) return cancel()
        if (!checkPlot()) return
        if (bot.heldItem?.name !== 'bone_meal' || bot.heldItem.count <= 0) return finish(null, 'empty')
        if (bot.currentWindow || bot.inventory.selectedItem) throw new Error('взращивание остановлено: открыт инвентарь')
        const hit = farmRay(bot, bot.entity.yaw, bot.entity.pitch, true)
        if (!hit?.position.equals(target) || hit.name !== `${species}_sapling`) {
          warn('[проверка] костная мука: пакет не отправлен — саженец перекрыт или прицел сместился; навожусь заново')
          return finish(null, 'aim')
        }
        if (pending) return
        if (cooldown > 0 && --cooldown > 0) return
        cooldown = 4
        pending = true
        Promise.resolve(bot._genericPlace(hit, FACE_VECTORS[hit.face], {
          forceLook: 'ignore', delta: hit.intersect.minus(hit.position), swingArm: 'right'
        })).then(() => { pending = false }, failed)
      } catch (error) { failed(error) }
    }
    bot.on('physicsTick', tick)
    bot.on('blockUpdate', update)
    bot.on('botifyDigReset', reset)
    bot.on('botifyPlacePacket', sent)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

function plantingOrder (bot, plot, random = Math.random) {
  const eye = eyePosition(bot.entity)
  return plot.map(position => ({ position, distance: eye.distanceTo(position.offset(0.5, 1, 0.5)), tie: random() }))
    .sort((a, b) => b.distance - a.distance || a.tie - b.tie).map(e => e.position)
}

function plantingAim (bot, ground, random = Math.random) {
  const eye = eyePosition(bot.entity)
  const points = Array.from({ length: 10 }, () => ground.offset(0.18 + random() * 0.64, 0.999, 0.18 + random() * 0.64))
  points.push(ground.offset(0.5, 0.999, 0.5))
  for (const point of points) {
    const angles = anglesFrom(eye, point)
    const hit = farmRay(bot, angles.yaw, angles.pitch)
    if (hit?.position.equals(ground) && hit.face === 1) return angles
  }
  return null
}

function waitTicks (bot, signal, count) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      bot.off('physicsTick', tick)
      bot.off('botifyDigReset', reset)
      signal.removeEventListener('abort', cancel)
      error ? reject(error) : resolve()
    }
    const tick = () => { if (--count <= 0) finish() }
    const cancel = () => finish(aborted())
    const reset = () => finish(new Error('соединение или мир изменились'))
    bot.on('physicsTick', tick)
    bot.on('botifyDigReset', reset)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

// Install confirmation/cancellation listeners BEFORE the write, and send exactly
// once on a physics tick. Cursor coordinates come from the final transmitted view.
function placeSapling (bot, ground, species, signal) {
  return new Promise((resolve, reject) => {
    const dest = ground.offset(0, 1, 0)
    const expected = new Set([`${species}_sapling`, `${species}_log`])
    let sent = false; let done = false; let timer
    const finish = error => {
      if (done) return
      done = true
      clearTimeout(timer)
      bot.off('physicsTick', send)
      bot.off('blockUpdate', update)
      bot.off('botifyDigReset', reset)
      signal.removeEventListener('abort', cancel)
      error ? reject(error) : resolve()
    }
    const update = (_old, block) => {
      if (sent && block?.position.equals(dest) && expected.has(block.name)) finish()
    }
    const cancel = () => finish(aborted())
    const reset = () => finish(new Error('соединение или мир изменились'))
    const send = () => {
      if (sent || done) return
      try {
        if (signal.aborted) return cancel()
        const target = bot.blockAt(dest)
        if (expected.has(target?.name)) return finish()
        const reference = bot.blockAt(ground)
        if (!AIR.has(target?.name) || !SOIL.has(reference?.name)) throw new Error('место посадки занято или земля изменилась')
        if (bot.heldItem?.name !== `${species}_sapling` || bot.currentWindow || bot.inventory.selectedItem) throw new Error('саженец не в руке или открыт инвентарь')
        const hit = farmRay(bot, bot.entity.yaw, bot.entity.pitch)
        if (!hit?.position.equals(ground) || hit.face !== 1) throw new Error('место посадки перекрыто или прицел сместился')
        sent = true
        timer = setTimeout(() => finish(new Error('сервер не подтвердил посадку за 5 секунд')), 5000)
        Promise.resolve(bot._genericPlace(reference, new Vec3(0, 1, 0), {
          forceLook: 'ignore', delta: hit.intersect.minus(ground), swingArm: 'right'
        })).catch(finish)
      } catch (error) { finish(error) }
    }
    bot.on('physicsTick', send)
    bot.on('blockUpdate', update)
    bot.on('botifyDigReset', reset)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

async function farmTrees (bot, signal, { plot, species, random = Math.random }, deps) {
  const { look, dig, reply } = deps
  let ended = false
  const checkCancel = signal => {
    deps.checkCancel(signal)
    if (ended) throw new Error('соединение или мир изменились')
  }
  const pause = async (min, max = min) => {
    checkCancel(signal)
    await waitTicks(bot, signal, min + Math.floor(random() * (max - min + 1)))
    checkCancel(signal)
  }
  const logName = `${species}_log`; const saplingName = `${species}_sapling`
  if (!findAxe(bot)) throw new Error('нет Shard Axe в инвентаре')
  if (['adventure', 'spectator'].includes(bot.game.gameMode)) throw new Error('в этом режиме нельзя выращивать и рубить деревья')
  let origin = bot.entity.position.clone()
  const reset = () => { ended = true }
  bot.on('botifyDigReset', reset)
  let lastState = ''; let trees = 0; let lastWoodCheck = -Infinity
  const state = text => { if (lastState !== text) { lastState = text; reply(text) } }
  const warningTimes = new Map()
  const warn = text => {
    const category = text.split(':')[0]
    if (Date.now() - (warningTimes.get(category) ?? -Infinity) < 5000) return
    warningTimes.set(category, Date.now())
    reply(text)
  }
  const hotbar = createFarmHotbar(bot, species, { checkCancel: () => checkCancel(signal), wait: n => pause(n), reply })
  const clearLeaf = async (target, message) => {
    if (!target) return false
    await hotbar.select('axe')
    const changed = () => signal.aborted || !canopyLeaf(bot.blockAt(target.block.position), species)
    if (!await look(target.yaw, target.pitch, changed)) return false
    checkCancel(signal)
    await hotbar.select('axe')
    const hit = farmRay(bot, bot.entity.yaw, bot.entity.pitch)
    if (!hit?.position.equals(target.block.position) || !canopyLeaf(hit, species)) return false
    state(message)
    await dig(hit, hit.face)
    await pause(5, 8)
    return true
  }
  reply(`ферма 2×2: ${key(plot[0])} → ${key(plot[3])}, ${saplingName}; .stop — остановить`)
  try {
    while (true) {
      checkCancel(signal)
      if (Date.now() - lastWoodCheck >= 5000) {
        await dropFarmWood(bot, signal, { species, plot, look, reply, checkCancel })
        lastWoodCheck = Date.now()
        checkCancel(signal)
      }
      if (Math.hypot(bot.entity.position.x - origin.x, bot.entity.position.z - origin.z) > 0.8) throw new Error('бот сместился с места фермы — запусти .tree farm заново')
      for (const p of plot) if (!SOIL.has(bot.blockAt(p)?.name)) throw new Error(`земля площадки изменилась: ${key(p)}`)
      const bases = plot.map(p => bot.blockAt(p.offset(0, 1, 0)))
      if (bases.some(b => !b)) throw new Error('чанк площадки не загружен')
      const overhead = headroomTarget(bot, species, random)
      if (overhead) {
        const axe = findAxe(bot)
        if (!axe) throw new Error('Shard Axe пропал из инвентаря')
        await hotbar.select('axe')
        checkCancel(signal)
        const changed = () => signal.aborted || !canopyLeaf(bot.blockAt(overhead.block.position), species)
        if (!await look(overhead.yaw, overhead.pitch, changed)) continue
        checkCancel(signal)
        await hotbar.select('axe')
        const hit = farmRay(bot, bot.entity.yaw, bot.entity.pitch)
        if (!hit?.position.equals(overhead.block.position) || !canopyLeaf(hit, species)) continue
        state('листва мешает встать — расчищаю над головой, затем продолжу ферму')
        await dig(hit, hit.face)
        await pause(5, 8)
        continue
      }
      const logs = bases.filter(b => b.name === logName)
      if (logs.length) {
        const axe = findAxe(bot)
        if (!axe) throw new Error('Shard Axe пропал из инвентаря')
        await hotbar.select('axe')
        checkCancel(signal)
        let target = null; let leafObstacle = null
        for (const block of logs.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))) {
          for (const aim of aimPoints(eyePosition(bot.entity), block.position, random).reverse()) {
            const angles = anglesFrom(eyePosition(bot.entity), aim)
            const hit = farmRay(bot, angles.yaw, angles.pitch)
            if (hit?.position.equals(block.position)) { target = { block, ...angles }; break }
            if (!leafObstacle && canopyLeaf(hit, species)) leafObstacle = { block: hit, ...angles }
          }
          if (target) break
        }
        target ??= leafObstacle
        if (!target) { state('ствол перекрыт — жду свободную линию прицела'); await pause(8, 12); continue }
        const targetName = target.block.name
        const cancelled = () => signal.aborted || bot.blockAt(target.block.position)?.name !== targetName
        if (!await look(target.yaw, target.pitch, cancelled)) continue
        checkCancel(signal)
        await hotbar.select('axe')
        const hit = farmRay(bot, bot.entity.yaw, bot.entity.pitch)
        if (!hit?.position.equals(target.block.position) || hit.name !== targetName) continue
        if (targetName !== logName) state('листва перекрывает ствол — расчищаю прицел')
        await dig(hit, hit.face)
        if (targetName === logName) {
          state(`срублено стволов: ${++trees} — освобождаю площадку`)
          if (deps.afterHarvest) { await deps.afterHarvest(); origin = bot.entity.position.clone(); checkCancel(signal) }
        }
        await pause(5, 8)
        continue
      }
      const blocked = bases.find(b => !AIR.has(b.name) && b.name !== saplingName)
      if (blocked) {
        if (canopyLeaf(blocked, species) && await clearLeaf(leafOnRay(bot,
          aimPoints(eyePosition(bot.entity), blocked.position, random), species), 'листва заняла место посадки — расчищаю топором')) continue
        state(`площадка занята: ${blocked.name}; жду освобождения`); await pause(10, 16); continue
      }
      const empty = plantingOrder(bot, plot, random).filter(p => AIR.has(bot.blockAt(p.offset(0, 1, 0))?.name))
      if (!empty.length) {
        const meal = bot.inventory.items().find(i => i.name === 'bone_meal' && i.count > 0)
        if (!meal) {
          state('4 саженца посажены; закончилась костная мука — жду пополнения или роста')
          if (deps.restock) { await deps.restock('bone_meal'); origin = bot.entity.position.clone(); checkCancel(signal) }
          await pause(10, 16); continue
        }
        const target = nearestSapling(bot, plot, species, random)
        if (!target) {
          if (await clearLeaf(leafOnRay(bot, plot.map(p => p.offset(0.5, 1.375, 0.5)), species), 'листва закрыла саженцы — расчищаю топором')) continue
          state('саженцы перекрыты — жду свободную линию прицела'); await pause(8, 12); continue
        }
        await hotbar.select('meal')
        checkCancel(signal)
        const changed = () => signal.aborted || plot.some(p => bot.blockAt(p.offset(0, 1, 0))?.name !== saplingName)
        if (!await look(target.yaw, target.pitch, changed)) continue
        checkCancel(signal)
        await hotbar.select('meal')
        state('взращиваю ближайший саженец костной мукой — удерживаю ПКМ до роста')
        await growSaplings(bot, plot, species, target.position, signal, warn)
        continue
      }
      const sapling = bot.inventory.items().find(i => i.name === saplingName && i.count > 0)
      if (!sapling) {
        state(`закончились ${saplingName} — жду пополнения`)
        if (deps.restock) { await deps.restock(saplingName); origin = bot.entity.position.clone(); checkCancel(signal) }
        await pause(20, 30); continue
      }
      const ground = empty[0] // Never fill a nearer hole ahead of an obstructed farther one.
      const aim = plantingAim(bot, ground, random)
      if (!aim) {
        const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25]].map(([x, z]) => ground.offset(x, 0.999, z))
        if (await clearLeaf(leafOnRay(bot, points, species), 'листва закрыла землю — расчищаю топором')) continue
        state(`место ${key(ground)} перекрыто — жду, через блоки не ставлю`); await pause(8, 12); continue
      }
      await hotbar.select('sapling')
      checkCancel(signal)
      const changed = () => signal.aborted || !AIR.has(bot.blockAt(ground.offset(0, 1, 0))?.name)
      if (!await look(aim.yaw, aim.pitch, changed)) continue
      checkCancel(signal)
      await hotbar.select('sapling')
      try {
        await placeSapling(bot, ground, species, signal)
        lastState = ''
      } catch (error) {
        checkCancel(signal)
        warn(`[проверка] посадка: ${error.message}. Возможны рассинхронизация, задержка или защита; флаг не подтверждён — повторю после паузы`)
        await pause(10, 16)
        continue
      }
      await pause(4, 6)
    }
  } catch (error) {
    if (signal.aborted) throw new deps.Cancelled()
    throw error
  } finally {
    bot.off('botifyDigReset', reset)
  }
}

module.exports = { plotFromCursor, selectFarmPlot, chooseSpecies, farmRay, plantingOrder, plantingAim, placeSapling, nearestSapling, growSaplings, headroomTarget, farmTrees }
