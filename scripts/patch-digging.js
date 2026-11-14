'use strict'
const fs = require('node:fs')

const MARKER = '// Botify digging: swing on completion and await authoritative block updates.'
const CHANGES = [
  ['function inject (bot) {', `function inject (bot) {\n  ${MARKER}`],
  ['    diggingTask = createTask()', '    let finishSent = false\n    diggingTask = createTask()'],
  [`    function finishDigging () {
      clearInterval(swingInterval)
      clearTimeout(waitTimeout)
      swingInterval = null
      waitTimeout = null
      if (bot.targetDigBlock) {
        bot._client.write('block_dig', {
          status: 2, // finish digging
          location: bot.targetDigBlock.position,
          face: bot.targetDigFace // always the same as the start face
        })
      }
      bot.targetDigBlock = null
      bot.targetDigFace = null
      bot.lastDigTime = performance.now()
      bot._updateBlockState(block.position, 0)
    }`, `    function finishDigging () {
      clearInterval(swingInterval)
      clearTimeout(waitTimeout)
      swingInterval = null
      waitTimeout = null
      if (!bot.targetDigBlock) return
      finishSent = true
      // Instant/creative breaks are completed by START_DESTROY_BLOCK alone.
      if (waitTime > 0 && bot.game.gameMode !== 'creative') {
        bot._client.write('block_dig', {
          status: 2,
          location: bot.targetDigBlock.position,
          face: bot.targetDigFace
        })
        // Completion and swing must reach the server in the same client tick.
        bot.swingArm()
      }
      // Do not invent an air block. Success comes only from the server's block update.
      waitTimeout = setTimeout(() => {
        bot.stopDigging(new Error('сервер не подтвердил разрушение блока за 5 секунд'))
      }, 5000)
    }`],
  ['    bot.stopDigging = () => {', "    bot.stopDigging = (reason = new Error('Digging aborted'), sendCancel = true) => {"],
  [`      bot._client.write('block_dig', {
        status: 1, // cancel digging
        location: bot.targetDigBlock.position,
        face: cancellationDiggingFace
      })`, `      if (!finishSent && sendCancel && bot._client.state === 'play') {
        bot._client.write('block_dig', {
          status: 1,
          location: bot.targetDigBlock.position,
          face: cancellationDiggingFace
        })
      }`],
  ["      diggingTask.cancel(new Error('Digging aborted'))", '      diggingTask.cancel(reason)'],
  ['      if (newBlock?.type !== 0) return', '      if (!newBlock || newBlock.type === block.type) return'],
  ["  bot.on('death', () => {", `  bot.on('end', () => bot.stopDigging(new Error('соединение закрыто'), false))
  bot._client.on('start_configuration', () => bot.stopDigging(new Error('смена сервера'), false))

  bot.on('death', () => {`]
]

// Mineflayer's initial stopDigging is a "noop" that throws any supplied error.
// A disconnect/configuration transition must only cancel an actual dig.
const IDLE_GUARDS = [
  ["bot.on('end', () => bot.stopDigging(new Error('соединение закрыто'), false))", "bot.on('end', () => { if (bot.targetDigBlock) bot.stopDigging(new Error('соединение закрыто'), false) })"],
  ["bot._client.on('start_configuration', () => bot.stopDigging(new Error('смена сервера'), false))", "bot._client.on('start_configuration', () => { if (bot.targetDigBlock) bot.stopDigging(new Error('смена сервера'), false) })"],
  ["    if (!digFace || typeof digFace === 'function') {", "    if (digFace == null || typeof digFace === 'function') {"],
  ['    bot.targetDigFace = 1 // Default (top)', '    bot.targetDigFace = Number.isInteger(digFace) ? digFace : 1 // explicit crosshair face or top'],
  ["      const stoppedBecauseOfNewDigRequest = !currentBlock.position.equals(bot.targetDigBlock.position)\n      const cancellationDiggingFace = !stoppedBecauseOfNewDigRequest ? bot.targetDigFace : 0", '      const cancellationDiggingFace = 0 // DOWN, as in vanilla stopDestroyBlock'],
  ["  bot.on('death', () => {", "  bot.on('respawn', () => { if (bot.targetDigBlock) bot.stopDigging(new Error('смена мира'), false) })\n\n  bot.on('death', () => {"]
]

