'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { BotManager } = require('../src/bots')
const mineflayer = require('mineflayer')
const { isRateLimited, authRetryDelay } = require('../src/connection-errors')
const { makeAuthHook, resolveSession, refreshMicrosoft } = require('../src/auth')

test('rate limits recognize the old non-JSON error and honor Retry-After', () => {
  assert.equal(isRateLimited(new Error('Response is not JSON. Status code: 429')), true)
  assert.equal(isRateLimited({ status: 429 }), true)
  assert.equal(isRateLimited(new Error('TooManyRequests')), true)
  assert.equal(isRateLimited(new Error('Invalid token (401)')), false)
  assert.equal(authRetryDelay({}), 300_000)
  assert.equal(authRetryDelay({ retryAfter: '600' }), 600_000)
  assert.equal(authRetryDelay({ retryAfter: new Date(900_000).toUTCString() }, 100_000), 800_000)
  assert.equal(authRetryDelay({ retryAfter: 'invalid' }), 300_000)
})

test('429 pauses online accounts and manual reconnects, while offline connections still work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const store = new EventEmitter()
  store.path = (...parts) => require('node:path').join(require('node:os').tmpdir(), 'botify-auth-test-unused', ...parts)
  const accounts = [{ id: 'a', type: 'token', username: 'First' }, { id: 'b', type: 'token', username: 'Second' }, { id: 'c', type: 'offline', username: 'Offline' }]
  store.settings = { server: { host: '127.0.0.1', port: 25565, version: '26.1' }, behavior: { autoReconnect: true, reconnectDelay: 5000, joinStagger: 0 } }
  store.listAccounts = () => accounts
  store.getAccount = id => accounts.find(a => a.id === id)
  const created = []
  t.mock.method(mineflayer, 'createBot', () => {
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    bot._client.write = () => {}
    bot._client.end = reason => bot.emit('end', reason)
    bot.quit = bot._client.end
    bot.loadPlugin = () => {}
    created.push(bot)
    return bot
  })
  const manager = new BotManager(store)
  t.after(() => manager.disconnectAll())
  const first = manager.get('a'); const second = manager.get('b')
  await first.connect()
  created[0].emit('error', new Error('Response is not JSON. Status code: 429'))
  created[0].emit('end', 'encryptionLoginError')
  assert.equal(first.reconnectAt, 301_000)
  assert.match(first.error, /HTTP 429/)
  t.mock.timers.tick(8000)
  await second.connect()
  assert.equal(second.reconnectAt, 301_000)
  await first.disconnect()
  await first.connect()
  assert.equal(first.reconnectAt, 301_000, 'manual retry cannot bypass shared cooldown')
  assert.equal(created.length, 1, 'no new network/auth attempts during the cooldown')
  await manager.get('c').connect()
  assert.equal(created.length, 2, 'offline accounts do not use the auth service')
  await manager.disconnectAll()
  accounts[1].autoReconnect = false
  await second.connect()
  assert.equal(second.state, 'error')
  assert.equal(second.reconnectTimer, null, 'disabled auto reconnect stays disabled')
  t.mock.timers.tick(292_000)
  await first.connect()
  assert.equal(created.length, 3, 'connection resumes after the full pause')
})

