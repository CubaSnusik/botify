'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Botify ships its own index.js for mineflayer-pathfinder (scripts/pathfinder-index.js):
// rolling planning, look-ahead, steering while turning, falling into lower nodes, and a
// stop that only releases keys. lib/ (A*, movements, goals) stays upstream.
const SUPPORTED_VERSION = '2.4.5'
const SOURCE = path.join(__dirname, 'pathfinder-index.js')

const normalize = text => text.replace(/\r\n/g, '\n')

function patchSimulation () {
  const file = require.resolve('mineflayer-pathfinder/lib/physics')
  const source = fs.readFileSync(file, 'utf8')
  const before = '  getController (nextPoint, jump, sprint, jumpAfter = 0) {\n'
  const after = `${before}    // Botify: predict the same rotating heading and WASD that the next ticks use.
    if (this.bot._botifySpinNavigation) return this.bot._botifySpinNavigation.controller(nextPoint, jump, sprint, jumpAfter)
`
  const normalized = normalize(source)
  if (normalized.includes(after)) return
  if (normalized.split(before).length !== 2) throw new Error('Unsupported pathfinder simulation: review scripts/patch-pathfinder.js')
  if (require.cache[file]) throw new Error('Apply the pathfinder patch before loading it; restart Botify')
  const patched = normalized.replace(before, after)
  fs.writeFileSync(file, source.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched)
}

function patchPathfinder () {
  const file = require.resolve('mineflayer-pathfinder')
  const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'package.json'), 'utf8'))
  if (version !== SUPPORTED_VERSION) {
    throw new Error(`Unsupported mineflayer-pathfinder ${version} (expected ${SUPPORTED_VERSION}): review scripts/pathfinder-index.js`)
  }
  const wanted = normalize(fs.readFileSync(SOURCE, 'utf8'))
  if (normalize(fs.readFileSync(file, 'utf8')) !== wanted) {
    if (require.cache[file]) throw new Error('Apply the pathfinder patch before loading it; restart Botify')
    fs.writeFileSync(file, wanted)
  }
  patchSimulation()
}

module.exports = patchPathfinder
if (require.main === module) patchPathfinder()
