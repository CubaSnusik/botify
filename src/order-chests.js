'use strict'
// Chest mode of .transfer: fill the seller's inventory from nearby storage,
// one random full stack at a time, using the farm's tested container helpers.
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { transferSupply, shuffledSupplies } = require('./auto-tree-farm')
const { signLines } = require('./sign-text')
const { eyePosition, anglesFrom, viewDirection } = require('./eye-raycast')

const STORAGE = /^(chest|trapped_chest|barrel)$/
const key = p => `${p.x},${p.y},${p.z}`
const CLOCKWISE = { north: 'east', east: 'south', south: 'west', west: 'north' }
const COUNTER = { north: 'west', west: 'south', south: 'east', east: 'north' }
const OFFSET = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }

// Vanilla ChestBlock.getConnectedDirection: LEFT → clockwise of facing, RIGHT → counter-clockwise.
// The partner is accepted only if it points back, so a neighbouring double chest is never merged.
function chestPartner (bot, block) {
  const p = block.getProperties?.() || {}
  if (!/chest$/.test(block.name) || (p.type !== 'left' && p.type !== 'right')) return null
  const dir = (p.type === 'left' ? CLOCKWISE : COUNTER)[p.facing]
  if (!dir) return null
  const other = bot.blockAt(block.position.offset(...OFFSET[dir]))
  const q = other?.getProperties?.() || {}
  return other?.name === block.name && q.facing === p.facing && q.type === (p.type === 'left' ? 'right' : 'left') ? other : null
}

// The block a sign hangs on (wall sign) or stands on (standing sign).
const WALL_SUPPORT = { north: [0, 0, 1], south: [0, 0, -1], west: [1, 0, 0], east: [-1, 0, 0] }
function signSupport (bot, sign) {
  const facing = sign.getProperties?.().facing
  const offset = /wall_(?:hanging_)?sign$/.test(sign.name) ? WALL_SUPPORT[facing] : /hanging_sign$/.test(sign.name) ? [0, 1, 0] : [0, -1, 0]
  return offset ? bot.blockAt(sign.position.offset(...offset)) : null
}

/**
 * The storage wall is marked by two signs, "start" and "end". Only containers
 * inside the box spanned by the signs and the blocks they are attached to are
 * used, so the bot never wanders off to unrelated chests.
 */
function storageArea (bot, radius, labels = { start: 'start', end: 'end' }) {
  const ids = bot.registry.blocksArray.filter(b => /_sign$/.test(b.name)).map(b => b.id)
  const signs = bot.findBlocks({ matching: ids, maxDistance: radius, count: 512 }).map(p => bot.blockAt(p)).filter(Boolean)
  const labelled = label => signs.filter(s => signLines(s).some(l => l.toLowerCase() === label.toLowerCase()))
  const starts = labelled(labels.start); const ends = labelled(labels.end)
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(`нужно ровно по одной табличке «${labels.start}» и «${labels.end}» в радиусе ${radius} от продавца; ` +
      `найдено «${labels.start}»: ${starts.length}, «${labels.end}»: ${ends.length} (табличек всего ${signs.length})`)
  }
  const points = [starts[0], ends[0]].flatMap(s => [s.position, signSupport(bot, s)?.position].filter(Boolean))
  const min = { x: Math.min(...points.map(p => p.x)), y: Math.min(...points.map(p => p.y)), z: Math.min(...points.map(p => p.z)) }
  const max = { x: Math.max(...points.map(p => p.x)), y: Math.max(...points.map(p => p.y)), z: Math.max(...points.map(p => p.z)) }
  return { min, max, start: starts[0].position, end: ends[0].position }
}

const inside = (area, p) => p.x >= area.min.x && p.x <= area.max.x && p.y >= area.min.y && p.y <= area.max.y && p.z >= area.min.z && p.z <= area.max.z