const TICK_CHANGES = [
  ['  let swingInterval = null', `  let swingInterval = null
  let digTick = null
  const stopDigClock = () => {
    if (digTick) bot.removeListener('physicsTick', digTick)
    digTick = null
    clearInterval(swingInterval)
  }`],
  [`    waitTimeout = setTimeout(finishDigging, waitTime)
    bot.targetDigBlock = block
    bot.swingArm()

    swingInterval = setInterval(() => {
      bot.swingArm()
    }, 350)`, `    bot.targetDigBlock = block
    bot.swingArm()
    let progress = 0
    const initialTool = bot.heldItem?.type
    // Botify: accumulate block damage on client ticks, never on elapsed wall-clock time.
    digTick = () => {
      if (!bot.targetDigBlock || finishSent) return
      if (bot.heldItem?.type !== initialTool) {
        bot.stopDigging(new Error('инструмент изменился во время копания'))
        return
      }
      if (bot.blockAtCursor) {
        const hit = bot.blockAtCursor(4.5)
        if (!hit || !hit.position.equals(block.position)) {
          bot.stopDigging(new Error('прицел ушёл с блока или блок вне досягаемости'))
          return
        }
      }
      progress = Math.fround(progress + Math.fround(bot.digTime(block, true)))
      if (progress >= 1) finishDigging()
      else bot.swingArm()
    }
    if (waitTime === 0) waitTimeout = setTimeout(finishDigging, 0)
    else bot.on('physicsTick', digTick)`],
  ['      clearInterval(swingInterval)', '      stopDigClock()'],
  ['  function digTime (block) {', '  function digTime (block, asProgress = false) {'],
  ['      bot.entity.effects\n', '      bot.entity.effects,\n      asProgress\n']
]

function patchBlockProgress () {
  const file = require.resolve('prismarine-block')
  const original = fs.readFileSync(file, 'utf8')
  let next = original.replace(/\r\n/g, '\n')
  if (next.includes('// Botify: expose per-tick damage before rounding to a duration.')) return
  for (const [before, after] of [
    ['digTime (heldItemType, creative, inWater, notOnGround, enchantments = [], effects = {}) {', 'digTime (heldItemType, creative, inWater, notOnGround, enchantments = [], effects = {}, asProgress = false) {'],
    ['      if (creative) return 0', '      if (creative) return asProgress ? 1 : 0'],
    ['      // Delta will always be zero if block has -1.0 durability', `      // Botify: expose per-tick damage before rounding to a duration.
      if (asProgress) return blockHardness === -1.0 ? 0 : blockBreakingDelta

      // Delta will always be zero if block has -1.0 durability`]
  ]) {
    if (next.split(before).length !== 2) throw new Error('Unsupported prismarine-block: review digging progress patch')
    next = next.replace(before, after)
  }
  if (require.cache[file]) throw new Error('Apply digging progress patch before loading prismarine-block; restart Botify')
  fs.writeFileSync(file, original.includes('\r\n') ? next.replace(/\n/g, '\r\n') : next)
}

function patchDigging () {
  patchBlockProgress()
  const file = require.resolve('mineflayer/lib/plugins/digging')
  const source = fs.readFileSync(file, 'utf8')
  let patched = source.replace(/\r\n/g, '\n')
  const changes = patched.includes(MARKER) ? IDLE_GUARDS : [...CHANGES, ...IDLE_GUARDS]
  for (const [before, after] of changes) {
    if (patched.includes(after)) continue
    if (patched.split(before).length !== 2) throw new Error('Unsupported digging plugin: review scripts/patch-digging.js for this dependency version')
    patched = patched.replace(before, after)
  }
  if (!patched.includes('// Botify: accumulate block damage on client ticks')) {
    for (const [before, after] of TICK_CHANGES) {
      const count = patched.split(before).length - 1
      if (count !== (before === '      clearInterval(swingInterval)' ? 3 : 1)) throw new Error('Unsupported digging tick clock: review scripts/patch-digging.js')
      patched = patched.split(before).join(after)
    }
  }
  if (patched === source.replace(/\r\n/g, '\n')) return
  if (require.cache[file]) throw new Error('Apply the digging patch before loading Mineflayer; restart Botify')
  fs.writeFileSync(file, source.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched)
}

module.exports = patchDigging
if (require.main === module) patchDigging()
