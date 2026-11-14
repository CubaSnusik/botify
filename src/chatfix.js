'use strict'
/*
 * Send commands the way the vanilla client does.
 *
 * minecraft-protocol sends EVERY command as `chat_command_signed` as soon as the account has
 * chat-signing keys — even `/tpa Nick`, which has nothing to sign. The vanilla client only uses
 * the signed packet for commands that contain a message argument (`/msg`, `/me`, `/say`, …);
 * everything else goes out as a plain `chat_command`. Servers and proxies (Velocity/Paper plugins)
 * that only expect what a real client sends may silently drop those odd signed packets, so a bot
 * types `/tpa` and nothing happens.
 *
 * Here: track which commands have a `minecraft:message` argument in the server's command tree
 * (following alias redirects) and send all the others as plain `chat_command`, like vanilla.
 */
function attachCommandSending (bot) {
  const client = bot._client
  const needsSigning = new Set()
  let treeKnown = false

  client.on('declare_commands', (packet) => {
    const nodes = packet?.nodes
    if (!Array.isArray(nodes) || !nodes[packet.rootIndex]) return
    needsSigning.clear()
    const memo = new Map()
    const visiting = new Set()
    const walk = (i) => {
      if (memo.has(i)) return memo.get(i)
      if (visiting.has(i)) return false
      visiting.add(i)
      const n = nodes[i]
      let found = false
      if (n) {
        if (n.extraNodeData?.parser === 'minecraft:message') found = true
        for (const c of n.children || []) if (walk(c)) found = true
        // aliases like /tell → /msg are redirects; a redirect to the root (/execute run …) is ignored
        const redirect = n.redirectNode
        if (!found && redirect != null && redirect !== packet.rootIndex && n.flags?.has_redirect_node) found = walk(redirect)
      }
      visiting.delete(i)
      memo.set(i, found)
      return found
    }
    for (const c of nodes[packet.rootIndex].children || []) {
      const name = nodes[c]?.extraNodeData?.name
      if (name && walk(c)) needsSigning.add(String(name).toLowerCase())
    }
    treeKnown = true
  })

  client.once('playerJoin', () => {
    const original = client.chat
    if (typeof original !== 'function' || typeof client._signedChat !== 'function') return
    if (!bot.supportFeature?.('seperateSignedChatCommandPacket')) return // 1.20.5+ has a separate unsigned packet
    client.chat = (message, options) => {
      if (typeof message === 'string' && message.startsWith('/')) {
        const name = message.slice(1).split(' ')[0].toLowerCase().replace(/^[a-z0-9_.-]+:/, '')
        // unknown tree → be conservative and only sign the classic message commands
        const sign = treeKnown ? needsSigning.has(name) || needsSigning.has(message.slice(1).split(' ')[0].toLowerCase()) : /^(msg|tell|w|me|say|teammsg|tm)$/.test(name)
        if (!sign) {
          client.write('chat_command', { command: message.slice(1) })
          return
        }
      }
      return original(message, options)
    }
  })
}

module.exports = { attachCommandSending }
