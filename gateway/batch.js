// batch.js — x402 "batch-settlement" scheme: accumulate many off-chain-
// verified vouchers, settle them in ONE on-chain transaction instead of
// one settlement per request.
//
// HONEST FRAMING (read this before treating this as a real payment
// channel — see README's "Batch settlement" section for the full
// writeup): the x402 spec's batch-settlement scheme describes a genuine
// bidirectional payment channel with an on-chain escrow deposit, a
// non-cooperative withdraw with a dispute timer (CDP's spec:
// `withdrawDelay`, 900-2,592,000 seconds), and a `receiverAuthorizer`
// that can sign claim batches. That requires its own smart contract —
// COVENANT has none deployed for this. What's built here instead is a
// simpler "running tab" that gets the SAME economic benefit (verify N
// requests for free, pay gas once instead of N times) using nothing but
// the existing approve+transferFrom pattern every other route uses:
//   1. Buyer approves the facilitator spender for a cap (same as always).
//   2. Buyer opens a channel: signs a channelId + validBefore window.
//   3. Each request, the buyer signs a VOUCHER — a cumulative total
//      ("I now owe up to X atomic units total on this channel"), NOT a
//      per-request amount. Verifying a voucher is pure signature math +
//      a monotonic-increase check: no RPC call, no gas, genuinely free,
//      same as the spec's documented behavior.
//   4. The facilitator claims the channel ONCE: a single transferFrom
//      for the latest cumulative total, whenever it chooses (channel
//      close, a cap threshold, a cron, whatever the deployer wants).
// What this does NOT have that a real payment channel contract would:
//   - No escrow — the buyer's USDC/USDG sits in their own wallet the
//     whole time, same as every other COVENANT route. The buyer's
//     safety valve if they distrust the facilitator is revoking the
//     ERC-20 approval (immediate, no dispute window needed) rather than
//     an on-chain non-cooperative withdraw.
//   - No facilitator-side dispute mechanism — if the facilitator claims
//     a channel and then refuses to deliver, that's the same trust
//     model COVENANT already has for "exact"/"upto" (deliver-then-claim
//     for marketplace listings, claim-then-deliver for owned routes).
//     Batch-settlement doesn't change that trust boundary, it only
//     changes WHEN the on-chain claim happens (once per channel instead
//     of once per request).
const crypto = require('crypto')
const db = require('./db')
const chains = require('./chains')

// Per-channel claim lock. Found by audit: two concurrent POST
// /x402/batch/claim calls for the SAME channel both read netClaimable()
// BEFORE either records its claim, both see the identical net amount,
// and both would execute a real transferFrom for that amount —
// overcharging the buyer beyond what any single voucher's cumulative
// total actually authorized (the buyer signed "owe up to X total", not
// "X total, claimable more than once concurrently"). Must span the
// ENTIRE claim flow (netClaimable check -> the async on-chain
// transferFrom -> recordClaim), not just the synchronous DB read, since
// the window where two requests could interleave is exactly the time
// spent waiting on the RPC call in between. In-memory Set is sufficient
// here: claims are a low-frequency, operator-triggered action (not a
// per-request hot path like verifyVoucher), and this process is the
// only writer to batch_channels.
// DB-backed lock (audit 2026-10): the old in-memory Set did not span processes or restarts.
// A lock older than CLAIM_LOCK_TTL_MS is treated as stale (crashed holder); an in-flight
// broadcast is protected separately by claim_pending, which survives the lock.
const CLAIM_LOCK_TTL_MS = 10 * 60 * 1000
function tryLockChannel(channelId) {
  const now = Date.now()
  return db.prepare('UPDATE batch_channels SET claim_lock = ? WHERE id = ? AND (claim_lock IS NULL OR claim_lock < ?)')
    .run(now, String(channelId || ''), now - CLAIM_LOCK_TTL_MS).changes > 0
}
function unlockChannel(channelId) {
  db.prepare('UPDATE batch_channels SET claim_lock = NULL WHERE id = ?').run(String(channelId || ''))
}
/** A broadcast-but-unrecorded claim tx: { txHash, netValue, totalValue, close, t }. */
function setClaimPending(channelId, obj) {
  db.prepare('UPDATE batch_channels SET claim_pending = ? WHERE id = ?').run(JSON.stringify(obj), String(channelId))
}
function clearClaimPending(channelId) {
  db.prepare('UPDATE batch_channels SET claim_pending = NULL WHERE id = ?').run(String(channelId))
}
function getClaimPending(channelId) {
  const r = db.prepare('SELECT claim_pending, chain_id FROM batch_channels WHERE id = ?').get(String(channelId || ''))
  if (!r || !r.claim_pending) return null
  try { return { ...JSON.parse(r.claim_pending), chainId: r.chain_id } } catch { return null }
}

