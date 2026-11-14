'use strict'
/*
 * Server screens:
 *  - Dialogs (1.21.6+ / 26.x "show_dialog"): notice, confirmation (yes/no), multi_action,
 *    dialog_list, server_links — with inputs (text, boolean, single_option, number_range).
 *    Buttons run their click action exactly like the vanilla client would:
 *    run_command, dynamic/run_command (template with $(input)), custom / dynamic/custom
 *    (→ custom_click_action packet with the input values as NBT), show_dialog, open_url…
 *  - Container GUIs (menus like /tpaccept with "click the green glass"): list / click slots.
 */
const nbt = require('prismarine-nbt')

// ---------- text ----------
function isTag (v) { return v && typeof v === 'object' && typeof v.type === 'string' && 'value' in v }

// NBT → plain JS, but keep `payload` / `additions` as raw tags (they are sent back to the server as NBT)
function simp (tag, keepRaw = true) {
  if (!isTag(tag)) return tag
  if (tag.type === 'compound') {
    const o = {}
    for (const [k, v] of Object.entries(tag.value)) o[k] = keepRaw && (k === 'payload' || k === 'additions') ? v : simp(v, keepRaw)
    return o
  }
  if (tag.type === 'list') return (tag.value?.value || []).map(x => simp({ type: tag.value.type, value: x }, keepRaw))
  return nbt.simplify(tag)
}

function textOf (bot, v) {
  if (v == null) return ''
  try {
    if (isTag(v)) v = nbt.simplify(v)
    if (typeof v === 'string') {
      try { v = JSON.parse(v) } catch { return v.replace(/§./g, '') }
    }
    if (typeof v.toString === 'function' && v.constructor?.name === 'ChatMessage') return v.toString()
    const ChatMessage = require('prismarine-chat')(bot.registry)
    return new ChatMessage(v).toString().replace(/§./g, '')
  } catch {
    return typeof v === 'string' ? v : JSON.stringify(v).slice(0, 120)
  }
}

const strip = (s) => String(s || '').replace(/^minecraft:/, '')

// ---------- items (shared by inventory + GUIs) ----------
function itemView (bot, it, slot) {
  if (!it) return null
  let enchants = []
  try { enchants = (it.enchants || []).map(e => `${e.name} ${e.lvl}`) } catch {}
  let maxDur = null; let used = 0
  try { maxDur = it.maxDurability || null; used = it.durabilityUsed || 0 } catch {}
  let custom = ''
  try { custom = it.customName ? textOf(bot, it.customName) : '' } catch {}
  let lore = []
  try { lore = (it.customLore || []).map(l => textOf(bot, l)).filter(s => s.trim()) } catch {}
  return {
    slot,
    name: it.name,
    displayName: custom.trim() ? custom : it.displayName,
    customName: custom,
    count: it.count,
    stackSize: it.stackSize,
    maxDur,
    used,
    enchants,
    lore
  }
}

// ---------- dialogs ----------
function parseInputs (bot, list) {
  const out = []
  for (const i of [].concat(list || [])) {
    const type = strip(i.type)
    const base = { key: i.key, label: textOf(bot, i.label) || i.key }
    if (type === 'text') out.push({ ...base, type: 'text', value: String(i.initial ?? ''), maxLength: i.max_length || 32, multiline: !!i.multiline })
    else if (type === 'boolean') out.push({ ...base, type: 'boolean', value: !!i.initial, onTrue: i.on_true ?? 'true', onFalse: i.on_false ?? 'false' })
    else if (type === 'single_option') {
      const options = (i.options || []).map(o => typeof o === 'string' ? { id: o, display: o } : { id: o.id, display: textOf(bot, o.display) || o.id, initial: !!o.initial })
      out.push({ ...base, type: 'option', options, value: (options.find(o => o.initial) || options[0] || {}).id ?? '' })
    } else if (type === 'number_range') {
      const start = Number(i.start ?? 0); const end = Number(i.end ?? 1)
      out.push({ ...base, type: 'number', start, end, step: i.step != null ? Number(i.step) : null, value: i.initial != null ? Number(i.initial) : start + (end - start) / 2 })
    } else out.push({ ...base, type: 'unknown' })
  }
  return out
}

