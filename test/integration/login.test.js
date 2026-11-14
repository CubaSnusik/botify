'use strict'
require('../../scripts/patch-login')()
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const mc = require('minecraft-protocol')
const yggdrasil = require('yggdrasil/src/utils')

test('status probe preserves the logical SRV host and ordinary direct connections', { timeout: 8000 }, async t => {
  const hosts = []
  const server = mc.createServer({ host: '127.0.0.1', port: 0, version: '26.1', 'online-mode': false })
  t.after(async () => { const closed = once(server, 'close'); server.close(); await closed })
  server.on('connection', client => client.on('set_protocol', p => hosts.push(p.serverHost)))
  await once(server, 'listening')
  const options = { host: '127.0.0.1', port: server.socketServer.address().port, version: '26.1', closeTimeout: 3000 }
  const status = await mc.ping({ ...options, fakeHost: 'logical.example.test' })
  assert.equal(status.version.name, '26.1')
  await mc.ping({ ...options })
  assert.deepEqual(hosts, ['logical.example.test', '127.0.0.1'])
})

test('session HTTP 429 propagates status and Retry-After for HTML, JSON and empty bodies', { timeout: 8000 }, async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'Retry-After': '900' })
    res.end(req.url === '/empty' ? '' : req.url === '/json' ? '{"error":"TooManyRequests"}' : '<html>rate limited</html>')
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const host = `http://127.0.0.1:${server.address().port}`
  for (const route of ['empty', 'json', 'html']) {
    await assert.rejects(yggdrasil.call(host, route, {}), err => err.status === 429 && err.retryAfter === '900')
  }
})