const DOMAIN_NAME = 'COVENANT'
const DOMAIN_VERSION = '1'

// Separate EIP-712 type from PaymentIntent (facilitator.js) — a voucher is
// a cumulative claim bound to a channel, not a one-shot transfer
// authorization, so it needs its own domain-separated type to avoid any
// cross-scheme signature confusion.
const VOUCHER_TYPES = {
  BatchVoucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'payTo', type: 'address' },
    { name: 'cumulativeValue', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
  ],
}

function domainFor(chainId) {
  const c = chains.getChain(chainId)
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: c.id, verifyingContract: c.usdc }
}

const MAX_CHANNEL_LIFETIME_SEC = 7 * 86400 // 7 days — long enough to actually batch many requests, bounded so a forgotten channel doesn't live forever

const stmts = {
  insert: db.prepare('INSERT INTO batch_channels (id, chain_id, payer, pay_to, opened_at, valid_before) VALUES (?,?,?,?,?,?)'),
  get: db.prepare('SELECT * FROM batch_channels WHERE id = ?'),
  bumpVoucher: db.prepare('UPDATE batch_channels SET last_cumulative_value = ?, last_nonce = ?, vouchers_verified = vouchers_verified + 1 WHERE id = ?'),
  claim: db.prepare('UPDATE batch_channels SET claimed_value = ?, claimed_tx_hashes = ?, closed = ? WHERE id = ?'),
  listOpenForPayer: db.prepare('SELECT * FROM batch_channels WHERE payer = ? AND closed = 0 ORDER BY opened_at DESC'),
  // Storage-growth hardening: POST /x402/batch/open is open (no auth, no
  // cost — same posture as POST /keys), so nothing stops a caller from
  // opening channels indefinitely and never using them. Sweep expired
  // channels that NEVER accumulated any claimable value (nothing was
  // claimed AND nothing is owed) — a channel that was actually used keeps
  // its history. Piggybacks on openChannel() the same way sessions.js's
  // sweepExpired piggybacks on stats() — no separate cron needed.
  sweepUnusedExpired: db.prepare("DELETE FROM batch_channels WHERE valid_before <= ? AND last_cumulative_value = '0' AND claimed_value = '0'"),
}

function rowToChannel(r) {
  return {
    id: r.id, chainId: r.chain_id, payer: r.payer, payTo: r.pay_to,
    openedAt: r.opened_at, validBefore: r.valid_before,
    lastCumulativeValue: r.last_cumulative_value, vouchersVerified: r.vouchers_verified,
    claimedValue: r.claimed_value, claimedTxHashes: JSON.parse(r.claimed_tx_hashes || '[]'),
    closed: !!r.closed,
  }
}

/** Open a channel. Returns { channelId, payTo, validBefore } for the buyer to sign vouchers against. */
function openChannel({ payer, payTo, chainId, validForSec }) {
  if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer)) throw new Error('payer must be a 0x address')
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error('payTo must be a 0x address')
  stmts.sweepUnusedExpired.run(Math.floor(Date.now() / 1000))
  const id = '0x' + crypto.randomBytes(32).toString('hex')
  const openedAt = Date.now()
  const validBefore = Math.floor(openedAt / 1000) + Math.min(MAX_CHANNEL_LIFETIME_SEC, Math.max(60, Number(validForSec) || 86400))
  stmts.insert.run(id, Number(chainId), payer.toLowerCase(), payTo.toLowerCase(), openedAt, validBefore)
  return { channelId: id, chainId: Number(chainId), payer: payer.toLowerCase(), payTo: payTo.toLowerCase(), validBefore, openedAt }
}

function getChannel(id) {
  const r = stmts.get.get(String(id || ''))
  return r ? rowToChannel(r) : null
}

