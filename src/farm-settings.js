'use strict'
const { webhookURL } = require('./discord-webhook')
const DEFAULT_FARM = {
  species: 'spruce', searchRadius: 32, autoLeave: true, restock: true,
  mealLabel: '1', experienceLabel: '2', saplingLabel: '3',
  mealCount: 64, saplingCount: 64, experienceCount: 16,
  discordEnabled: false, discordWebhook: '', axeAlertPercent: 10
}
function farmSettings (input = {}) {
  const out = { ...DEFAULT_FARM, ...input }
  if (!['spruce', 'jungle', 'dark_oak', 'pale_oak'].includes(out.species)) throw new Error('неизвестный вид саженцев')
  for (const [name, min, max] of [['searchRadius', 4, 64], ['mealCount', 4, 256], ['saplingCount', 4, 256], ['experienceCount', 0, 64], ['axeAlertPercent', 1, 100]]) {
    out[name] = Number(out[name])
    if (!Number.isInteger(out[name]) || out[name] < min || out[name] > max) throw new Error(`${name}: допустимо ${min}–${max}`)
  }
  for (const name of ['mealLabel', 'experienceLabel', 'saplingLabel']) {
    out[name] = String(out[name]).trim()
    if (!out[name] || out[name].length > 40) throw new Error('надпись на табличке: 1–40 символов')
  }
  if (new Set([out.mealLabel, out.experienceLabel, out.saplingLabel]).size !== 3) throw new Error('метки контейнеров должны различаться')
  out.autoLeave = !!out.autoLeave
  out.restock = !!out.restock
  out.discordEnabled = !!out.discordEnabled
  out.discordWebhook = webhookURL(out.discordWebhook)
  if (out.discordEnabled && !out.discordWebhook) throw new Error('укажите Discord webhook или отключите уведомления')
  return Object.fromEntries(Object.keys(DEFAULT_FARM).map(k => [k, out[k]]))
}
function friendNames (names) {
  if (!Array.isArray(names) || names.length > 1000) throw new Error('список друзей: не более 1000 ников')
  const result = new Map()
  for (const value of names) {
    const name = String(value).trim()
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error(`неверный ник: ${name}`)
    result.set(name.toLowerCase(), name)
  }
  return [...result.values()]
}
module.exports = { DEFAULT_FARM, farmSettings, friendNames }
