'use strict'
const AUTH_RETRY_DELAY = 5 * 60_000 // conservative local fallback, not a promised service recovery time

function isRateLimited (err) {
  if (Number(err?.status ?? err?.statusCode ?? err?.response?.status) === 429) return true
  return /(?:status(?:\s+code)?\s*:?\s*429\b|HTTP\s+429\b|too\s*many\s*requests)/i.test(String(err?.message || err))
}

function authRetryDelay (err, now = Date.now()) {
  const value = err?.retryAfter
  let retry = 0
  if (value != null && String(value).trim() !== '') {
    retry = /^\d+$/.test(String(value).trim()) ? Number(value) * 1000 : Date.parse(value) - now
  }
  return Math.max(AUTH_RETRY_DELAY, Number.isFinite(retry) ? retry : 0)
}

function isAlreadyOnline (text) {
  return /\byou\s+are\s+already\s+online\b/i.test(String(text).replace(/§[0-9a-fk-or]/gi, ''))
}

module.exports = { isRateLimited, authRetryDelay, isAlreadyOnline }
