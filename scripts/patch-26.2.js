#!/usr/bin/env node
/*
 * Botify: adds Minecraft 26.2 (protocol 776) support to mineflayer.
 *
 * Released mineflayer 4.39 / minecraft-protocol 1.68 / minecraft-data 3.119
 * only go up to 26.1. Support for 26.2 exists in PrismarineJS PRs
 * (minecraft-data#1344, node-minecraft-protocol#1550, mineflayer#4192) and
 * those PRs say that only the DATA changes — no code changes are needed.
 *
 * This script:
 *   1. downloads data/pc/26.2/*.json from a pinned commit of the PR branch
 *   2. registers 26.2 in minecraft-data's dataPaths.json + versions.json
 *   3. regenerates minecraft-data/data.js
 *   4. adds '26.2' to the version lists of minecraft-protocol and mineflayer
 *
 * Idempotent: running it again does nothing if already patched.
 * Runs automatically as npm "postinstall". Remove it once upstream releases 26.2.
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const VERSION = '26.2'
const REPO = 'Cyverno/minecraft-data'
const COMMIT = '6cff26d8dd4cc3fe8c54728695124b95e3c8e0ae' // PR #1344 head (pc26.2-data-fixes)
const FILES = [
  'attributes', 'biomes', 'blockCollisionShapes', 'blockLoot', 'blocks', 'commands',
  'entities', 'entityLoot', 'foods', 'items', 'language', 'loginPacket', 'materials',
  'particles', 'protocol', 'recipes', 'sounds', 'tints', 'version'
]

const ROOT = path.resolve(__dirname, '..')
const NM = path.join(ROOT, 'node_modules')
const MCD = path.join(NM, 'minecraft-data')
const DATA = path.join(MCD, 'minecraft-data', 'data')

const log = (...a) => console.log('[botify:26.2]', ...a)

async function download (rel, dest) {
  const url = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/${rel}`
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'botify-patcher' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      JSON.parse(buf.toString('utf8')) // validate
      fs.writeFileSync(dest, buf)
      return
    } catch (e) {
      if (attempt === 3) throw new Error(`${rel}: ${e.message}`)
      await new Promise(r => setTimeout(r, 1000 * attempt))
    }
  }
}

function patchVersionList (file, re) {
  if (!fs.existsSync(file)) { log('skip (not found):', path.relative(ROOT, file)); return }
  let src = fs.readFileSync(file, 'utf8')
  if (src.includes(`'${VERSION}'`)) return
  const next = src.replace(re, (m) => m.replace(/'26\.1'\]/, `'26.1', '${VERSION}']`))
  if (next === src) { log('WARN: could not patch', path.relative(ROOT, file)); return }
  fs.writeFileSync(file, next)
  log('patched', path.relative(ROOT, file))
}

async function main () {
  if (!fs.existsSync(MCD)) { log('minecraft-data not installed, skipping'); return }

  const dir = path.join(DATA, 'pc', VERSION)
  fs.mkdirSync(dir, { recursive: true })
  const missing = FILES.filter(f => !fs.existsSync(path.join(dir, f + '.json')))
  if (missing.length) {
    log(`downloading ${missing.length} data files for ${VERSION}...`)
    await Promise.all(missing.map(f => download(`data/pc/${VERSION}/${f}.json`, path.join(dir, f + '.json'))))
  }

  // dataPaths.json
  const dpFile = path.join(DATA, 'dataPaths.json')
  const dp = JSON.parse(fs.readFileSync(dpFile, 'utf8'))
  let regen = false
  const hasFile = (key, p) => {
    const d = path.join(DATA, p)
    return fs.existsSync(d) && fs.readdirSync(d).some(f => f.startsWith(key + '.'))
  }
  const bad = dp.pc[VERSION] && Object.entries(dp.pc[VERSION]).some(([k, p]) => !hasFile(k, p))
  if (!dp.pc[VERSION] || bad) {
    // unchanged categories (effects, enchantments, windows, ...) are inherited from 26.1
    const entry = { ...dp.pc['26.1'] }
    for (const f of FILES) entry[f] = `pc/${VERSION}`
    dp.pc[VERSION] = entry
    fs.writeFileSync(dpFile, JSON.stringify(dp, null, 2))
    regen = true
    log('registered in dataPaths.json')
  }

  // common/versions.json (drives supportedVersions)
  const vFile = path.join(DATA, 'pc', 'common', 'versions.json')
  const versions = JSON.parse(fs.readFileSync(vFile, 'utf8'))
  if (!versions.includes(VERSION)) {
    versions.splice(versions.indexOf('26.1') + 1, 0, VERSION)
    fs.writeFileSync(vFile, JSON.stringify(versions, null, 2))
    regen = true
  }

  const dataJs = path.join(MCD, 'data.js')
  if (regen || !fs.readFileSync(dataJs, 'utf8').includes(`'${VERSION}': {`)) {
    execFileSync(process.execPath, [path.join(MCD, 'bin', 'generate_data.js')], { cwd: MCD, stdio: 'ignore' })
    log('regenerated minecraft-data/data.js')
  }

  patchVersionList(path.join(NM, 'minecraft-protocol', 'src', 'version.js'), /supportedVersions:\s*\[[^\]]*\]/)
  patchVersionList(path.join(NM, 'mineflayer', 'lib', 'version.js'), /testedVersions\s*=\s*\[[^\]]*\]/)

  // prismarine-chunk picks the chunk format by major version; 26.2 uses the same as 26.1
  const chunkIdx = path.join(NM, 'prismarine-chunk', 'src', 'index.js')
  if (fs.existsSync(chunkIdx)) {
    const src = fs.readFileSync(chunkIdx, 'utf8')
    if (!src.includes(`'${VERSION}':`)) {
      const next = src.replace(/(\n(\s*)26\.1: require\('([^']+)'\))/, `$1,\n$2'${VERSION}': require('$3')`)
      if (next !== src) { fs.writeFileSync(chunkIdx, next); log('patched prismarine-chunk') } else log('WARN: could not patch prismarine-chunk')
    }
  }

  // minecraft-protocol bug: writing an inline registryEntryHolder (e.g. an inline dialog, or an item
  // component with an inline instrument/song) skips the 0 marker byte with `offset += 1` instead of
  // writing it, so the packet carries a random byte from an uninitialized buffer.
  const compMc = path.join(NM, 'minecraft-protocol', 'src', 'datatypes', 'compiler-minecraft.js')
  if (fs.existsSync(compMc)) {
    const src = fs.readFileSync(compMc, 'utf8')
    const bad = /(\} else if \(\$\{otherwiseName\}\) \{\n)(\s*)offset \+= 1\n/
    if (bad.test(src)) {
      fs.writeFileSync(compMc, src.replace(bad, '$1$2buffer[offset++] = 0 // botify: write the inline marker\n'))
      log('patched minecraft-protocol registryEntryHolder writer')
    }
  }

  // minecraft-data bug: serverbound custom_click_action (answer to a server dialog) is described as
  // "optional bool + NBT", but vanilla encodes the payload as a VarInt length-prefixed byte block
  // holding an optional tag (an END byte when empty). Servers kick with
  // "Failed to decode packet 'serverbound/minecraft:custom_click_action'". Make it a raw byte block;
  // Botify fills it in (src/screens.js).
  let ccaPatched = 0
  for (const dir of fs.readdirSync(path.join(DATA, 'pc'))) {
    const file = path.join(DATA, 'pc', dir, 'protocol.json')
    if (!fs.existsSync(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    if (!src.includes('packet_common_custom_click_action')) continue
    const proto = JSON.parse(src)
    const def = proto.types?.packet_common_custom_click_action
    const field = Array.isArray(def) && def[1].find(f => f.name === 'nbt' && JSON.stringify(f.type) === '["option","anonymousNbt"]')
    if (!field) continue
    field.name = 'payload'
    field.type = ['buffer', { countType: 'varint' }]
    fs.writeFileSync(file, JSON.stringify(proto, null, 2))
    ccaPatched++
  }
  if (ccaPatched) log(`patched custom_click_action encoding in ${ccaPatched} protocol versions`)

  // prismarine-physics feature table (liquid gravity, ladder climbing) — must match vanilla
  const physFeat = path.join(NM, 'prismarine-physics', 'lib', 'features.json')
  if (fs.existsSync(physFeat)) {
    const feats = JSON.parse(fs.readFileSync(physFeat, 'utf8'))
    let changed = false
    for (const f of feats) {
      if (f.versions.includes('26.1') && !f.versions.includes(VERSION)) { f.versions.push(VERSION); changed = true }
    }
    if (changed) { fs.writeFileSync(physFeat, JSON.stringify(feats, null, 2)); log('patched prismarine-physics features') }
  }

  log('ok — Minecraft', VERSION, 'enabled')
}

main().catch(e => {
  console.error('[botify:26.2] FAILED:', e.message)
  console.error('[botify:26.2] Bots will still work on <= 26.1 servers (and on 26.2 servers with ViaVersion).')
})
