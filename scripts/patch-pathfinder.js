'use strict'
const fs = require('node:fs')

const OLD_STOP = `  function fullStop () {
    bot.clearControlStates()

    // Force horizontal velocity to 0 (otherwise inertia can move us too far)
    // Kind of cheaty, but the server will not tell the difference
    bot.entity.velocity.x = 0
    bot.entity.velocity.z = 0

    const blockX = Math.floor(bot.entity.position.x) + 0.5
    const blockZ = Math.floor(bot.entity.position.z) + 0.5

    // Make sure our bounding box don't collide with neighboring blocks
    // otherwise recenter the position
    if (Math.abs(bot.entity.position.x - blockX) > 0.2) { bot.entity.position.x = blockX }
    if (Math.abs(bot.entity.position.z - blockZ) > 0.2) { bot.entity.position.z = blockZ }
  }`

const NEW_STOP = `  function fullStop () {
    // Botify: release keys; only physics may change position or velocity when stopping.
    bot.clearControlStates()
  }`

const OLD_TURN = '    bot.look(Math.atan2(-dx, -dz), 0)\n    bot.setControlState(\'forward\', true)'
const NEW_TURN = `    bot.look(Math.atan2(-dx, -dz), 0)
    // Botify: face the route before accelerating; braking remains ordinary physics.
    if (bot.smoothLook && !bot.smoothLook.isAligned(Math.atan2(-dx, -dz))) {
      bot.clearControlStates()
      return
    }
    bot.setControlState('forward', true)`

const NAVIGATION_TURN = NEW_TURN.replace('    bot.look(Math.atan2(-dx, -dz), 0)', `    // Botify: navigation has a relaxed heading target; block interactions keep precise aim.
    if (bot.smoothLook?.navigate) bot.smoothLook.navigate(Math.atan2(-dx, -dz))
    else bot.look(Math.atan2(-dx, -dz), 0)`)

const SPIN_TURN = `    // Botify: spin follows the same planned nodes with keys resolved before physics.
    if (bot._botifySpinNavigation) {
      bot._botifySpinNavigation.route(nextPoint, path, physics)
      if (performance.now() - lastNodeTime > 3500) resetPath('stuck')
      return
    }
${NAVIGATION_TURN}`

function patchSimulation () {
  const file = require.resolve('mineflayer-pathfinder/lib/physics')
  const source = fs.readFileSync(file, 'utf8')
  const before = '  getController (nextPoint, jump, sprint, jumpAfter = 0) {\n'
  const after = `${before}    // Botify: predict the same rotating heading and WASD that the next ticks use.
    if (this.bot._botifySpinNavigation) return this.bot._botifySpinNavigation.controller(nextPoint, jump, sprint, jumpAfter)
`
  const normalized = source.replace(/\r\n/g, '\n')
  if (normalized.includes(after)) return
  if (normalized.split(before).length !== 2) throw new Error('Unsupported pathfinder simulation: review scripts/patch-pathfinder.js')
  if (require.cache[file]) throw new Error('Apply the pathfinder patch before loading it; restart Botify')
  const patched = normalized.replace(before, after)
  fs.writeFileSync(file, source.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched)
}

function patchPathfinder () {
  const file = require.resolve('mineflayer-pathfinder')
  const source = fs.readFileSync(file, 'utf8')
  let patched = source.replace(/\r\n/g, '\n')
  for (const [before, after] of [[OLD_STOP, NEW_STOP], [patched.includes(NEW_TURN) ? NEW_TURN : OLD_TURN, NAVIGATION_TURN], [NAVIGATION_TURN, SPIN_TURN]]) {
    if (patched.includes(after)) continue
    if (patched.split(before).length !== 2) throw new Error('Unsupported pathfinder: review scripts/patch-pathfinder.js for this dependency version')
    patched = patched.replace(before, after)
  }
  if (patched !== source.replace(/\r\n/g, '\n')) {
    if (require.cache[file]) throw new Error('Apply the pathfinder patch before loading it; restart Botify')
    fs.writeFileSync(file, source.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched)
  }
  patchSimulation()
}

module.exports = patchPathfinder
if (require.main === module) patchPathfinder()
