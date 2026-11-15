'use strict'
/*
 * Account auth for Botify.
 *
 * Supported account types (stored in data/accounts.json):
 *   offline    — just a nickname, for offline-mode servers
 *   microsoft  — device-code login handled by prismarine-auth (cache in data/auth-cache/<id>)
 *   token      — Minecraft access token (JWT from api.minecraftservices.com, lives ~24h)
 *   refresh    — Microsoft OAuth refresh token → MS access → Xbox Live → XSTS → Minecraft token.
 *                The refreshed Minecraft token is cached in the account, the rotated
 *                refresh token is written back so the account stays alive.
 *
 * Cookie import: Microsoft login.live.com cookies (a Netscape jar, a pasted
 * "name=value; …" Cookie header, or a Localts `M.C…` line) are exchanged for a
 * refresh token at import time (cookie → authorize code → refresh token) and
 * then stored as a normal `refresh` account. The raw cookies are never saved.
 *
 * Tokens and cookies only ever go to Microsoft / Xbox / Mojang endpoints.
 */
const crypto = require('crypto')
const { isRateLimited } = require('./connection-errors')

const UA = 'Botify/0.1 (+mineflayer)'

// Public client ids used by official Minecraft/Xbox apps.
// A refresh token only works with the client id that issued it.
const LIVE_CLIENT_IDS = [
  '00000000402b5328', // Minecraft Launcher (live.com, MBI_SSL)
  '00000000441cc96b', // Minecraft for Nintendo Switch (prismarine-auth default)
  '000000004c12ae6f' // Xbox App
]

const XSTS_ERRORS = {
  2148916227: 'Аккаунт забанен в Xbox Live',
  2148916233: 'У аккаунта нет Xbox-профиля (зайди один раз на minecraft.net)',
  2148916235: 'Xbox Live недоступен в стране аккаунта',
  2148916236: 'Нужна верификация возраста (Южная Корея)',
  2148916237: 'Нужна верификация возраста (Южная Корея)',
  2148916238: 'Детский аккаунт — нужно добавить в семейную группу'
}

class AuthError extends Error {}

async function http (url, { method = 'GET', headers = {}, json, form } = {}) {
  const opts = { method, headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } }
  if (json) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(json)
  } else if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'
    opts.body = new URLSearchParams(form).toString()
  }
  let res
  try {
    res = await fetch(url, opts)
  } catch (e) {
    throw new AuthError(`Сеть: не удалось достучаться до ${new URL(url).host} (${e.cause?.code || e.message})`)
  }
  const text = await res.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!res.ok) {
    const msg = body.errorMessage || body.error_description || body.error || body.Message ||
      (body.XErr && (XSTS_ERRORS[body.XErr] || `XErr ${body.XErr}`)) || text.slice(0, 160) || res.statusText
    const err = new AuthError(`${new URL(url).host}: ${res.status} ${msg}`)
    err.status = res.status
    err.retryAfter = res.headers.get('retry-after')
    err.body = body
    throw err
  }
  return body
}