function storageContainers (bot, radius, area, point) {
  const ids = bot.registry.blocksArray.filter(b => STORAGE.test(b.name)).map(b => b.id)
  const seen = new Set(); const out = []
  for (const p of bot.findBlocks({ matching: ids, maxDistance: radius, count: 4096, ...(point ? { point } : {}) })) {
    const block = bot.blockAt(p)
    if (!block || seen.has(key(p))) continue
    const partner = chestPartner(bot, block)
    const blocks = partner ? [block, partner] : [block]
    for (const b of blocks) seen.add(key(b.position))
    if (area && !blocks.some(b => inside(area, b.position))) continue
    out.push({ id: blocks.map(b => key(b.position)).sort()[0], blocks })
  }
  if (area) {
    // Walk the wall from the "start" sign towards "end": column by column
    // (horizontal distance from start), top row first within a column.
    // Measure along the wall's own axis (signs hang one block in front of it).
    const axis = Math.abs(area.end.x - area.start.x) >= Math.abs(area.end.z - area.start.z) ? 'x' : 'z'
    const along = c => Math.min(...c.blocks.map(b => Math.abs(b.position[axis] - area.start[axis])))
    out.sort((a, b) => along(a) - along(b) || b.blocks[0].position.y - a.blocks[0].position.y)
  }
  return out
}

const freeSlots = bot => (bot.currentWindow || bot.inventory).emptySlotCount()

// Containers already found empty, remembered across runs per storage wall
// (server + item + start/end signs) in data/transfer-chests.json.
const fs = require('node:fs')
const path = require('node:path')
const areaKey = (server, item, area) => `${server}|${item}|${key(area.start)}|${key(area.end)}`
function readMemory (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}
function loadEmptied (file, k) {
  const ids = readMemory(file)[k]?.emptied
  return new Set(Array.isArray(ids) ? ids : [])
}
function saveEmptied (file, k, ids) {
  const all = readMemory(file)
  if (ids) all[k] = { emptied: [...ids], updated: new Date().toISOString() }
  else delete all[k]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2))
  fs.renameSync(tmp, file)
}

// After a delivery the server re-opens menus on its own (Deliver Items, then
// the Orders page). Walking with any menu open is answered with a setback
// every few ticks, so close everything and keep closing until the server has
// stayed quiet for a while. `settle` waits for that quiet period even when
// nothing is open right now (right after a delivery).
async function closeScreens (inst, signal, { settle = false, quiet = 1200, timeout = 8000 } = {}) {
  const bot = inst.bot
  const open = () => !!bot.currentWindow || !!inst.dialog
  if (!settle && !open()) return
  const sleep = ms => require('node:timers/promises').setTimeout(ms, undefined, { signal })
  const start = Date.now()
  let quietSince = Date.now()
  while (Date.now() - start < timeout) {
    if (open()) {
      if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
      if (inst.dialog) inst.dialogClose?.()
      quietSince = Date.now()
    } else if (Date.now() - quietSince >= quiet) return
    await sleep(100)
  }
  throw new Error('сервер снова и снова открывает меню — не могу его закрыть')
}

// The same ray test the opener uses (tree-farm farmRay), but from any eye position.
const RAY_AIR = new Set(['air', 'cave_air', 'void_air'])
// Outline shapes the server's interaction ray uses for blocks without collision.
// Vanilla WallSignBlock / StandingSignBlock; signs hang on the chests' faces,
// so treating them as full cubes hid those chests completely.
const WALL_SIGN = {
  north: [0, 4.5 / 16, 14 / 16, 1, 12.5 / 16, 1],
  south: [0, 4.5 / 16, 0, 1, 12.5 / 16, 2 / 16],
  east: [0, 4.5 / 16, 0, 2 / 16, 12.5 / 16, 1],
  west: [14 / 16, 4.5 / 16, 0, 1, 12.5 / 16, 1]
}
function outline (block) {
  if (/(?<!hanging)_wall_sign$/.test(block.name) || block.name === 'wall_sign') {
    const shape = WALL_SIGN[block.getProperties?.().facing]
    if (shape) return [shape]
  } else if (/_sign$/.test(block.name) && !/hanging/.test(block.name)) {
    return [[0.25, 0, 0.25, 0.75, 1, 0.75]]
  }
  return block.shapes?.length ? block.shapes : [[0, 0, 0, 1, 1, 1]]
}

