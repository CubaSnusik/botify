'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { joinCircleFormation } = require('../src/circle-formation')

function participant () {
  return {
    bot: { entity: { position: new Vec3(3, 1, 0) }, game: { dimension: 'overworld' }, _client: { state: 'play' } },
    target: { username: 'Nick', position: new Vec3(0, 1, 0) },
    server: { host: 'example.test', port: 25565 },
    radius: 3
  }
}

test('formation isolates managers, servers, ports, dimensions, target players and radii', () => {
  for (const change of ['manager', 'host', 'port', 'dimension', 'player', 'radius']) {
    const scope = {}; const a = participant(); const b = participant()
    if (change === 'host') b.server.host = 'another.test'
    if (change === 'port') b.server.port++
    if (change === 'dimension') b.bot.game.dimension = 'the_nether'
    if (change === 'player') b.target.username = 'OtherPlayer'
    if (change === 'radius') b.radius = 3.5
    const first = joinCircleFormation(scope, a.server, a.bot, a.target, a.radius)
    const second = joinCircleFormation(change === 'manager' ? {} : scope, b.server, b.bot, b.target, b.radius)
    assert.equal(first.pace(), 1, change)
    assert.equal(second.pace(), 1, change)
    first.stop(); second.stop()
  }
})

test('formation releases the waiting bot when its neighbour stops and does not retain old members', () => {
  const scope = {}; const a = participant(); const b = participant()
  b.server.host = b.server.host.toUpperCase()
  b.target.username = 'nICK'
  const first = joinCircleFormation(scope, a.server, a.bot, a.target, 3)
  const second = joinCircleFormation(scope, b.server, b.bot, b.target, 3)
  assert.equal(first.pace(), 0)
  assert.equal(second.pace(), 1)
  second.stop(); second.stop()
  assert.equal(first.pace(), 1)
  first.stop()
  const restarted = joinCircleFormation(scope, a.server, a.bot, a.target, 3)
  assert.equal(restarted.pace(), 1)
  restarted.stop()
})

test('members far from the ring, on another elevation or outside play do not hold up the circle', () => {
  const scope = {}; const a = participant(); const b = participant()
  const first = joinCircleFormation(scope, a.server, a.bot, a.target, 3)
  const second = joinCircleFormation(scope, b.server, b.bot, b.target, 3)
  b.bot.entity.position.x = 20
  assert.equal(first.pace(), 1)
  b.bot.entity.position.set(3, 10, 0)
  assert.equal(first.pace(), 1)
  b.bot.entity.position.set(3, 1, 0)
  b.bot._client.state = 'configuration'
  assert.equal(first.pace(), 1)
  first.stop(); second.stop()
})
