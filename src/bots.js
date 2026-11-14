'use strict'
require('../scripts/patch-login')()
require('../scripts/patch-physics')()
require('../scripts/patch-pathfinder')()
require('../scripts/patch-digging')()
const { EventEmitter } = require('events')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { Authflow, Titles } = require('prismarine-auth')
const { makeAuthHook, resolveSession, tokenExpiresAt } = require('./auth')
const { isRateLimited, authRetryDelay, isAlreadyOnline } = require('./connection-errors')
const { ConnectionQueue } = require('./connection-queue')
const { execute, lookSmooth, fromF3, toF3, stopAllHolds } = require('./commands')
const screens = require('./screens')
const { attachCommandSending } = require('./chatfix')
const { attachEyeRaycast } = require('./eye-raycast')
const { attachVanillaDigSpeed } = require('./dig-speed')
const { attachDigDiagnostics } = require('./dig-diagnostics')
const dns = require('dns').promises
const net = require('net')

/**
 * "mc.example.com" without a port → look up the _minecraft._tcp SRV record like the vanilla
 * client does; the handshake still carries the address the user typed (fakeHost).
 */
async function resolveAddress (host, port) {
  if (port) return { host, port }
  if (net.isIP(host) || host === 'localhost') return { host, port: 25565 }
  try {
    const recs = await Promise.race([
      dns.resolveSrv('_minecraft._tcp.' + host),
      new Promise((resolve) => setTimeout(() => resolve(null), 3000))
    ])
    if (recs && recs.length) {
      recs.sort((a, b) => a.priority - b.priority || b.weight - a.weight)
      return { host: recs[0].name.replace(/\.$/, ''), port: recs[0].port, fakeHost: host, srv: true }
    }
  } catch {}
  return { host, port: 25565 }
}

const addrStr = (host, port) => port && port !== 25565 ? `${host}:${port}` : host

// precise 20 TPS physics clock (fixes stutter from Windows' 15.6 ms timers) — must run before any bot is created
const ticker = require('./ticker')
const TICKER_ON = !process.env.BOTIFY_NO_TICKER
if (TICKER_ON) ticker.install()
const { attachVanillaTick } = require('./vanilla')
const { attachSetbackMonitor } = require('./setbacks')
const { attachMovementRecovery } = require('./movement-recovery')

const LOG_LIMIT = 600

// ---------- text helpers ----------
function chatToText (v) {
  if (v == null) return ''
  if (typeof v === 'string') {
    try { return chatToText(JSON.parse(v)) } catch { return v.replace(/§./g, '') }
  }
  if (Array.isArray(v)) return v.map(chatToText).join('')
  if (typeof v === 'object') {
    if (typeof v.toString === 'function' && v.constructor && v.constructor.name === 'ChatMessage') return v.toString()
    if (v.type && 'value' in v && typeof v.type === 'string') { // NBT
      try { return chatToText(require('prismarine-nbt').simplify(v)) } catch {}
    }
    let s = ''
    if (v.text != null) s += v.text
    if (v[''] != null) s += v['']
    if (v.translate) s += v.translate + (v.with ? ' ' + v.with.map(chatToText).join(' ') : '')
    if (v.extra) s += chatToText(v.extra)
    return s.replace(/§./g, '')
  }
  return String(v)
}

function friendlyError (err) {
  const code = err?.code || err?.cause?.code
  const msg = String(err?.message || err)
  if (isRateLimited(err)) return 'сервис авторизации ограничил частоту запросов (HTTP 429); следующая попытка будет после паузы'
  if (/Connection closed before the server sent a status response/i.test(msg)) {
    return 'сервер закрыл запрос определения версии; если повторяется, укажи версию Minecraft вручную вместо «авто»'
  }
  if (msg.includes('multiplayer.disconnect.authservers_down')) {
    return 'сервер сообщил, что не смог проверить сессию через сервис авторизации (multiplayer.disconnect.authservers_down)'
  }
  if (code === 'ECONNREFUSED') return 'сервер не отвечает (ECONNREFUSED) — проверь IP и порт'
  if (code === 'ENOTFOUND') return 'сервер не найден (ENOTFOUND) — проверь адрес'
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) return 'таймаут соединения'
  if (code === 'ECONNRESET') return 'соединение сброшено сервером'
  if (/unsupported protocol version|is not supported/i.test(msg)) return `версия сервера не поддерживается: ${msg}`
  if (/Failed to verify username|Invalid session/i.test(msg)) return 'сервер не принял сессию — токен протух или аккаунт не лицензия'
  return msg
}

