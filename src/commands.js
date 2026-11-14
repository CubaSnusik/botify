'use strict'
/*
 * Console commands. A line starting with "." is a Botify command, anything else
 * goes to the server chat as-is (so "/home" or "hello" work like in the game).
 *
 * "Legit" rules every action follows:
 *  - movement only through mineflayer physics + pathfinder (control states, gravity,
 *    collisions) — never position packets / teleports, so no walking through blocks
 *  - pathfinder never digs or places blocks on its own unless asked
 *  - blocks are only mined from within 4.5 blocks (survival reach) and with line of
 *    sight; the bot walks to a spot from which it can see the block first
 *  - mining time is the vanilla one (tool, efficiency, haste, on-ground, in-water)
 *  - head rotations are interpolated over several ticks instead of snapping
 *  - melee only within 3 blocks, one hit per attack cooldown
 */
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { startFollowing } = require('./follow-navigation')
const { chopTrees } = require('./tree-chopper')
const { describeDigSpeed } = require('./dig-speed')
const { equipDigTool } = require('./dig-tool')
const { digUntilChanged } = require('./held-dig')

const REACH_BLOCK = 4.5
const REACH_ENTITY = 3.0
const DEG = Math.PI / 180

class CmdError extends Error {}
class Cancelled extends Error {}

// ---------- helpers ----------
const fmt = (n) => (Math.round(n * 10) / 10).toString()
const fmtPos = (p) => `${fmt(p.x)} ${fmt(p.y)} ${fmt(p.z)}`

function needOnline (inst) {
  if (!inst.bot || inst.state !== 'online') throw new CmdError('бот не в сети (.connect)')
  return inst.bot
}

function parseCoord (s, base) {
  if (s === undefined) throw new CmdError('не хватает координат')
  if (s.startsWith('~')) {
    const off = s.length > 1 ? Number(s.slice(1)) : 0
    if (Number.isNaN(off)) throw new CmdError(`плохая координата: ${s}`)
    return Math.floor(base) + off
  }
  const n = Number(s)
  if (Number.isNaN(n)) throw new CmdError(`плохая координата: ${s}`)
  return Math.floor(n)
}

function findPlayerEntity (bot, name) {
  const key = Object.keys(bot.players).find(n => n.toLowerCase() === String(name).toLowerCase())
  const p = key && bot.players[key]
  if (!p) throw new CmdError(`игрок ${name} не найден в табе`)
  if (!p.entity) throw new CmdError(`игрок ${p.username} далеко (вне зоны прорисовки)`)
  return p.entity
}

function wrapAngle (a) {
  a = (a + Math.PI) % (2 * Math.PI)
  if (a < 0) a += 2 * Math.PI
  return a - Math.PI
}

/** Rotate the head towards yaw/pitch over several ticks (max `speed` degrees per tick). */
async function lookSmooth (bot, yaw, pitch, speed = 35, cancelled = () => false) {
  if (bot.smoothLook) return bot.smoothLook.turn(yaw, pitch, cancelled)
  const max = speed * DEG
  for (let i = 0; i < 40; i++) {
    if (cancelled()) return
    const dy = wrapAngle(yaw - bot.entity.yaw)
    const dp = pitch - bot.entity.pitch
    if (Math.abs(dy) <= max && Math.abs(dp) <= max) {
      await bot.look(yaw, pitch, true)
      await bot.waitForTicks(1) // let the final view reach the server before using a block
      return
    }
    const sy = Math.max(-max, Math.min(max, dy))
    const sp = Math.max(-max, Math.min(max, dp))
    await bot.look(bot.entity.yaw + sy, bot.entity.pitch + sp, true)
    await bot.waitForTicks(1)
  }
  await bot.look(yaw, pitch, true)
  await bot.waitForTicks(1)
}

// F3 convention: yaw 0 = south (+Z), 90 = west, ±180 = north, -90 = east; pitch -90 = up, 90 = down.
// mineflayer: radians, yaw 0 = north, counter-clockwise; pitch positive = up.
function fromF3 (yawDeg, pitchDeg) {
  return { yaw: Math.PI - yawDeg * DEG, pitch: -Math.max(-90, Math.min(90, pitchDeg)) * DEG }
}
function toF3 (bot) {
  let yaw = (Math.PI - bot.entity.yaw) / DEG
  yaw = ((yaw + 180) % 360 + 360) % 360 - 180
  return { yaw, pitch: -bot.entity.pitch / DEG }
}

function anglesTo (bot, point) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const d = point.minus(eye)
  const yaw = Math.atan2(-d.x, -d.z)
  const pitch = Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z))
  return { yaw, pitch }
}

async function lookAtSmooth (bot, point, cancelled = () => false) {
  const { yaw, pitch } = anglesTo(bot, point)
  return lookSmooth(bot, yaw, pitch, 35, cancelled)
}

/** distance from the eyes to the closest point of the block's cube */
function blockReachDist (bot, pos) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const cx = Math.max(pos.x, Math.min(pos.x + 1, eye.x))
  const cy = Math.max(pos.y, Math.min(pos.y + 1, eye.y))
  const cz = Math.max(pos.z, Math.min(pos.z + 1, eye.z))
  return eye.distanceTo(new Vec3(cx, cy, cz))
}

function checkCancel (signal) {
  if (signal.aborted) throw new Cancelled()
}

/**
 * All bots share one Node process. Pathfinder's default is 40 ms of A* per 50 ms tick
 * PER BOT — five bots searching at once starve the event loop (physics, packets, UI).
 * Split a fixed ~24 ms/tick budget between online bots and bound the search area.
 */