const button = (bot, b, fallback) => ({ label: textOf(bot, b?.label) || fallback, tooltip: b?.tooltip ? textOf(bot, b.tooltip) : '', action: b?.action || null })

function parseDialog (bot, raw, registryKey) {
  const type = strip(raw.type)
  const d = {
    type,
    key: registryKey || null,
    title: textOf(bot, raw.title) || registryKey || 'Диалог',
    body: [],
    inputs: parseInputs(bot, raw.inputs),
    buttons: [],
    exit: null,
    canEscape: raw.can_close_with_escape !== 0 && raw.can_close_with_escape !== false,
    afterAction: strip(raw.after_action || 'close')
  }
  for (const b of [].concat(raw.body || [])) {
    const bt = strip(b.type)
    if (bt === 'item') {
      const desc = b.description ? textOf(bot, b.description.contents ?? b.description) : ''
      d.body.push(`[предмет] ${strip(b.item?.id)}${b.item?.count > 1 ? ' ×' + b.item.count : ''}${desc ? ' — ' + desc : ''}`)
    } else d.body.push(textOf(bot, b.contents ?? b))
  }
  if (type === 'notice') {
    const a = button(bot, raw.action, 'OK')
    d.buttons = [a]
    d.exit = a.action
  } else if (type === 'confirmation') {
    const yes = button(bot, raw.yes, 'Да'); const no = button(bot, raw.no, 'Нет')
    d.buttons = [yes, no]
    d.exit = no.action
  } else if (type === 'multi_action') {
    d.buttons = (raw.actions || []).map((b, i) => button(bot, b, `Кнопка ${i + 1}`))
    if (raw.exit_action) { const e = button(bot, raw.exit_action, 'Назад'); d.buttons.push(e); d.exit = e.action }
  } else if (type === 'dialog_list') {
    d.buttons = [].concat(raw.dialogs || []).map((ref) => ({
      label: typeof ref === 'string' ? ref : textOf(bot, ref.external_title ?? ref.title) || 'Диалог',
      tooltip: '',
      action: { type: 'show_dialog', dialog: ref }
    }))
    if (raw.exit_action) { const e = button(bot, raw.exit_action, 'Назад'); d.buttons.push(e); d.exit = e.action }
  } else if (type === 'server_links') {
    d.body.push('(список ссылок сервера)')
    if (raw.exit_action) { const e = button(bot, raw.exit_action, 'Назад'); d.buttons.push(e); d.exit = e.action }
  }
  return d
}

function templateValue (inp) {
  if (inp.type === 'boolean') return inp.value ? inp.onTrue : inp.onFalse
  if (inp.type === 'number') return Number.isInteger(inp.value) ? String(inp.value) : String(inp.value)
  return String(inp.value)
}

function inputTag (inp) {
  if (inp.type === 'boolean') return { type: 'byte', value: inp.value ? 1 : 0 }
  if (inp.type === 'number') return { type: 'float', value: Number(inp.value) }
  return { type: 'string', value: String(inp.value) }
}