// ---------- one bot ----------
class BotInstance extends EventEmitter {
  constructor (manager, id) {
    super()
    this.manager = manager
    this.id = id
    this.state = 'offline' // offline | connecting | online | reconnecting | error
    this.error = null
    this.bot = null
    this.logs = []
    this.task = null
    this.manualStop = true
    this.reconnectTimer = null
    this.reconnectAt = null
    this.attempt = 0
    this.authCode = null
    this.holds = new Map() // key -> AbortController (held mouse buttons / keys)
    this.dialog = null // current server dialog (see screens.js)
    this.dialogSeq = 0
    this._lookSeq = 0
    this._upd = null
    this._inv = null
  }

  get store () { return this.manager.store }
  get acc () { return this.store.getAccount(this.id) }

  server () {
    const s = this.acc?.server
    if (s && s.host) return { host: s.host, port: Number(s.port) || null, version: s.version || 'auto', custom: true }
    const g = this.store.settings.server
    return { host: g.host, port: Number(g.port) || null, version: g.version || 'auto', custom: false }
  }

  autoReconnect () {
    if (this.acc?.accountIssue) return false
    const a = this.acc?.autoReconnect
    return a == null ? this.store.settings.behavior.autoReconnect : a
  }

  // ---- logging / events ----
  log (kind, text) {
    const entry = { t: Date.now(), kind, text: String(text) }
    this.logs.push(entry)
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT)
    this.manager.emit('log', this.id, entry)
  }

  setState (state, error = null) {
    this.state = state
    this.error = error
    this.update(true)
    if (state !== 'connecting' && state !== 'queued') this.emit('connectionSettled')
  }

  update (now = false) {
    if (now) {
      clearTimeout(this._upd); this._upd = null
      this.manager.emit('update', this.snapshot())
      return
    }
    if (this._upd) return
    this._upd = setTimeout(() => { this._upd = null; this.manager.emit('update', this.snapshot()) }, 250)
  }

  inventoryChanged () {
    if (this._inv) return
    this._inv = setTimeout(() => { this._inv = null; this.manager.emit('inventory', this.id, this.inventory()) }, 150)
  }

  // ---- connection ----
  async connect () {
    if (!this.acc || this.bot || this.state === 'connecting') return
    if (this.acc.accountIssue) {
      this.setState('error', 'утерян / украден: You are already online; подключение остановлено')
      return
    }
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAt = null
    return this.manager.connectionQueue.add(this)
  }

  async _connectNow () {
    const acc = this.acc
    if (!acc) return
    if (this.manualStop || acc.accountIssue) { this.setState('offline'); return }
    if (this.bot || this.state === 'connecting') return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAt = null
    this.manualStop = false
    const cooldown = this.acc.type !== 'offline' ? this.manager.authCooldownUntil - Date.now() : 0
    if (cooldown > 0) {
      this.error = `пауза авторизации после HTTP 429: осталось ${Math.ceil(cooldown / 1000)} с`
      this.log('sys', this.error)
      if (this.autoReconnect()) {
        this.state = 'reconnecting'
        this.scheduleReconnect()
      } else this.setState('error', this.error)
      return
    }
    this.error = null
    const srv = this.server()
    this.setState('connecting')
    this.log('sys', `подключаюсь к ${addrStr(srv.host, srv.port)} (${srv.version === 'auto' ? 'версия авто' : srv.version})…`)

    const addr = await resolveAddress(srv.host, srv.port)
    if (this.manualStop) { this.setState('offline'); return } // disconnected while resolving
    if (addr.srv) this.log('sys', `SRV-запись: ${srv.host} → ${addr.host}:${addr.port}`)

    const behavior = this.store.settings.behavior
    const options = {
      host: addr.host,
      port: addr.port,
      ...(addr.fakeHost ? { fakeHost: addr.fakeHost } : {}),
      version: srv.version === 'auto' ? false : srv.version,
      hideErrors: true,
      logErrors: false,
      checkTimeoutInterval: 60_000,
      viewDistance: behavior.viewDistance || 'normal',
      respawn: true
    }

    try {
      if (acc.type === 'offline') {
        options.auth = 'offline'
        options.username = acc.username
      } else if (acc.type === 'microsoft') {
        options.auth = 'microsoft'
        options.username = acc.id // cache key for prismarine-auth, the real name comes from the profile
        options.profilesFolder = this.store.path('auth-cache', acc.id)
        options.onMsaCode = (data) => this.onMsaCode(data)
      } else if (acc.type === 'token' || acc.type === 'refresh') {
        options.username = acc.username || 'Player'
        options.auth = makeAuthHook(
          () => resolveSession(this.acc, this.store, (m) => this.log('sys', m)),
          client => !this.manualStop && !this.error && this.bot?._client === client
        )
      } else {
        throw new Error(`неизвестный тип аккаунта ${acc.type}`)
      }
      this.bot = mineflayer.createBot(options)
    } catch (e) {
      this.bot = null
      this.log('err', friendlyError(e))
      this.setState('error', friendlyError(e))
      return
    }
    this.attach(this.bot)
  }

  onMsaCode (data) {
    this.authCode = { code: data.user_code, url: data.verification_uri, expiresAt: Date.now() + (data.expires_in || 900) * 1000 }
    this.log('sys', `нужен вход в Microsoft: открой ${data.verification_uri} и введи код ${data.user_code}`)
    this.manager.emit('authCode', this.id, this.authCode)
  }

  attach (bot) {
    bot.loadPlugin(pathfinder)
    // after Mineflayer's own plugins (ray_trace) were injected: crosshair from the eyes, like vanilla
    // and mining speed from the tool components and server attributes.
    bot.once('inject_allowed', () => { attachEyeRaycast(bot); attachVanillaDigSpeed(bot) })
    const client = bot._client
    screens.attachDialogs(this, bot) // before login: servers may show dialogs during configuration
    if (!process.env.BOTIFY_NO_CHATFIX) attachCommandSending(bot) // send /commands like vanilla (signed only when they carry a message)
    // vanilla packets: correct entity_action ids on 1.21.6+ (always); per-tick order — player_input,
    // sprint timing, collision flag, tick_end — when the ticker drives physics
    // Install the recorder below the packet adapter so it sees the actual outgoing stream.
    const recovery = attachMovementRecovery(bot, {
      file: this.store.path('movement', encodeURIComponent(this.id) + '.json'),
      log: text => this.log('sys', text),
      stop: () => {
        this.cancelTask()
        stopAllHolds(this)
        bot.pathfinder.setGoal(null)
        bot.smoothLook?.cancel()
        bot.clearControlStates()
        this.update()
      }
    })
    attachDigDiagnostics(bot, {
      file: this.store.path('digging', encodeURIComponent(this.id) + '.json'),
      log: text => this.log('sys', text)
    })
    const vanillaHooks = process.env.BOTIFY_NO_VANILLA ? null : attachVanillaTick(bot, { perTick: TICKER_ON })
    const movementHooks = vanillaHooks && {
      before () { recovery.before(); vanillaHooks.before() },
      after () { try { vanillaHooks.after() } finally { recovery.after() } }
    }
    // Server corrections are observable; their cause (anticheat, command, plugin) is not.
    this.setbacks = attachSetbackMonitor(bot, (text) => this.log('sys', text), () => this.update())
    let ended = false
    let spawned = false

    // safety net: if we never get to spawn (dead ping, stuck login), give up and let reconnect logic run
    const connectTimeout = setTimeout(() => {
      if (spawned || ended || this.authCode) return
      this.error = this.error || 'не удалось зайти за 45 с (таймаут)'
      this.log('err', this.error)
      try { client.end('timeout') } catch {}
      setTimeout(() => onEnd('timeout'), 1000)
    }, 45_000)

    client.on('session', (s) => {
      const p = s?.selectedProfile
      if (p && (p.name !== this.acc?.username || p.id !== this.acc?.uuid)) {
        this.store.updateAccount(this.id, { username: p.name, uuid: p.id })
        this.update()
      }
    })

    bot.once('login', () => {
      // runs before mineflayer's physics 'login' handler, which creates the physics interval
      if (movementHooks && TICKER_ON) { ticker.claimNext(movementHooks); setImmediate(() => ticker.cancelClaim(movementHooks)) }
      fixLpVec3Velocity(bot)
      this.authCode = null
      this.manager.emit('authCode', this.id, null)
      this.log('sys', `залогинен как ${bot.username} · ${bot.version}`)
      if (this.acc?.type === 'offline' && bot.player?.uuid && !this.acc.uuid) {
        this.store.updateAccount(this.id, { uuid: bot.player.uuid })
      }
    })

    bot.once('spawn', () => {
      spawned = true
      clearTimeout(connectTimeout)
      const mov = new Movements(bot)
      // legit movement: no digging/placing on the way, no pillaring, no free flying
      mov.canDig = false
      mov.allow1by1towers = false
      mov.scafoldingBlocks = []
      mov.allowParkour = true
      mov.allowSprinting = true
      mov.allowFreeMotion = false
      mov.canOpenDoors = true
      bot.pathfinder.setMovements(mov)
      bot.pathfinder.enablePathShortcut = true
      bot.pathfinder.tickTimeout = 8 // re-tuned per command in commands.js (shared CPU budget)

      this.attempt = 0
      this.setState('online')
      this.log('sys', `заспавнился: ${fmtPos(bot.entity.position)} (${bot.game.dimension})`)
      const walkingProfile = vanillaHooks && TICKER_ON && bot.physics?.botifyWalkingProfile
      this.log('sys', `[движение] протокол ${bot.version}; физика ${walkingProfile ? `vanilla ${walkingProfile}` : 'Prismarine (ванильная ветка не включена)'}`)
      this.inventoryChanged()

      bot.inventory.on('updateSlot', () => this.inventoryChanged())
    })

    bot.on('messagestr', (msg, position) => {
      if (position === 'game_info') return // action bar — handled below
      if (!msg.trim()) return
      this.log('chat', msg)
    })

    // Action bar: servers often answer commands there ("Request sent"). Log it when the text really
    // changes (ignoring digits, so countdowns/coords don't spam) and keep the latest one for the UI.
    let lastShape = ''
    bot.on('actionBar', (msg) => {
      const text = chatToText(msg).trim()
      if (!text) return
      this.actionBar = { text, t: Date.now() }
      const shape = text.replace(/[\d.,:]+/g, '#')
      if (shape !== lastShape) { lastShape = shape; this.log('sys', `[экшн-бар] ${text}`) }
      this.update()
    })

    bot.on('title', (text, type) => {
      const t = chatToText(text)
      if (t.trim()) this.log('sys', `[${type === 'subtitle' ? 'подзаголовок' : 'титл'}] ${t}`)
    })

    bot.on('health', () => this.update())
    bot.on('move', () => this.update())
    bot.on('experience', () => this.update())
    bot.on('game', () => this.update())
    bot.on('heldItemChanged', () => { this.update(); this.inventoryChanged() })
    bot.on('playerUpdated', (p) => { if (p.username === bot.username) this.update() })
    bot.on('death', () => this.log('err', 'бот умер'))
    bot.on('respawn', () => { this.log('sys', 'возродился'); this.inventoryChanged() })
    bot.on('windowOpen', (w) => {
      for (const line of screens.describeWindow(this)) this.log('out', line)
      w.on('updateSlot', () => this.inventoryChanged())
      this.inventoryChanged()
      this.update(true)
    })
    bot.on('windowClose', (w) => {
      // servers often send close_window with nothing open (e.g. on join) — not worth a log line
      if (w) this.log('sys', '[окно] закрыто')
      this.inventoryChanged()
      this.update(true)
    })

    bot.on('kicked', (reason, loggedIn) => {
      if (ended || this.bot !== bot) return
      const raw = chatToText(reason)
      const authUnavailable = raw.includes('multiplayer.disconnect.authservers_down')
      const text = authUnavailable ? friendlyError(raw) : raw
      this.log('err', `кикнут${loggedIn ? '' : ' при входе'}: ${text || '(без причины)'}`)
      if (authUnavailable) {
        const modes = { offline: 'только ник (offline)', token: 'access token', refresh: 'refresh token', microsoft: 'Microsoft' }
        this.log('sys', `диагностика входа: версия ${bot.version || client.version || '?'}, способ ${modes[this.acc?.type] || '?'}; этот ответ не подтверждает ни истечение токена, ни общий сбой Mojang`)
      }
      this.error = `кик: ${text}`
      if (isAlreadyOnline(raw)) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        this.reconnectAt = null
        this.store.updateAccount(this.id, { accountIssue: {
          code: 'already_online', label: 'утерян / украден', reason: raw, at: Date.now()
        } })
        this.log('sys', 'аккаунт помечен «утерян / украден»: повторные подключения остановлены только для него')
        this.update(true)
        try { client.end('already_online') } catch {}
        onEnd('already_online')
      }
    })

    bot.on('error', (err) => {
      if (ended) return
      if (isRateLimited(err)) this.manager.authCooldownUntil = Math.max(this.manager.authCooldownUntil, Date.now() + authRetryDelay(err))
      const m = friendlyError(err)
      if (m !== this.error) this.log('err', m)
      this.error = m
      // errors before login (dead ping, refused socket) don't always produce 'end'
      if (!spawned) setTimeout(() => { if (!ended && !spawned) { try { client.end('error') } catch {} onEnd('error') } }, 1500)
    })

    bot.on('end', (reason) => onEnd(reason))

    const onEnd = (reason) => {
      if (ended) return
      ended = true
      clearTimeout(connectTimeout)
      if (this.bot !== bot) return
      this.cancelTask()
      stopAllHolds(this)
      this.dialog = null
      // keep a no-op error listener: late socket errors must not crash the process
      bot.on('error', () => {})
      this.bot = null
      this.authCode = null
      this.manager.emit('authCode', this.id, null)
      this.log('sys', `отключён${reason && reason !== 'socketClosed' ? ` (${reason})` : ''}`)
      this.manager.emit('inventory', this.id, null)
      const err = this.error
      if (!this.manualStop && this.autoReconnect() && this.acc) {
        this.state = 'reconnecting'
        this.error = err
        this.scheduleReconnect()
      } else {
        this.setState(err && !this.manualStop ? 'error' : 'offline', this.manualStop ? null : err)
      }
      this.emit('connectionSettled')
    }
  }

  scheduleReconnect () {
    if (this.acc?.accountIssue || this.manualStop) return
    this.attempt++
    const base = this.store.settings.behavior.reconnectDelay || 5000
    const cooldown = this.acc?.type !== 'offline' ? this.manager.authCooldownUntil - Date.now() : 0
    const delay = Math.min(2 ** 31 - 1, Math.max(0, cooldown, Math.min(120_000, base * Math.pow(1.6, Math.min(this.attempt - 1, 8)))))
    this.reconnectAt = Date.now() + delay
    this.log('sys', `переподключение через ${Math.round(delay / 1000)}с (попытка ${this.attempt})`)
    this.update(true)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectAt = null
      this.error = null
      this.connect()
    }, delay)
  }

  async disconnect () {
    this.manualStop = true
    this.manager.connectionQueue.cancel(this)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.reconnectAt = null
    this.attempt = 0
    this.cancelTask()
    if (this.bot) {
      this.log('sys', 'отключаюсь…')
      const bot = this.bot
      try { bot.quit('disconnect') } catch {}
      // force-close if the server doesn't answer
      setTimeout(() => { if (this.bot === bot) { try { bot._client.socket?.destroy() } catch {} } }, 3000)
    } else {
      this.setState('offline')
    }
  }

  // ---- tasks (long actions that .stop cancels) ----
  runTask (name, fn) {
    this.cancelTask()
    const ac = new AbortController()
    const task = { name, ac }
    this.task = task
    this.update()
    return fn(ac.signal).finally(() => {
      if (this.task === task) { this.task = null; this.update() }
    })
  }

  cancelTask () {
    if (!this.task) return
    const t = this.task
    this.task = null
    t.ac.abort()
    this.bot?.smoothLook?.cancel()
    try { this.bot?.pathfinder?.setGoal(null) } catch {}
    try { this.bot?.clearControlStates() } catch {}
  }

  command (line, reply) {
    const out = reply || ((text, kind) => this.log(kind || 'out', text))
    return execute(this, line, out)
  }

  // ---- views ----
  snapshot () {
    const acc = this.acc || {}
    const srv = this.server()
    const bot = this.bot
    let live = null
    if (bot && this.state === 'online' && bot.entity) {
      const p = bot.entity.position
      live = {
        health: bot.health,
        food: bot.food,
        saturation: bot.foodSaturation,
        level: bot.experience?.level ?? 0,
        xpProgress: bot.experience?.progress ?? 0,
        pos: { x: p.x, y: p.y, z: p.z },
        yaw: bot.entity.yaw,
        pitch: bot.entity.pitch,
        dimension: bot.game?.dimension,
        gameMode: bot.game?.gameMode,
        ping: bot.player?.ping ?? null,
        version: bot.version,
        rot: toF3(bot),
        heldSlot: bot.quickBarSlot ?? 0,
        players: Object.keys(bot.players || {}).length,
        actionBar: this.actionBar && Date.now() - this.actionBar.t < 8000 ? this.actionBar.text : null,
        setbacks: this.setbacks ? this.setbacks.rate() : 0
      }
    }
    return {
      id: this.id,
      type: acc.type,
      username: (bot && bot.username && bot.username !== this.id) ? bot.username : (acc.username || ''),
      uuid: acc.uuid || null,
      state: this.state,
      error: this.error,
      accountIssue: acc.accountIssue || null,
      server: srv,
      autoReconnect: acc.autoReconnect,
      reconnectAt: this.reconnectAt,
      task: this.task?.name || null,
      holds: [...this.holds.keys()],
      dialog: screens.dialogView(this.dialog),
      window: bot?.currentWindow ? { id: bot.currentWindow.id } : null,
      authCode: this.authCode,
      tokenExpiresAt: acc.type === 'token' ? tokenExpiresAt(acc) : null,
      note: acc.note || '',
      live
    }
  }

  inventory () {
    const bot = this.bot
    if (!bot || !bot.inventory) return null
    const slots = bot.inventory.slots.map((it, i) => screens.itemView(bot, it, i))
    return { version: bot.version, heldSlot: bot.quickBarSlot ?? 0, slots, window: screens.windowView(bot) }
  }

  // ---- inventory actions from the UI ----
  async selectHotbar (index) {
    if (!this.bot) throw new Error('бот не в сети')
    this.bot.setQuickBarSlot(Math.max(0, Math.min(8, index)))
  }

  async dropSlot (slot, all = true) {
    const bot = this.bot
    if (!bot) throw new Error('бот не в сети')
    const it = bot.inventory.slots[slot]
    if (!it) return
    if (all) await bot.tossStack(it)
    else await bot.toss(it.type, null, 1)
  }

  /** Smoothly turn the head to F3-style yaw/pitch (degrees). A newer call cancels an older one. */
  async look (yawDeg, pitchDeg) {
    const bot = this.bot
    if (!bot || this.state !== 'online') throw new Error('бот не в сети')
    const seq = ++this._lookSeq
    const { yaw, pitch } = fromF3(Number(yawDeg) || 0, Number(pitchDeg) || 0)
    await lookSmooth(bot, yaw, pitch, 35, () => seq !== this._lookSeq || this.bot !== bot)
    this.update()
  }

  _invWindow () {
    const bot = this.bot
    if (!bot || this.state !== 'online') throw new Error('бот не в сети')
    if (bot.currentWindow) throw new Error('у бота открыто окно (сундук и т.п.) — сначала закрой')
    return bot
  }

  // vanilla closes the player inventory screen after clicking around in it
  _closeInv (bot) {
    try { bot._client.write('close_window', { windowId: 0 }) } catch {}
  }

  /** Drag & drop: move/swap the stack in `from` to `to` (player-inventory window slot ids). */
  async moveSlot (from, to) {
    const bot = this._invWindow()
    from = Number(from); to = Number(to)
    if (![from, to].every(s => s >= 5 && s <= 45) || from === to) return
    if (!bot.inventory.slots[from]) return
    await bot.moveSlotItem(from, to)
    this._closeInv(bot)
    this.inventoryChanged()
  }

  /** Shift+click: move a stack between hotbar and main inventory / armor. */
  async quickMove (slot) {
    const bot = this._invWindow()
    if (!bot.inventory.slots[slot]) return
    await bot.clickWindow(Number(slot), 0, 1)
    this._closeInv(bot)
    this.inventoryChanged()
  }

  /** Hover a slot + press 1–9 (one vanilla "swap" click): put that stack into hotbar slot `index`. */
  async hotbarSwap (slot, index) {
    const bot = this._invWindow()
    slot = Number(slot); index = Math.max(0, Math.min(8, Number(index)))
    if (slot === 36 + index) return
    await bot.clickWindow(slot, index, 2)
    this._closeInv(bot)
    this.inventoryChanged()
  }

  // ---- server screens (dialogs, menu GUIs) ----
  dialogClick (index, values) {
    if (!this.bot) throw new Error('бот не в сети')
    screens.setDialogInputs(this, values)
    const res = screens.clickDialogButton(this, Number(index))
    this.log('cmd', `[диалог] ${res}`)
    return res
  }

  dialogClose () {
    if (!this.bot) throw new Error('бот не в сети')
    const res = screens.closeDialog(this)
    this.log('cmd', `[диалог] закрыт: ${res}`)
    return res
  }

  async windowClick (slot, how = 'left') {
    if (!this.bot) throw new Error('бот не в сети')
    const name = await screens.clickWindowSlot(this, Number(slot), how)
    this.log('cmd', `[окно] клик ${how === 'left' ? '' : how + ' '}#${slot}: ${name}`)
    this.inventoryChanged()
  }

  windowClose () {
    const bot = this.bot
    if (!bot?.currentWindow) throw new Error('окон не открыто')
    bot.closeWindow(bot.currentWindow)
  }

  async equipSlot (slot, dest = 'hand') {
    const bot = this.bot
    if (!bot) throw new Error('бот не в сети')
    const it = bot.inventory.slots[slot]
    if (!it) return
    if (dest === 'hand' && slot >= 36 && slot <= 44) { bot.setQuickBarSlot(slot - 36); return }
    await bot.equip(it, dest)
  }
}

