'use strict'
/*
 * Tree chopping with a Donut SMP "shard axe": breaking ANY log of a tree fells the whole tree
 * server-side, so the bot only has to land one legit break per tree.
 *
 * Loop (stationary — the bot stays where it was put):
 *   1. scan logs within reach that belong to a natural tree (natural, non-persistent leaves);
 *   2. pick an aim point on a face the eyes can see, preferring a clean line of sight and
 *      the smallest head movement;
 *   3. if the ray from the eyes hits something else first, that obstacle is the target
 *      (broken with the same shard axe), then the loop continues with the tree;
 *   4. humanized turn (minimum-jerk, see smooth-look.js), verify the crosshair, dig;
 *   5. a block the server does not confirm ("ghost") is simply broken again.
 */
const { Vec3 } = require('vec3')
const { anglesFrom, eyePosition, viewDirection } = require('./eye-raycast')
const { textOf } = require('./screens')
const { equipDigTool } = require('./dig-tool')

const REACH = 4.5
const DEG = Math.PI / 180
const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI

const isLog = name => /_(log|stem)$/.test(name || '') && name !== 'mushroom_stem'
const isLeaves = name => /_leaves$|^(nether_wart_block|warped_wart_block|shroomlight)$/.test(name || '')
const NOT_SOLID = /^(air|cave_air|void_air|water|lava|bubble_column)$/
// never break these just because they are in the way
const PROTECTED = /chest|barrel|shulker_box|spawner|hopper|furnace|smoker|beacon|_bed$|sign$|ender_chest|anvil|enchanting_table|respawn_anchor|lodestone/

const posKey = p => `${p.x},${p.y},${p.z}`
const NEIGHBORS = []
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) NEIGHBORS.push(new Vec3(x, y, z))

// ---------- shard axe ----------
function itemText (bot, it) {
  const parts = [it.name, it.displayName]
  try { if (it.customName) parts.push(textOf(bot, it.customName)) } catch {}
  try { for (const line of it.customLore || []) parts.push(textOf(bot, line)) } catch {}
  try { parts.push(JSON.stringify(it.components ?? it.nbt ?? '')) } catch {}
  return parts.join(' ').toLowerCase()
}

/** The shard axe: an axe whose name / lore / item data mentions "shard" — or `query` if given. */
function findAxe (bot, query = '') {
  const q = String(query).trim().toLowerCase()
  const items = bot.inventory.items()
  const held = bot.heldItem
  const match = it => q ? itemText(bot, it).includes(q) : /_axe$/.test(it.name) && itemText(bot, it).includes('shard')
  if (held && match(held)) return held
  return items.find(match) || null
}

// ---------- trees ----------
function naturalLeaves (block) {
  if (!block || !isLeaves(block.name)) return false
  let persistent
  try { persistent = block.getProperties?.().persistent } catch {}
  return persistent !== true && persistent !== 'true'
}

/**
 * Connected logs (26-neighbour, like tree-feller plugins) + whether natural leaves touch them.
 * Player builds use persistent leaves or none, so their logs are not treated as trees.
 */
function treeAt (bot, pos, limit = 256) {
  const logs = new Map()
  const queue = [pos]
  let leaves = false
  while (queue.length && logs.size < limit) {
    const p = queue.shift()
    const k = posKey(p)
    if (logs.has(k)) continue
    const b = bot.blockAt(p)
    if (!b || !isLog(b.name)) continue
    logs.set(k, p)
    for (const d of NEIGHBORS) {
      const n = p.plus(d)
      const nb = bot.blockAt(n)
      if (!nb) continue
      if (isLog(nb.name)) { if (!logs.has(posKey(n))) queue.push(n) } else if (!leaves && naturalLeaves(nb)) leaves = true
    }
  }
  return { logs, natural: leaves }
}

/** distance from the eyes to the closest point of the block's cube (the vanilla reach check) */
function reachDist (eye, pos) {
  const c = new Vec3(
    Math.max(pos.x, Math.min(pos.x + 1, eye.x)),
    Math.max(pos.y, Math.min(pos.y + 1, eye.y)),
    Math.max(pos.z, Math.min(pos.z + 1, eye.z)))
  return eye.distanceTo(c)
}

