'use strict'

// Resolve a request once its attempt starts, but wait for spawn/end before starting
// the next account. Failed logins release their slot just like successful logins.
class ConnectionQueue {
  constructor (delay) {
    this.delay = delay
    this.pending = []
    this.entries = new Map()
    this.running = false
  }

  add (bot) {
    if (this.entries.has(bot)) return this.entries.get(bot).started
    const entry = { bot }
    entry.started = new Promise(resolve => { entry.resolve = resolve })
    this.entries.set(bot, entry)
    this.pending.push(entry)
    bot.manualStop = false
    bot.setState('queued')
    this.run()
    return entry.started
  }

  cancel (bot) {
    const index = this.pending.findIndex(entry => entry.bot === bot)
    if (index < 0) return
    const [entry] = this.pending.splice(index, 1)
    this.entries.delete(bot)
    entry.resolve()
  }

  async run () {
    if (this.running) return
    this.running = true
    try {
      while (this.pending.length) {
        const entry = this.pending.shift()
        const bot = entry.bot
        let finish
        const settled = new Promise(resolve => { finish = resolve })
        bot.on('connectionSettled', finish)
        try {
          await bot._connectNow()
          entry.resolve()
          if (bot.state === 'connecting') await settled
        } catch (err) {
          bot.log('err', err.message)
          bot.setState('error', err.message)
        } finally {
          entry.resolve()
          bot.off('connectionSettled', finish)
          this.entries.delete(bot)
        }
        const delay = Math.max(0, Number(this.delay()) || 0)
        if (this.pending.length && delay) await new Promise(resolve => setTimeout(resolve, delay))
      }
    } finally { this.running = false }
  }
}

module.exports = { ConnectionQueue }
