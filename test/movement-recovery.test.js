'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { attachMovementRecovery } = require('../src/movement-recovery')

async function fixture (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'botify-recovery-'))
  const file = path.join(dir, 'trace.json')
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  const sent = []
  bot._client.write = (name, packet) => sent.push({ name, packet })
  bot.version = '26.2'
  bot.physics = { botifyWalkingProfile: '26.2' }
  bot.controlState = { forward: true }
  bot.entity = { position: { x: 1, y: 64, z: 2 }, velocity: { x: 0.1, y: -0.0784, z: 0 },
    onGround: true, attributes: { 'minecraft:friction_modifier': { value: 2, modifiers: [] } } }
  let time = 0; let stopped = 0
  const logs = []
  const recovery = attachMovementRecovery(bot, { file, now: () => time, log: s => logs.push(s), stop: () => { stopped++; bot.controlState.forward = false } })
  t.after(async () => { await recovery.flushed(); await fs.rm(dir, { recursive: true, force: true }) })
  return { bot, recovery, file, sent, logs, stopped: () => stopped, advance: ms => { time += ms },
    correct: (keys = ['forward']) => bot.emit('botifyCorrection', { keys, distance: 0.2, teleportId: 10 }) }
}

test('repeated moving corrections stop input, preserve physics and save a bounded movement-only trace', async t => {
  const f = await fixture(t)
  const initial = structuredClone(f.bot.entity)
  for (let i = 0; i < 300; i++) {
    f.recovery.before()
    f.bot._client.write('position', { ...f.bot.entity.position, flags: { onGround: true } })
    f.recovery.after()
  }
  f.bot._client.write('chat_message', { message: 'PRIVATE_CHAT_SENTINEL' })
  f.bot._client.write('encryption_begin', { accessToken: 'PRIVATE_TOKEN_SENTINEL' })
  for (let i = 0; i < 3; i++) { f.correct(); f.advance(100) }
  assert.equal(f.stopped(), 0)
  f.correct()
  await f.recovery.flushed()
  assert.equal(f.stopped(), 1)
  assert.equal(f.bot.controlState.forward, false)
  assert.deepEqual(f.bot.entity, initial, 'no position or velocity changes')
  const text = await fs.readFile(f.file, 'utf8')
  assert.doesNotMatch(text, /PRIVATE_|accessToken|encryption_begin|chat_message/)
  const report = JSON.parse(text)
  assert.equal(report.physics, '26.2')
  assert.equal(report.records.length, 400)
  assert.ok(report.records.some(r => r.type === 'packet' && r.name === 'position'))
  assert.ok(report.records.some(r => r.type === 'before' && r.attributes['minecraft:friction_modifier'].value === 2))
  assert.equal(f.sent.length, 302, 'recorder must not filter the outgoing connection')
})

test('idle, spaced corrections and respawn do not trigger a stop', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 6; i++) { f.correct(); f.advance(1100) }
  for (let i = 0; i < 8; i++) f.correct([])
  for (let i = 0; i < 3; i++) f.correct()
  f.bot.emit('respawn')
  f.correct()
  assert.equal(f.stopped(), 0)
  await assert.rejects(fs.readFile(f.file), { code: 'ENOENT' })
})