const rayFrom = (bot, eye, point) => rayDir(bot, eye, point.minus(eye).normalize())
function rayDir (bot, eye, dir) {
  return bot.world.raycast(eye, dir, 4.5, (block, ray) => {
    if (RAY_AIR.has(block.name)) return false
    const hit = ray.intersect(outline(block), block.position)
    if (!hit) return false
    block.face = hit.face; block.intersect = hit.pos
    return true
  })
}
const sees = (bot, eye, block) => facePoints(block, eye).some(({ point }) => rayFrom(bot, eye, point)?.position.equals(block.position))
const passable = b => !!b && b.boundingBox === 'empty' && !/^(water|lava|bubble_column)$/.test(b.name)

/**
 * Cells the bot can stand in (solid floor, two free blocks) from which the
 * container is clickable by the same ray test the opener uses — so the bot
 * never walks to a spot the pathfinder likes but the opener can't use.
 */
function standCells (bot, blocks, from) {
  const out = []; const seen = new Set()
  for (const target of blocks) {
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -3; dy <= 1; dy++) {
      const p = target.position.offset(dx, dy, dz)
      if (seen.has(key(p))) continue
      seen.add(key(p))
      const floor = bot.blockAt(p.offset(0, -1, 0))
      // Real floor only — never climb onto the storage wall itself.
      if (floor?.boundingBox !== 'block' || STORAGE.test(floor.name)) continue
      if (!passable(bot.blockAt(p)) || !passable(bot.blockAt(p.offset(0, 1, 0)))) continue
      const eye = p.offset(0.5, 1.62, 0.5)
      if (eye.distanceTo(target.position.offset(0.5, 0.5, 0.5)) > 4.2) continue
      if (blocks.some(b => sees(bot, eye, b))) out.push(p)
    }
  }
  return out.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(from) - b.offset(0.5, 0, 0.5).distanceTo(from))
}

// Points on every face of the block's real shape that face the eye (3×3 grid
// per face), each with the protocol face number. A chest is 1/16 smaller than
// a full block on the sides and 1/8 lower — aiming at the full cube misses it.
const FACES = [
  { face: 0, axis: 'y', side: 0 }, { face: 1, axis: 'y', side: 1 },
  { face: 2, axis: 'z', side: 0 }, { face: 3, axis: 'z', side: 1 },
  { face: 4, axis: 'x', side: 0 }, { face: 5, axis: 'x', side: 1 }
]
function facePoints (block, eye) {
  const [x0, y0, z0, x1, y1, z1] = block.shapes?.[0] || [0, 0, 0, 1, 1, 1]
  const lo = { x: x0, y: y0, z: z0 }; const hi = { x: x1, y: y1, z: z1 }
  const p = block.position; const out = []
  for (const { face, axis, side } of FACES) {
    const plane = p[axis] + (side ? hi[axis] : lo[axis])
    if (side ? eye[axis] <= plane : eye[axis] >= plane) continue // face points away from the eye
    const [a, b] = ['x', 'y', 'z'].filter(k => k !== axis)
    // Centre first, then towards the edges (a sign may cover the middle band).
    for (const u of [0.5, 0.25, 0.75, 0.1, 0.9]) for (const v of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const point = { [axis]: plane + (side ? -0.001 : 0.001) }
      point[a] = p[a] + lo[a] + (hi[a] - lo[a]) * u
      point[b] = p[b] + lo[b] + (hi[b] - lo[b]) * v
      out.push({ face, point: new Vec3(point.x, point.y, point.z) })
    }
  }
  return out
}

// Aim points that the eye really reaches on this block (same ray rules as the opener).
function visiblePoints (bot, eye, block) {
  return facePoints(block, eye).filter(({ point }) => {
    const hit = rayFrom(bot, eye, point)
    return hit?.position.equals(block.position)
  })
}

