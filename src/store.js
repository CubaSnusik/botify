'use strict'
/*
 * Local storage. Everything is plain JSON in ./data (or $BOTIFY_DATA):
 *
 *   data/settings.json      global server + behaviour settings
 *   data/accounts.json      one entry per bot, INCLUDING tokens (plain text, by design)
 *   data/auth-cache/<id>/   prismarine-auth cache for "Microsoft login" accounts
 *   data/cache/skins/       downloaded skin PNGs
 *
 * Writes are atomic (tmp file + rename) so a crash never leaves half a JSON file.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { DEFAULT_FARM, farmSettings, friendNames } = require('./farm-settings')

const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = process.env.BOTIFY_DATA ? path.resolve(process.env.BOTIFY_DATA) : path.join(ROOT, 'data')

const DEFAULT_SETTINGS = {
  server: { host: 'localhost', port: null, version: 'auto' }, // port null → 25565 or SRV record
  behavior: {
    autoReconnect: true,
    reconnectDelay: 5000, // ms
    joinStagger: 1500, // ms after each settled login before starting the next queued account
    viewDistance: 'short' // tiny | short | normal | far
  },
  ui: { theme: 'dark' },
  farm: DEFAULT_FARM,
  friends: []
}

function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // keep the broken file around instead of silently overwriting it
      const backup = `${file}.broken-${Date.now()}`
      try { fs.copyFileSync(file, backup) } catch {}
      console.error(`[store] ${path.basename(file)} is not valid JSON, backup: ${backup}`)
    }
    return fallback
  }
}

function writeJsonAtomic (file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function merge (base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v)
      : v
  }
  return out
}

class Store extends EventEmitter {
  constructor (dir = DATA_DIR) {
    super()
    this.dir = dir
    this.settingsFile = path.join(dir, 'settings.json')
    this.accountsFile = path.join(dir, 'accounts.json')
    fs.mkdirSync(dir, { recursive: true })

    this.settings = merge(DEFAULT_SETTINGS, readJson(this.settingsFile, {}))
    const acc = readJson(this.accountsFile, { version: 1, accounts: [] })
    this.accounts = Array.isArray(acc.accounts) ? acc.accounts : []
    this._timers = {}
    this.saveSettings()
    this.saveAccounts()
  }

  path (...p) { return path.join(this.dir, ...p) }

  _debounced (key, fn) {
    clearTimeout(this._timers[key])
    this._timers[key] = setTimeout(fn, 150)
  }

  saveSettings () { this._debounced('s', () => writeJsonAtomic(this.settingsFile, this.settings)) }
  saveAccounts () { this._debounced('a', () => writeJsonAtomic(this.accountsFile, { version: 1, accounts: this.accounts })) }

  flush () {
    for (const t of Object.values(this._timers)) clearTimeout(t)
    writeJsonAtomic(this.settingsFile, this.settings)
    writeJsonAtomic(this.accountsFile, { version: 1, accounts: this.accounts })
  }

  // ---- settings ----
  updateSettings (patch) {
    if ('farm' in patch) patch = { ...patch, farm: farmSettings({ ...this.settings.farm, ...patch.farm }) }
    if ('friends' in patch) patch = { ...patch, friends: friendNames(patch.friends) }
    this.settings = merge(this.settings, patch)
    if (this.settings.server) this.settings.server.port = Number(this.settings.server.port) || null
    this.saveSettings()
    this.emit('settings', this.settings)
    return this.settings
  }

  // ---- accounts ----
  listAccounts () { return this.accounts }
  getAccount (id) { return this.accounts.find(a => a.id === id) }

  addAccount (data) {
    const acc = {
      id: 'b_' + crypto.randomBytes(5).toString('hex'),
      type: 'offline',
      username: '',
      uuid: null,
      server: null, // null → use global server
      autoReconnect: null, // null → use global setting
      createdAt: Date.now(),
      ...data
    }
    this.accounts.push(acc)
    this.saveAccounts()
    this.emit('accounts')
    return acc
  }

  updateAccount (id, patch) {
    const acc = this.getAccount(id)
    if (!acc) return null
    Object.assign(acc, patch)
    this.saveAccounts()
    this.emit('accounts')
    return acc
  }

  removeAccount (id) {
    const i = this.accounts.findIndex(a => a.id === id)
    if (i === -1) return false
    this.accounts.splice(i, 1)
    this.saveAccounts()
    try { fs.rmSync(this.path('auth-cache', id), { recursive: true, force: true }) } catch {}
    this.emit('accounts')
    return true
  }

  reorder (ids) {
    const byId = new Map(this.accounts.map(a => [a.id, a]))
    const next = ids.map(id => byId.get(id)).filter(Boolean)
    for (const a of this.accounts) if (!next.includes(a)) next.push(a)
    this.accounts = next
    this.saveAccounts()
  }
}

module.exports = { Store, DATA_DIR, ROOT }