// ---------- JWT helpers ----------
function decodeJwt (token) {
  try {
    const part = String(token).split('.')[1]
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function isJwt (s) { return /^ey[\w-]+\.[\w-]+\.[\w-]*$/.test(String(s).trim()) }

function jwtExpiry (token) {
  const p = decodeJwt(token)
  return p && p.exp ? p.exp * 1000 : null
}

function tokenExpiresAt (acc) {
  return acc.accessTokenExpiresAt || jwtExpiry(acc.accessToken) || null
}

// ---------- Minecraft services ----------
async function fetchProfile (accessToken) {
  try {
    const p = await http('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    return { id: p.id, name: p.name, skins: p.skins || [] }
  } catch (e) {
    if (e.status === 401) throw new AuthError('Токен недействителен или истёк (401)')
    if (e.status === 404) throw new AuthError('На аккаунте нет Minecraft Java (профиль не найден)')
    throw e
  }
}

function pemToDer (pem) {
  return Buffer.from(pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
}

// Chat-signing key pair (needed on servers with enforce-secure-profile=true)
async function fetchProfileKeys (accessToken) {
  const cert = await http('https://api.minecraftservices.com/player/certificates', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const keys = {
    publicPEM: cert.keyPair.publicKey,
    privatePEM: cert.keyPair.privateKey,
    publicDER: pemToDer(cert.keyPair.publicKey),
    privateDER: pemToDer(cert.keyPair.privateKey),
    signature: Buffer.from(cert.publicKeySignature, 'base64'),
    signatureV2: Buffer.from(cert.publicKeySignatureV2, 'base64'),
    expiresOn: new Date(cert.expiresAt),
    refreshAfter: new Date(cert.refreshedAfter)
  }
  keys.public = crypto.createPublicKey({ key: keys.publicDER, format: 'der', type: 'spki' })
  keys.private = crypto.createPrivateKey({ key: keys.privateDER, format: 'der', type: 'pkcs8' })
  return keys
}

// ---------- Microsoft → Xbox → Minecraft ----------
async function refreshMicrosoft (refreshToken, clientId) {
  const azure = clientId && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(clientId)
  if (azure) {
    const r = await http('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
      method: 'POST',
      form: { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'XboxLive.signin offline_access' }
    })
    return { accessToken: r.access_token, refreshToken: r.refresh_token, clientId, azure: true }
  }
  const ids = clientId ? [clientId] : LIVE_CLIENT_IDS
  let lastErr
  for (const id of ids) {
    try {
      const r = await http('https://login.live.com/oauth20_token.srf', {
        method: 'POST',
        form: { client_id: id, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'service::user.auth.xboxlive.com::MBI_SSL' }
      })
      return { accessToken: r.access_token, refreshToken: r.refresh_token, clientId: id, azure: false }
    } catch (e) {
      if (isRateLimited(e)) throw e
      lastErr = e
    }
  }
  const hint = clientId ? '' : ' (не подошёл ни один стандартный client_id — укажи свой)'
  throw new AuthError(`Refresh token не принят: ${lastErr?.message}${hint}`)
}

// ---------- Microsoft login cookies → refresh token ----------
// Accepts a Netscape cookie jar (tab-separated), a pasted "name=value; …" Cookie
// header, or a mix across lines. Returns { name: value }.
function parseCookies (text) {
  const jar = {}
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim()
    if (!line) continue
    if (/\t/.test(line)) { // Netscape: domain flag path secure expiry name value
      const cols = line.replace(/^#HttpOnly_/i, '').split('\t')
      if (cols.length >= 7 && cols[5]) jar[cols[5].trim()] = cols.slice(6).join('\t').trim()
      continue
    }
    if (line.startsWith('#')) continue
    for (const pair of line.split(';')) {
      const i = pair.indexOf('=')
      if (i > 0) { const k = pair.slice(0, i).trim(); if (k) jar[k] = pair.slice(i + 1).trim() }
    }
  }
  return jar
}

// The __Host-MSAAUTH(P) cookie is what actually carries the login; its presence
// is how we tell a cookie blob apart from a bare token or JSON line.
function looksLikeCookies (text) {
  return /__Host-MSAAUTHP?\s*[=\t]/.test(text) || /\t[^\t\n]*\.login\.live\.com/i.test(text)
}

// Cookie login is the Minecraft launcher flow on login.live.com; a custom Azure
// (GUID) client id does not apply here, so fall back to the launcher id.
async function cookieToRefresh (text, clientId) {
  const jar = parseCookies(text)
  if (!jar['__Host-MSAAUTHP'] && !jar['__Host-MSAAUTH']) {
    throw new AuthError('В куках нет __Host-MSAAUTH(P) — экспортируй куки login.live.com заново')
  }
  const azure = clientId && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(clientId)
  const id = clientId && !azure ? clientId : LIVE_CLIENT_IDS[0]
  const redirect = 'https://login.live.com/oauth20_desktop.srf'
  const scope = 'service::user.auth.xboxlive.com::MBI_SSL'
  const header = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
  const url = 'https://login.live.com/oauth20_authorize.srf?' +
    new URLSearchParams({ client_id: id, response_type: 'code', scope, redirect_uri: redirect }).toString()
  let res
  try {
    res = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': UA, Cookie: header } })
  } catch (e) {
    throw new AuthError(`Сеть: login.live.com недоступен (${e.cause?.code || e.message})`)
  }
  let code = null
  try { code = new URL(res.headers.get('location') || '', 'https://login.live.com').searchParams.get('code') } catch {}
  if (!code) throw new AuthError('Microsoft не принял куки без входа (нужен пароль/2FA) — обнови куки')
  const r = await http('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    form: { client_id: id, grant_type: 'authorization_code', code, redirect_uri: redirect, scope }
  })
  if (!r.refresh_token) throw new AuthError('login.live.com не вернул refresh token')
  return { type: 'refresh', refreshToken: r.refresh_token, clientId: id, viaCookies: true }
}

async function xboxToMinecraft (msAccessToken, azure) {
  const xbl = await http('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'x-xbl-contract-version': '1' },
    json: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: (azure ? 'd=' : 't=') + msAccessToken },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    }
  })
  let xsts
  try {
    xsts = await http('https://xsts.auth.xboxlive.com/xsts/authorize', {
      method: 'POST',
      headers: { 'x-xbl-contract-version': '1' },
      json: {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT'
      }
    })
  } catch (e) {
    if (e.body?.XErr && XSTS_ERRORS[e.body.XErr]) throw new AuthError(XSTS_ERRORS[e.body.XErr])
    throw e
  }
  const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs
  const mc = await http('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    json: { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }
  })
  return { accessToken: mc.access_token, expiresAt: Date.now() + (mc.expires_in || 86400) * 1000 }
}