/**
 * Open a container like a player: turn to a point the eye really sees, check
 * the view ray after the turn, then one use-item-on packet (vanilla.js adds
 * the sequence) and the arm swing. No held item is needed — unlike
 * mineflayer's _genericPlace, which refuses with an empty hand.
 * Returns the window, or { reason } when the container isn't usable from here.
 */
async function openContainerHere (bot, blocks, signal, look) {
  let reason = 'не видно ни одной точки сундука'
  for (const block of blocks) {
    const eye = eyePosition(bot.entity)
    const points = visiblePoints(bot, eye, block)
    if (!points.length) {
      const blocker = blockerFrom(bot, eye, block.position)
      if (blocker) reason = `не видно; луч упирается в ${blocker}`
      continue
    }
    for (const { point } of points.slice(0, 3)) {
      const angles = anglesFrom(eye, point)
      let turned = await look(angles.yaw, angles.pitch, () => signal.aborted)
      if (!turned && !signal.aborted) turned = await look(angles.yaw, angles.pitch, () => signal.aborted)
      if (signal.aborted) throw new Error('операция отменена')
      if (!turned) { reason = 'поворот головы прерван (сервер поправил позицию или взгляд)'; continue }
      // What the server will see: the ray along the view we actually sent.
      const view = rayDir(bot, eyePosition(bot.entity), viewDirection(bot.entity.yaw, bot.entity.pitch))
      if (!view?.position.equals(block.position)) {
        reason = `после поворота взгляд упирается в ${view ? `${view.name} @ ${key(view.position)}` : 'пустоту'}`
        continue
      }
      return await new Promise((resolve, reject) => {
        const finish = (error, window) => {
          clearTimeout(timer); bot.off('windowOpen', opened); signal.removeEventListener('abort', cancel)
          error ? reject(error) : resolve(window)
        }
        const opened = window => {
          if (!/^minecraft:(generic|container|chest|barrel|shulker_box)/.test(window.type) || !Number.isInteger(window.inventoryStart)) {
            finish(new Error(`сервер открыл неподходящее окно ${window.type}`)); return
          }
          finish(null, window)
        }
        const cancel = () => finish(new Error('операция отменена'))
        const timer = setTimeout(() => finish(new Error('сервер не открыл сундук за 5 секунд')), 5000)
        bot.on('windowOpen', opened)
        signal.addEventListener('abort', cancel, { once: true })
        bot.setControlState?.('sneak', false) // sneaking would place the held item instead
        bot._client.write('block_place', {
          hand: 0,
          location: view.position,
          direction: view.face,
          cursorX: view.intersect.x - view.position.x,
          cursorY: view.intersect.y - view.position.y,
          cursorZ: view.intersect.z - view.position.z,
          insideBlock: false,
          worldBorderHit: false,
          sequence: 0 // replaced with the world's prediction sequence in vanilla.js
        })
        bot.swingArm?.('right')
      })
    }
  }
  return { reason }
}

// "Луч упирается в …" — what is in the way, for the log.
function blockerFrom (bot, eye, position) {
  const hit = rayFrom(bot, eye, position.offset(0.5, 0.5, 0.5))
  return hit && !hit.position.equals(position) ? `${hit.name} @ ${key(hit.position)}` : null
}

const MAX_ATTEMPTS = 2 // a container that failed to open gets one more try per run
const NO_PATH = /путь не найден|пути туда нет/i

function areaContainers (bot, area, radius) {
  // Search around the area itself, not the bot, so walking along the wall
  // never drops or adds containers.
  const point = area && new Vec3((area.min.x + area.max.x) / 2, (area.min.y + area.max.y) / 2, (area.min.z + area.max.z) / 2)
  const span = area ? Math.ceil(Math.hypot(area.max.x - area.min.x, area.max.y - area.min.y, area.max.z - area.min.z) / 2) + 2 : radius
  return storageContainers(bot, span, area, point)
}

/**
 * Walk to the next not-yet-emptied container (from "start" to "end") and take
 * full stacks of `item` until the inventory has no empty slot or nothing is
 * left. `emptied` persists across runs; `skipped` (id → failed attempts) only
 * for this run — a container that couldn't be opened may still hold items.
 */