/**
 * Points on the faces of `pos` turned towards the eye, kept away from the edges (a person does
 * not aim at a corner) and slightly inside the block so the ray enters through that face.
 */
function aimPoints (eye, pos, random = Math.random) {
  const out = []
  const jitter = () => 0.5 + (random() - 0.5) * 0.44 // 0.28 … 0.72 of the face
  const inset = 0.04
  const faces = [
    [eye.x < pos.x, p => new Vec3(pos.x + inset, pos.y + p[0], pos.z + p[1])],
    [eye.x > pos.x + 1, p => new Vec3(pos.x + 1 - inset, pos.y + p[0], pos.z + p[1])],
    [eye.y < pos.y, p => new Vec3(pos.x + p[0], pos.y + inset, pos.z + p[1])],
    [eye.y > pos.y + 1, p => new Vec3(pos.x + p[0], pos.y + 1 - inset, pos.z + p[1])],
    [eye.z < pos.z, p => new Vec3(pos.x + p[0], pos.y + p[1], pos.z + inset)],
    [eye.z > pos.z + 1, p => new Vec3(pos.x + p[0], pos.y + p[1], pos.z + 1 - inset)]
  ]
  for (const [visible, point] of faces) {
    if (!visible) continue
    out.push(point([0.5, 0.5]))
    out.push(point([jitter(), jitter()]))
  }
  return out
}

function breakable (bot, block) {
  if (!block || NOT_SOLID.test(block.name)) return false
  if (!block.diggable || block.hardness == null || block.hardness < 0) return false
  if (PROTECTED.test(block.name)) return false
  // never dig out the floor the bot is standing on
  const feet = bot.entity.position
  const under = block.position.y === Math.floor(feet.y - 0.01)
  const overlaps = Math.abs(block.position.x + 0.5 - feet.x) < 0.8 && Math.abs(block.position.z + 0.5 - feet.z) < 0.8
  return !(under && overlaps)
}

/**
 * Choose what to hit next. Returns { block, log, aim, yaw, pitch, obstacle } or null.
 * `block` is what the eye ray hits first: the log itself, or an obstacle in front of it.
 */
function pickTarget (bot, { requireNatural = true, skip = new Set(), random = Math.random } = {}) {
  const eye = eyePosition(bot.entity)
  const ids = bot.registry.blocksArray.filter(b => isLog(b.name)).map(b => b.id)
  const found = bot.findBlocks({ matching: ids, maxDistance: Math.ceil(REACH) + 2, count: 128 })
  const naturalCache = new Map()
  const isNatural = pos => {
    const k = posKey(pos)
    if (!naturalCache.has(k)) {
      const tree = treeAt(bot, pos)
      for (const key of tree.logs.keys()) naturalCache.set(key, tree.natural)
      if (!naturalCache.has(k)) naturalCache.set(k, false)
    }
    return naturalCache.get(k)
  }
  let best = null
  for (const pos of found) {
    if (skip.has(posKey(pos))) continue
    if (reachDist(eye, pos) > REACH - 0.05) continue
    if (requireNatural && !isNatural(pos)) continue
    for (const aim of aimPoints(eye, pos, random)) {
      const { yaw, pitch } = anglesFrom(eye, aim)
      const hit = bot.world.raycast(eye, viewDirection(yaw, pitch), REACH)
      if (!hit || skip.has(posKey(hit.position))) continue
      // another log of a tree in front is just as good a target (the shard axe fells its tree)
      const otherTreeLog = !hit.position.equals(pos) && isLog(hit.name) && (!requireNatural || isNatural(hit.position))
      const obstacle = !hit.position.equals(pos) && !otherTreeLog
      if (!breakable(bot, hit)) continue
      const turn = Math.hypot(wrap(yaw - bot.entity.yaw), pitch - bot.entity.pitch) / DEG
      // a clean line of sight beats a shorter turn; lower trunk logs are a little preferred
      const cost = turn + (obstacle ? 40 : 0) + Math.max(0, pos.y - Math.floor(eye.y)) * 2 + random() * 3
      if (!best || cost < best.cost) best = { block: hit, log: pos, aim, yaw, pitch, obstacle, cost, face: hit.face }
    }
  }
  return best
}