/**
 * Turns a stored account (token / refresh) into a ready session.
 * May update the account in the store (rotated refresh token, cached access token, name).
 */
async function resolveSession (acc, store, log = () => {}) {
  let accessToken
  if (acc.type === 'token') {
    const exp = tokenExpiresAt(acc)
    if (exp && exp < Date.now() + 30_000) {
      throw new AuthError('Access token истёк — загрузи свежий или используй refresh token')
    }
    accessToken = acc.accessToken
  } else if (acc.type === 'refresh') {
    const exp = tokenExpiresAt(acc)
    if (acc.accessToken && exp && exp > Date.now() + 5 * 60_000) {
      accessToken = acc.accessToken
    } else {
      log('обновляю токен через Microsoft…')
      const ms = await refreshMicrosoft(acc.refreshToken, acc.clientId)
      const mc = await xboxToMinecraft(ms.accessToken, ms.azure)
      store.updateAccount(acc.id, {
        refreshToken: ms.refreshToken || acc.refreshToken,
        clientId: ms.clientId,
        accessToken: mc.accessToken,
        accessTokenExpiresAt: mc.expiresAt,
        lastRefreshAt: Date.now()
      })
      accessToken = mc.accessToken
    }
  } else {
    throw new AuthError(`resolveSession: неподдерживаемый тип ${acc.type}`)
  }

  const profile = await fetchProfile(accessToken)
  if (profile.name !== acc.username || profile.id !== acc.uuid) {
    store.updateAccount(acc.id, { username: profile.name, uuid: profile.id })
  }
  let profileKeys = null
  try {
    profileKeys = await fetchProfileKeys(accessToken)
  } catch (e) {
    if (isRateLimited(e)) throw e
    log(`ключи подписи чата не получены (${e.message}) — чат будет без подписи`)
  }
  return { accessToken, profile, profileKeys }
}

/**
 * mineflayer/minecraft-protocol `auth` hook: does the async login, then lets the
 * connection continue exactly like the built-in microsoft auth does.
 */
function makeAuthHook (getSession, isActive = () => true) {
  return function botifyAuth (client, options) {
    getSession().then(({ accessToken, profile, profileKeys }) => {
      // A failed status probe or manual disconnect may finish before this HTTP request.
      // Do not reopen a connection belonging to that obsolete attempt.
      if (!isActive(client)) return
      const session = { accessToken, selectedProfile: { id: profile.id, name: profile.name }, availableProfile: [{ id: profile.id, name: profile.name }] }
      if (profileKeys) client.profileKeys = profileKeys
      client.session = session
      client.username = profile.name
      options.accessToken = accessToken
      options.haveCredentials = true
      client.emit('session', session)
      options.connect(client)
    }).catch(err => { if (isActive(client)) client.emit('error', err) })
  }
}

/**
 * Parses pasted text: one account per line.
 *   eyJ...            → access token (JWT)
 *   M.C5..._BAY...    → refresh token
 *   token|client_id   → refresh token with explicit client id
 *   {"accessToken": "...", "refreshToken": "..."}  → JSON line (launcher / account manager export)
 */
function parseTokenLines (text, defaultClientId) {
  const out = []
  for (let raw of String(text).split(/\r?\n/)) {
    raw = raw.trim()
    if (!raw || raw.startsWith('#')) continue
    if (raw.startsWith('{')) {
      try {
        const j = JSON.parse(raw)
        const at = j.accessToken || j.access_token || j.mcToken || j.minecraftToken
        const rt = j.refreshToken || j.refresh_token
        if (rt) out.push({ type: 'refresh', refreshToken: rt, clientId: j.clientId || j.client_id || defaultClientId || null, accessToken: at && isJwt(at) ? at : undefined })
        else if (at) out.push({ type: 'token', accessToken: at })
        else out.push({ error: 'JSON без accessToken/refreshToken', raw })
        continue
      } catch {
        out.push({ error: 'битый JSON', raw })
        continue
      }
    }
    const [tok, cid] = raw.split('|').map(s => s.trim())
    if (isJwt(tok)) out.push({ type: 'token', accessToken: tok })
    else if (tok.length > 40 && !/\s/.test(tok)) out.push({ type: 'refresh', refreshToken: tok, clientId: cid || defaultClientId || null })
    else out.push({ error: 'не похоже ни на access, ни на refresh token', raw })
  }
  return out
}

module.exports = {
  AuthError,
  decodeJwt,
  jwtExpiry,
  tokenExpiresAt,
  fetchProfile,
  refreshMicrosoft,
  xboxToMinecraft,
  resolveSession,
  makeAuthHook,
  parseTokenLines,
  parseCookies,
  looksLikeCookies,
  cookieToRefresh
}