function sendCommand (bot, cmd) {
  cmd = String(cmd || '').trim().replace(/^\//, '')
  if (cmd) bot.chat('/' + cmd)
  return cmd
}

/**
 * Vanilla ServerboundCustomClickActionPacket: Identifier id, then the payload as a VarInt
 * length-prefixed block containing an optional network NBT tag (type byte + body, no name;
 * a single END byte when there is no payload). See scripts/patch-26.2.js for the protocol fix.
 */
function anonymousNbtBytes (tag) {
  if (!tag) return Buffer.from([0]) // TAG_End = Optional.empty()
  const named = nbt.writeUncompressed({ type: tag.type, name: '', value: tag.value }, 'big')
  return Buffer.concat([named.subarray(0, 1), named.subarray(3)]) // drop the u16 name length
}

function writeCustomClick (bot, id, payload) {
  let field = null
  try {
    const proto = require('minecraft-data')(bot.version).protocol
    const t = proto.types?.packet_common_custom_click_action || proto.play.toServer.types.packet_common_custom_click_action
    field = t?.[1]?.find(f => f.name === 'payload' || f.name === 'nbt')
  } catch {}
  if (!field || field.name !== 'payload') {
    throw new Error('данные протокола не исправлены — запусти npm install (без этого сервер кикнет за ответ на диалог)')
  }
  bot._client.write('custom_click_action', { id: String(id), payload: anonymousNbtBytes(payload) })
}

/** Run a dialog click action. Returns a short description for the console. */
function runAction (inst, d, action) {
  const bot = inst.bot
  if (!action) return 'у кнопки нет действия'
  const type = strip(action.type)
  const byKey = Object.fromEntries((d?.inputs || []).map(i => [i.key, i]))
  switch (type) {
    case 'run_command':
      return `команда /${sendCommand(bot, action.command)}`
    case 'dynamic/run_command': {
      const cmd = String(action.template || '').replace(/\$\(([a-zA-Z0-9_]+)\)/g, (_, k) => byKey[k] ? templateValue(byKey[k]) : '')
      return `команда /${sendCommand(bot, cmd)}`
    }
    case 'custom':
      writeCustomClick(bot, action.id, isTag(action.payload) ? action.payload : null)
      return `отправил ${strip(action.id)}`
    case 'dynamic/custom': {
      const value = {}
      for (const i of d?.inputs || []) if (i.type !== 'unknown') value[i.key] = inputTag(i)
      if (isTag(action.additions) && action.additions.type === 'compound') Object.assign(value, action.additions.value)
      writeCustomClick(bot, action.id, { type: 'compound', name: '', value })
      return `отправил ${strip(action.id)} с полями`
    }
    case 'show_dialog':
      showDialogRef(inst, action.dialog)
      return 'открыт вложенный диалог'
    case 'open_url':
      return `ссылка: ${action.url}`
    case 'copy_to_clipboard':
      return `текст для копирования: ${action.value}`
    case 'suggest_command':
      return `сервер предлагает команду: ${action.command}`
    default:
      return `действие ${type} не поддерживается`
  }
}

function setDialog (inst, d) {
  inst.dialogSeq = (inst.dialogSeq || 0) + 1
  inst.dialog = d ? { ...d, seq: inst.dialogSeq } : null
  inst.update(true)
  if (!d) return
  inst.log('out', `[диалог] ${d.title}`)
  for (const line of d.body) if (line.trim()) inst.log('out', `  ${line}`)
  for (const i of d.inputs) {
    const v = i.type === 'boolean' ? (i.value ? 'да' : 'нет') : i.type === 'option' ? i.options.map(o => o.id === i.value ? `[${o.display}]` : o.display).join(' / ') : JSON.stringify(i.value)
    inst.log('out', `  поле ${i.key} (${i.label}) = ${v}`)
  }
  if (d.buttons.length) inst.log('out', '  ' + d.buttons.map((b, i) => `[${i + 1}] ${b.label}`).join('   '))
  inst.log('sys', `  ответ: .dialog <номер|текст кнопки>${d.inputs.length ? ' · поля: .dialog set <поле> <значение>' : ''}${d.canEscape ? ' · .dialog close' : ''}`)
}

function showDialogRef (inst, ref) {
  const bot = inst.bot
  if (typeof ref === 'string') {
    const e = inst.dialogRegistry?.find(x => x.key === ref || strip(x.key) === strip(ref))
    if (e?.value) return setDialog(inst, parseDialog(bot, simp(e.value), e.key))
    return setDialog(inst, { type: 'unknown', key: ref, title: ref, body: ['(встроенный диалог клиента — содержимое неизвестно)'], inputs: [], buttons: [], exit: null, canEscape: true, afterAction: 'close' })
  }
  if (ref && typeof ref === 'object') setDialog(inst, parseDialog(bot, isTag(ref) ? simp(ref) : ref))
}

/** Click button #index (0-based) of the current dialog. */
function clickDialogButton (inst, index) {
  const d = inst.dialog
  if (!d) throw new Error('диалога нет')
  const b = d.buttons[index]
  if (!b) throw new Error(`нет кнопки ${index + 1}`)
  const res = runAction(inst, d, b.action)
  if (inst.dialog?.seq === d.seq) {
    if (d.afterAction === 'none') { /* stays open */ } else if (d.afterAction === 'wait_for_response') { inst.dialog = { ...d, waiting: true }; inst.update(true) } else setDialog(inst, null)
  }
  return `${b.label}: ${res}`
}

function closeDialog (inst) {
  const d = inst.dialog
  if (!d) throw new Error('диалога нет')
  if (!d.canEscape) throw new Error('этот диалог нельзя закрыть — выбери кнопку')
  const res = d.exit ? runAction(inst, d, d.exit) : 'закрыт'
  if (inst.dialog?.seq === d.seq) setDialog(inst, null)
  return res
}

function setDialogInput (inst, key, raw) {
  const d = inst.dialog
  if (!d) throw new Error('диалога нет')
  const i = d.inputs.find(x => x.key === key) || d.inputs.find(x => x.label.toLowerCase() === String(key).toLowerCase())
  if (!i) throw new Error(`нет поля ${key}. Есть: ${d.inputs.map(x => x.key).join(', ') || '—'}`)
  const s = String(raw ?? '')
  if (i.type === 'boolean') i.value = /^(1|true|yes|on|да|вкл|y)$/i.test(s)
  else if (i.type === 'number') {
    let n = Number(s.replace(',', '.'))
    if (Number.isNaN(n)) throw new Error('нужно число')
    n = Math.max(Math.min(i.start, i.end), Math.min(Math.max(i.start, i.end), n))
    i.value = n
  } else if (i.type === 'option') {
    const o = i.options.find(x => x.id === s) || i.options.find(x => x.display.toLowerCase() === s.toLowerCase()) ||
      i.options[Number(s) - 1] || i.options.find(x => x.display.toLowerCase().includes(s.toLowerCase()))
    if (!o) throw new Error(`варианты: ${i.options.map((x, n) => `${n + 1}) ${x.display}`).join(', ')}`)
    i.value = o.id
  } else i.value = s.slice(0, i.maxLength || 256)
  inst.update(true)
  return i
}

