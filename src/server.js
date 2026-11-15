'use strict'
/*
 * Local backend: static UI + item icons + skins + a WebSocket API.
 * Listens on 127.0.0.1 only and rejects foreign Host/Origin headers, so no web
 * page in your browser can talk to it (DNS-rebinding / cross-site WS safe).
 * Tokens are never sent to the UI.
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const { Store, ROOT } = require('./store')
const { BotManager, microsoftLogin } = require('./bots')
const { getItemIcon, SkinService } = require('./assets')
const { parseTokenLines, resolveSession, AuthError } = require('./auth')
const { COMMAND_INFO, holdKey, startHold, stopHold } = require('./commands')

/** "host", "host:port", "[::1]:port" → { host, port|null } */
function parseAddress (s, port) {
  s = String(s || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
  let host = s; let p = port
  const v6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (v6) { host = v6[1]; p = v6[2] || p } else if (/^[^:]+:\d+$/.test(s)) { [host, p] = s.split(':') }
  p = Number(p) || null
  return { host, port: p }
}

const PUBLIC = path.join(ROOT, 'public')
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }
const NICK_RE = /^[A-Za-z0-9_]{1,16}$/

function createApp () {
  const store = new Store()
  const manager = new BotManager(store)
  const skins = new SkinService(store.path('cache', 'skins'))
  return { store, manager, skins }
}

// One misbehaving bot (e.g. mineflayer throwing inside a socket callback on an
// unsupported server) must never take down every other bot with it.
let guardsInstalled = false
function installCrashGuards () {
  if (guardsInstalled) return
  guardsInstalled = true
  process.on('uncaughtException', (e) => console.error('[botify] uncaught:', e?.stack || e))
  process.on('unhandledRejection', (e) => console.error('[botify] unhandled rejection:', e?.stack || e))
}

