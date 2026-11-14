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

// 1.20.5+ item components: Item#enchants is { enchantments: [{ id, level }] }, not [{ name, lvl }].
// Mineflayer concatenates it with the helmet's and prismarine-block iterates it → TypeError on
// any enchanted tool or helmet. Normalise both to the [{ name, lvl }] list digTime expects.
const ENCHANT_CHANGES = [
  ['function inject (bot) {', `// Botify: normalise component enchantments for digTime.
function botifyEnchantList (registry, item) {
  let list = item?.enchants
  if (list && !Array.isArray(list)) list = list.enchantments ?? list.levels ?? []
  if (!Array.isArray(list)) return []
  return list.map(e => ({
    name: typeof e.name === 'string' ? e.name : registry?.enchantments?.[e.id]?.name ?? String(e.id),
    lvl: e.lvl ?? e.level ?? 0
  }))
}

function inject (bot) {`],
  ['      enchantments = currentlyHeldItem.enchants', '      enchantments = botifyEnchantList(bot.registry, currentlyHeldItem)'],
  ['      const helmetEnchantments = headEquippedItem.enchants', '      const helmetEnchantments = botifyEnchantList(bot.registry, headEquippedItem)']
]

// After STOP_DESTROY the vanilla server either breaks the block (now or as a delayed destroy) or,
// when a plugin/anticheat cancels the break, resends the old block. Report that refusal.
const REFUSAL_CHANGES = [
  ['    let finishSent = false\n    diggingTask = createTask()', '    let finishSent = false\n    let serverReturned = false\n    diggingTask = createTask()'],
  ['      if (!newBlock || newBlock.type === block.type) return', `      if (!newBlock) return
      if (newBlock.type === block.type) {
        // Botify: after STOP the server only resends the old block when it refused the break.
        if (finishSent && !serverReturned) {
          serverReturned = true
          clearTimeout(waitTimeout)
          waitTimeout = setTimeout(() => bot.stopDigging(new Error('сервер вернул блок обратно — не дал сломать (приват/защита, античит или слишком быстро)')), 1000)
        }
        return
      }`]
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

// START belongs to a client tick too. Starting between ticks and crediting the very next
// physicsTick can shorten a two-tick break to just over 50 ms instead of 100 ms.
const ALIGNED_MARKER = '// Botify: align START with the digging tick clock.'
const ALIGNED_CHANGES = [
  ['    let finishSent = false', `    ${ALIGNED_MARKER}
    let started = false
    let finishSent = false`],
  [`    bot._client.write('block_dig', {
      status: 0, // start digging
      location: block.position,
      face: bot.targetDigFace // default face is 1 (top)
    })
    bot.targetDigBlock = block
    bot.swingArm()`, '    bot.targetDigBlock = block'],
  ['      progress = Math.fround(progress + Math.fround(bot.digTime(block, true)))', `      if (!started) {
        started = true
        bot._client.write('block_dig', { status: 0, location: block.position, face: bot.targetDigFace })
        bot.swingArm()
        if (waitTime === 0) finishDigging()
        return // START is not a continueDestroyBlock tick.
      }
      progress = Math.fround(progress + Math.fround(bot.digTime(block, true)))`],
  [`    if (waitTime === 0) waitTimeout = setTimeout(finishDigging, 0)
    else bot.on('physicsTick', digTick)`, "    bot.on('physicsTick', digTick)"],
  ["      if (!finishSent && sendCancel && bot._client.state === 'play') {", "      if (started && !finishSent && sendCancel && bot._client.state === 'play') {"],
  ['      diggingTask.cancel(reason)', `      bot.emit('botifyDigResult', { ok: false, block, started, finishSent, reason: reason.message })
      diggingTask.cancel(reason)`],
  ["      bot.emit('diggingCompleted', newBlock)", `      bot.emit('botifyDigResult', { ok: true, block, started, finishSent })
      bot.emit('diggingCompleted', newBlock)`],
  // A replacement request must not lose its face when cancelling the previous request.
  ['    if (bot.targetDigBlock) bot.stopDigging()', `    if (bot.targetDigBlock) {
      const nextFace = bot.targetDigFace
      bot.stopDigging()
      bot.targetDigFace = nextFace
    }`]
]

// A same-state update is an observation, not a server-provided rejection reason.
// It can also be followed by a delayed destroy; keep the full confirmation deadline.
const OBSERVED_CHANGES = [
  ["bot.stopDigging(new Error('сервер не подтвердил разрушение блока за 5 секунд'))", `bot.stopDigging(new Error(serverReturned
          ? 'сервер повторно прислал этот блок; разрушение не подтверждено за 5 секунд'
          : 'сервер не подтвердил разрушение блока за 5 секунд'))`],
  [`        // Botify: after STOP the server only resends the old block when it refused the break.
        if (finishSent && !serverReturned) {
          serverReturned = true
          clearTimeout(waitTimeout)
          waitTimeout = setTimeout(() => bot.stopDigging(new Error('сервер вернул блок обратно — не дал сломать (приват/защита, античит или слишком быстро)')), 1000)
        }`, `        // Botify: a same-state update does not identify the cause or exclude a delayed destroy.
        if (finishSent) serverReturned = true`]
]

// Legacy experimental gate, retained only to migrate already-patched installations
// back to the client tick clock. Prediction ACKs are not a mining clock.
const ACK_CHANGES = [
  ['    let started = false', `    let started = false
    let startSequence = null
    let waitingForStart = false`],
  [`        bot.swingArm()
        if (waitTime === 0) finishDigging()`, `        bot.swingArm()
        startSequence = bot._botifyDigAcknowledgements?.start ?? null
        if (waitTime > 0 && startSequence != null) {
          waitingForStart = true
          waitTimeout = setTimeout(() => bot.stopDigging(new Error('сервер не подтвердил начало копания за 5 секунд (START)')), 5000)
        }
        if (waitTime === 0) finishDigging()`],
  ['      progress = Math.fround(progress + Math.fround(bot.digTime(block, true)))', `      // Botify: wait for the acknowledged START before counting mining ticks.
      if (waitingForStart) {
        if (bot._botifyDigAcknowledgements.acknowledged < startSequence) {
          bot.swingArm()
          return
        }
        waitingForStart = false
        clearTimeout(waitTimeout)
        waitTimeout = null
      }
      progress = Math.fround(progress + Math.fround(bot.digTime(block, true)))`]
]

// Keep the held attack visible while waiting for the authoritative block change.
// STOP is sent once; extra swings never add another START/STOP or fake block damage.
const HOLD_CHANGES = [
  ['      if (!bot.targetDigBlock || finishSent) return', '      if (!bot.targetDigBlock) return'],
  ['      if (!started) {', `      // Botify: keep swinging until the server changes the block or the dig is cancelled.
      if (bot.currentWindow || bot.inventory?.selectedItem) {
        bot.stopDigging(new Error('открыт инвентарь во время копания'))
        return
      }
      if (finishSent) {
        bot.swingArm()
        return
      }
      if (!started) {`],
  ['    function finishDigging () {\n      stopDigClock()', '    function finishDigging () {\n      // Keep the tick listener for swings and target/tool checks during confirmation.'],
  [`        bot.stopDigging(new Error(serverReturned
          ? 'сервер повторно прислал этот блок; разрушение не подтверждено за 5 секунд'
          : 'сервер не подтвердил разрушение блока за 5 секунд'))`, `        const error = new Error(serverReturned
          ? 'сервер повторно прислал этот блок; разрушение не подтверждено за 5 секунд'
          : 'сервер не подтвердил разрушение блока за 5 секунд')
        error.code = 'BOTIFY_DIG_UNCONFIRMED'
        bot.stopDigging(error)`]
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
  if (!patched.includes(ALIGNED_MARKER)) {
    const changes = [...(patched.includes(MARKER) ? IDLE_GUARDS : [...CHANGES, ...IDLE_GUARDS]), ...ENCHANT_CHANGES, ...REFUSAL_CHANGES]
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
    for (const [before, after] of ALIGNED_CHANGES) {
      if (patched.split(before).length !== 2) throw new Error('Unsupported digging start clock: review scripts/patch-digging.js')
      patched = patched.replace(before, after)
    }
  }
  for (const [before, after] of OBSERVED_CHANGES) {
    if (patched.includes('// Botify: keep swinging until the server changes the block or the dig is cancelled.')) break
    if (patched.includes(after)) continue
    if (patched.split(before).length !== 2) throw new Error('Unsupported digging confirmation: review scripts/patch-digging.js')
    patched = patched.replace(before, after)
  }
  if (patched.includes('// Botify: wait for the acknowledged START before counting mining ticks.')) {
    for (const [before, after] of [...ACK_CHANGES].reverse()) {
      if (patched.split(after).length !== 2) throw new Error('Unsupported digging acknowledgement migration: review scripts/patch-digging.js')
      patched = patched.replace(after, before)
    }
  }
  const cleanupBefore = "      if (started && !finishSent && sendCancel && bot._client.state === 'play') {"
  const cleanupAfter = `      // Botify: STOP is a prediction, not confirmation that the server stopped mining.
      // Release an unsuccessful survival attempt even when STOP was already sent.
      if (started && (!finishSent || waitTime > 0) && sendCancel && bot._client.state === 'play') {`
  if (!patched.includes(cleanupAfter)) {
    if (patched.split(cleanupBefore).length !== 2) throw new Error('Unsupported digging cancellation: review scripts/patch-digging.js')
    patched = patched.replace(cleanupBefore, cleanupAfter)
  }
  if (!patched.includes('// Botify: keep swinging until the server changes the block or the dig is cancelled.')) {
    for (const [before, after] of HOLD_CHANGES) {
      if (patched.split(before).length !== 2) throw new Error('Unsupported held digging: review scripts/patch-digging.js')
      patched = patched.replace(before, after)
    }
  }
  if (!patched.includes('// Botify: release held digging across lifecycle transitions.')) {
    // Reuse the plugin's existing lifecycle listeners. Helpers subscribe to one
    // dedicated event rather than duplicating end/respawn/configuration listeners.
    for (const prefix of ["bot.on('end', () => {", "bot.on('respawn', () => {", "bot._client.on('start_configuration', () => {", "bot.on('death', () => {"]) {
      if (patched.split(prefix).length !== 2) throw new Error('Unsupported digging lifecycle: review scripts/patch-digging.js')
      patched = patched.replace(prefix, prefix + " bot.emit('botifyDigReset');")
    }
    patched = patched.replace(ALIGNED_MARKER, ALIGNED_MARKER + '\n    // Botify: release held digging across lifecycle transitions.')
  }
  if (patched === source.replace(/\r\n/g, '\n')) return
  if (require.cache[file]) throw new Error('Apply the digging patch before loading Mineflayer; restart Botify')
  fs.writeFileSync(file, source.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched)
}

module.exports = patchDigging
if (require.main === module) patchDigging()
