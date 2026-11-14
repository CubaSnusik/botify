'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('assets load on demand; offline skins do not parse item textures', async t => {
  const reads = []
  const read = fs.readFileSync
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (String(file).endsWith('texture_content.json')) reads.push(String(file))
    return read.call(this, file, ...args)
  })
  const assets = require('../src/assets')
  assert.equal(require.cache[require.resolve('minecraft-assets')], undefined)
  assert.equal(reads.length, 0)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botify-assets-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const skin = await new assets.SkinService(dir).skinFor({ type: 'offline', username: 'TestBot' })
  assert.equal(fs.existsSync(skin), true)
  assert.equal(reads.length, 0)
  const icon = assets.getItemIcon('diamond_axe', '26.2')
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(reads.length, 1, 'common icon reads one version only')
  assert.equal(assets.getItemIcon('diamond_axe', '26.2'), icon)
  assert.equal(reads.length, 1)
  for (const name of ['oak_stairs', 'lime_stained_glass_pane']) {
    assert.equal(assets.getItemIcon(name, '26.1').subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  }
  assert.equal(assets.getItemIcon('nonexistent_test_item', 'unknown'), null)
  assert.equal(new Set(reads).size, reads.length, 'each version is read at most once')
})