function tunePathfinder (inst, target) {
  const bot = inst.bot
  const online = Math.max(1, inst.manager.onlineCount())
  bot.pathfinder.tickTimeout = Math.max(3, Math.floor(24 / online))
  bot.pathfinder.thinkTimeout = 8000
  const p = bot.entity.position
  const d = target ? Math.hypot(target.x - p.x, target.z - p.z) + (target.y ? Math.abs(target.y - p.y) : 0) : Infinity
  bot.pathfinder.searchRadius = d < 96 ? Math.ceil(d + 24) : -1
}

async function pathTo (inst, goal, signal, target) {
  const bot = inst.bot
  checkCancel(signal)
  tunePathfinder(inst, target)
  try {
    await bot.pathfinder.goto(goal)
  } catch (e) {
    if (signal.aborted) throw new Cancelled()
    const m = String(e.message || e)
    if (/no ?path/i.test(m) || e.name === 'NoPath') throw new CmdError('путь не найден')
    if (e.name === 'Timeout' || /timeout|too? long/i.test(m)) throw new CmdError('пути туда нет (точка недостижима пешком или слишком далеко)')
    if (/goal ?changed|path ?stopped/i.test(m)) throw new Cancelled()
    throw e
  }
}

/**
 * Snap a target to where a player can actually stand in that column:
 * inside a solid block → move up; floating above leaf litter / grass / flowers / air → move down
 * to the first block with collision (or liquid). Unloaded chunks are left as is.
 */
function groundY (bot, x, y, z) {
  const at = (yy) => bot.blockAt(new Vec3(x, yy, z))
  if (!at(y)) return y
  const solid = (yy) => at(yy)?.boundingBox === 'block'
  const liquid = (yy) => /^(water|lava|bubble_column)$/.test(at(yy)?.name || '')
  for (let i = 0; i < 6 && solid(y); i++) y++
  for (let i = 0; i < 8 && at(y - 1) && !solid(y - 1) && !liquid(y - 1) && !liquid(y); i++) y--
  return y
}

function goalCenter (g) {
  if (g.x !== undefined && g.z !== undefined) return new Vec3(g.x, g.y ?? 0, g.z)
  return null
}

/**
 * Pass the actual crosshair face to the patched dig plugin without turning the head again.
 */
async function digWithFace (bot, block, face, signal, reply) {
  if (bot.currentWindow) throw new CmdError('перед копанием закрой открытое окно')
  if (bot.inventory.selectedItem) throw new CmdError('перед копанием убери предмет с курсора инвентаря')
  if (signal) {
    await digUntilChanged(bot, block, face, signal, retries => {
      if (retries === 1 || retries % 10 === 0) reply?.(`сервер ещё не подтвердил разрушение ${block.name} — продолжаю удерживать копание (повтор ${retries}; .stop — остановить)`)
    })
  } else await bot.dig(block, 'ignore', face)
}

// ---------- held keys (like keeping a mouse button / key pressed) ----------
const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
const KEY_ALIASES = {
  lmb: 'lmb', attack: 'lmb', break: 'lmb', mine: 'lmb', dig: 'lmb', 'лкм': 'lmb',
  rmb: 'rmb', use: 'rmb', place: 'rmb', 'пкм': 'rmb',
  forward: 'forward', w: 'forward', back: 'back', s: 'back', left: 'left', a: 'left', right: 'right', d: 'right',
  jump: 'jump', space: 'jump', sneak: 'sneak', shift: 'sneak', sprint: 'sprint', ctrl: 'sprint'
}
const KEY_LABEL = { lmb: 'ЛКМ', rmb: 'ПКМ', forward: 'W', back: 'S', left: 'A', right: 'D', jump: 'пробел', sneak: 'shift', sprint: 'ctrl' }

function holdKey (name) {
  const k = KEY_ALIASES[String(name || '').toLowerCase()]
  if (!k) throw new CmdError(`не знаю клавишу ${name}. Есть: lmb, rmb, w, a, s, d, jump, sneak, sprint`)
  return k
}

const eyeDist = (bot, p) => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0).distanceTo(p)

/** Holding LMB: mine whatever is under the crosshair, re-target when the view moves, hit entities. */
async function holdLmb (inst, bot, signal) {
  const alive = () => !signal.aborted && inst.bot === bot
  while (alive()) {
    const ent = typeof bot.entityAtCursor === 'function' ? bot.entityAtCursor(REACH_ENTITY) : null
    const block = bot.blockAtCursor(REACH_BLOCK)
    if (ent && (!block || eyeDist(bot, ent.position) < eyeDist(bot, block.position.offset(0.5, 0.5, 0.5)))) {
      bot.attack(ent)
      await bot.waitForTicks(/axe/.test(bot.heldItem?.name || '') ? 20 : 12)
      continue
    }
    const mode = bot.game.gameMode
    if (block && block.diggable && block.hardness != null && block.hardness >= 0 && mode !== 'adventure' && mode !== 'spectator') {
      const target = block.position
      // like vanilla: when the crosshair leaves the block, digging stops and restarts on the new one
      const watch = () => {
        const b = bot.blockAtCursor(REACH_BLOCK)
        if (signal.aborted || !b || !b.position.equals(target)) { try { bot.stopDigging() } catch {} }
      }
      bot.on('physicsTick', watch)
      try { await digWithFace(bot, block, block.face ?? 1, signal) } catch {} finally { bot.off('physicsTick', watch) }
      if (!alive()) break
      await bot.waitForTicks(5) // vanilla destroy delay between blocks
      continue
    }
    await bot.waitForTicks(2)
  }
  try { bot.stopDigging() } catch {}
}

