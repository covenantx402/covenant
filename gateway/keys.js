// Agent API keys. Raw secret shown once; only sha256 is stored. Persisted to disk.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const STORE_PATH = process.env.TRIBUTE_KEYS_STORE ||
  path.join(__dirname, 'data', 'keys.json')

const keys = new Map() // id -> rec

function load() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
      for (const [id, rec] of Object.entries(data)) keys.set(id, rec)
    }
  } catch (e) {
    console.error('keys load failed:', e.message)
  }
}

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const tmp = STORE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(keys)))
  fs.renameSync(tmp, STORE_PATH)
}

load()

function publicView(rec) {
  return {
    id: rec.id,
    label: rec.label,
    prefix: rec.prefix,
    createdAt: rec.createdAt,
    lastUsed: rec.lastUsed,
    hits: rec.hits
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
    createdAt: Date.now(),
    lastUsed: null,
    hits: 0
  }
  keys.set(id, rec)
  save()
  return { ...publicView(rec), key: raw }
}

function verify(raw) {
  const token = String(raw || '').trim()
  if (!token.startsWith('trb_')) return null
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  for (const rec of keys.values()) {
    if (rec.hash === hash) {
      rec.hits++
      rec.lastUsed = Date.now()
      save()
      return rec
    }
  }
  return null
}

function revoke(id) {
  const had = keys.delete(id)
  if (had) save()
  return had
}

function list() { return [...keys.values()].map(publicView) }
function count() { return keys.size }
function hits() { return [...keys.values()].reduce((s, k) => s + k.hits, 0) }

module.exports = { mint, verify, revoke, list, count, hits }