function startServer ({ port = 7878, fallback = true, app = createApp() } = {}) {
  installCrashGuards()
  const { store, manager, skins } = app
  let actualPort = port

  const allowedHost = (h) => h === `127.0.0.1:${actualPort}` || h === `localhost:${actualPort}`

  const server = http.createServer(async (req, res) => {
    if (!allowedHost(req.headers.host)) { res.writeHead(403); res.end('forbidden'); return }
    const url = new URL(req.url, 'http://x')
    const p = decodeURIComponent(url.pathname)
    try {
      // item icon: /icon/<version>/<name>.png
      let m = p.match(/^\/icon\/([\w.-]+)\/([a-z0-9_]+)\.png$/)
      if (m) {
        const buf = getItemIcon(m[2], m[1])
        if (!buf) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' })
        res.end(buf)
        return
      }
      // skin png for a bot: /skin/<id>
      m = p.match(/^\/skin\/(b_[a-f0-9]+)$/)
      if (m) {
        const acc = store.getAccount(m[1])
        if (!acc) { res.writeHead(404); res.end(); return }
        const file = await skins.skinFor(acc)
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' })
        fs.createReadStream(file).pipe(res)
        return
      }
      // static
      const rel = p === '/' ? 'index.html' : p.slice(1)
      const file = path.join(PUBLIC, path.normalize(rel))
      if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
        res.end(data)
      })
    } catch (e) {
      res.writeHead(500); res.end(String(e.message))
    }
  })

  const wss = new WebSocketServer({
    server,
    maxPayload: 4 * 1024 * 1024,
    verifyClient: ({ req }) => {
      if (!allowedHost(req.headers.host)) return false
      const o = req.headers.origin
      return !o || o === `http://127.0.0.1:${actualPort}` || o === `http://localhost:${actualPort}`
    }
  })

  const clients = new Set()
  const broadcast = (type, data) => {
    const msg = JSON.stringify({ type, data })
    for (const ws of clients) if (ws.readyState === 1) ws.send(msg)
  }

  manager.on('update', (snap) => broadcast('bot', snap))
  manager.on('log', (id, entry) => broadcast('log', { id, entry }))
  manager.on('globalLog', (entry) => broadcast('glog', entry))
  manager.on('inventory', (id, inv) => broadcast('inventory', { id, inv }))
  manager.on('removed', (id) => broadcast('removed', { id }))
  manager.on('authCode', (id, code) => broadcast('authCode', { id, code }))
  store.on('accounts', () => broadcast('bots', manager.list()))
  store.on('settings', (s) => broadcast('settings', s))

  // ---- RPC handlers ----
  const pendingLogins = new Map() // accId -> true
  const handlers = {
    hello: () => ({
      bots: manager.list(),
      settings: store.settings,
      commands: COMMAND_INFO,
      globalLogs: manager.globalLogs.slice(-300),
      dataDir: store.dir
    }),
    'bot.logs': ({ id }) => manager.get(id).logs,
    'discord.test': async ({ id }) => {
      const inst = manager.get(id)
      if (!inst.alerts.enabled()) throw new Error('сначала включите и сохраните Discord webhook')
      await inst.alerts.notify('test', 'Проверка уведомлений Botify', 'Вебхук работает. Уведомления настроены для всех ботов.', { force: true })
      return true
    },
    'bot.inventory': ({ id }) => manager.get(id).inventory(),
    'bot.connect': ({ id }) => { manager.get(id).connect() },
    'bot.disconnect': ({ id }) => manager.get(id).disconnect(),
    'bot.command': ({ id, line }) => {
      const b = manager.get(id)
      b.log('cmd', line)
      b.command(line)
    },
    'bot.clearLogs': ({ id }) => { manager.get(id).logs = [] },
    'bot.hotbar': ({ id, index }) => manager.get(id).selectHotbar(index),
    'bot.drop': ({ id, slot, all }) => manager.get(id).dropSlot(slot, all !== false),
    'bot.equip': ({ id, slot, dest }) => manager.get(id).equipSlot(slot, dest),
    'bot.moveSlot': ({ id, from, to }) => manager.get(id).moveSlot(from, to),
    'bot.quickMove': ({ id, slot }) => manager.get(id).quickMove(slot),
    'bot.hotbarSwap': ({ id, slot, index }) => manager.get(id).hotbarSwap(slot, index),
    'bot.look': ({ id, yaw, pitch }) => { manager.get(id).look(yaw, pitch).catch(() => {}) },
    'bot.dialogClick': ({ id, index, values }) => manager.get(id).dialogClick(index, values),
    'bot.dialogClose': ({ id }) => manager.get(id).dialogClose(),
    'bot.windowClick': ({ id, slot, how }) => manager.get(id).windowClick(slot, how),
    'bot.windowClose': ({ id }) => manager.get(id).windowClose(),
    'bot.hold': ({ id, key, on }) => {
      const inst = manager.get(id)
      const k = holdKey(key)
      if (on) startHold(inst, k)
      else stopHold(inst, k)
      return [...inst.holds.keys()]
    },
    'global.look': ({ targets, yaw, pitch }) => {
      for (const b of manager.bots.values()) {
        if (b.state === 'online' && (!targets?.length || targets.includes(b.id))) b.look(yaw, pitch).catch(() => {})
      }
    },
    'bot.update': ({ id, patch }) => {
      const acc = store.getAccount(id)
      if (!acc) throw new Error('бот не найден')
      const clean = {}
      if ('server' in patch) {
        const s = patch.server
        clean.server = s && s.host ? { ...parseAddress(s.host, s.port), version: s.version || 'auto' } : null
      }
      if ('autoReconnect' in patch) clean.autoReconnect = patch.autoReconnect
      if ('note' in patch) clean.note = String(patch.note).slice(0, 200)
      if (patch.accountIssue === null) clean.accountIssue = null
      if ('username' in patch && acc.type === 'offline') {
        if (!NICK_RE.test(patch.username)) throw new Error('ник: 1–16 символов, латиница/цифры/_')
        clean.username = patch.username
        clean.uuid = null
      }
      store.updateAccount(id, clean)
      if (clean.accountIssue === null && !manager.get(id).bot) manager.get(id).setState('offline')
      manager.get(id).update(true)
    },
    'bot.remove': async ({ id }) => {
      const b = manager.bots.get(id)
      if (b) await b.disconnect()
      store.removeAccount(id)
    },
    'bots.reorder': ({ ids }) => { store.reorder(ids); broadcast('bots', manager.list()) },
    'bots.connectAll': ({ ids }) => { manager.connectAll(ids) },
    'bots.disconnectAll': () => manager.disconnectAll(),
    'global.command': ({ line, targets }) => { manager.runGlobal(line, targets) },
    'global.clear': () => { manager.globalLogs = [] },
    'settings.update': ({ patch }) => {
      if (patch.server) {
        const a = parseAddress(patch.server.host, patch.server.port)
        if (!a.host) throw new Error('укажи адрес сервера')
        patch = { ...patch, server: { ...patch.server, ...a } }
      }
      return store.updateSettings(patch)
    },

    'accounts.addOffline': ({ names, server }) => {
      const added = []; const errors = []
      const existing = new Set(store.listAccounts().filter(a => a.type === 'offline').map(a => a.username.toLowerCase()))
      for (let n of names) {
        n = String(n).trim()
        if (!n) continue
        if (!NICK_RE.test(n)) { errors.push(`${n}: недопустимый ник`); continue }
        if (existing.has(n.toLowerCase())) { errors.push(`${n}: уже есть`); continue }
        existing.add(n.toLowerCase())
        added.push(store.addAccount({ type: 'offline', username: n, server: server || null }).id)
      }
      return { added: added.length, errors }
    },

    'accounts.importTokens': async ({ text, clientId, server }) => {
      const parsed = parseTokenLines(text, clientId ? String(clientId).trim() : null)
      const results = []
      for (const p of parsed) {
        if (p.error) { results.push({ ok: false, error: p.error, raw: String(p.raw).slice(0, 24) + '…' }); continue }
        const temp = { id: '__probe', ...p }
        // probe: validate the token and fetch the profile before saving anything
        const probeStore = {
          getAccount: () => temp,
          updateAccount: (_, patch) => Object.assign(temp, patch)
        }
        try {
          const s = await resolveSession(temp, probeStore)
          const dup = store.listAccounts().find(a => a.uuid && a.uuid === s.profile.id)
          const fields = {
            type: temp.type,
            username: s.profile.name,
            uuid: s.profile.id,
            accessToken: temp.accessToken,
            accessTokenExpiresAt: temp.accessTokenExpiresAt || null,
            refreshToken: temp.refreshToken,
            clientId: temp.clientId || null
          }
          for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k]
          if (dup) {
            store.updateAccount(dup.id, fields)
            results.push({ ok: true, name: s.profile.name, updated: true })
          } else {
            store.addAccount({ ...fields, server: server || null })
            results.push({ ok: true, name: s.profile.name })
          }
        } catch (e) {
          results.push({ ok: false, error: e instanceof AuthError ? e.message : `ошибка: ${e.message}` })
        }
      }
      return results
    },

    'accounts.microsoftLogin': async ({ server }, ws) => {
      const acc = store.addAccount({ type: 'microsoft', username: '', server: server || null, pending: true })
      pendingLogins.set(acc.id, true)
      try {
        const profile = await microsoftLogin(store, acc.id, (data) => {
          send(ws, 'msaCode', { id: acc.id, code: data.user_code, url: data.verification_uri, expiresIn: data.expires_in })
        })
        if (!pendingLogins.has(acc.id)) throw new Error('отменено')
        const dup = store.listAccounts().find(a => a.id !== acc.id && a.uuid === profile.id)
        if (dup) {
          store.removeAccount(acc.id)
          throw new Error(`${profile.name} уже добавлен`)
        }
        store.updateAccount(acc.id, { username: profile.name, uuid: profile.id, pending: undefined })
        return { name: profile.name }
      } catch (e) {
        if (store.getAccount(acc.id)?.pending) store.removeAccount(acc.id)
        throw e
      } finally {
        pendingLogins.delete(acc.id)
      }
    },
    'accounts.cancelMicrosoft': () => {
      for (const id of pendingLogins.keys()) { pendingLogins.delete(id); store.removeAccount(id) }
    }
  }

  function send (ws, type, data) { if (ws.readyState === 1) ws.send(JSON.stringify({ type, data })) }

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.on('message', async (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      const h = handlers[msg.type]
      if (!h) { send(ws, 'res', { reqId: msg.reqId, ok: false, error: 'unknown request ' + msg.type }); return }
      try {
        const data = await h(msg.data || {}, ws)
        send(ws, 'res', { reqId: msg.reqId, ok: true, data })
      } catch (e) {
        send(ws, 'res', { reqId: msg.reqId, ok: false, error: e.message || String(e) })
      }
    })
  })

  // don't list half-finished microsoft logins from a previous run
  for (const a of store.listAccounts().filter(a => a.pending)) store.removeAccount(a.id)

  return new Promise((resolve, reject) => {
    const tryListen = (p) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && fallback && p !== 0) tryListen(0)
        else reject(e)
      })
      server.listen(p, '127.0.0.1', () => {
        actualPort = server.address().port
        resolve({
          port: actualPort,
          url: `http://127.0.0.1:${actualPort}/`,
          app,
          async close () {
            await manager.disconnectAll()
            store.flush()
            for (const ws of clients) ws.terminate()
            await new Promise(r => server.close(r))
          }
        })
      })
    }
    tryListen(port)
  })
}

module.exports = { startServer, createApp }

// standalone: `node src/server.js [--port 7878] [--open]`
if (require.main === module) {
  const args = process.argv.slice(2)
  const pi = args.indexOf('--port')
  const port = pi >= 0 ? Number(args[pi + 1]) : Number(process.env.BOTIFY_PORT) || 7878
  startServer({ port }).then((srv) => {
    console.log(`Botify → ${srv.url}`)
    console.log(`данные: ${srv.app.store.dir}`)
    if (args.includes('--open')) {
      const { exec } = require('child_process')
      const cmd = process.platform === 'win32' ? `start "" "${srv.url}"` : process.platform === 'darwin' ? `open "${srv.url}"` : `xdg-open "${srv.url}"`
      exec(cmd)
    }
    let closing = false
    const shutdown = async () => {
      if (closing) process.exit(0)
      closing = true
      console.log('\nвыключаю ботов…')
      await Promise.race([srv.close(), new Promise(r => setTimeout(r, 4000))])
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }).catch((e) => { console.error(e); process.exit(1) })
}
