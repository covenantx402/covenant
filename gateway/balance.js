// Buyer prepaid balances — "Tahap 3": top up once with x402, then call paid
// APIs with an API key (no per-call wallet signature). USDG sits in the
// facilitator wallet as escrow; this ledger is the authoritative server-side
// record of who owns what. Withdrawals require the owner's EIP-712 signature.
//
// Ledger amounts are USDG atomic (6 decimals). SQLite-backed (see db.js) —
// indexed upserts, no more full-file JSON rewrite on every credit/debit/key
// mint (this is the ledger holding actual escrowed USDG; it's the one place
// a lost/corrupted flat-file write matters most).
'use strict'
const crypto = require('crypto')
const { ethers } = require('ethers')
const db = require('./db')

const stmts = {
  getBalance: db.prepare('SELECT * FROM balances WHERE address = ?'),
  insertBalance: db.prepare('INSERT INTO balances (address, balance_atomic, created_at) VALUES (?,?,?) ON CONFLICT(address) DO NOTHING'),
  setBalance: db.prepare('UPDATE balances SET balance_atomic = ? WHERE address = ?'),
  addHistory: db.prepare('INSERT INTO balance_history (address, type, amount, note, t) VALUES (?,?,?,?,?)'),
  recentHistory: db.prepare('SELECT type, amount, note, t FROM balance_history WHERE address = ? ORDER BY t DESC LIMIT ?'),
  insertKey: db.prepare('INSERT INTO balance_keys (hash, address, created_at, last_used) VALUES (?,?,?,NULL)'),
  getKey: db.prepare('SELECT * FROM balance_keys WHERE hash = ?'),
  touchKey: db.prepare('UPDATE balance_keys SET last_used = ? WHERE hash = ?'),
  delKey: db.prepare('DELETE FROM balance_keys WHERE hash = ?'),
  listKeys: db.prepare('SELECT hash, created_at, last_used FROM balance_keys WHERE address = ?'),
}

function rec(addr) {
  const k = String(addr || '').toLowerCase()
  if (!ethers.isAddress(k)) return null
  let row = stmts.getBalance.get(k)
  if (!row) {
    stmts.insertBalance.run(k, '0', Date.now())
    row = stmts.getBalance.get(k)
  }
  return { address: ethers.getAddress(k), balanceAtomic: row.balance_atomic }
}

function balanceOf(addr) {
  const row = stmts.getBalance.get(String(addr || '').toLowerCase())
  return row ? BigInt(row.balance_atomic || 0) : 0n
}

/** Credit (top-up) or debit (call). Debit fails cleanly when funds are short. */
function credit(addr, atomic, note) {
  const r = rec(addr); if (!r) return { ok: false, error: 'bad address' }
  const k = addr.toLowerCase()
  const next = String(BigInt(r.balanceAtomic || 0) + BigInt(atomic))
  stmts.setBalance.run(next, k)
  stmts.addHistory.run(k, 'credit', String(atomic), note || null, Date.now())
  return { ok: true, balanceAtomic: next }
}
function debit(addr, atomic, note) {
  const r = rec(addr); if (!r) return { ok: false, error: 'bad address' }
  const k = addr.toLowerCase()
  const v = BigInt(atomic)
  if (BigInt(r.balanceAtomic || 0) < v) return { ok: false, error: 'insufficient balance' }
  const next = String(BigInt(r.balanceAtomic) - v)
  stmts.setBalance.run(next, k)
  stmts.addHistory.run(k, 'debit', String(v), note || null, Date.now())
  return { ok: true, balanceAtomic: next }
}

// ---- API keys -------------------------------------------------------------
const keyHash = k => crypto.createHash('sha256').update(String(k)).digest('hex')

function createKey(addr) {
  const r = rec(addr); if (!r) return null
  const key = 'trb_' + crypto.randomBytes(20).toString('base64url')
  stmts.insertKey.run(keyHash(key), addr.toLowerCase(), Date.now())
  return { key, address: r.address }
}