function setDialogInputs (inst, values) {
  if (!values || !inst.dialog) return
  for (const [k, v] of Object.entries(values)) {
    const i = inst.dialog.inputs.find(x => x.key === k)
    if (!i) continue
    try { setDialogInput(inst, k, i.type === 'boolean' ? (v ? 'true' : 'false') : v) } catch {}
  }
}

/** Hook dialog packets on a fresh client (works in configuration and play state). */
function attachDialogs (inst, bot) {
  const client = bot._client
  inst.dialogRegistry = []
  client.on('registry_data', (p) => {
    if (strip(p.id) === 'dialog') inst.dialogRegistry = p.entries || []
  })
  client.on('show_dialog', (p) => {
    try {
      const h = p.dialog || {}
      if (h.data) setDialog(inst, parseDialog(bot, simp(h.data)))
      else if (typeof h.dialog === 'number') {
        const e = inst.dialogRegistry[h.dialog]
        if (e?.value) setDialog(inst, parseDialog(bot, simp(e.value), e.key))
        else showDialogRef(inst, e?.key || `#${h.dialog}`)
      }
    } catch (e) {
      inst.log('err', `не смог разобрать диалог: ${e.message}`)
    }
  })
  client.on('clear_dialog', () => { if (inst.dialog) { setDialog(inst, null); inst.log('sys', '[диалог] закрыт сервером') } })
}

/** Public view of the dialog for the UI (no raw actions). */
function dialogView (d) {
  if (!d) return null
  return {
    seq: d.seq,
    type: d.type,
    title: d.title,
    body: d.body,
    inputs: d.inputs,
    buttons: d.buttons.map(b => ({ label: b.label, tooltip: b.tooltip, kind: strip(b.action?.type || '') })),
    canEscape: d.canEscape,
    waiting: !!d.waiting
  }
}

// ---------- container GUIs ----------
// only neutral panes count as decoration; a green/red pane is usually the button itself
const FILLER = /^((black|gray|light_gray|white)_stained_)?glass_pane$/

