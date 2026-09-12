// agent-vault.js — credential broker for AI agents (persistent, SQLite-backed).
// Agents never hold real credentials. They reference secrets by {{name}};
// this vault substitutes server-side and scrubs values from every readback.
// Storage: entries are AES-256-GCM encrypted, then the encrypted blobs are
// persisted in SQLite (indexed, crash-safe via WAL) — plaintext never hits disk.
const crypto = require('crypto')
const db = require('./db')

function key() {
  const raw = process.env.TRIBUTE_VAULT_KEY || crypto.createHash('sha256')
    .update(process.env.TRIBUTE_RPC_UPSTREAM || 'tribute-local').digest()
  return crypto.createHash('sha256').update(raw).digest()
}

const stmts = {
  put: db.prepare('INSERT INTO vault_entries (name, enc, iv, tag, created_at, hits) VALUES (?,?,?,?,?,0) ON CONFLICT(name) DO UPDATE SET enc=excluded.enc, iv=excluded.iv, tag=excluded.tag, created_at=excluded.created_at, hits=0'),
  get: db.prepare('SELECT * FROM vault_entries WHERE name = ?'),
  bumpHits: db.prepare('UPDATE vault_entries SET hits = hits + 1 WHERE name = ?'),
  list: db.prepare('SELECT name, created_at, hits, length(enc) AS enc_len FROM vault_entries ORDER BY created_at DESC'),
  listNames: db.prepare('SELECT name FROM vault_entries'),
  del: db.prepare('DELETE FROM vault_entries WHERE name = ?'),
  auditInsert: db.prepare('INSERT INTO vault_audit (t, kind, name, detail) VALUES (?,?,?,?)'),
  auditRecent: db.prepare('SELECT t, kind, name, detail FROM vault_audit ORDER BY t DESC LIMIT ?'),
  auditCountByKind: db.prepare("SELECT COUNT(*) AS n FROM vault_audit WHERE kind = 'broker'"),
  count: db.prepare('SELECT COUNT(*) AS n FROM vault_entries'),
}

function put(name, value) {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new Error('name must be 1-64 chars of [A-Za-z0-9_.-]')
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error('value must be a non-empty string ≤ 4096 chars')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const createdAt = Date.now()
  stmts.put.run(name, enc.toString('base64'), iv.toString('base64'), cipher.getAuthTag().toString('base64'), createdAt)
  return { name, createdAt, valueLength: value.length }
}

function get(name) {
  const e = stmts.get.get(name)
  if (!e) return null
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(e.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(e.tag, 'base64'))
  const v = Buffer.concat([decipher.update(Buffer.from(e.enc, 'base64')), decipher.final()]).toString('utf8')
  stmts.bumpHits.run(name)
  return v
}

function resolve(text, { scrub = true } = {}) {
  const used = []
  let out = String(text).replace(/\{\{([a-zA-Z0-9_.-]{1,64})\}\}/g, (m, name) => {
    const v = get(name)
    if (v === null) return m
    used.push(name)
    return v
  })
  if (scrub) out = scrubSecrets(out)
  return { body: out, used: [...new Set(used)] }
}

function scrubSecrets(text) {
  let out = String(text)
  for (const { name } of stmts.listNames.all()) {
    try {
      const v = get(name)
      if (v && v.length >= 4) out = out.split(v).join(`[REDACTED:${name}]`)
    } catch { /* keep going */ }
  }
  return out
}

function list() {
  return stmts.list.all().map(r => ({ name: r.name, createdAt: r.created_at, hits: r.hits, valueLength: r.enc_len }))
}

function del(name) {
  const info = stmts.del.run(name)
  return info.changes > 0
}

function audit(kind, name, detail = {}) {
  stmts.auditInsert.run(Date.now(), kind, name || null, JSON.stringify(detail))
}

function stats() {
  const recent = stmts.auditRecent.all(12).map(r => ({ t: r.t, kind: r.kind, name: r.name, ...JSON.parse(r.detail || '{}') }))
  return { entries: stmts.count.get().n, brokered: stmts.auditCountByKind.get().n, recent }
}

module.exports = { put, get, resolve, scrubSecrets, list, del, audit, stats }