test('already-online kick persists a flag only on that account and the remaining logins continue', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os')
  const { Store } = require('../src/store')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botify-queue-test-'))
  const store = new Store(dir)
  store.updateSettings({ server: { host: '127.0.0.1', port: 25565, version: '26.1' },
    behavior: { autoReconnect: true, joinStagger: 0 } })
  const accounts = ['First', 'Second', 'Third'].map(username => store.addAccount({ type: 'offline', username }))
  const created = []
  t.mock.method(mineflayer, 'createBot', () => {
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    bot._client.write = () => {}
    bot._client.end = reason => bot.emit('end', reason)
    bot.quit = bot._client.end
    bot.loadPlugin = () => {}
    created.push(bot)
    return bot
  })
  const manager = new BotManager(store)
  t.after(async () => { await manager.disconnectAll(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }) })
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  const all = manager.connectAll()
  await flush()
  assert.equal(created.length, 1, 'only the first account attempts login')
  const reason = 'You are already online\nYou are connected to proxy: 3f9648bb914e\nConnect reason: proxy request-join-cache login'
  created[0].emit('kicked', { text: reason }, false)
  await flush()
  assert.equal(created.length, 2, 'second account starts after the first account fails')
  const first = manager.get(accounts[0].id)
  assert.equal(first.acc.accountIssue.code, 'already_online')
  assert.equal(first.snapshot().accountIssue.reason, reason)
  assert.equal(first.autoReconnect(), false)
  assert.equal(first.reconnectTimer, null)
  assert.equal(first.reconnectAt, null)
  created[1].emit('kicked', { text: 'You are not whitelisted' }, false)
  created[1].emit('end', 'socketClosed')
  await flush()
  await all
  assert.equal(created.length, 3, 'third account still starts after a different kick')
  const second = manager.get(accounts[1].id)
  assert.equal(second.acc.accountIssue, undefined)
  assert.equal(second.autoReconnect(), true, 'other accounts retain their reconnect settings')
  assert.ok(second.reconnectTimer)
  await first.connect()
  await manager.connectAll([first.id])
  first.scheduleReconnect()
  assert.equal(created.length, 3, 'blocked account is skipped for manual and bulk requests')
  assert.equal(first.reconnectTimer, null)
  store.flush()
  const saved = JSON.parse(fs.readFileSync(store.accountsFile, 'utf8')).accounts
  assert.equal(saved[0].accountIssue.reason, reason)
  assert.equal(saved[1].accountIssue, undefined)
  const reloaded = new Store(dir)
  const restarted = new BotManager(reloaded)
  await restarted.get(first.id).connect()
  assert.equal(created.length, 3, 'flag blocks connections after restart too')
  await restarted.disconnectAll()
  reloaded.flush()
})

test('an auth response arriving after cancellation cannot reopen the connection', async () => {
  const client = new EventEmitter()
  let resolve; let active = true; let connections = 0; let sessions = 0
  client.on('session', () => sessions++)
  const pending = new Promise(r => { resolve = r })
  makeAuthHook(() => pending, () => active)(client, { connect: () => connections++ })
  active = false
  resolve({ accessToken: 'test-only', profile: { id: 'test-profile', name: 'Test' } })
  await pending
  await Promise.resolve()
  assert.equal(connections, 0)
  assert.equal(sessions, 0)
})

test('an active auth response still supplies credentials before connecting', async () => {
  const client = new EventEmitter()
  const session = { accessToken: 'test-only', profile: { id: 'test-profile', name: 'Test' } }
  let connected = false
  const options = { connect: c => { assert.equal(c.session.selectedProfile.id, session.profile.id); connected = true } }
  makeAuthHook(async () => session)(client, options)
  await Promise.resolve()
  assert.equal(connected, true)
  assert.equal(options.haveCredentials, true)
  assert.equal(options.accessToken, session.accessToken)
})

test('certificate rate limit stops login and preserves the retry deadline', async t => {
  let requests = 0
  t.mock.method(global, 'fetch', async () => ++requests === 1
    ? new Response(JSON.stringify({ id: 'id', name: 'Test' }))
    : new Response('limited', { status: 429, headers: { 'Retry-After': '900' } }))
  await assert.rejects(resolveSession({ type: 'token', accessToken: 'test-only', uuid: 'id', username: 'Test' }, {}), err => err.status === 429 && err.retryAfter === '900')
  assert.equal(requests, 2)
})

test('refresh token rate limit does not try further client IDs', async t => {
  let requests = 0
  t.mock.method(global, 'fetch', async () => {
    requests++
    return new Response('limited', { status: 429, headers: { 'Retry-After': '600' } })
  })
  await assert.rejects(refreshMicrosoft('test-only'), err => err.status === 429 && err.retryAfter === '600')
  assert.equal(requests, 1)
})
