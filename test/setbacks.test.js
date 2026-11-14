'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { attachSetbackMonitor } = require('../src/setbacks')

function fixture (t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { position: new Vec3(0, 64, 0), velocity: new Vec3(0, -0.0784, 0), yaw: 0, onGround: true }
  bot.controlState = { forward: true }
  bot.blockAt = () => ({ name: 'stone' })
  const lines = []; const rates = []
  const monitor = attachSetbackMonitor(bot, text => lines.push(text), () => rates.push(monitor.rate()))
  // Native listener applies absolute or relative coordinates between the monitor's two listeners.
  bot._client.on('position', p => {
    bot.entity.position = p.relative ? bot.entity.position.plus(p.pos) : p.pos.clone()
  })
  bot.emit('login')
  bot.emit('spawn')
  const shift = (x = 0.0014, y = 0, z = 0) => bot._client.emit('position', { relative: true, pos: new Vec3(x, y, z) })
  t.after(() => bot.emit('end'))
  return { bot, monitor, lines, rates, shift }
}

test('monitor ignores spawn placement, zero changes and separates large teleports', t => {
  const f = fixture(t)
  f.shift(1)
  t.mock.timers.tick(3000)
  f.shift(0)
  f.shift(20)
  assert.equal(f.monitor.rate(), 0)
  assert.equal(f.lines.length, 1)
  assert.match(f.lines[0], /\[перемещение\]/)
  f.shift()
  assert.equal(f.monitor.rate(), 1)
  assert.match(f.lines[1], /вбок -0\.0014/)
  assert.match(f.lines[1], /на земле, forward/)
  assert.deepEqual(f.bot.entity.velocity, new Vec3(0, -0.0784, 0))
  assert.equal(f.bot.entity.onGround, true)
})

test('correction burst limits details and summarizes the remainder without losing counts', t => {
  const f = fixture(t)
  t.mock.timers.tick(3000)
  for (let i = 0; i < 12; i++) f.shift(0, 0.002, -0.003)
  assert.equal(f.monitor.rate(), 12)
  assert.equal(f.lines.length, 3)
  t.mock.timers.tick(5000)
  assert.equal(f.lines.length, 4)
  assert.match(f.lines[3], /ещё 9 за 5 с/)
  assert.match(f.lines[3], /вперёд -0\.0030, вбок 0, вверх -0\.0020/)
})

test('counter expires at ten seconds and notifies UI even when bot is idle', t => {
  const f = fixture(t)
  t.mock.timers.tick(3000)
  f.shift()
  t.mock.timers.tick(500)
  f.shift()
  t.mock.timers.tick(9500)
  assert.equal(f.monitor.rate(), 1)
  t.mock.timers.tick(500)
  assert.equal(f.monitor.rate(), 0)
  assert.deepEqual(f.rates, [1, 2, 1, 0])
})

for (const event of ['respawn', 'start_configuration', 'end', 'client_end']) {
  test(`${event} clears counts and pending summaries`, t => {
    const f = fixture(t)
    t.mock.timers.tick(3000)
    for (let i = 0; i < 5; i++) f.shift()
    if (event === 'start_configuration') f.bot._client.emit(event)
    else if (event === 'client_end') f.bot._client.emit('end')
    else f.bot.emit(event)
    assert.equal(f.monitor.rate(), 0)
    assert.equal(f.rates.at(-1), 0)
    f.shift()
    t.mock.timers.tick(12_000)
    assert.equal(f.lines.length, 3, 'no stale summary or placement correction')
    if (!event.endsWith('end')) {
      f.shift()
      assert.equal(f.monitor.rate(), 1)
    } else {
      f.shift()
      assert.equal(f.monitor.rate(), 0)
    }
  })
}
