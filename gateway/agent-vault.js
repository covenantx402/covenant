// agent-vault.js — credential broker for AI agents (persistent).
// Agents never hold real credentials. They reference secrets by {{name}};
// this vault substitutes server-side and scrubs values from every readback.
// Storage: entries are AES-256-GCM encrypted, then the encrypted blobs are
// persisted to disk (JSON) so secrets survive restarts. Plaintext never hits disk.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const STORE_PATH = process.env.TRIBUTE_VAULT_STORE ||
  path.join(__dirname, 'data', 'vault.json')
const AUDIT_PATH = process.env.TRIBUTE_VAULT_AUDIT ||
  path.join(__dirname, 'data', 'vault-audit.json')

const entries = new Map()   // name -> { enc, iv, tag, createdAt, hits }
const log = []              // audit trail (last 200 kept, persisted)

function ensureDir() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
}

function key() {
  const raw = process.env.TRIBUTE_VAULT_KEY || crypto.createHash('sha256')
    .update(process.env.TRIBUTE_RPC_UPSTREAM || 'tribute-local').digest()
  return crypto.createHash('sha256').update(raw).digest()
}

function load() {
  try {
    ensureDir()
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
      for (const [k, v] of Object.entries(data.entries || {})) entries.set(k, v)
      log.push(...(data.audit || []))
    }
  } catch (e) {
    console.error('vault load failed:', e.message)
  }
}

function save() {
  ensureDir()
  const tmp = STORE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ entries: Object.fromEntries(entries), audit: log.slice(0, 200) }))
  fs.renameSync(tmp, STORE_PATH)
}

function saveAudit() {
  try {
    ensureDir()
    fs.writeFileSync(AUDIT_PATH, JSON.stringify(log.slice(0, 200)))
  } catch { /* audit is best-effort */ }
}

load()

function put(name, value) {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new Error('name must be 1-64 chars of [A-Za-z0-9_.-]')
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error('value must be a non-empty string ≤ 4096 chars')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  entries.set(name, {
    enc: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    createdAt: Date.now(),
    hits: 0
  })
  save()
  return { name, createdAt: Date.now(), valueLength: value.length }
}

function get(name) {
  const e = entries.get(name)
  if (!e) return null
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(e.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(e.tag, 'base64'))
  const v = Buffer.concat([decipher.update(Buffer.from(e.enc, 'base64')), decipher.final()]).toString('utf8')
  e.hits++
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
  if (used.length) save()
  return { body: out, used: [...new Set(used)] }
}

function scrubSecrets(text) {
  let out = String(text)
  for (const name of entries.keys()) {
    try {
      const v = get(name)
      if (v && v.length >= 4) out = out.split(v).join(`[REDACTED:${name}]`)
    } catch { /* keep going */ }
  }
  return out
}

function list() {
  return [...entries.entries()].map(([name, e]) => ({
    name,
    createdAt: e.createdAt,
    hits: e.hits,
    valueLength: Buffer.from(e.enc, 'base64').length
  }))
}

function del(name) {
  const had = entries.delete(name)
  if (had) save()
  return had
}

function audit(kind, name, detail = {}) {
  log.unshift({ t: Date.now(), kind, name: name || null, ...detail })
  if (log.length > 200) log.length = 200
  saveAudit()
}

function stats() {
  return { entries: entries.size, brokered: log.filter(l => l.kind === 'broker').length, recent: log.slice(0, 12) }
}

module.exports = { put, get, resolve, scrubSecrets, list, del, audit, stats }
