#!/usr/bin/env node
// migrate-json-to-sqlite.js — one-time import of the legacy flat-JSON
// stores into gateway.db. Safe to re-run (INSERT OR IGNORE / upsert
// semantics) but intended to run exactly once during the SQLite cutover.
const fs = require('fs')
const path = require('path')
const db = require('./db')

const DATA = path.join(__dirname, 'data')
function readJson(name) {
  const p = path.join(DATA, name)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {
    console.error(`skip ${name}: parse error`, e.message); return null
  }
}

let migrated = { vault: 0, vaultAudit: 0, keys: 0, wallets: 0, sessions: 0, reputation: 0, nonces: 0, settlements: 0 }

// ---- vault.json ----
const vaultData = readJson('vault.json')
if (vaultData) {
  const put = db.prepare('INSERT OR IGNORE INTO vault_entries (name, enc, iv, tag, created_at, hits) VALUES (?,?,?,?,?,?)')
  for (const [name, e] of Object.entries(vaultData.entries || {})) {
    put.run(name, e.enc, e.iv, e.tag, e.createdAt, e.hits || 0)
    migrated.vault++
  }
  const auditIns = db.prepare('INSERT INTO vault_audit (t, kind, name, detail) VALUES (?,?,?,?)')
  for (const a of (vaultData.audit || [])) {
    const { t, kind, name, ...detail } = a
    auditIns.run(t, kind, name || null, JSON.stringify(detail))
    migrated.vaultAudit++
  }
}

// ---- keys.json ----
const keysData = readJson('keys.json')
if (keysData) {
  const put = db.prepare('INSERT OR IGNORE INTO agent_keys (id, label, prefix, hash, created_at, last_used, hits) VALUES (?,?,?,?,?,?,?)')
  for (const [id, rec] of Object.entries(keysData)) {
    put.run(id, rec.label, rec.prefix, rec.hash, rec.createdAt, rec.lastUsed || null, rec.hits || 0)
    migrated.keys++
  }
}

// ---- wallets.json ----
const walletsData = readJson('wallets.json')
if (Array.isArray(walletsData)) {
  const put = db.prepare('INSERT OR IGNORE INTO wallets (address, label, vault_ref, chain_id, created_at) VALUES (?,?,?,?,?)')
  for (const w of walletsData) {
    put.run(w.address, w.label, w.vault, w.chainId, w.createdAt)
    migrated.wallets++
  }
}

// ---- sessions.json ----
const sessionsData = readJson('sessions.json')
if (sessionsData && typeof sessionsData === 'object') {
  const put = db.prepare('INSERT OR IGNORE INTO sessions (id, payer, pay_to, value, calls_used, calls_max, expires_at, created_at, tx_hash) VALUES (?,?,?,?,?,?,?,?,?)')
  for (const [id, s] of Object.entries(sessionsData)) {
    put.run(id, s.payer, s.payTo || null, s.value != null ? String(s.value) : null, s.calls?.used || 0, s.calls?.max || 1, s.expiresAt, s.createdAt, s.txHash || null)
    migrated.sessions++
  }
}

// ---- reputation.json ----
const repData = readJson('reputation.json')
if (repData) {
  const put = db.prepare('INSERT OR IGNORE INTO reputation (address, first_seen, last_seen, settled_count, total_usdg, resources, txs) VALUES (?,?,?,?,?,?,?)')
  for (const [addr, a] of Object.entries(repData)) {
    put.run(addr, a.firstSeen, a.lastSeen, a.settledCount || 0, a.totalUsdg || 0, JSON.stringify(a.resources || {}), JSON.stringify(a.txs || []))
    migrated.reputation++
  }
}

// ---- settlements.json (nonces + settle log) ----
const settleData = readJson('settlements.json')
if (settleData) {
  const nonces = settleData.nonces || settleData // v1 shape had no wrapper
  const nonceIns = db.prepare('INSERT OR IGNORE INTO nonces (nonce, tx_hash, t, from_addr, value, redeemed) VALUES (?,?,?,?,?,?)')
  for (const [nonce, rec] of Object.entries(nonces)) {
    if (typeof rec !== 'object') continue
    nonceIns.run(nonce, rec.txHash || null, rec.t || Date.now(), rec.from || null, rec.value || '0', rec.redeemed ? 1 : 0)
    migrated.nonces++
  }
  const settleIns = db.prepare('INSERT OR IGNORE INTO settlements (tx_hash, t, payer, pay_to, value, value_formatted, resource, gas_used, pending_splits, splits, splits_cancelled) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  for (const rec of (settleData.log || [])) {
    settleIns.run(
      rec.txHash, rec.t, rec.payer, rec.to, rec.value, rec.valueFormatted, rec.resource || '',
      rec.gasUsed || null,
      rec.pendingSplits ? JSON.stringify(rec.pendingSplits) : null,
      rec.splits ? JSON.stringify(rec.splits) : null,
      rec.splitsCancelled ? 1 : 0
    )
    migrated.settlements++
  }
}

console.log('migration complete:', migrated)
