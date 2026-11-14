'use strict'
// Bot backend running in its own process (Electron utilityProcess), so heavy bot work
// (pathfinding, chunk parsing) can never freeze the window.
const { startServer } = require('./server')

const port = process.parentPort

startServer({ port: Number(process.env.BOTIFY_PORT) || 7878, fallback: true }).then((srv) => {
  port.postMessage({ type: 'ready', url: srv.url, theme: srv.app.store.settings.ui?.theme || 'dark' })
  srv.app.store.on('settings', (s) => port.postMessage({ type: 'theme', theme: s.ui?.theme || 'dark' }))
  port.on('message', async (e) => {
    if (e.data?.type === 'shutdown') {
      await Promise.race([srv.close(), new Promise(r => setTimeout(r, 4000))])
      process.exit(0)
    }
  })
}).catch((e) => {
  console.error('[botify] backend failed to start:', e)
  port.postMessage({ type: 'fatal', error: String(e?.message || e) })
  process.exit(1)
})