const USABLE = /^(bow|crossbow|shield|trident|spyglass|goat_horn|brush|fishing_rod)$|potion|_bucket$|^honey_bottle$/
/** Holding RMB: keep using the held item (eat, block with shield, draw bow) or click the block in view every 4 ticks. */
async function holdRmb (inst, bot, signal) {
  const alive = () => !signal.aborted && inst.bot === bot
  try {
    while (alive()) {
      const item = bot.heldItem
      const isFood = item && bot.registry.foodsByName?.[item.name]
      if (item && (isFood || USABLE.test(item.name))) {
        if (!bot.usingHeldItem) bot.activateItem()
        await bot.waitForTicks(4)
        continue
      }
      const block = bot.blockAtCursor(REACH_BLOCK)
      if (block) {
        const dir = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)][block.face ?? 1]
        const cursor = block.intersect ? block.intersect.minus(block.position) : new Vec3(0.5, 0.5, 0.5)
        try { await bot.activateBlock(block, dir, cursor) } catch {}
      } else if (item) {
        bot.activateItem()
      }
      await bot.waitForTicks(4) // vanilla right-click repeat delay
    }
  } finally {
    try { bot.deactivateItem() } catch {}
  }
}

function startHold (inst, key) {
  const bot = needOnline(inst)
  if (inst.holds.has(key)) return false
  const ac = new AbortController()
  inst.holds.set(key, ac)
  inst.update(true)
  const done = () => { if (inst.holds.get(key) === ac) { inst.holds.delete(key); inst.update(true) } }
  if (CONTROL_KEYS.includes(key)) {
    bot.setControlState(key, true)
    ac.signal.addEventListener('abort', () => { try { bot.setControlState(key, false) } catch {} done() }, { once: true })
    return true
  }
  const loop = key === 'lmb' ? holdLmb : holdRmb
  loop(inst, bot, ac.signal)
    .catch((e) => inst.log('err', `зажатие ${KEY_LABEL[key]}: ${e.message}`))
    .finally(() => { ac.abort(); done() })
  return true
}

function stopHold (inst, key) {
  const ac = inst.holds.get(key)
  if (!ac) return false
  inst.holds.delete(key)
  ac.abort()
  inst.update(true)
  return true
}

function stopAllHolds (inst) {
  for (const k of [...inst.holds.keys()]) stopHold(inst, k)
}

