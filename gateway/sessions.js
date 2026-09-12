// sessions.js — paid session manager for TRIBUTE (SQLite-backed).
// Pattern (matches Stripe MPP-style session intent):
//   1. Agent pays once for a session (a settlement with resource = "session:<id>")
//   2. The session grants N calls (or a TTL) against a route
//   3. Each call redeems the session — no per-request on-chain payment
// Sessions persist in SQLite so restarts don't strand paid sessions, and
// redemption is a single indexed UPDATE instead of a full-table rewrite.
const crypto = require('crypto')
const db = require('./db')

const stmts = {
  insert: db.prepare('INSERT INTO sessions (id, payer, pay_to, value, calls_used, calls_max, expires_at, created_at, tx_hash) VALUES (?,?,?,?,0,?,?,?,?)'),
  get: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  redeem: db.prepare('UPDATE sessions SET calls_used = calls_used + 1 WHERE id = ? AND calls_used < calls_max'),
  del: db.prepare('DELETE FROM sessions WHERE id = ?'),
  sweepExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  activeStats: db.prepare('SELECT COUNT(*) AS active, COALESCE(SUM(calls_max - calls_used), 0) AS callsLeft FROM sessions WHERE expires_at > ?'),
}

/**
 * Open a session after a successful settlement whose intent.resource === "session".
 * Returns the session record with its bearer id.
 */
function open({ payer, payTo, value, calls, ttlSec, txHash }) {
  const id = crypto.randomBytes(24).toString('base64url')
  const callsMax = Math.max(1, Math.min(100000, Number(calls) || 100))
  const expiresAt = Date.now() + Math.min(86400, Math.max(60, Number(ttlSec) || 3600)) * 1000
  const createdAt = Date.now()
  stmts.insert.run(id, payer, payTo || null, value != null ? String(value) : null, callsMax, expiresAt, createdAt, txHash || null)
  return { sessionId: id, payer, payTo, value, calls: { used: 0, max: callsMax }, expiresAt, createdAt, txHash: txHash || null }
}

/**
 * Redeem one call from a session. Returns { ok, reason?, remaining?, session? }.
 */
function redeem(sessionId) {
  const s = stmts.get.get(String(sessionId || ''))
  if (!s) return { ok: false, reason: 'unknown or expired session' }
  if (Date.now() > s.expires_at) {
    stmts.del.run(sessionId)
    return { ok: false, reason: 'session expired' }
  }
  if (s.calls_used >= s.calls_max) return { ok: false, reason: 'session call budget exhausted' }
  const info = stmts.redeem.run(sessionId)
  if (info.changes === 0) return { ok: false, reason: 'session call budget exhausted' }
  const remaining = s.calls_max - (s.calls_used + 1)
  return { ok: true, remaining, session: { ...s, calls: { used: s.calls_used + 1, max: s.calls_max } } }
}

function status(sessionId) {
  const s = stmts.get.get(String(sessionId || ''))
  if (!s) return null
  return {
    payer: s.payer,
    callsUsed: s.calls_used,
    callsRemaining: s.calls_max - s.calls_used,
    expiresAt: s.expires_at,
    txHash: s.tx_hash,
  }
}

function stats() {
  const now = Date.now()
  stmts.sweepExpired.run(now)
  const row = stmts.activeStats.get(now)
  return { activeSessions: row.active, callsRemaining: row.callsLeft }
}

module.exports = { open, redeem, status, stats }
