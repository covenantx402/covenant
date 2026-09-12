// keys.js — agent API keys (SQLite-backed). Raw secret shown once; only sha256 is stored.
const crypto = require('crypto')
const db = require('./db')

const stmts = {
  insert: db.prepare('INSERT INTO agent_keys (id, label, prefix, hash, created_at, last_used, hits) VALUES (?,?,?,?,?,NULL,0)'),
  byHash: db.prepare('SELECT * FROM agent_keys WHERE hash = ?'),
  bumpUse: db.prepare('UPDATE agent_keys SET hits = hits + 1, last_used = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM agent_keys WHERE id = ?'),
  list: db.prepare('SELECT * FROM agent_keys ORDER BY created_at DESC'),
  count: db.prepare('SELECT COUNT(*) AS n FROM agent_keys'),
  totalHits: db.prepare('SELECT COALESCE(SUM(hits), 0) AS n FROM agent_keys'),
}

function publicView(rec) {
  return {
    id: rec.id,
    label: rec.label,
    prefix: rec.prefix,
    createdAt: rec.created_at,
    lastUsed: rec.last_used,
    hits: rec.hits,
  }
}

function mint(label) {
  const raw = 'trb_' + crypto.randomBytes(24).toString('hex')
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  const id = crypto.randomBytes(8).toString('hex')
  const rec = {
    id,
    label: String(label || 'agent').slice(0, 40),
    prefix: raw.slice(0, 12),
    hash,
    created_at: Date.now(),
    last_used: null,
    hits: 0,
  }
  stmts.insert.run(rec.id, rec.label, rec.prefix, rec.hash, rec.created_at)
  return { ...publicView(rec), key: raw }
}

function verify(raw) {
  const token = String(raw || '').trim()
  if (!token.startsWith('trb_')) return null
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  const rec = stmts.byHash.get(hash)
  if (!rec) return null
  stmts.bumpUse.run(Date.now(), rec.id)
  rec.hits += 1
  rec.last_used = Date.now()
  return rec
}

function revoke(id) {
  return stmts.del.run(id).changes > 0
}

function list() { return stmts.list.all().map(publicView) }
function count() { return stmts.count.get().n }
function hits() { return stmts.totalHits.get().n }

module.exports = { mint, verify, revoke, list, count, hits }
