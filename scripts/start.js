#!/usr/bin/env node
// Launches the Electron app. Strips ELECTRON_RUN_AS_NODE, which some hosts (e.g. VS Code
// extension terminals) leak into the environment and which turns Electron into plain Node.
'use strict'
const { spawn } = require('child_process')
const path = require('path')

let electron
try {
  electron = require('electron') // in plain Node this resolves to the binary path
} catch {
  console.error('Electron не установлен. Запусти `npm install` или используй `npm run web`.')
  process.exit(1)
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [path.resolve(__dirname, '..')], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