// Russian words → item-id fragments, so ".gui click зеленое стекло" finds lime_stained_glass_pane
const RU_WORDS = [
  [/^зел[её]н|^лайм|^салат/, 'lime|green'], [/^красн/, 'red'], [/^ж[её]лт/, 'yellow'], [/^син/, 'blue'],
  [/^голуб/, 'light_blue'], [/^бирюз/, 'cyan'], [/^фиолет/, 'purple'], [/^пурпур|^маджент/, 'magenta'],
  [/^розов/, 'pink'], [/^оранж/, 'orange'], [/^бел/, 'white'], [/^ч[её]рн/, 'black'], [/^светло-?сер/, 'light_gray'],
  [/^сер/, 'gray'], [/^коричн/, 'brown'], [/^стекл/, 'glass'], [/^панел/, 'pane'], [/^шерст/, 'wool'],
  [/^бетон/, 'concrete'], [/^терракот/, 'terracotta'], [/^голов/, 'head|skull'], [/^алмаз/, 'diamond'],
  [/^зол/, 'gold'], [/^желез/, 'iron'], [/^книг/, 'book'], [/^бумаг/, 'paper'], [/^барьер/, 'barrier'],
  [/^стрел/, 'arrow'], [/^компас/, 'compass'], [/^час/, 'clock'], [/^краситель|^краск/, 'dye']
]
function idPatterns (q) {
  return q.toLowerCase().split(/[\s_]+/).filter(Boolean).map((w) => {
    const hit = RU_WORDS.find(([re]) => re.test(w))
    return new RegExp(hit ? hit[1] : w.replace(/[^a-z0-9]/g, '') || '^$')
  })
}

function windowView (bot) {
  const w = bot.currentWindow
  if (!w) return null
  const size = w.inventoryStart ?? Math.max(0, w.slots.length - 36)
  return {
    id: w.id,
    type: strip(w.type),
    title: textOf(bot, w.title) || strip(w.type),
    size,
    slots: w.slots.slice(0, size).map((it, i) => itemView(bot, it, i))
  }
}

function describeWindow (inst) {
  const bot = inst.bot
  const v = windowView(bot)
  if (!v) return ['окон не открыто']
  const lines = [`[окно] ${v.title} — ${v.size} слотов`]
  let fillers = 0
  for (const s of v.slots) {
    if (!s) continue
    const blank = !s.customName.trim() || s.customName.trim() === ' '
    if (FILLER.test(s.name) && blank) { fillers++; continue }
    lines.push(`  #${s.slot} ${s.displayName}${s.count > 1 ? ' ×' + s.count : ''} (${s.name})${s.lore.length ? ' — ' + s.lore.join(' | ') : ''}`)
  }
  if (fillers) lines.push(`  (+${fillers} пустых стёкол-заполнителей)`)
  lines.push('  ответ: .gui click <№|текст> [right|shift] · .gui close')
  return lines
}

function findWindowSlot (bot, q) {
  const v = windowView(bot)
  if (!v) throw new Error('окон не открыто')
  const n = Number(q)
  if (String(q).trim() !== '' && Number.isInteger(n)) {
    if (n < 0 || n >= v.slots.length + 36) throw new Error(`слота ${n} нет`)
    return n
  }
  const s = String(q).toLowerCase().trim()
  const real = v.slots.filter(x => x && !(FILLER.test(x.name) && !x.customName.trim()))
  const hit = (pred) => real.find(pred) || v.slots.find(x => x && pred(x))
  const pats = idPatterns(s)
  const found = hit(x => x.customName.toLowerCase().includes(s)) ||
    hit(x => x.displayName.toLowerCase().includes(s)) ||
    hit(x => x.lore.some(l => l.toLowerCase().includes(s))) ||
    hit(x => x.name.includes(s.replace(/\s+/g, '_'))) ||
    hit(x => pats.every(re => re.test(x.name)))
  if (!found) throw new Error(`в окне нет «${q}»`)
  return found.slot
}

async function clickWindowSlot (inst, slot, how = 'left') {
  const bot = inst.bot
  if (!bot?.currentWindow) throw new Error('окон не открыто')
  const [button, mode] = how === 'right' ? [1, 0] : how === 'shift' ? [0, 1] : how === 'middle' ? [2, 3] : [0, 0]
  const it = bot.currentWindow.slots[slot]
  await bot.clickWindow(slot, button, mode)
  // menus usually cancel the click; if the server put the item on our cursor, drop it back
  return it ? (itemView(bot, it, slot).displayName) : 'пустой слот'
}

module.exports = {
  textOf,
  itemView,
  attachDialogs,
  dialogView,
  clickDialogButton,
  closeDialog,
  setDialogInput,
  setDialogInputs,
  windowView,
  describeWindow,
  findWindowSlot,
  clickWindowSlot
}
