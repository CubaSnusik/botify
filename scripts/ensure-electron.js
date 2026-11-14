#!/usr/bin/env node
// Newer npm versions may skip dependency install scripts, leaving Electron without its binary.
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const dir = path.resolve(__dirname, '..', 'node_modules', 'electron')
if (!fs.existsSync(dir)) process.exit(0)
let ok = false
try {
  const p = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim()
  ok = fs.existsSync(path.join(dir, 'dist', p))
} catch {}
if (!ok) {
  console.log('[botify] downloading Electron binary…')
  try {
    execFileSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit' })
  } catch (e) {
    console.error('[botify] Electron download failed — use `npm run web` (browser mode) instead.')
  }
}
