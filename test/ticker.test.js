'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const ticker = require('../src/ticker')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('worker discards accumulated ticks after a blocked event loop', { timeout: 5000 }, async () => {
  ticker.install()
  let ticks = 0
  let before = 0
  let after = 0
  const simulatedTimes = []
  ticker.claimNext({ before: () => before++, after: () => after++ })
  const handle = setInterval(function doPhysics () {
    ticks++
    simulatedTimes.push(performance.now())
  }, 50)
  try {
    for (let i = 0; i < 30 && ticks < 3; i++) await delay(50)
    assert.ok(ticks >= 3, 'worker started')
    const previousTicks = ticks
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    await delay(125)
    assert.ok(ticks - previousTicks <= 4, `replayed ${ticks - previousTicks} ticks after stall`)
    assert.ok(ticks > previousTicks, 'worker resumes')
    assert.equal(before, ticks)
    assert.equal(after, ticks)
    for (let i = 1; i < simulatedTimes.length; i++) assert.ok(Math.abs(simulatedTimes[i] - simulatedTimes[i - 1] - 50) < 1e-8)
  } finally { clearInterval(handle) }
  assert.equal(ticker.stats().bots, 0)
})

test('after hook restores tick state even if physics throws', { timeout: 5000 }, async () => {
  let after = 0
  ticker.claimNext({ after: () => after++ })
  const log = console.error
  console.error = () => {}
  const handle = setInterval(function doPhysics () { throw new Error('test failure') }, 50)
  try {
    for (let i = 0; i < 20 && after === 0; i++) await delay(50)
    assert.ok(after > 0)
  } finally {
    clearInterval(handle)
    console.error = log
  }
})