function fmtPos (p) { return `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}` }

/**
 * mineflayer bug (1.21.9+ / 26.x): velocity in entity_velocity / spawn_entity is now an
 * lpVec3 that is already in blocks per tick, but mineflayer still multiplies it by 1/8000.
 * Result: knockback from hits, explosions pushing via velocity, fishing rods, etc. are
 * silently lost and the bot "ignores physics". Our listeners run after mineflayer's
 * (plugins are injected before 'login') and put the real value back.
 */
function fixLpVec3Velocity (bot) {
  let types
  try { types = require('minecraft-data')(bot.version).protocol.play.toClient.types } catch { return }
  const isLp = (name) => JSON.stringify(types[name] || '').includes('"lpVec3"')
  const client = bot._client
  if (isLp('packet_entity_velocity')) {
    client.on('entity_velocity', (p) => {
      const e = bot.entities[p.entityId]
      if (e && e.velocity && p.velocity) e.velocity.set(p.velocity.x, p.velocity.y, p.velocity.z)
    })
  }
  if (isLp('packet_spawn_entity')) {
    client.on('spawn_entity', (p) => {
      const e = bot.entities[p.entityId]
      if (e && e.velocity && p.velocity) e.velocity.set(p.velocity.x, p.velocity.y, p.velocity.z)
    })
  }
}

