// One-time migration: marketplace.json (flat file, pre-SQLite) -> the
// marketplace_listings / marketplace_subs / marketplace_nonces tables in
// db.js. Safe to run even when marketplace.json doesn't exist (no-op) or
// when the SQLite tables already have data (INSERT ... ON CONFLICT DO
// NOTHING / skips existing slugs) — idempotent, re-runnable.
//
// Usage: TRIBUTE_DB_PATH=... TRIBUTE_MARKETPLACE_STORE=... node scripts/migrate-marketplace-json-to-sqlite.js
const fs = require('fs')
const path = require('path')
const db = require('../db')

const STORE_PATH = process.env.TRIBUTE_MARKETPLACE_STORE ||
  path.join(__dirname, '..', 'data', 'marketplace.json')

if (!fs.existsSync(STORE_PATH)) {
  console.log('no marketplace.json found at', STORE_PATH, '- nothing to migrate')
  process.exit(0)
}

const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
const listings = data.listings || []
const subs = data.subs || []
const nonces = data.nonces || []

const insertListing = db.prepare(`INSERT INTO marketplace_listings
  (slug, kind, name, description, upstream, price, seller, status, created_at,
   delisted_at, hits, paid, failed, refunded, earned_atomic, refunded_atomic,
   lat_sum_ms, lat_n, last_latency_ms, plan_calls, plan_price, plan_atomic, private_headers_enc)
  VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?, ?,?,?,?)
  ON CONFLICT(slug) DO NOTHING`)

let migratedListings = 0
for (const l of listings) {
  if (!l || !l.slug) continue
  const r = insertListing.run(
    l.slug, l.kind || 'external', l.name, l.description || null, l.upstream, String(l.price), l.seller,
    l.status || 'active', l.createdAt || Date.now(), l.delistedAt || null,
    l.hits || 0, l.paid || 0, l.failed || 0, l.refunded || 0,
    String(l.earnedAtomic || '0'), String(l.refundedAtomic || '0'),
    l.latSumMs || 0, l.latN || 0, l.lastLatencyMs || null,
    l.plan ? l.plan.calls : null, l.plan ? l.plan.price : null, l.plan ? String(l.plan.atomic) : null,
    l.privateHeadersEnc ? JSON.stringify(l.privateHeadersEnc) : null,
  )
  if (r.changes) migratedListings++
}

const insertSub = db.prepare(`INSERT INTO marketplace_subs
  (slug, buyer, plan_calls, plan_price, atomic, remaining, used, purchased_at, tx_hash)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(slug, buyer) DO NOTHING`)
let migratedSubs = 0
for (const s of subs) {
  if (!s || !s.slug || !s.buyer) continue
  const r = insertSub.run(s.slug, s.buyer, s.planCalls, String(s.planPrice), String(s.atomic || '0'), s.remaining || 0, s.used || 0, s.purchasedAt || Date.now(), s.txHash || null)
  if (r.changes) migratedSubs++
}

const insertNonce = db.prepare('INSERT INTO marketplace_nonces (nonce, t) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING')
let migratedNonces = 0
for (const n of nonces) {
  const r = insertNonce.run(n, Date.now())
  if (r.changes) migratedNonces++
}

console.log(`migrated: ${migratedListings} listings, ${migratedSubs} subs, ${migratedNonces} nonces from ${STORE_PATH}`)
console.log(`source file left in place at ${STORE_PATH} — safe to delete once verified`)
