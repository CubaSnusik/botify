'use strict'

function aborted () { return new Error('Digging aborted') }

// Wait on the same tick clock as mining. A release/disconnect must settle the wait
// even when physics has stopped and no more ticks will arrive.
function retryDelay (bot, signal, count = 5) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      bot.off('physicsTick', tick)
      signal?.removeEventListener('abort', cancel)
      error ? reject(error) : resolve()
    }
    const tick = () => { if (--count <= 0) finish() }
    const cancel = () => finish(signal.reason ?? aborted())
    bot.on('physicsTick', tick)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    else if (bot._client.state !== 'play') finish(new Error('соединение или мир изменились'))
  })
}

/** Hold attack on one target until the server changes it or the user releases it. */
async function digUntilChanged (bot, block, face, signal, onRetry = () => {}) {
  const initialTool = bot.heldItem?.type
  const initialSlot = bot.quickBarSlot
  let retries = 0
  let stopped = false
  let confirmation = null
  const sent = packet => {
    if (packet.status === 2 && Number.isInteger(packet.sequence) && block.position.equals(packet.location)) {
      confirmation = { sequence: packet.sequence, ticks: 0, returned: false, acknowledged: false }
    }
  }
  const updated = (_old, current) => {
    if (confirmation && current?.position.equals(block.position) && current.type === block.type) confirmation.returned = true
  }
  const acknowledged = packet => {
    const sequence = packet.sequenceId ?? packet.sequence
    if (confirmation && sequence >= confirmation.sequence) confirmation.acknowledged = true
  }
  const tick = () => {
    if (!confirmation) return
    confirmation.ticks++
    // MultiPlayerGameMode's destroyDelay is five client ticks. A matching STOP
    // acknowledgement plus the returned block resolves the failed prediction;
    // ACK alone must never mean either success or failure.
    if (confirmation.ticks >= 5 && confirmation.returned && confirmation.acknowledged) {
      confirmation = null
      const error = new Error('сервер обработал завершение копания и вернул прежний блок')
      error.code = 'BOTIFY_DIG_CORRECTED'
      // The client's predicted destroy has already ended. Do not insert ABORT
      // between a completed STOP and the next held-button START.
      bot.stopDigging(error, false)
    }
  }
  const released = new AbortController()
  const end = () => {
    stopped = true
    released.abort(new Error('соединение или мир изменились'))
  }
  const cancel = () => {
    released.abort(aborted())
    if (bot.targetDigBlock) bot.stopDigging()
  }
  // The patched digging plugin forwards disconnect, respawn, configuration and
  // death here, including when no individual dig is active during the retry gap.
  bot.on('botifyDigReset', end)
  bot.on('botifyDigPacket', sent)
  bot.on('blockUpdate', updated)
  bot.on('physicsTick', tick)
  bot._client.on('acknowledge_player_digging', acknowledged)
  signal?.addEventListener('abort', cancel)
  try {
    while (true) {
      if (signal?.aborted) throw aborted()
      if (stopped || bot._client.state !== 'play') throw new Error('соединение или мир изменились')
      const current = bot.blockAt(block.position)
      if (!current) throw new Error('чанк не загружен')
      // No local air prediction: the world was updated by the server between attempts.
      if (current.type !== block.type) return
      if (bot.heldItem?.type !== initialTool || bot.quickBarSlot !== initialSlot) throw new Error('инструмент изменился во время копания')
      if (bot.currentWindow || bot.inventory?.selectedItem) throw new Error('перед копанием закрой инвентарь и убери предмет с курсора')
      const hit = bot.blockAtCursor(4.5)
      if (!hit || !hit.position.equals(block.position)) throw new Error('прицел ушёл с блока или блок вне досягаемости')
      try {
        confirmation = null
        await bot.dig(current, 'ignore', face)
        return
      } catch (error) {
        if (signal?.aborted) throw aborted()
        if (!['BOTIFY_DIG_UNCONFIRMED', 'BOTIFY_DIG_CORRECTED'].includes(error.code)) throw error
        onRetry(++retries)
        if (error.code === 'BOTIFY_DIG_CORRECTED') continue // destroyDelay already elapsed
        // A full attempt already waited five seconds. Release, then leave the normal
        // destroy delay before START. Never send repeated STOP packets while waiting.
        await retryDelay(bot, released.signal)
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    bot.off('botifyDigReset', end)
    bot.off('botifyDigPacket', sent)
    bot.off('blockUpdate', updated)
    bot.off('physicsTick', tick)
    bot._client.off('acknowledge_player_digging', acknowledged)
  }
}

module.exports = { digUntilChanged }