/** Walk (if needed) to see the block, equip best tool, look at it, dig it the vanilla way. */
async function digLegit (inst, block, signal, reply = null, hold = false) {
  const bot = inst.bot
  if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') throw new CmdError('там воздух')
  if (!block.diggable || block.hardness === null || block.hardness < 0) throw new CmdError(`${block.name} нельзя сломать`)
  if (bot.game.gameMode === 'adventure') throw new CmdError('в adventure-режиме ломать нельзя')
  if (bot.game.gameMode === 'spectator') throw new CmdError('в spectator-режиме ломать нельзя')

  const visibleNow = () => {
    const hit = bot.blockAtCursor(REACH_BLOCK)
    return hit && hit.position.equals(block.position)
  }

  if (blockReachDist(bot, block.position) > REACH_BLOCK - 0.2) {
    await pathTo(inst, new goals.GoalLookAtBlock(block.position, bot.world, { reach: REACH_BLOCK - 0.5 }), signal, block.position)
  }
  checkCancel(signal)

  const tool = bot.pathfinder.bestHarvestTool(block)
  if (tool && bot.heldItem?.type !== tool.type) await equipDigTool(bot, tool, () => checkCancel(signal))
  if (reply) {
    const s = describeDigSpeed(bot, block)
    reply(`в руке ${bot.heldItem?.name ?? 'пусто'} · ${s.ticks} тик. (${fmt(s.ticks / 20)} с)` +
      (s.efficiency ? ` · эффективность +${fmt(s.efficiency)} (${s.efficiencySource})` : ''))
  }

  await lookAtSmooth(bot, block.position.offset(0.5, 0.5, 0.5), () => signal.aborted)
  checkCancel(signal)
  if (!visibleNow()) {
    // maybe just the center is hidden — try the faces
    let seen = false
    for (const off of [[0.5, 0.9, 0.5], [0.5, 0.1, 0.5], [0.1, 0.5, 0.5], [0.9, 0.5, 0.5], [0.5, 0.5, 0.1], [0.5, 0.5, 0.9]]) {
      await lookAtSmooth(bot, block.position.offset(...off), () => signal.aborted)
      checkCancel(signal)
      if (visibleNow()) { seen = true; break }
    }
    if (!seen) throw new CmdError('блок не виден — что-то загораживает')
  }
  if (blockReachDist(bot, block.position) > REACH_BLOCK) throw new CmdError('блок вне досягаемости')
  checkCancel(signal)

  const onAbort = () => { try { bot.stopDigging() } catch {} }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const hit = bot.blockAtCursor(REACH_BLOCK)
    await digWithFace(bot, block, hit?.face ?? 1, hold ? signal : undefined, reply)
    await bot.waitForTicks(5) // leave the vanilla destroy delay before the next automated block
    checkCancel(signal)
  } catch (e) {
    if (signal.aborted) throw new Cancelled()
    throw new CmdError(`копание прервано: ${e.message}`)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function itemByName (bot, query) {
  const q = String(query).toLowerCase().replace(/^minecraft:/, '')
  const items = bot.inventory.items()
  return items.find(i => i.name === q) ||
    items.find(i => i.name.includes(q)) ||
    items.find(i => (i.displayName || '').toLowerCase().includes(q))
}

function describeItem (i) {
  const dur = i.maxDurability ? ` [${i.maxDurability - (i.durabilityUsed || 0)}/${i.maxDurability}]` : ''
  return `${i.count}× ${i.displayName || i.name}${dur}`
}

// ---------- command table ----------
const COMMANDS = [
  {
    name: 'help',
    usage: '.help [команда]',
    desc: 'список команд',
    offline: true,
    run (ctx) {
      const [name] = ctx.args
      if (name) {
        const c = find(name)
        if (!c) throw new CmdError(`нет команды ${name}`)
        ctx.reply(`${c.usage} — ${c.desc}`)
        return
      }
      ctx.reply('Текст без точки отправляется в чат сервера (/команды тоже).')
      for (const c of COMMANDS) ctx.reply(`${c.usage.padEnd(28)} ${c.desc}`)
    }
  },
  {
    name: 'connect',
    aliases: ['join'],
    usage: '.connect',
    desc: 'подключить бота',
    offline: true,
    run (ctx) { ctx.inst.connect() }
  },
  {
    name: 'disconnect',
    aliases: ['quit', 'leave'],
    usage: '.disconnect',
    desc: 'отключить бота',
    offline: true,
    run (ctx) { ctx.inst.disconnect() }
  },
  {
    name: 'reconnect',
    aliases: ['rejoin'],
    usage: '.reconnect',
    desc: 'перезайти',
    offline: true,
    async run (ctx) {
      await ctx.inst.disconnect()
      setTimeout(() => ctx.inst.connect(), 1200)
    }
  },
  {
    name: 'say',
    usage: '.say <текст>',
    desc: 'написать в чат (если текст начинается с точки)',
    run (ctx) {
      if (!ctx.rest) throw new CmdError('пустое сообщение')
      needOnline(ctx.inst).chat(ctx.rest)
    }
  },
  {
    name: 'goto',
    aliases: ['go', 'pos1'],
    usage: '.goto <x> [y] <z> | <игрок>',
    desc: 'дойти пешком (~ = относительно)',
    task: true,
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const a = ctx.args
      const p = bot.entity.position
      let goal, label
      if (a.length === 1) {
        const e = findPlayerEntity(bot, a[0])
        goal = new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2)
        label = a[0]
      } else if (a.length === 2) {
        const x = parseCoord(a[0], p.x); const z = parseCoord(a[1], p.z)
        goal = new goals.GoalXZ(x, z)
        label = `${x} ${z}`
      } else if (a.length === 3) {
        const x = parseCoord(a[0], p.x); const z = parseCoord(a[2], p.z)
        const y0 = parseCoord(a[1], p.y)
        const y = groundY(bot, x, y0, z)
        if (y !== y0) ctx.reply(`${x} ${y0} ${z} ${y > y0 ? 'внутри блока' : 'в воздухе'} — цель поправлена на y=${y}`)
        ctx.reply(`иду к ${x} ${y} ${z}…`)
        try {
          await pathTo(ctx.inst, new goals.GoalBlock(x, y, z), ctx.signal, new Vec3(x, y, z))
        } catch (e) {
          if (!(e instanceof CmdError)) throw e
          ctx.reply(`ровно в ${x} ${y} ${z} не пройти (${e.message}) — подойду как можно ближе`)
          await pathTo(ctx.inst, new goals.GoalNearXZ(x, z, 2), ctx.signal, new Vec3(x, y, z))
        }
        const pos = bot.entity.position
        const left = Math.hypot(pos.x - (x + 0.5), pos.z - (z + 0.5))
        const dy = y - Math.floor(pos.y)
        if (pos.floored().x === x && pos.floored().z === z && Math.abs(pos.y - y) < 1.1) ctx.reply(`на месте: ${fmtPos(pos)}`)
        else ctx.reply(`остановился рядом: ${fmtPos(pos)} — до цели ${fmt(left)} бл.${dy ? `, по высоте ${dy > 0 ? '+' : ''}${dy}` : ''}`)
        return
      } else throw new CmdError('usage: .goto <x> [y] <z> | <игрок>')
      ctx.reply(`иду к ${label}…`)
      await pathTo(ctx.inst, goal, ctx.signal, goalCenter(goal))
      ctx.reply(`на месте: ${fmtPos(bot.entity.position)}`)
    }
  },
  ...['follow', 'circle'].map(command => ({
    name: command,
    usage: `.${command} <игрок> [${command === 'circle' ? 'радиус' : 'дистанция'}] [spin] [speed=град/с]`,
    desc: command === 'circle' ? 'ходить по кругу вокруг игрока' : 'ходить за игроком',
    task: true,
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const circle = command === 'circle'
      const [name, ...options] = ctx.args
      const usage = `usage: .${command} <игрок> [${circle ? 'радиус' : 'дистанция'}] [spin] [speed=град/с]`
      if (!name) throw new CmdError(usage)
      const spin = options.some(value => value.toLowerCase() === 'spin')
      const speeds = options.filter(value => /^speed=/i.test(value))
      const distances = options.filter(value => value.toLowerCase() !== 'spin' && !/^speed=/i.test(value))
      if (distances.length > 1 || speeds.length > 1 || options.filter(value => value.toLowerCase() === 'spin').length > 1) {
        throw new CmdError(usage)
      }
      if (speeds.length && !spin) throw new CmdError('speed задаётся вместе с spin')
      const spinSpeed = speeds.length ? Number(speeds[0].slice(6)) : 120
      if (!Number.isFinite(spinSpeed) || spinSpeed < 1 || spinSpeed > 720) throw new CmdError('скорость spin должна быть от 1 до 720 градусов в секунду')
      const dist = distances[0] ?? (circle ? '3' : '2')
      if (spin && !bot.smoothLook?.spin) throw new CmdError('режиму spin нужен включённый контроллер движения и плавного поворота')
      if (circle && !bot.smoothLook) throw new CmdError('команде circle нужен включённый контроллер движения и плавного поворота')
      const e = findPlayerEntity(bot, name)
      if (e === bot.entity || e.id === bot.entity.id) throw new CmdError('нельзя следовать за самим собой')
      const distance = Number(dist)
      if (!Number.isFinite(distance) || distance < 1) throw new CmdError(`${circle ? 'радиус должен быть числом' : 'дистанция должна быть числом'} не меньше 1 блока`)
      checkCancel(ctx.signal)
      tunePathfinder(ctx.inst, null)
      const formation = circle ? { scope: ctx.inst.manager, server: ctx.inst.server() } : null
      const following = startFollowing(bot, e, distance, { spin, spinSpeed, circle, formation })
      ctx.reply(`${circle ? 'хожу вокруг' : 'следую за'} ${e.username || name}, ${circle ? 'радиус' : 'дистанция'} ${distance} бл.${spin ? `, режим spin ${spinSpeed}°/с` : ''} (.stop — перестать)`)
      await new Promise((resolve) => {
        let stopped = false
        const stop = () => {
          if (stopped) return
          stopped = true
          ctx.signal.removeEventListener('abort', stop)
          bot.off('entityGone', onGone)
          bot.off('end', stop)
          bot.off('death', stop)
          bot.off('respawn', stop)
          bot._client.off('start_configuration', stop)
          following.stop()
          resolve()
        }
        const onGone = (ent) => { if (ent === e || ent.id === e.id) { ctx.reply(`${e.username || name} пропал из виду`); stop() } }
        bot.on('entityGone', onGone)
        bot.once('end', stop)
        bot.once('death', stop)
        bot.once('respawn', stop)
        bot._client.once('start_configuration', stop)
        ctx.signal.addEventListener('abort', stop, { once: true })
        if (ctx.signal.aborted) stop()
      })
    }
  })),
  {
    name: 'stop',
    aliases: ['s', 'cancel'],
    usage: '.stop',
    desc: 'остановить всё (ходьбу, копание, следование)',
    run (ctx) {
      ctx.inst.cancelTask()
      stopAllHolds(ctx.inst)
      const bot = ctx.inst.bot
      if (bot) {
        bot.smoothLook?.cancel()
        try { bot.pathfinder.setGoal(null) } catch {}
        try { bot.stopDigging() } catch {}
        try { bot.deactivateItem() } catch {}
        bot.clearControlStates()
      }
      ctx.reply('остановлен')
    }
  },
  {
    name: 'break',
    aliases: ['dig', 'b'],
    usage: '.break [x y z]',
    desc: 'удерживать копание блока до ответа сервера (.stop — остановить)',
    task: true,
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      let block
      if (ctx.args.length >= 3) {
        const p = bot.entity.position
        const pos = new Vec3(parseCoord(ctx.args[0], p.x), parseCoord(ctx.args[1], p.y), parseCoord(ctx.args[2], p.z))
        block = bot.blockAt(pos)
        if (!block) throw new CmdError('чанк не загружен')
      } else {
        block = bot.blockAtCursor(REACH_BLOCK)
        if (!block) throw new CmdError('бот ни на что не смотрит')
      }
      ctx.reply(`ломаю ${block.name} @ ${block.position.x} ${block.position.y} ${block.position.z} (.stop — остановить)`)
      await digLegit(ctx.inst, block, ctx.signal, ctx.reply, true)
      ctx.reply('готово')
    }
  },
  {
    name: 'mine',
    usage: '.mine <блок> [кол-во]',
    desc: 'найти и добыть блоки рядом (до 48 блоков)',
    task: true,
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const [query, cnt = '1'] = ctx.args
      if (!query) throw new CmdError('usage: .mine <блок> [кол-во]')
      const q = query.toLowerCase().replace(/^minecraft:/, '')
      const types = bot.registry.blocksArray.filter(b => b.name === q || (q.length > 2 && b.name.endsWith('_' + q)) || b.name === q + '_ore')
      if (!types.length) throw new CmdError(`не знаю блок ${query}`)
      const ids = types.map(t => t.id)
      const want = Math.max(1, Math.min(512, Number(cnt) || 1))
      const skipped = new Set()
      let done = 0
      while (done < want) {
        checkCancel(ctx.signal)
        const found = bot.findBlocks({ matching: ids, maxDistance: 48, count: 64 })
          .filter(p => !skipped.has(p.toString()))
          .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
        if (!found.length) { ctx.reply(`больше не нашёл ${query} поблизости`); break }
        const block = bot.blockAt(found[0])
        try {
          await digLegit(ctx.inst, block, ctx.signal)
          done++
          ctx.reply(`${block.name} ${done}/${want}`)
        } catch (e) {
          if (e instanceof Cancelled) throw e
          skipped.add(found[0].toString())
          if (skipped.size > 30) throw new CmdError('слишком много недоступных блоков, сдаюсь')
        }
      }
      ctx.reply(`добыто: ${done}`)
    }
  },
  {
    name: 'tree',
    task: true,
    aliases: ['chop', 'trees'],
    usage: '.tree [any] [предмет]',
    desc: 'стоять на месте и рубить деревья shard axe (плавный прицел, ломает препятствия)',
    task: true,
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const args = [...ctx.args]
      const any = args[0]?.toLowerCase() === 'any'
      if (any) args.shift()
      await chopTrees(bot, ctx.signal, { requireNatural: !any, item: args.join(' ') }, {
        look: (yaw, pitch, cancelled) => bot.smoothLook
          ? bot.smoothLook.turn(yaw, pitch, cancelled, 'human')
          : lookSmooth(bot, yaw, pitch, 12, cancelled).then(() => true),
        dig: (block, face) => digWithFace(bot, block, face, ctx.signal, ctx.reply),
        checkCancel,
        Cancelled,
        CmdError,
        reply: ctx.reply
      })
    }
  },
  {
    name: 'slot',
    aliases: ['hotbar'],
    usage: '.slot <1-9> [предмет]',
    desc: 'выбрать слот хотбара; с предметом — сначала положить его туда',
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const n = Number(ctx.args[0])
      if (!(n >= 1 && n <= 9)) throw new CmdError('слот от 1 до 9')
      const q = ctx.args.slice(1).join(' ')
      if (q) {
        const it = itemByName(bot, q)
        if (!it) throw new CmdError(`нет ${q} в инвентаре`)
        if (it.slot !== 36 + n - 1) await ctx.inst.hotbarSwap(it.slot, n - 1)
      }
      bot.setQuickBarSlot(n - 1)
      await bot.waitForTicks(1)
      const it = bot.inventory.slots[36 + n - 1]
      ctx.reply(`слот ${n}: ${it ? describeItem(it) : 'пусто'}`)
    }
  },
  {
    name: 'hold',
    aliases: ['press'],
    usage: '.hold <lmb|rmb|w|a|s|d|jump|sneak|sprint>',
    desc: 'зажать кнопку (lmb — ломать то, куда смотрит)',
    run (ctx) {
      if (!ctx.args.length) throw new CmdError('usage: .hold <lmb|rmb|w|a|s|d|jump|sneak|sprint>')
      for (const a of ctx.args) {
        const k = holdKey(a)
        ctx.reply(startHold(ctx.inst, k) ? `зажал ${KEY_LABEL[k]}` : `${KEY_LABEL[k]} уже зажата`)
      }
    }
  },
  {
    name: 'release',
    aliases: ['unhold', 'up'],
    usage: '.release [кнопка|all]',
    desc: 'отпустить кнопку (без аргумента — все)',
    run (ctx) {
      const [a] = ctx.args
      if (!a || a === 'all') { stopAllHolds(ctx.inst); ctx.reply('отпустил всё'); return }
      const k = holdKey(a)
      ctx.reply(stopHold(ctx.inst, k) ? `отпустил ${KEY_LABEL[k]}` : `${KEY_LABEL[k]} и так не зажата`)
    }
  },
  {
    name: 'gui',
    aliases: ['window', 'menu'],
    usage: '.gui [click <№|текст> [right|shift] | close]',
    desc: 'открытое меню/сундук: показать, кликнуть слот, закрыть',
    async run (ctx) {
      needOnline(ctx.inst)
      const screens = require('./screens')
      const [sub, ...rest] = ctx.args
      if (!sub || sub === 'list' || sub === 'show') { for (const l of screens.describeWindow(ctx.inst)) ctx.reply(l); return }
      if (sub === 'close') { ctx.inst.windowClose(); ctx.reply('закрыл'); return }
      if (sub === 'click' || /^\d+$/.test(sub)) {
        const args = sub === 'click' ? rest : [sub, ...rest]
        let how = 'left'
        if (['right', 'shift', 'middle', 'пкм'].includes(args[args.length - 1])) how = args.pop().replace('пкм', 'right')
        if (!args.length) throw new CmdError('usage: .gui click <№|текст>')
        const slot = screens.findWindowSlot(ctx.inst.bot, args.join(' '))
        await ctx.inst.windowClick(slot, how)
        return
      }
      throw new CmdError('usage: .gui [click <№|текст> [right|shift] | close]')
    }
  },
  {
    name: 'dialog',
    aliases: ['d', 'answer'],
    usage: '.dialog [<№|кнопка> | set <поле> <значение> | close]',
    desc: 'ответить на экран-диалог сервера (да/нет, кнопки, поля)',
    run (ctx) {
      const inst = ctx.inst
      const screens = require('./screens')
      const d = inst.dialog
      const [sub, ...rest] = ctx.args
      if (!d) throw new CmdError('диалога сейчас нет')
      if (!sub || sub === 'show' || sub === 'list') {
        ctx.reply(`[диалог] ${d.title}${d.waiting ? ' (ждёт ответа сервера)' : ''}`)
        for (const l of d.body) if (l.trim()) ctx.reply(`  ${l}`)
        for (const i of d.inputs) ctx.reply(`  поле ${i.key} (${i.label}) = ${i.type === 'option' ? i.options.find(o => o.id === i.value)?.display : JSON.stringify(i.value)}`)
        ctx.reply('  ' + d.buttons.map((b, n) => `[${n + 1}] ${b.label}`).join('   '))
        return
      }
      if (sub === 'close' || sub === 'esc') { ctx.reply(inst.dialogClose()); return }
      if (sub === 'set') {
        const [key, ...val] = rest
        if (!key) throw new CmdError('usage: .dialog set <поле> <значение>')
        try {
          const i = screens.setDialogInput(inst, key, val.join(' '))
          ctx.reply(`${i.key} = ${i.type === 'option' ? i.options.find(o => o.id === i.value)?.display : JSON.stringify(i.value)}`)
        } catch (e) { throw new CmdError(e.message) }
        return
      }
      const q = [sub, ...rest].join(' ')
      let idx = Number(q) - 1
      if (!Number.isInteger(idx) || !d.buttons[idx]) {
        const low = q.toLowerCase()
        const yesNo = { yes: 0, да: 0, y: 0, no: 1, нет: 1, n: 1 }
        idx = d.buttons.findIndex(b => b.label.toLowerCase() === low)
        if (idx < 0) idx = d.buttons.findIndex(b => b.label.toLowerCase().includes(low))
        if (idx < 0 && d.type === 'confirmation' && low in yesNo) idx = yesNo[low]
      }
      if (idx < 0 || !d.buttons[idx]) throw new CmdError(`нет такой кнопки. Есть: ${d.buttons.map((b, n) => `${n + 1}) ${b.label}`).join(', ')}`)
      try { inst.dialogClick(idx) } catch (e) { throw new CmdError(e.message) }
    }
  },
  {
    name: 'turn',
    aliases: ['rot'],
    usage: '.turn <Δyaw> [Δpitch]',
    desc: 'повернуться относительно (градусы, + вправо / вниз)',
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const dy = Number(ctx.args[0] || 0); const dp = Number(ctx.args[1] || 0)
      if (Number.isNaN(dy) || Number.isNaN(dp)) throw new CmdError('usage: .turn <Δyaw> [Δpitch]')
      const { yaw, pitch } = toF3(bot)
      await ctx.inst.look(yaw + dy, pitch + dp)
      const r = toF3(bot)
      ctx.reply(`смотрю ${fmt(r.yaw)} / ${fmt(r.pitch)}`)
    }
  },
  {
    name: 'equip',
    usage: '.equip <предмет> [hand|off-hand|head|torso|legs|feet]',
    desc: 'взять/надеть предмет',
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const [q, dest = 'hand'] = ctx.args
      if (!q) throw new CmdError('usage: .equip <предмет> [куда]')
      const it = itemByName(bot, q)
      if (!it) throw new CmdError(`нет ${q} в инвентаре`)
      await bot.equip(it, dest)
      ctx.reply(`экипировал ${it.displayName} → ${dest}`)
    }
  },
  {
    name: 'drop',
    aliases: ['toss', 'q'],
    usage: '.drop [предмет|all] [кол-во]',
    desc: 'выбросить (без аргументов — то, что в руке)',
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const [q, n] = ctx.args
      if (!q) {
        if (!bot.heldItem) throw new CmdError('рука пустая')
        const d = describeItem(bot.heldItem)
        await bot.tossStack(bot.heldItem)
        ctx.reply(`выбросил ${d}`)
        return
      }
      if (q === 'all') {
        const items = bot.inventory.items()
        for (const it of items) {
          checkCancel(ctx.signal)
          await bot.tossStack(it)
          await bot.waitForTicks(2)
        }
        ctx.reply(`выбросил ${items.length} стаков`)
        return
      }
      const it = itemByName(bot, q)
      if (!it) throw new CmdError(`нет ${q} в инвентаре`)
      if (n) {
        await bot.toss(it.type, null, Math.min(Number(n) || 1, bot.inventory.count(it.type)))
        ctx.reply(`выбросил ${n}× ${it.displayName}`)
      } else {
        await bot.tossStack(it)
        ctx.reply(`выбросил ${describeItem(it)}`)
      }
    }
  },
  {
    name: 'use',
    aliases: ['rmb'],
    usage: '.use [stop]',
    desc: 'ПКМ предметом в руке (зелье, лук, щит…)',
    run (ctx) {
      const bot = needOnline(ctx.inst)
      if (ctx.args[0] === 'stop') { bot.deactivateItem(); ctx.reply('отпустил ПКМ'); return }
      bot.activateItem()
      ctx.reply(`использую ${bot.heldItem?.displayName || 'руку'}`)
    }
  },
  {
    name: 'click',
    aliases: ['interact'],
    usage: '.click',
    desc: 'ПКМ по блоку под прицелом (кнопка, дверь, сундук)',
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const b = bot.blockAtCursor(REACH_BLOCK)
      if (!b) throw new CmdError('нет блока под прицелом')
      await bot.activateBlock(b)
      ctx.reply(`нажал ${b.name}`)
    }
  },
  {
    name: 'eat',
    usage: '.eat',
    desc: 'съесть что-нибудь из инвентаря',
    task: true,
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      if (bot.food >= 20) throw new CmdError('не голоден')
      const foods = bot.registry.foodsByName || {}
      const food = bot.inventory.items()
        .filter(i => foods[i.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'].includes(i.name))
        .sort((a, b) => (foods[b.name].foodPoints || 0) - (foods[a.name].foodPoints || 0))[0]
      if (!food) throw new CmdError('нет еды')
      await bot.equip(food, 'hand')
      ctx.reply(`ем ${food.displayName}…`)
      await bot.consume()
      ctx.reply(`сытость ${bot.food}/20`)
    }
  },
  {
    name: 'look',
    usage: '.look <yaw> <pitch>',
    desc: 'повернуть голову (градусы как в F3)',
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const [y, p] = ctx.args.map(Number)
      if ([y, p].some(Number.isNaN) || ctx.args.length < 2) throw new CmdError('usage: .look <yaw> <pitch>')
      await ctx.inst.look(y, p)
      ctx.reply(`смотрю ${y} / ${p}`)
    }
  },
  {
    name: 'lookat',
    usage: '.lookat <x y z | игрок>',
    desc: 'посмотреть на точку или игрока',
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      if (ctx.args.length === 1) {
        const e = findPlayerEntity(bot, ctx.args[0])
        await lookAtSmooth(bot, e.position.offset(0, e.height * 0.9, 0))
      } else if (ctx.args.length === 3) {
        const p = bot.entity.position
        await lookAtSmooth(bot, new Vec3(parseCoord(ctx.args[0], p.x) + 0.5, parseCoord(ctx.args[1], p.y) + 0.5, parseCoord(ctx.args[2], p.z) + 0.5))
      } else throw new CmdError('usage: .lookat <x y z | игрок>')
      ctx.reply('ок')
    }
  },
  {
    name: 'attack',
    aliases: ['hit'],
    usage: '.attack [игрок|nearest] [удары]',
    desc: 'ударить (подойдёт вплотную, с кулдауном)',
    task: true,
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      const [who = 'nearest', times = '1'] = ctx.args
      let target
      if (who === 'nearest') {
        target = bot.nearestEntity(e => e !== bot.entity && (e.type === 'hostile' || e.type === 'mob' || e.type === 'animal' || e.type === 'player') && e.position.distanceTo(bot.entity.position) < 16)
        if (!target) throw new CmdError('рядом никого')
      } else target = findPlayerEntity(bot, who)
      const n = Math.max(1, Math.min(100, Number(times) || 1))
      for (let i = 0; i < n; i++) {
        checkCancel(ctx.signal)
        if (!target.isValid) { ctx.reply('цель пропала'); return }
        if (bot.entity.position.distanceTo(target.position) > REACH_ENTITY) {
          await pathTo(ctx.inst, new goals.GoalFollow(target, 1.8), ctx.signal, target.position)
        }
        await lookAtSmooth(bot, target.position.offset(0, target.height * 0.8, 0))
        if (bot.entity.position.distanceTo(target.position) > REACH_ENTITY + 0.5) throw new CmdError('не дотягиваюсь')
        bot.attack(target)
        // vanilla attack cooldown: ~0.625s for swords, 1s for axes — be conservative
        if (i < n - 1) await bot.waitForTicks(/axe/.test(bot.heldItem?.name || '') ? 20 : 13)
      }
      ctx.reply(`ударил ${target.username || target.displayName || target.name} ×${n}`)
    }
  },
  {
    name: 'jump',
    usage: '.jump',
    desc: 'прыгнуть',
    async run (ctx) {
      const bot = needOnline(ctx.inst)
      bot.setControlState('jump', true)
      await bot.waitForTicks(2)
      bot.setControlState('jump', false)
    }
  },
  {
    name: 'sneak',
    aliases: ['shift'],
    usage: '.sneak [on|off]',
    desc: 'присесть / встать',
    run (ctx) {
      const bot = needOnline(ctx.inst)
      const want = ctx.args[0] ? ctx.args[0] === 'on' : !bot.getControlState('sneak')
      bot.setControlState('sneak', want)
      ctx.reply(want ? 'присел' : 'встал')
    }
  },
  {
    name: 'pos',
    aliases: ['where', 'coords'],
    usage: '.pos',
    desc: 'координаты',
    run (ctx) {
      const bot = needOnline(ctx.inst)
      ctx.reply(`${fmtPos(bot.entity.position)} (${bot.game.dimension})`)
    }
  },
  {
    name: 'status',
    aliases: ['hp', 'info'],
    usage: '.status',
    desc: 'здоровье, голод, пинг, режим',
    run (ctx) {
      const bot = needOnline(ctx.inst)
      ctx.reply(`HP ${fmt(bot.health)}/20 · еда ${bot.food}/20 · lvl ${bot.experience?.level ?? 0} · ${bot.game.gameMode} · ${bot.player?.ping ?? '?'}ms · ${bot.version}`)
    }
  },
  {
    name: 'inv',
    aliases: ['inventory', 'i'],
    usage: '.inv',
    desc: 'что в инвентаре',
    run (ctx) {
      const bot = needOnline(ctx.inst)
      const items = bot.inventory.items()
      if (!items.length) { ctx.reply('инвентарь пуст'); return }
      ctx.reply(items.map(describeItem).join(', '))
    }
  },
  {
    name: 'players',
    aliases: ['list', 'tab'],
    usage: '.players',
    desc: 'игроки на сервере',
    run (ctx) {
      const bot = needOnline(ctx.inst)
      const names = Object.keys(bot.players)
      ctx.reply(`${names.length}: ${names.join(', ')}`)
    }
  },
  {
    name: 'respawn',
    usage: '.respawn',
    desc: 'возродиться',
    run (ctx) {
      const bot = needOnline(ctx.inst)
      bot.respawn()
      ctx.reply('возрождаюсь')
    }
  }
]

