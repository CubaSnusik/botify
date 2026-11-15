'use strict'
const nbt = require('prismarine-nbt')

// 1.21.5+ sign messages are text components in NBT, not necessarily strings.
// prismarine-block's getSignText() currently joins compounds as [object Object].
function componentText (value, depth = 0) {
  if (depth > 12 || value == null) return ''
  if (value && typeof value === 'object' && typeof value.type === 'string' && 'value' in value) {
    try { return componentText(nbt.simplify(value), depth + 1) } catch { return '' }
  }
  if (typeof value === 'string') {
    if (/^\s*[\[{\"]/.test(value)) {
      try { return componentText(JSON.parse(value), depth + 1) } catch {}
    }
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(v => componentText(v, depth + 1)).join('')
  if (typeof value === 'object') {
    // Mixed-type NBT lists can wrap primitive entries in an unnamed compound key.
    if (Object.keys(value).length === 1 && Object.hasOwn(value, '')) return componentText(value[''], depth + 1)
    let text = componentText(value.text, depth + 1)
    // Servers also send literal labels as translation keys (e.g. { translate: '1' }).
    // With no translation available, display the fallback or the key itself.
    if (value.text == null && typeof value.translate === 'string') {
      const format = typeof value.fallback === 'string' ? value.fallback : value.translate
      const args = Array.isArray(value.with) ? value.with : []
      let next = 0
      text = format.replace(/%%|%(?:(\d+)\$)?s/g, (token, index) => {
        if (token === '%%') return '%'
        const argument = index ? Number(index) - 1 : next++
        return argument >= 0 && argument < args.length ? componentText(args[argument], depth + 1) : token
      })
    }
    return text + componentText(value.extra, depth + 1)
  }
  return ''
}

function signLines (block) {
  let data = block.entity
  try { if (data?.type === 'compound') data = nbt.simplify(data) } catch { data = null }
  const messages = []
  let raw = false
  for (const side of ['front_text', 'back_text']) {
    if (Array.isArray(data?.[side]?.messages)) { raw = true; messages.push(...data[side].messages) }
  }
  if (!raw && data && ['Text1', 'Text2', 'Text3', 'Text4'].some(k => k in data)) {
    raw = true
    messages.push(...['Text1', 'Text2', 'Text3', 'Text4'].map(k => data[k]))
  }
  if (!raw) {
    try { messages.push(...(block.getSignText?.() ?? [block.signText || ''])) } catch {}
  }
  return messages.flatMap(message => componentText(message).replace(/§./g, '').split(/\r?\n/)).map(s => s.trim()).filter(Boolean)
}
module.exports = { componentText, signLines }