/**
 * Verify a voucher — PURE off-chain check, no RPC call, no gas, genuinely
 * free (this is the entire economic point of batch-settlement). Checks:
 *   - channel exists, is open, not expired
 *   - signature recovers to the channel's payer
 *   - cumulativeValue is MONOTONICALLY INCREASING vs. the last accepted
 *     voucher (a voucher can only raise the running total, never lower
 *     it — otherwise a payer could sign a smaller voucher to "undo" an
 *     earlier claim)
 * Returns { ok, reason? }. On success, records the voucher as the new
 * high-water mark (does NOT touch the chain).
 */
function verifyVoucher({ ethers, channelId, cumulativeValue, signature }) {
  const ch = stmts.get.get(String(channelId || ''))
  if (!ch) return { ok: false, reason: 'unknown channel' }
  if (ch.closed) return { ok: false, reason: 'channel already closed' }
  const now = Math.floor(Date.now() / 1000)
  if (ch.valid_before <= now) return { ok: false, reason: 'channel expired' }

  let cv
  try { cv = BigInt(cumulativeValue) } catch { return { ok: false, reason: 'cumulativeValue is invalid' } }
  if (cv <= 0n) return { ok: false, reason: 'cumulativeValue must be > 0' }
  const last = BigInt(ch.last_cumulative_value || '0')
  if (cv <= last) return { ok: false, reason: `cumulativeValue (${cv}) must exceed the channel's current high-water mark (${last}) — vouchers only raise the running total` }

  const voucher = { channelId: ch.id, payer: ch.payer, payTo: ch.pay_to, cumulativeValue: cv.toString(), validBefore: String(ch.valid_before) }
  let signer
  try { signer = ethers.verifyTypedData(domainFor(ch.chain_id), VOUCHER_TYPES, voucher, signature) }
  catch (e) { return { ok: false, reason: 'voucher signature verification error: ' + String(e.shortMessage || e.message) } }
  if (signer.toLowerCase() !== ch.payer.toLowerCase()) return { ok: false, reason: 'voucher signature does not match channel payer' }

  stmts.bumpVoucher.run(cv.toString(), signature, ch.id)
  return { ok: true, channelId: ch.id, cumulativeValue: cv.toString(), vouchersVerified: ch.vouchers_verified + 1 }
}

/**
 * Claim a channel on-chain: one transferFrom for (latest cumulative
 * value - already-claimed value), i.e. only the NET NEW amount since the
 * last claim (a channel can be claimed more than once across its
 * lifetime without double-spending the already-settled portion).
 * Returns { ok, reason? } to the caller, who performs the actual
 * transferFrom (kept in facilitator.js, not duplicated here, so there is
 * ONE settlement code path on-chain regardless of scheme).
 */
function netClaimable(channelId) {
  const ch = stmts.get.get(String(channelId || ''))
  if (!ch) return { ok: false, reason: 'unknown channel' }
  const total = BigInt(ch.last_cumulative_value || '0')
  const already = BigInt(ch.claimed_value || '0')
  const net = total - already
  if (net <= 0n) return { ok: false, reason: 'nothing new to claim on this channel' }
  return { ok: true, channel: rowToChannel(ch), netValue: net.toString(), totalValue: total.toString() }
}

/** Record a successful on-chain claim. claimedTotal is the cumulative value the tx actually covered —
 *  NOT the channel's current high-water mark, which a concurrent voucher may have raised since. */
function recordClaim(channelId, txHash, closeChannel, claimedTotal) {
  const ch = stmts.get.get(String(channelId || ''))
  if (!ch) return
  const hashes = JSON.parse(ch.claimed_tx_hashes || '[]')
  hashes.push(txHash)
  stmts.claim.run(String(claimedTotal), JSON.stringify(hashes), closeChannel ? 1 : 0, ch.id)
  clearClaimPending(ch.id)
}

function listOpenChannels(payer) {
  return stmts.listOpenForPayer.all(String(payer || '').toLowerCase()).map(rowToChannel)
}

module.exports = {
  VOUCHER_TYPES, domainFor, MAX_CHANNEL_LIFETIME_SEC,
  openChannel, getChannel, verifyVoucher, netClaimable, recordClaim, listOpenChannels,
  tryLockChannel, unlockChannel, setClaimPending, clearClaimPending, getClaimPending,
}