const BY_NAME = new Map()
for (const c of COMMANDS) {
  BY_NAME.set(c.name, c)
  for (const a of c.aliases || []) BY_NAME.set(a, c)
}
function find (name) { return BY_NAME.get(String(name).toLowerCase().replace(/^\./, '')) }

const activeBreakCommands = new WeakMap()

/**
 * Executes one console line for one bot.
 * reply(text, kind) — kind: 'out' | 'err'
 */
async function execute (inst, line, reply) {
  line = String(line).trim()
  if (!line) return
  if (!line.startsWith('.')) {
    if (!inst.bot || inst.state !== 'online') { reply('бот не в сети — сообщение не отправлено', 'err'); return }
    inst.bot.chat(line)
    return
  }
  const [head, ...args] = line.slice(1).split(/\s+/)
  const rest = line.slice(1 + head.length).trim()
  const cmd = find(head)
  if (!cmd) { reply(`неизвестная команда .${head} — смотри .help`, 'err'); return }
  const breakKey = args.join(' ')
  const activeBreak = activeBreakCommands.get(inst)
  if (cmd.name === 'break' && activeBreak && activeBreak.task === inst.task &&
      activeBreak.bot === inst.bot && activeBreak.key === breakKey) {
    reply('копание уже удерживается; .stop — остановить', 'sys')
    return
  }

  const run = async (signal) => {
    const ctx = { inst, bot: inst.bot, args, rest, signal, reply: (t, k = 'out') => reply(t, k) }
    try {
      await cmd.run(ctx)
    } catch (e) {
      if (e instanceof Cancelled) { reply(`.${cmd.name}: отменено`, 'sys'); return }
      reply(e instanceof CmdError ? `.${cmd.name}: ${e.message}` : `.${cmd.name}: ошибка — ${e.message}`, 'err')
    }
  }

  if (cmd.task) {
    const pending = inst.runTask(cmd.name, run)
    if (cmd.name !== 'break') return pending
    const entry = { task: inst.task, bot: inst.bot, key: breakKey }
    activeBreakCommands.set(inst, entry)
    try { return await pending } finally {
      if (activeBreakCommands.get(inst) === entry) activeBreakCommands.delete(inst)
    }
  }
  return run(new AbortController().signal)
}

const COMMAND_INFO = COMMANDS.map(c => ({ name: c.name, aliases: c.aliases || [], usage: c.usage, desc: c.desc }))

module.exports = {
  execute,
  COMMAND_INFO,
  lookSmooth,
  fromF3,
  toF3,
  startHold,
  stopHold,
  stopAllHolds,
  holdKey,
  KEY_LABEL
}
