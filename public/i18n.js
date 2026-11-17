import { english, commands } from './locales/en.js'

let language = 'ru'

export function getLanguage () { return language }

export function localizeCommand (command) {
  const translation = language === 'en' && commands[command.name]
  return translation ? { ...command, usage: translation[0], desc: translation[1] } : command
}

export function setLanguage (value) {
  const next = value === 'en' ? 'en' : 'ru'
  const changed = next !== language
  language = next
  document.documentElement.lang = next
  return changed
}

// Translate only application-owned strings. Chat, names, server dialogs and
// user input must never pass through the translation catalog.
export function t (source, ...values) {
  const text = language === 'en' ? (english[source] ?? source) : source
  return text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match)
}

export function translateStatic () {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    for (const el of document.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)))
  }
}

export function botCount (count) {
  if (language === 'en') return `${count} ${count === 1 ? 'bot' : 'bots'}`
  const suffix = count % 10 === 1 && count % 100 !== 11 ? '' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? 'а' : 'ов'
  return `${count} бот${suffix}`
}
