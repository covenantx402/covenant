// sessions.js — paid session manager for TRIBUTE.
// Pattern (matches Stripe MPP-style session intent):
//   1. Agent pays once for a session (a settlement with resource = "session:<id>")
//   2. The session grants N calls (or a TTL) against a route
//   3. Each call redeems the session — no per-request on-chain payment
// Sessions are persisted so restarts don't strand paid sessions.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const STORE_PATH = process.env.TRIBUTE_SESSIONS_STORE ||
  path.join(__dirname, 'data', 'sessions.json')

// sessionId -> { payer, payTo, value, resource, calls: {used, max}, expiresAt, createdAt, txHash }
const sessions = new Map()

function load() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
      const now = Date.now()
      for (const [id, s] of Object.entries(data)) {
        if (s.expiresAt > now) sessions.set(id, s) // drop expired on load
      }
    }
  } catch (e) { console.error('sessions load failed:', e.message) }
}

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const tmp = STORE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)))
  fs.renameSync(tmp, STORE_PATH)
}

load()

/**
 * Open a session after a successful settlement whose intent.resource === "session".
 * Returns the session record with its bearer id.
 */
function open({ payer, payTo, value, calls, ttlSec, txHash }) {
  const id = crypto.randomBytes(24).toString('base64url')
  const rec = {
    payer,
    payTo,
    value,
    calls: { used: 0, max: Math.max(1, Math.min(100000, Number(calls) || 100)) },
    expiresAt: Date.now() + Math.min(86400, Math.max(60, Number(ttlSec) || 3600)) * 1000,
    createdAt: Date.now(),
    txHash: txHash || null,
  }
  sessions.set(id, rec)
  save()
  return { sessionId: id, ...rec }
}

/**
 * Redeem one call from a session. Returns { ok, reason?, remaining?, session? }.
 */
function redeem(sessionId) {
  const s = sessions.get(String(sessionId || ''))
  if (!s) return { ok: false, reason: 'unknown or expired session' }
  if (Date.now() > s.expiresAt) {
    sessions.delete(sessionId); save()
    return { ok: false, reason: 'session expired' }
  }
  if (s.calls.used >= s.calls.max) return { ok: false, reason: 'session call budget exhausted' }
  s.calls.used++
  save()
  return { ok: true, remaining: s.calls.max - s.calls.used, session: s }
}

function status(sessionId) {
  const s = sessions.get(String(sessionId || ''))
  if (!s) return null
  return {
    payer: s.payer,
    callsUsed: s.calls.used,
    callsRemaining: s.calls.max - s.calls.used,
    expiresAt: s.expiresAt,
    txHash: s.txHash,
  }
}

function stats() {
  const now = Date.now()
  let active = 0, callsLeft = 0
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now) { sessions.delete(id); continue }
    active++
    callsLeft += s.calls.max - s.calls.used
  }
  return { activeSessions: active, callsRemaining: callsLeft }
}

setInterval(() => save(), 60000).unref()

module.exports = { open, redeem, status, stats }
