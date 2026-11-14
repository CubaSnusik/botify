'use strict'
/*
 * Item icons (from the minecraft-assets package, fully offline) and player skins
 * for the head avatars (Mojang session server for premium accounts, vanilla
 * default skin picked from the UUID for offline ones — same as the game does).
 */
const fs = require('fs')
const path = require('path')
const { nameToMcOfflineUUID } = require('minecraft-protocol/src/datatypes/uuid')

// `require('minecraft-assets')` eagerly parses the textures, block states and models of EVERY game
// version. Cold reads can delay startup. Botify only
// needs one small file per version (texture_content.json, ~1 MB), so read just that, on demand.
const DATA_DIR = path.join(path.dirname(require.resolve('minecraft-assets')), 'minecraft-assets', 'data')
const versionParts = (v) => v.split('.').map(n => parseInt(n, 10) || 0)
const byVersion = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return 0
}
const ASSET_VERSIONS = fs.readdirSync(DATA_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(DATA_DIR, d.name, 'texture_content.json')))
  .map(d => d.name)
  .sort(byVersion)
  .reverse() // newest first
const assetCache = new Map()

function assetsFor (version) {
  const v = ASSET_VERSIONS.includes(version) ? version : ASSET_VERSIONS[0]
  if (!assetCache.has(v)) {
    const textureContent = {}
    try {
      for (const e of JSON.parse(fs.readFileSync(path.join(DATA_DIR, v, 'texture_content.json'), 'utf8'))) textureContent[e.name] = e
    } catch (e) {
      console.error(`[botify] item icons for ${v} unavailable: ${e.message}`)
    }
    assetCache.set(v, { textureContent, directory: path.join(DATA_DIR, v) })
  }
  return assetCache.get(v)
}

const iconCache = new Map()

/** PNG buffer for an item/block name, or null. */
function getItemIcon (name, version) {
  const key = `${version}|${name}`
  if (iconCache.has(key)) return iconCache.get(key)
  let buf = null
  // try requested version first, then newer→older (new 26.2 items fall back gracefully)
  const order = [...new Set([ASSET_VERSIONS.includes(version) ? version : ASSET_VERSIONS[0], ...ASSET_VERSIONS.slice(0, 4)])]
  // items without their own texture: panes look like their glass, stairs/slabs/walls like the base block
  const names = [name, name.replace(/_pane$/, ''), name.replace(/_(stairs|slab|wall)$/, ''), name.replace(/_(stairs|slab|wall)$/, '_planks'), name.replace(/_(stairs|slab|wall)$/, 's')]
  outer:
  for (const n of [...new Set(names)]) {
    for (const v of order) {
      const a = assetsFor(v)
      const t = a.textureContent[n]?.texture
      if (t && t.startsWith('data:image/png;base64,')) {
        buf = Buffer.from(t.slice(22), 'base64')
        break outer
      }
    }
  }
  iconCache.set(key, buf)
  return buf
}

// ---------- skins ----------
// vanilla DefaultPlayerSkin order: 9 slim then 9 wide
const SKIN_NAMES = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri']
const DEFAULT_SKINS = [...SKIN_NAMES.map(n => `slim/${n}`), ...SKIN_NAMES.map(n => `wide/${n}`)]

function javaUuidHash (uuid) {
  const hex = uuid.replace(/-/g, '')
  const msb = BigInt.asIntN(64, BigInt('0x' + hex.slice(0, 16)))
  const lsb = BigInt.asIntN(64, BigInt('0x' + hex.slice(16)))
  const hilo = msb ^ lsb
  return Number(BigInt.asIntN(32, hilo >> 32n) ^ BigInt.asIntN(32, hilo))
}

function defaultSkinFile (uuid) {
  const idx = ((javaUuidHash(uuid) % 18) + 18) % 18
  const dir = path.join(DATA_DIR, ASSET_VERSIONS[0], 'entity', 'player')
  return path.join(dir, DEFAULT_SKINS[idx] + '.png')
}

class SkinService {
  constructor (cacheDir) {
    this.dir = cacheDir
    fs.mkdirSync(cacheDir, { recursive: true })
    this.pending = new Map()
  }

  /** returns { file } of a 64x64 (or 64x32) skin png for the account */
  async skinFor (acc) {
    if (acc.type === 'offline' || !acc.uuid) {
      return defaultSkinFile(acc.uuid || nameToMcOfflineUUID(acc.username || 'Steve'))
    }
    const uuid = acc.uuid.replace(/-/g, '')
    const file = path.join(this.dir, `${uuid}.png`)
    try {
      const st = fs.statSync(file)
      if (Date.now() - st.mtimeMs < 6 * 3600_000) return file
    } catch {}
    if (!this.pending.has(uuid)) {
      this.pending.set(uuid, this._download(uuid, file).finally(() => this.pending.delete(uuid)))
    }
    try {
      return await this.pending.get(uuid)
    } catch {
      return fs.existsSync(file) ? file : defaultSkinFile(uuid)
    }
  }

  async _download (uuid, file) {
    const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`)
    if (!res.ok) throw new Error('profile ' + res.status)
    const prof = await res.json()
    const tex = prof.properties?.find(p => p.name === 'textures')
    const url = tex && JSON.parse(Buffer.from(tex.value, 'base64').toString()).textures?.SKIN?.url
    if (!url) return defaultSkinFile(uuid)
    const img = await fetch(url.replace(/^http:/, 'https:'))
    if (!img.ok) throw new Error('skin ' + img.status)
    fs.writeFileSync(file, Buffer.from(await img.arrayBuffer()))
    return file
  }
}

module.exports = { getItemIcon, SkinService, ASSET_VERSIONS }