// ---------- loop ----------
/**
 * deps: { look(yaw, pitch, cancelled) → Promise<bool>, dig(block, face), checkCancel(), Cancelled, CmdError, reply }
 */
async function chopTrees (bot, signal, opts, deps) {
  const { look, dig, checkCancel, Cancelled, CmdError, reply } = deps
  const requireNatural = opts.requireNatural !== false
  const mode = bot.game.gameMode
  if (mode === 'adventure' || mode === 'spectator') throw new CmdError(`в ${mode}-режиме ломать нельзя`)
  const axe = findAxe(bot, opts.item)
  if (!axe) throw new CmdError(opts.item ? `нет «${opts.item}» в инвентаре` : 'нет shard axe в инвентаре (или укажи предмет: .tree <название>)')
  reply(`рублю деревья: ${itemLabel(bot, axe)}${requireNatural ? '' : ' · режим any (любые брёвна)'} (.stop — перестать)`)

  const fails = new Map() // posKey → consecutive failures
  const cooldown = new Map() // posKey → time until which the block is skipped
  let trees = 0
  let obstacles = 0
  let waiting = false
  const ticks = (min, max) => bot.waitForTicks(min + Math.floor(Math.random() * (max - min + 1)))

  while (true) {
    checkCancel(signal)
    // the shard axe must be in the hand for every break
    const tool = findAxe(bot, opts.item)
    if (!tool) throw new CmdError('shard axe пропал из инвентаря')
    if (bot.heldItem !== tool) {
      await equipDigTool(bot, tool, () => checkCancel(signal))
      continue
    }

    const now = Date.now()
    for (const [k, until] of cooldown) if (until <= now) cooldown.delete(k)
    const target = pickTarget(bot, { requireNatural, skip: new Set(cooldown.keys()) })
    if (!target) {
      if (!waiting) { reply('деревьев в досягаемости нет — жду'); waiting = true }
      await ticks(10, 16)
      continue
    }
    if (waiting) { reply('вижу дерево'); waiting = false }

    const block = target.block
    const key = posKey(block.position)
    const type = block.type
    const gone = () => signal.aborted || bot.blockAt(block.position)?.type !== type
    const turned = await look(target.yaw, target.pitch, gone)
    checkCancel(signal)
    if (!turned || gone()) continue // the tree fell / block changed while turning — rescan

    // The crosshair the server will see. Anything else in front now → next loop picks it as an obstacle.
    const hit = bot.blockAtCursor(REACH)
    if (!hit || !hit.position.equals(block.position)) { await ticks(1, 2); continue }

    const onAbort = () => { try { bot.stopDigging() } catch {} }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await dig(hit, hit.face ?? 1)
      fails.delete(key)
      if (target.obstacle) {
        obstacles++
        reply(`убрал препятствие ${hit.name} — продолжаю`)
        await ticks(5, 8) // vanilla destroy delay
      } else {
        trees++
        reply(`срублено деревьев: ${trees} (${hit.name})`)
        await ticks(8, 14) // let the shard axe fell the rest of the tree server-side
      }
    } catch (e) {
      if (signal.aborted || e instanceof Cancelled) throw new Cancelled()
      const n = (fails.get(key) || 0) + 1
      fails.set(key, n)
      reply(`${hit.name}: ${e.message} — повтор ${n}`)
      if (n >= 6) {
        cooldown.set(key, Date.now() + 15_000)
        fails.delete(key)
        reply(`${hit.name} @ ${key} не ломается ${n} раз подряд — пропускаю на 15 с`)
      }
      await ticks(3, 6)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function itemLabel (bot, it) {
  let custom = ''
  try { custom = it.customName ? textOf(bot, it.customName).trim() : '' } catch {}
  return custom || it.displayName || it.name
}

module.exports = { chopTrees, findAxe, pickTarget, treeAt, aimPoints, isLog, REACH }