async function fillFromStorage ({ inst, item, radius, area, emptied, skipped = new Map(), signal, check, walk, look, reply }) {
  const bot = inst.bot
  const count = () => (bot.currentWindow || bot.inventory).items().filter(i => i.name === item).reduce((n, i) => n + i.count, 0)
  const before = count()
  const fail = (c, reason) => {
    skipped.set(c.id, (skipped.get(c.id) || 0) + 1)
    reply(`[transfer] не смог взять из ${c.id}: ${reason}` + (skipped.get(c.id) < MAX_ATTEMPTS ? ' — попробую ещё раз в конце' : ' — пропускаю'), 'err')
  }
  while (freeSlots(bot) > 0) {
    check()
    const open = areaContainers(bot, area, radius).filter(c => !emptied.has(c.id) && (skipped.get(c.id) || 0) < MAX_ATTEMPTS)
    // Untried containers first (in start→end order), failed ones get their retry last.
    const list = open.filter(c => !skipped.has(c.id)).concat(open.filter(c => skipped.has(c.id)))
    const here = bot.entity.position
    const next = area ? list[0] : list.sort((a, b) => a.blocks[0].position.distanceTo(here) - b.blocks[0].position.distanceTo(here))[0]
    if (!next) return { taken: count() - before, exhausted: true }
    await closeScreens(inst, signal)
    check()
    let window
    try {
      if (bot.inventory.selectedItem) throw new Error('на курсоре предмет — уберите его')
      const fresh = () => next.blocks.map(b => bot.blockAt(b.position)).filter(b => b && STORAGE.test(b.name))
      if (!fresh().length) throw new Error('контейнер исчез')
      // From where the bot stands now first (checked from its real eyes, not
      // a cell centre), then from up to three floor cells that see the chest.
      let result = await openContainerHere(bot, fresh(), signal, look)
      if (!result || result.reason) {
        const cells = standCells(bot, fresh(), bot.entity.position).filter(c => !bot.entity.position.floored().equals(c))
        if (!cells.length && result?.reason) throw new Error(`нет места на полу, откуда его видно; отсюда: ${result.reason}`)
        for (const cell of cells.slice(0, 3)) {
          try {
            await walk(new goals.GoalBlock(cell.x, cell.y, cell.z), cell)
          } catch (error) {
            check()
            // Only "no path" is the spot's fault; a stuck or corrected bot would
            // otherwise "skip" every remaining chest in a row.
            if (!NO_PATH.test(error.message)) throw Object.assign(new Error(`не дошёл до сундука ${next.id}: ${error.message}`), { fatal: true })
            continue
          }
          check()
          result = await openContainerHere(bot, fresh(), signal, look)
          if (!result.reason) break
        }
      }
      if (result.reason) throw new Error(result.reason)
      window = result
      skipped.delete(next.id)
      check()
      for (const stack of shuffledSupplies(window, item)) {
        check()
        if (window.emptySlotCount() <= 0) break
        await transferSupply(bot, window, stack, stack.count, signal)
      }
      if (!window.containerItems().some(i => i.name === item)) emptied.add(next.id)
    } catch (error) {
      check()
      if (error.fatal) throw error
      fail(next, error.message)
    } finally {
      if (window && bot.currentWindow === window) await bot.closeWindow(window)
    }
  }
  return { taken: count() - before, exhausted: false }
}

// What is left of the wall: for the final report.
function areaSummary (bot, area, radius, emptied, skipped) {
  const all = areaContainers(bot, area, radius)
  const failed = all.filter(c => !emptied.has(c.id) && (skipped.get(c.id) || 0) >= MAX_ATTEMPTS).map(c => c.id)
  return { total: all.length, emptied: all.filter(c => emptied.has(c.id)).length, unchecked: all.length - all.filter(c => emptied.has(c.id)).length - failed.length, failed }
}

module.exports = { chestPartner, signSupport, storageArea, storageContainers, standCells, facePoints, visiblePoints, openContainerHere, outline, fillFromStorage, closeScreens, areaSummary, areaKey, loadEmptied, saveEmptied }