/** Resolve an API key to its owner record; null when unknown. */
function ownerByKey(key) {
  const k = stmts.getKey.get(keyHash(key))
  return k ? rec(k.address) : null
}
function touchKey(addr, key) {
  const h = keyHash(key)
  if (stmts.getKey.get(h)) stmts.touchKey.run(Date.now(), h)
}
function revokeKey(addr, key) {
  const h = keyHash(key)
  const row = stmts.getKey.get(h)
  if (!row || row.address !== String(addr).toLowerCase()) return false
  stmts.delKey.run(h)
  return true
}
function listKeys(addr) {
  return stmts.listKeys.all(String(addr || '').toLowerCase())
    .map(k => ({ createdAt: k.created_at, lastUsed: k.last_used }))
}

// ---- withdrawals (owner-signed, EIP-712) ----------------------------------
const KEY_TYPES = {
  CreateKeyIntent: [
    { name: 'buyer', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
  ],
}
function verifyKeyIntent(intent, signature, DOMAIN) {
  try {
    const signer = ethers.verifyTypedData(DOMAIN, KEY_TYPES, intent, signature)
    if (signer.toLowerCase() !== String(intent.buyer).toLowerCase()) return { ok: false, reason: 'signer mismatch' }
    const now = Math.floor(Date.now() / 1000)
    if (intent.validAfter && now < Number(intent.validAfter)) return { ok: false, reason: 'not yet valid' }
    if (intent.validBefore && now > Number(intent.validBefore)) return { ok: false, reason: 'expired' }
    return { ok: true, buyer: signer }
  } catch (e) { return { ok: false, reason: 'bad signature: ' + e.message } }
}

const WITHDRAW_TYPES = {
  WithdrawIntent: [
    { name: 'buyer', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'to', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
  ],
}

/**
 * Verify a withdrawal signature against the domain the buyer already knows
 * (same EIP-712 domain as payments). Returns { ok, reason } — the CALLER
 * executes the on-chain transfer after this passes AND balance suffices.
 */
function verifyWithdraw(intent, signature, DOMAIN) {
  try {
    const signer = ethers.verifyTypedData(DOMAIN, WITHDRAW_TYPES, intent, signature)
    if (signer.toLowerCase() !== String(intent.buyer).toLowerCase()) return { ok: false, reason: 'signer mismatch' }
    if (String(intent.to).toLowerCase() !== String(intent.buyer).toLowerCase()) return { ok: false, reason: 'withdrawal must go to your own wallet' }
    const now = Math.floor(Date.now() / 1000)
    if (intent.validAfter && now < Number(intent.validAfter)) return { ok: false, reason: 'not yet valid' }
    if (intent.validBefore && now > Number(intent.validBefore)) return { ok: false, reason: 'expired' }
    const bal = balanceOf(intent.buyer)
    if (BigInt(intent.amount) <= 0n) return { ok: false, reason: 'amount must be positive' }
    if (BigInt(intent.amount) > bal) return { ok: false, reason: 'insufficient balance' }
    return { ok: true, buyer: ethers.getAddress(String(intent.buyer).toLowerCase()), amount: BigInt(intent.amount) }
  } catch (e) { return { ok: false, reason: 'bad signature: ' + e.message } }
}

function view(addr) {
  const row = stmts.getBalance.get(String(addr || '').toLowerCase())
  if (!row) return { address: null, balance: '0.000000', keys: [], history: [] }
  const address = ethers.getAddress(row.address)
  return {
    address,
    balance: ethers.formatUnits(BigInt(row.balance_atomic || 0), 6),
    balanceAtomic: String(row.balance_atomic || '0'),
    keys: listKeys(address),
    history: stmts.recentHistory.all(String(addr).toLowerCase(), 20).map(h => ({ type: h.type, amount: h.amount, note: h.note, at: h.t })),
  }
}

module.exports = {
  rec, balanceOf, credit, debit, createKey, ownerByKey, touchKey, revokeKey, listKeys,
  verifyWithdraw, WITHDRAW_TYPES, verifyKeyIntent, KEY_TYPES, view,
}