// ---------- manager ----------
class BotManager extends EventEmitter {
  constructor (store) {
    super()
    this.store = store
    this.bots = new Map()
    this.globalLogs = []
    this.connectionQueue = new ConnectionQueue(() => this.store.settings.behavior.joinStagger ?? 1500)
    this.authCooldownUntil = 0 // shared by online accounts; manual reconnect does not clear it
    this.sync()
    store.on('accounts', () => this.sync())
    store.on('settings', () => { for (const b of this.bots.values()) b.update() })
  }

  sync () {
    const ids = new Set(this.store.listAccounts().map(a => a.id))
    for (const a of this.store.listAccounts()) {
      if (!this.bots.has(a.id)) this.bots.set(a.id, new BotInstance(this, a.id))
    }
    for (const [id, inst] of this.bots) {
      if (!ids.has(id)) {
        inst.disconnect()
        this.bots.delete(id)
        this.emit('removed', id)
      }
    }
  }

  get (id) {
    const b = this.bots.get(id)
    if (!b) throw new Error('бот не найден')
    return b
  }

  onlineCount () {
    let n = 0
    for (const b of this.bots.values()) if (b.state === 'online') n++
    return n
  }

  list () {
    return this.store.listAccounts().filter(a => !a.pending).map(a => this.bots.get(a.id)?.snapshot()).filter(Boolean)
  }

