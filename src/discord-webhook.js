'use strict'
const timers = require('node:timers/promises')

function webhookURL (value) {
  if (!value) return ''
  let url
  try { url = new URL(String(value).trim()) } catch { throw new Error('некорректный Discord webhook URL') }
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname) ||
      url.port || url.username || url.password || !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(url.pathname)) {
    throw new Error('нужна HTTPS-ссылка Discord вида discord.com/api/webhooks/ID/TOKEN')
  }
  const thread = url.searchParams.get('thread_id')
  url.search = ''; url.hash = ''
  if (thread && /^\d+$/.test(thread)) url.searchParams.set('thread_id', thread)
  url.searchParams.set('wait', 'true')
  return url.toString()
}

function safeText (value) {
  return String(value ?? '').replace(/https?:\/\/\S+/gi, '[ссылка скрыта]')
    .replace(/(?:Bearer\s+)[\w.-]+/gi, 'Bearer [скрыто]')
    .replace(/((?:access|refresh)[_-]?token\s*[:=]\s*)\S+/gi, '$1[скрыто]').slice(0, 1400)
}

class DiscordWebhook {
  constructor ({ fetch = globalThis.fetch, sleep = ms => timers.setTimeout(ms) } = {}) {
    this.fetch = fetch; this.sleep = sleep; this.tail = Promise.resolve(); this.pending = 0
  }

  send (url, content) {
    url = webhookURL(url)
    if (!url) return Promise.reject(new Error('Discord webhook не задан'))
    if (this.pending >= 100) return Promise.reject(new Error('очередь Discord заполнена'))
    this.pending++
    const run = this.tail.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let response
        try {
          response = await this.fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'Botify', content: content.slice(0, 1900), allowed_mentions: { parse: [] } }) })
        } catch {
          if (attempt === 2) throw new Error('Discord: сеть недоступна или истёк таймаут')
          await this.sleep(1000 * (attempt + 1)); continue
        }
        if (response.ok) { await response.text(); return }
        if (response.status === 429 && attempt < 2) {
          const body = await response.json().catch(() => ({}))
          const seconds = Number(body.retry_after ?? response.headers.get('retry-after'))
          await this.sleep(Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 30000)); continue
        }
        await response.text()
        if (response.status >= 500 && attempt < 2) { await this.sleep(1000 * (attempt + 1)); continue }
        throw new Error(`Discord: HTTP ${response.status}`)
      }
    }).finally(() => { this.pending-- })
    this.tail = run.catch(() => {})
    return run
  }
}

module.exports = { DiscordWebhook, webhookURL, safeText }
