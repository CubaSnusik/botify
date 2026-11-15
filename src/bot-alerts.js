'use strict'
const { safeText } = require('./discord-webhook')
const { findAxe } = require('./tree-chopper')

class BotAlerts {
  constructor (inst) { this.inst = inst; this.sent = new Map(); this.failures = []; this.lastDeliveryError = -Infinity }
  get config () { return this.inst.store.settings.farm || {} }
  enabled () { return this.config.discordEnabled && this.config.discordWebhook }

  notify (key, title, detail, { force = false } = {}) {
    if (!this.enabled()) return Promise.resolve(false)
    const now = Date.now()
    if (!force && now - (this.sent.get(key) ?? -Infinity) < 300000) return Promise.resolve(false)
    this.sent.set(key, now)
    const inst = this.inst
    const body = `**${title}**\nБот: ${safeText(inst.acc?.username || inst.id)}\nСервер: ${safeText(inst.server().host)}\n${safeText(detail)}\n${new Date(now).toISOString()}`
    return Promise.resolve().then(() => inst.manager.discord.send(this.config.discordWebhook, body)).then(() => true).catch(error => {
      if (Date.now() - this.lastDeliveryError >= 60000) {
        this.lastDeliveryError = Date.now()
        inst.log('sys', `[Discord] уведомление не доставлено: ${safeText(error.message)}`)
      }
      if (force) throw error
      return false
    })
  }

  log (kind, text) {
    if (!this.enabled() || kind === 'chat' || kind === 'cmd' || text.startsWith('[Discord]')) return
    if (/^кикнут/.test(text)) { void this.notify('kick', 'Кик / возможный бан — ответ сервера', text); return }
    if (/^\[автолив\]/.test(text)) { void this.notify('leave', 'Автолив: рядом посторонний игрок', text); return }
    if (/^отключён/.test(text)) {
      if (['kick', 'leave'].some(key => Date.now() - (this.sent.get(key) ?? -Infinity) < 10000)) return
      void this.notify('connection', 'Бот отключился', text); return
    }
    if (/^бот умер$/.test(text)) { void this.notify('death', 'Бот погиб', text); return }
    if (/^\[движение\] остановлено после/.test(text)) {
      void this.notify('corrections', 'Движение остановлено после частых коррекций', `${text}\nПричина коррекций неизвестна; флаг античита не подтверждён.`); return
    }
    if (/^\[(коррекция|проверка)\]/.test(text)) {
      this.failures = this.failures.filter(t => Date.now() - t < 30000)
      const n = Number(text.match(/^\[коррекция\] ещё (\d+)/)?.[1] || 1)
      for (let i = 0; i < Math.min(3, n); i++) this.failures.push(Date.now())
      if (this.failures.length >= 3) {
        void this.notify('corrections', 'Повторяются коррекции или сбои действий', `${text}\nНе менее трёх событий за 30 секунд. Возможны задержка, защита или рассинхронизация; флаг античита не подтверждён.`)
        this.failures = []
      }
    }
    // Supply alerts come directly from an opened container inspection, never
    // from an empty player inventory, missing sign or unsuccessful transfer.
    if (kind === 'err' && /^\.(?:autotree|autotreefarm|tree)\b/.test(text) && !/отменено$/.test(text)) {
      void this.notify('farm-error', 'Ошибка автофермы', text)
    }
  }

  inventory () {
    if (!this.enabled() || !this.inst.bot?.inventory) return
    const bot = this.inst.bot
    let axe
    try { axe = findAxe(bot) } catch { return }
    if (!axe) return
    const max = axe.maxDurability; const used = axe.durabilityUsed
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(used)) return
    const remaining = Math.max(0, max - used)
    if (remaining / max * 100 <= (this.config.axeAlertPercent ?? 10)) {
      void this.notify('axe', 'Мало прочности у топора', `Осталось ${remaining}/${max} (${(remaining / max * 100).toFixed(1)}%). Автоматическая починка не включена.`)
    } else this.sent.delete('axe')
  }
}
module.exports = { BotAlerts }