  async connectAll (ids) {
    const list = (ids || this.store.listAccounts().map(a => a.id))
      .map(id => this.bots.get(id))
      .filter(b => b && !b.bot && !b.acc?.accountIssue && b.state !== 'connecting')
    await Promise.all(list.map(b => b.connect()))
  }

  async disconnectAll () {
    await Promise.all([...this.bots.values()].map(b => b.disconnect()))
  }

  globalLog (entry) {
    const e = { t: Date.now(), ...entry }
    this.globalLogs.push(e)
    if (this.globalLogs.length > LOG_LIMIT * 2) this.globalLogs.splice(0, this.globalLogs.length - LOG_LIMIT * 2)
    this.emit('globalLog', e)
  }

  /**
   * Global console. `targets` = array of bot ids, or null for "every online bot".
   * A line may also start with "@Nick1,Nick2" to pick bots by name.
   */
  async runGlobal (line, targets) {
    line = String(line).trim()
    if (!line) return
    let pool = [...this.bots.values()]
    const m = line.match(/^@(\S+)\s+(.*)$/)
    if (m) {
      const names = m[1].toLowerCase().split(',')
      line = m[2]
      pool = pool.filter(b => names.includes((b.snapshot().username || '').toLowerCase()))
    } else if (Array.isArray(targets) && targets.length) {
      pool = pool.filter(b => targets.includes(b.id))
    }
    const isConn = /^\.(connect|join|reconnect|rejoin)\b/i.test(line)
    if (!isConn) pool = pool.filter(b => b.state === 'online')

    this.globalLog({ kind: 'cmd', text: line, count: pool.length })
    if (!pool.length) { this.globalLog({ kind: 'err', text: 'нет подходящих ботов в сети' }); return }

    if (/^\.(connect|join)\b/i.test(line)) return this.connectAll(pool.map(b => b.id))

    await Promise.all(pool.map(b => {
      const name = b.snapshot().username
      b.log('cmd', `[общая] ${line}`)
      return b.command(line, (text, kind = 'out') => {
        b.log(kind, text)
        this.globalLog({ kind, text, bot: name, botId: b.id })
      })
    }))
  }
}

module.exports = { BotManager, BotInstance, chatToText }

// exported for the "add Microsoft account" flow (login without joining a server)
module.exports.microsoftLogin = async function microsoftLogin (store, accId, onCode) {
  const flow = new Authflow(accId, store.path('auth-cache', accId), {
    authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo', flow: 'live'
  }, onCode)
  const res = await flow.getMinecraftJavaToken({ fetchProfile: true })
  if (!res.profile || res.profile.error) throw new Error('на аккаунте нет Minecraft Java')
  return res.profile
}
