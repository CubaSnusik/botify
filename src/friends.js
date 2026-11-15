'use strict'
function friendCommand (store, args) {
  const [action = 'list', name] = args
  const names = [...(store.settings.friends || [])]
  const index = names.findIndex(n => n.toLowerCase() === name?.toLowerCase())
  if (action === 'list' && args.length <= 1) return `друзья всех ботов: ${names.join(', ') || 'список пуст'}`
  if (action === 'clear' && args.length === 1) store.updateSettings({ friends: [] })
  else if (['add', 'remove'].includes(action) && args.length === 2 && /^[A-Za-z0-9_]{1,16}$/.test(name)) {
    if (action === 'add' && index < 0) names.push(name)
    if (action === 'remove' && index >= 0) names.splice(index, 1)
    store.updateSettings({ friends: names })
  } else throw new Error('usage: .friend add/remove <ник> | .friend clear/list')
  return `друзья всех ботов: ${store.settings.friends.join(', ') || 'список пуст'}`
}
function isFriend (inst, entity) {
  const name = typeof entity === 'string' ? entity : entity?.username
  return !!name && (inst.store?.settings.friends || []).some(n => n.toLowerCase() === name.toLowerCase())
}
function ownBot (inst, entity) {
  if (entity === inst.bot?.entity) return true
  return [...(inst.manager?.bots?.values() || [])].some(b => b.bot?.username && b.bot.username.toLowerCase() === entity.username?.toLowerCase())
}
// Only actual player entities in loaded/rendered range count, not the tab list.
function watchFarmPlayers (inst, signal, reply) {
  const bot = inst.bot
  let tripped = false
  const inspect = entity => {
    if (tripped || signal.aborted || !inst.store.settings.farm?.autoLeave) return
    if (entity?.type !== 'player' || entity.isValid === false || !entity.position || ownBot(inst, entity) || isFriend(inst, entity)) return
    tripped = true
    reply(`[автолив] рядом ${entity.username || 'неизвестный игрок'} — отключаюсь без переподключения`)
    // disconnect sets manualStop synchronously and cancels queued/timed reconnects.
    inst.disconnect().catch(error => reply(`[автолив] ${error.message}`))
  }
  const scan = () => { for (const entity of Object.values(bot.entities || {})) inspect(entity) }
  const cleanup = () => {
    bot.off('entitySpawn', inspect); bot.off('entityMoved', inspect); bot.off('physicsTick', scan)
    signal.removeEventListener('abort', cleanup)
  }
  bot.on('entitySpawn', inspect); bot.on('entityMoved', inspect); bot.on('physicsTick', scan)
  signal.addEventListener('abort', cleanup, { once: true })
  if (signal.aborted) cleanup()
  else scan()
  return cleanup
}
module.exports = { isFriend, watchFarmPlayers, friendCommand }
