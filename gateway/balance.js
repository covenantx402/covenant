// Buyer prepaid balances — "Tahap 3": top up once with x402, then call paid
// APIs with an API key (no per-call wallet signature). USDG sits in the
// facilitator wallet as escrow; this ledger is the authoritative server-side
// record of who owns what. Withdrawals require the owner's EIP-712 signature.
//
// Ledger amounts are USDG atomic (6 decimals). All mutations go through the
// debit/credit helpers so the JSON store stays consistent (atomic rename).
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { ethers } = require('ethers')

const STORE_PATH = process.env.TRIBUTE_BALANCE_STORE ||
  path.join(__dirname, '..', 'data', 'balances.json')

const buyers = new Map()   // addrLower -> { address, balanceAtomic, keys: {keyHash}, history: [] }
const keyIndex = new Map() // keyHash -> addrLower

function save() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    const tmp = STORE_PATH + '.tmp'
    const obj = {}
    for (const [k, v] of buyers) obj[k] = v
    fs.writeFileSync(tmp, JSON.stringify(obj))
    fs.renameSync(tmp, STORE_PATH)
  } catch (e) { console.error('balance save failed:', e.message) }
}

function load() {
  try {
    if (!fs.existsSync(STORE_PATH)) return
    const obj = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    for (const [k, v] of Object.entries(obj)) {
      buyers.set(k, v)
      for (const kh of Object.keys(v.keys || {})) keyIndex.set(kh, k)
    }
  } catch (e) { console.error('balance load failed:', e.message) }
}
load()

function rec(addr) {
  const k = String(addr || '').toLowerCase()
  if (!ethers.isAddress(k)) return null
  if (!buyers.has(k)) buyers.set(k, { address: ethers.getAddress(k), balanceAtomic: '0', keys: {}, history: [] })
  return buyers.get(k)
}

function balanceOf(addr) {
  const r = buyers.get(String(addr || '').toLowerCase())
  return r ? BigInt(r.balanceAtomic || 0) : 0n
}

/** Credit (top-up) or debit (call). Debit fails cleanly when funds are short. */
function credit(addr, atomic, note) {
  const r = rec(addr); if (!r) return { ok: false, error: 'bad address' }
  r.balanceAtomic = String(BigInt(r.balanceAtomic || 0) + BigInt(atomic))
  push(r, { type: 'credit', amount: String(atomic), note, at: Date.now() })
  save()
  return { ok: true, balanceAtomic: r.balanceAtomic }
}
function debit(addr, atomic, note) {
  const r = rec(addr); if (!r) return { ok: false, error: 'bad address' }
  const v = BigInt(atomic)
  if (BigInt(r.balanceAtomic || 0) < v) return { ok: false, error: 'insufficient balance' }
  r.balanceAtomic = String(BigInt(r.balanceAtomic) - v)
  push(r, { type: 'debit', amount: String(v), note, at: Date.now() })
  save()
  return { ok: true, balanceAtomic: r.balanceAtomic }
}
function push(r, ev) {
  r.history = r.history || []
  r.history.push(ev)
  if (r.history.length > 200) r.history = r.history.slice(-200)
}

// ---- API keys -------------------------------------------------------------
const keyHash = k => crypto.createHash('sha256').update(String(k)).digest('hex')

function createKey(addr) {
  const r = rec(addr); if (!r) return null
  const key = 'trb_' + crypto.randomBytes(20).toString('base64url')
  r.keys[keyHash(key)] = { createdAt: Date.now(), lastUsed: null }
  keyIndex.set(keyHash(key), String(addr).toLowerCase())
  save()
  return { key, address: r.address }
}

/** Resolve an API key to its owner record; null when unknown. */
function ownerByKey(key) {
  const a = keyIndex.get(keyHash(key))
  return a ? buyers.get(a) : null
}
function touchKey(addr, key) {
  const r = buyers.get(String(addr).toLowerCase())
  const m = r && r.keys[keyHash(key)]
  if (m) { m.lastUsed = Date.now(); save() }
}
function revokeKey(addr, key) {
  const r = buyers.get(String(addr).toLowerCase()); if (!r) return false
  const h = keyHash(key)
  if (!r.keys[h]) return false
  delete r.keys[h]; keyIndex.delete(h); save()
  return true
}
function listKeys(addr) {
  const r = buyers.get(String(addr).toLowerCase()); if (!r) return []
  return Object.values(r.keys).map(m => ({ createdAt: m.createdAt, lastUsed: m.lastUsed }))
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
  const r = buyers.get(String(addr || '').toLowerCase())
  if (!r) return { address: null, balance: '0.000000', keys: [], history: [] }
  return {
    address: r.address,
    balance: ethers.formatUnits(BigInt(r.balanceAtomic || 0), 6),
    balanceAtomic: String(r.balanceAtomic || '0'),
    keys: listKeys(r.address),
    history: (r.history || []).slice(-20).reverse(),
  }
}

module.exports = {
  rec, balanceOf, credit, debit, createKey, ownerByKey, touchKey, revokeKey, listKeys,
  verifyWithdraw, WITHDRAW_TYPES, verifyKeyIntent, KEY_TYPES, view,
}
