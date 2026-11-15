'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DiscordWebhook, webhookURL } = require('../src/discord-webhook')
const { BotAlerts } = require('../src/bot-alerts')
const { farmSettings } = require('../src/farm-settings')
const URL = 'https://discord.com/api/webhooks/123456/fake_test_token'
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture () {
  const calls = []; const logs = []
  const inst = { id: 'b_test', acc: { username: 'Farmer' }, server: () => ({ host: 'mc.example.test' }),
    store: { settings: { farm: { discordEnabled: true, discordWebhook: URL, axeAlertPercent: 10 } } },
    manager: { discord: { send: async (url, body) => calls.push({ url, body }) } },
    log: (kind, text) => { logs.push(text); alerts.log(kind, text) } }
  const alerts = new BotAlerts(inst)
  return { inst, alerts, calls, logs }
}

test('webhook validates Discord HTTPS endpoints and blocks redirects, private hosts and missing tokens', () => {
  assert.match(webhookURL(URL), /wait=true/)
  for (const url of ['http://discord.com/api/webhooks/1/token', 'https://127.0.0.1/api/webhooks/1/t', 'https://discord.com.evil.test/api/webhooks/1/t', 'https://user:pass@discord.com/api/webhooks/1/t', 'https://discord.com/api/webhooks/1']) assert.throws(() => webhookURL(url))
  assert.throws(() => farmSettings({ discordEnabled: true }), /webhook/)
  assert.throws(() => farmSettings({ axeAlertPercent: 0 }))
  assert.equal(farmSettings({ discordEnabled: true, discordWebhook: URL }).axeAlertPercent, 10)
})

test('Discord delivery sends no mentions, honours 429 retry_after and serializes queued messages', async () => {
  const calls = []; const waits = []
  const sender = new DiscordWebhook({ sleep: async ms => waits.push(ms), fetch: async (url, options) => {
    calls.push({ url, options })
    return calls.length === 1 ? new Response(JSON.stringify({ retry_after: 2.5 }), { status: 429 }) : new Response('{}', { status: 200 })
  } })
  await Promise.all([sender.send(URL, 'first @everyone'), sender.send(URL, 'second')])
  assert.deepEqual(waits, [2500])
  assert.deepEqual(calls.map(c => JSON.parse(c.options.body).content), ['first @everyone', 'first @everyone', 'second'])
  assert.deepEqual(JSON.parse(calls[0].options.body).allowed_mentions, { parse: [] })
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(sender.pending, 0)
})

test('real bot logging routes kicks, bans and disconnects without duplicate end messages', async () => {
  const { BotInstance } = require('../src/bots')
  const f = fixture()
  f.inst.store.getAccount = () => ({ username: 'Farmer', server: { host: 'mc.example.test' } })
  const bot = new BotInstance({ store: f.inst.store, discord: f.inst.manager.discord, emit: () => {} }, 'test')
  bot.log('sys', 'отключён (disconnect)')
  bot.log('err', 'кикнут: You are banned')
  bot.log('sys', 'отключён (disconnect)')
  await flush()
  assert.equal(f.calls.length, 2)
  assert.match(f.calls[1].body, /You are banned/)
})

test('correction bursts and task errors alert; empty player inventory and restock failures do not', async () => {
  const f = fixture()
  f.alerts.log('chat', 'кикнут: fake')
  f.alerts.log('sys', '.autotree: отменено')
  f.alerts.log('sys', '[проверка] посадка: отказ')
  f.alerts.log('sys', '[коррекция] бот был: вперёд 1')
  await flush(); assert.equal(f.calls.length, 0)
  f.alerts.log('sys', '[коррекция] бот был: вперёд 1')
  f.alerts.log('out', '4 саженца посажены; закончилась костная мука — жду пополнения или роста')
  f.alerts.log('out', 'закончились spruce_sapling — жду пополнения')
  f.alerts.log('out', '[запасы] bone_meal: взято 0, в инвентаре 0')
  f.alerts.log('out', '[запасы] bone_meal: метка «1» не найдена')
  f.alerts.log('out', '[запасы] инвентарь заполнен — освободите место')
  f.alerts.log('err', '.autotree: ошибка — нет Shard Axe')
  await flush()
  assert.equal(f.calls.length, 2)
  assert.match(f.calls[0].body, /не подтверждён/)
  f.alerts.log('out', 'закончились spruce_sapling — жду пополнения')
  await flush(); assert.equal(f.calls.length, 2)
})

test('low axe durability alerts at threshold and rearms after repair', async () => {
  const f = fixture()
  const axe = { name: 'netherite_axe', customName: 'Shard Axe', maxDurability: 1000, durabilityUsed: 900 }
  f.inst.bot = { inventory: { items: () => [axe] }, heldItem: axe }
  f.alerts.inventory(); f.alerts.inventory(); await flush()
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].body, /100\/1000/)
  axe.durabilityUsed = 0; f.alerts.inventory()
  axe.durabilityUsed = 950; f.alerts.inventory(); await flush()
  assert.equal(f.calls.length, 2)
})

test('disabled notifications make no requests; delivery errors are bounded and redact URL secrets', async () => {
  const f = fixture()
  f.inst.store.settings.farm.discordEnabled = false
  await f.alerts.notify('x', 'test', 'test'); assert.equal(f.calls.length, 0)
  f.inst.store.settings.farm.discordEnabled = true
  f.inst.manager.discord.send = async () => { throw new Error(`failed ${URL}`) }
  await f.alerts.notify('x', 'test', 'test')
  await f.alerts.notify('y', 'test', 'test')
  assert.equal(f.logs.length, 1); assert.ok(!f.logs[0].includes('fake_test_token'))
  await assert.rejects(f.alerts.notify('test', 'test', 'test', { force: true }))
})

test('per-problem cooldown expires after five minutes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 })
  const f = fixture()
  await f.alerts.notify('meal', 'test', 'empty')
  t.mock.timers.tick(299999)
  await f.alerts.notify('meal', 'test', 'empty'); assert.equal(f.calls.length, 1)
  t.mock.timers.tick(1)
  await f.alerts.notify('meal', 'test', 'empty'); assert.equal(f.calls.length, 2)
})
