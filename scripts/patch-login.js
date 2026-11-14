'use strict'
const fs = require('node:fs')

function patch (file, before, after) {
  const original = fs.readFileSync(file, 'utf8')
  const source = original.replace(/\r\n/g, '\n')
  if (source.includes(after)) return
  if (source.split(before).length !== 2) throw new Error(`Unsupported login dependency: review ${file}`)
  if (require.cache[file]) throw new Error('Apply the login patch before loading Mineflayer; restart Botify')
  const next = source.replace(before, after)
  fs.writeFileSync(file, original.includes('\r\n') ? next.replace(/\n/g, '\r\n') : next)
}

function patchLogin () {
  // A virtual host must see the same logical address in status and login handshakes.
  patch(require.resolve('minecraft-protocol/src/ping'),
    'serverHost: options.host,', 'serverHost: options.fakeHost || options.host, // Botify: preserve SRV virtual host')
  // Preserve rate-limit metadata, including for non-JSON or empty error bodies.
  patch(require.resolve('yggdrasil/src/utils'),
    "  let body = await resp.text()\n  if (body.length === 0) return ''",
    `  let body = await resp.text()
  // Botify: HTTP 429 is a rate limit regardless of the response body format.
  if (resp.status === 429) {
    const error = new Error('Session service: HTTP 429 Too Many Requests')
    error.status = 429
    error.retryAfter = resp.headers.get('retry-after')
    throw error
  }
  if (body.length === 0) return ''`)
}

module.exports = patchLogin
if (require.main === module) patchLogin()
