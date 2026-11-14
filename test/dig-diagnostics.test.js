'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { attachDigDiagnostics } = require('../src/dig-diagnostics')

test('failed digging saves a bounded trace of timing, acknowledgements and item changes only', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'botify-dig-'))
  const file = path.join(dir, 'attempt.json')
  const successFile = path.join(dir, 'attempt.success.json')
  const cancelledFile = path.join(dir, 'attempt.cancelled.json')
  t.after(async () => {
    await fs.unlink(file).catch(() => {})
    await fs.unlink(successFile).catch(() => {})
    await fs.unlink(cancelledFile).catch(() => {})
    await fs.rmdir(dir)
  })
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  const sent = []
  bot._client.write = (name, data) => sent.push([name, data])
  bot.version = '26.1'
  bot.registry = require('prismarine-registry')(bot.version)
  const Block = require('prismarine-block')(bot.registry)
  const block = Block.fromStateId(bot.registry.blocksByName.oak_log.defaultState, 0)
  block.position = new Vec3(2, 2, 0)
  bot.blockAt = () => block
  bot.entity = { position: new Vec3(0.5, 1, 0.5), yaw: Math.PI / 2, pitch: 0, eyeHeight: 1.62,
    onGround: true, attributes: {}, effects: {} }
  bot.controlState = Object.defineProperty({}, 'sneak', { get: () => true })
  const World = require('prismarine-world')(bot.registry)
  const Chunk = require('prismarine-chunk')(bot.registry)
  bot.world = new World(null, null, 0).sync
  bot.world.setColumn(0, 0, new Chunk({ minY: -64, worldHeight: 384 }))
  bot.world.setBlockStateId(block.position, block.stateId)
  bot.heldItem = { name: 'netherite_axe', type: bot.registry.itemsByName.netherite_axe.id,
    enchants: { enchantments: [{ id: 1, level: 5 }] },
    components: [{ type: 'custom_data', data: 'DO_NOT_RECORD_ITEM_DATA' },
      { type: 'tool', data: { defaultMiningSpeed: 2, rules: [] } }] }
  bot._botifyEnchantments = ['example:tree_feller', 'minecraft:efficiency']
  let time = 0
  const logs = []
  const trace = attachDigDiagnostics(bot, { file, log: message => logs.push(message), now: () => time })
  bot._client.write('held_item_slot', { slotId: 0 })
  bot._client.write('position_look', { x: 0.5, y: 1, z: 0.5, yaw: -90, pitch: 0, flags: { onGround: true } })
  time = 50
  // These angles live on Mineflayer's shared object but are not serialized by packet_position.
  bot._client.write('position', { x: 0.5, y: 1, z: 0.5, yaw: 180, pitch: 90, flags: { onGround: true } })
  time = 100
  bot._client.write('block_dig', { status: 0, location: block.position, face: 4, sequence: 1 })
  bot._client.write('chat_message', { message: 'DO_NOT_RECORD_CHAT' })
  time = 450
  bot._client.write('block_dig', { status: 2, location: block.position, face: 4, sequence: 2 })
  bot._client.emit('acknowledge_player_digging', { sequenceId: 2 })
  bot.emit('blockUpdate', block, block)
  bot.emit('heldItemChanged', null)
  bot.emit('botifyDigResult', { ok: false, started: true, finishSent: true, reason: 'timeout' })
  await trace.flushed()
  const json = await fs.readFile(file, 'utf8')
  const report = JSON.parse(json)
  assert.equal(report.format, 2)
  assert.equal(report.atStart.wire.rotation.yaw, -90)
  assert.equal(report.atStart.local.rotation.yaw, 90)
  assert.equal(report.atStart.wire.slot, 0)
  assert.equal(report.atStart.local.controls.sneak, true, 'Mineflayer controls are non-enumerable')
  assert.equal(report.atStart.heldItem.enchantments[0].name, 'minecraft:efficiency')
  assert.equal(report.atStart.heldItem.enchantmentRegistry, 'server')
  assert.equal(report.atStart.heldItem.components[0].data.defaultMiningSpeed, 2)
  assert.deepEqual(report.atStart.wireHit.position, { x: 2, y: 2, z: 0 })
  assert.equal(report.before.find(r => r.kind === 'position').rotation, undefined)
  assert.equal(report.before.find(r => r.kind === 'position').ms, -50)
  assert.equal(report.records.find(r => r.kind === 'block_dig' && r.status === 2).ms, 350)
  assert.equal(report.records.find(r => r.kind === 'ack').sequence, 2)
  assert.ok(report.records.some(r => r.kind === 'blockUpdate'))
  assert.ok(logs.some(line => line.includes('350 мс')))
  assert.ok(!json.includes('DO_NOT_RECORD'))
  assert.equal(sent.length, 6, 'recorder forwards packets unchanged')

  bot._client.write('block_dig', { status: 0, location: block.position, face: 4, sequence: 3 })
  for (let i = 0; i < 400; i++) bot._client.write('arm_animation', { hand: 0 })
  time += 10000
  bot._client.write('block_dig', { status: 2, location: block.position, face: 4, sequence: 4 })
  bot.emit('botifyDigResult', { ok: false, started: true, finishSent: true, reason: 'timeout' })
  await trace.flushed()
  const longAttempt = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(longAttempt.records.length, 240)
  assert.ok(longAttempt.records.some(r => r.kind === 'block_dig' && r.status === 0), 'continuous swings preserve START in the bounded trace')
  assert.equal(longAttempt.finishMs, 10000)

  bot._client.write('block_dig', { status: 0, location: block.position, face: 4, sequence: 5 })
  bot.emit('botifyDigResult', { ok: true, started: true, finishSent: false })
  await trace.flushed()
  assert.equal(JSON.parse(await fs.readFile(successFile, 'utf8')).result.ok, true)
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).result.ok, false, 'success does not overwrite failure')

  bot._client.write('block_dig', { status: 0, location: block.position, face: 4, sequence: 6 })
  bot.emit('botifyDigResult', { ok: false, started: true, finishSent: false, reason: 'Digging aborted' })
  await trace.flushed()
  assert.equal(JSON.parse(await fs.readFile(cancelledFile, 'utf8')).result.reason, 'Digging aborted')
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).result.reason, 'timeout', 'manual cancellation preserves the last actual failure')

  bot._client.emit('start_configuration')
  bot._client.write('block_dig', { status: 0, location: block.position, face: 4, sequence: 6 })
  bot.emit('botifyDigResult', { ok: false, started: true, finishSent: false, reason: 'test' })
  await trace.flushed()
  const reset = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.deepEqual(reset.before, [])
  assert.equal(reset.atStart.wire.position, null)
})
