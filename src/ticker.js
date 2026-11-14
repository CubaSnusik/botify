'use strict'
/*
 * Precise 20 TPS physics clock for all bots.
 *
 * mineflayer drives physics with setInterval(doPhysics, 50). On Windows the default timer
 * resolution is 15.6 ms, so that interval actually fires every ~62 ms and mineflayer's
 * time accumulator then runs 0 or 2 physics ticks per call. The server receives movement
 * packets in bursts with gaps → bots visibly stutter while walking.
 *
 * Fix:
 *  1. a worker-thread metronome: coarse Atomics.wait sleep, then a short spin until the exact
 *     deadline (the margin is calibrated to the OS timer resolution, so on Linux/macOS it's ~1 ms);
 *  2. mineflayer's setInterval(doPhysics, 50) is intercepted and attached to that metronome;
 *  3. each call hands doPhysics an exact +50 ms timeline (its first performance.now() read),
 *     so it always runs exactly ONE physics tick — no bursts, no gaps. Everything else
 *     (pathfinder timing etc.) keeps seeing the real clock.
 */
const { Worker } = require('worker_threads')
const { performance } = require('perf_hooks')

const STEP = 50

const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads')
const { performance } = require('perf_hooks')
const sab = new Int32Array(workerData.sab) // [0]=sleep slot, [1]=running flag, [2]=pending tick
const STEP = ${STEP}

// calibrate: how late does a 1 ms sleep wake up? (≈15.6 ms on default Windows, ≈0.1 ms elsewhere)
let worst = 0
for (let i = 0; i < 8; i++) {
  const t = performance.now(); Atomics.wait(sab, 0, 0, 1); worst = Math.max(worst, performance.now() - t - 1)
}
const margin = Math.min(18, worst + 1.5)
parentPort.postMessage({ type: 'calibrated', margin })

let next = 0
for (;;) {
  if (Atomics.load(sab, 1) === 0) { Atomics.wait(sab, 1, 0); next = 0 }
  const now = performance.now()
  if (!next || now - next > 250) next = now + STEP // (re)sync after pause/suspend
  const wait = next - performance.now() - margin
  if (wait > 0) Atomics.wait(sab, 0, 0, wait)
  while (performance.now() < next) {} // short spin for the last few ms
  // Only one notification may be in flight. A blocked main thread must not accumulate a
  // queue of historical ticks and replay seconds of movement in a single network burst.
  if (Atomics.load(sab, 1) && Atomics.compareExchange(sab, 2, 0, 1) === 0) parentPort.postMessage(next)
  next += STEP
}
`

let worker = null
let sab = null
const subs = new Map() // handle -> { fn, now }
let installed = false
let margin = null

function ensureWorker () {
  if (worker) return
  sab = new Int32Array(new SharedArrayBuffer(12))
  worker = new Worker(WORKER_SRC, { eval: true, workerData: { sab: sab.buffer } })
  worker.on('message', (m) => {
    if (m && m.type === 'calibrated') { margin = m.margin; return }
    try { onTick() } finally { Atomics.store(sab, 2, 0) }
  })
  worker.on('error', (e) => console.error('[botify] ticker worker error:', e))
  worker.unref()
}

function setRunning (on) {
  ensureWorker()
  Atomics.store(sab, 1, on ? 1 : 0)
  Atomics.notify(sab, 1)
}

/** call fn() so that its FIRST performance.now() returns t; the real clock is restored right after */
function callWithNow (fn, t) {
  const own = Object.getOwnPropertyDescriptor(performance, 'now')
  const restore = () => { if (own) Object.defineProperty(performance, 'now', own); else delete performance.now }
  Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => { restore(); return t } })
  try { fn() } finally { restore() }
}

function onTick () {
  for (const s of subs.values()) {
    s.now += STEP
    try {
      s.hooks?.before?.()
      try { callWithNow(s.fn, s.now) } finally { s.hooks?.after?.() }
    } catch (e) { console.error('[botify] physics tick error:', e) }
  }
}

// mineflayer creates its physics interval inside its own 'login' handler. Botify's 'login' handler
// runs first and "claims" the next interval for that bot, so per-tick hooks know whose tick it is.
let pendingHooks = null
function claimNext (hooks) { pendingHooks = hooks }
function cancelClaim (hooks) { if (pendingHooks === hooks) pendingHooks = null }

function add (fn) {
  const handle = { botifyTicker: true, unref () { return this }, ref () { return this }, hasRef () { return false } }
  // mineflayer set lastPhysicsFrameTime = performance.now() right before setInterval.
  // Start half a step ahead so the accumulator sits at 25 ms → exactly one tick per call.
  subs.set(handle, { fn, now: performance.now() + STEP / 2 - STEP, hooks: pendingHooks })
  pendingHooks = null
  if (subs.size === 1) setRunning(true)
  return handle
}

function remove (handle) {
  if (!subs.delete(handle)) return false
  if (subs.size === 0 && worker) setRunning(false)
  return true
}

function install () {
  if (installed) return
  installed = true
  const realSetInterval = global.setInterval
  const realClearInterval = global.clearInterval
  global.setInterval = function (fn, ms, ...args) {
    if (ms === STEP && typeof fn === 'function' && fn.name === 'doPhysics' && !args.length) return add(fn)
    return realSetInterval.call(this, fn, ms, ...args)
  }
  global.clearInterval = function (h) {
    if (h && h.botifyTicker) { remove(h); return }
    return realClearInterval.call(this, h)
  }
}

module.exports = { install, claimNext, cancelClaim, stats: () => ({ bots: subs.size, margin }) }
