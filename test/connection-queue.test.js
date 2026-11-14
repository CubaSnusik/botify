'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { ConnectionQueue } = require('../src/connection-queue')
const { isAlreadyOnline } = require('../src/connection-errors')

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function account (id, order) {
  const b = new EventEmitter()
  b.state = 'offline'
  b.setState = state => {
    b.state = state
    if (!['queued', 'connecting'].includes(state)) b.emit('connectionSettled')
  }
  b.log = () => {}
  b._connectNow = async () => { order.push(id); b.setState('connecting') }
  return b
}

test('queue waits for spawn/end, deduplicates requests and continues after a failed account', async () => {
  const queue = new ConnectionQueue(() => 0)
  const order = []; const a = account('a', order); const b = account('b', order); const c = account('c', order)
  await queue.add(a)
  const second = queue.add(b); const third = queue.add(c)
  assert.equal(queue.add(b), second)
  await flush()
  assert.deepEqual(order, ['a'])
  a.setState('online')
  await second
  assert.deepEqual(order, ['a', 'b'])
  b.setState('error')
  await third
  assert.deepEqual(order, ['a', 'b', 'c'])
  c.setState('online')
  await flush()
  assert.equal(queue.entries.size, 0)
  for (const bot of [a, b, c]) assert.equal(bot.listenerCount('connectionSettled'), 0)
})

test('a thrown connection failure releases the queue and cancelling a queued account prevents its login', async () => {
  const queue = new ConnectionQueue(() => 0)
  const order = []; const a = account('a', order); const b = account('b', order); const c = account('c', order)
  a._connectNow = async () => { order.push('a'); throw new Error('DNS failed') }
  const first = queue.add(a); const second = queue.add(b); const third = queue.add(c)
  queue.cancel(b)
  await Promise.all([first, second, third])
  assert.deepEqual(order, ['a', 'c'])
  c.setState('online')
  await flush()
  assert.equal(queue.entries.size, 0)
})

test('join delay starts after a settled attempt, and zero delay still serializes logins', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const queue = new ConnectionQueue(() => 1500)
  const order = []; const a = account('a', order); const b = account('b', order)
  await queue.add(a)
  const second = queue.add(b)
  t.mock.timers.tick(10_000)
  await flush()
  assert.deepEqual(order, ['a'])
  a.setState('online')
  await flush()
  t.mock.timers.tick(1499)
  await flush()
  assert.deepEqual(order, ['a'])
  t.mock.timers.tick(1)
  await second
  assert.deepEqual(order, ['a', 'b'])
  b.setState('online')
  await flush()
})

test('already-online detection accepts the proxy kick and does not classify unrelated errors', () => {
  assert.equal(isAlreadyOnline('You are already online\nYou are connected to proxy: 3f9648bb914e\nConnect reason: proxy request-join-cache login'), true)
  assert.equal(isAlreadyOnline('§cYOU ARE ALREADY ONLINE'), true)
  for (const text of ['multiplayer.disconnect.authservers_down', 'You are not whitelisted', 'Already connecting', 'HTTP 429']) {
    assert.equal(isAlreadyOnline(text), false)
  }
})
