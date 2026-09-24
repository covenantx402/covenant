// facilitator.js — on-chain settlement verifier for USDG (Robinhood Chain 4663).
//
// IMPORTANT: USDG (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) does NOT support
// EIP-3009 transferWithAuthorization (verified on-chain: selector missing from
// the implementation bytecode). Settlement therefore uses the approve+transferFrom
// pattern: the paying agent approves the facilitator's settlement wallet, then the
// facilitator pulls funds with transferFrom. Verification here checks:
//   - signature is a valid EIP-712 payment intent signed by `from`
//   - the signer holds sufficient USDG balance (or has approved the spender)
//   - the authorization window is valid and the nonce unused (replay guard)
// The signed intent is the server's proof-of-authorization to execute transferFrom.
//
// EIP-712 domain (verified on-chain via DOMAIN_SEPARATOR):
//   name "TRIBUTE", version "1", chainId 4663, verifyingContract USDG
//
// NOTE: name was "Global Dollar" (the token) before. Wallets flagged that as
// a phishing-shaped approval: the message claimed to come from the token
// contract itself. TRIBUTE is the party asking the user to sign, so TRIBUTE
// is the correct domain name. Must stay in sync with frontend
// /root/tributex402/src/lib/pay.ts DOMAIN.
const { ethers } = require('ethers')
const db = require('./db')

const CHAIN_ID = 4663
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const USDG_DECIMALS = 6
const DOMAIN_NAME = 'TRIBUTE'
const DOMAIN_VERSION = '1'

const DOMAIN = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: USDG,
}

const INTENT_TYPES = {
  PaymentIntent: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'resource', type: 'string' },
  ],
}

// nonce + settlement log now live in SQLite (see db.js) — indexed lookups,
// no more full-file JSON rewrite on every single settlement.
const stmts = {
  nonceGet: db.prepare('SELECT * FROM nonces WHERE nonce = ?'),
  nonceInsert: db.prepare('INSERT INTO nonces (nonce, tx_hash, t, from_addr, value, redeemed) VALUES (?,?,?,?,?,0) ON CONFLICT(nonce) DO NOTHING'),
  nonceClaim: db.prepare('INSERT INTO nonces (nonce, tx_hash, t, from_addr, value, redeemed) VALUES (?,NULL,?,NULL,\'0\',0) ON CONFLICT(nonce) DO NOTHING'),
  nonceRedeem: db.prepare('UPDATE nonces SET redeemed = 1 WHERE nonce = ? AND redeemed = 0'),
  nonceDelete: db.prepare('DELETE FROM nonces WHERE nonce = ?'),
  settleInsert: db.prepare('INSERT INTO settlements (tx_hash, t, payer, pay_to, value, value_formatted, resource, gas_used, pending_splits, splits, splits_cancelled) VALUES (?,?,?,?,?,?,?,?,?,?,0)'),
  settleByTx: db.prepare('SELECT * FROM settlements WHERE tx_hash = ?'),
  settleRecent: db.prepare('SELECT * FROM settlements ORDER BY t DESC LIMIT ?'),
  settleAll: db.prepare('SELECT * FROM settlements ORDER BY t DESC'),
  settleCount: db.prepare('SELECT COUNT(*) AS n FROM settlements'),
  settleTotalUsdg: db.prepare('SELECT COALESCE(SUM(CAST(value_formatted AS REAL)), 0) AS n FROM settlements'),
  settleSetSplits: db.prepare('UPDATE settlements SET pending_splits = ? WHERE tx_hash = ?'),
  settleFinalizeSplits: db.prepare('UPDATE settlements SET splits = ?, pending_splits = NULL WHERE tx_hash = ?'),
  settleCancelSplits: db.prepare('UPDATE settlements SET pending_splits = NULL, splits_cancelled = 1 WHERE tx_hash = ?'),
}

function rowToSettleRecord(r) {
  return {
    t: r.t,
    payer: r.payer,
    to: r.pay_to,
    value: r.value,
    valueFormatted: r.value_formatted,
    resource: r.resource || '',
    txHash: r.tx_hash,
    gasUsed: r.gas_used,
    pendingSplits: r.pending_splits ? JSON.parse(r.pending_splits) : null,
    splits: r.splits ? JSON.parse(r.splits) : undefined,
    splitsCancelled: !!r.splits_cancelled,
  }
}

function usedNoncesHas(nonce) { return !!stmts.nonceGet.get(nonce) }


// provider()/settlementWallet() are memoized singletons — verify()/settle()/
// publicView()/refundPayment()/payout()/finalizeSplits()/currentBlock() each
// used to construct a fresh JsonRpcProvider (and Wallet) per call, so a
// single /facilitator/settle request could spin up 3-4 separate RPC
// connections. One provider, one wallet, reused for the process lifetime.
let _provider = null
function provider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(process.env.TRIBUTE_RPC_UPSTREAM)
  return _provider
}

let _wallet = null
function settlementWallet() {
  const pk = process.env.TRIBUTE_SETTLE_KEY
  if (!pk) return null
  if (!_wallet) _wallet = new ethers.Wallet(pk, provider())
  return _wallet
}

function publicView() {
  const w = settlementWallet()
  const recent = stmts.settleRecent.all(12).map(rowToSettleRecord)
  return {
    chainId: CHAIN_ID,
    asset: USDG,
    assetName: 'USDG',
    decimals: USDG_DECIMALS,
    eip3009: false,
    pattern: 'approve+transferFrom',
    spender: w ? w.address : null,
    settled: stmts.settleCount.get().n,
    totalSettledUsdg: stmts.settleTotalUsdg.get().n,
    recent,
  }
}

/**
 * Verify a signed payment intent. Returns { ok, reason?, payer? }.
 * intent: { from, to, value, validAfter, validBefore, nonce, resource }
 * signature: EIP-712 signature over PaymentIntent in the USDG domain.
 */
async function verify(intent, signature) {
  try {
    const now = Math.floor(Date.now() / 1000)
    if (!intent || typeof intent !== 'object') return { ok: false, reason: 'bad intent' }
    if (!signature || typeof signature !== 'string') return { ok: false, reason: 'missing signature' }

    const value = BigInt(intent.value)
    if (value <= 0n) return { ok: false, reason: 'value must be > 0' }
    const validAfter = BigInt(intent.validAfter || 0)
    const validBefore = BigInt(intent.validBefore || 0)
    if (validBefore <= BigInt(now)) return { ok: false, reason: 'authorization expired' }
    if (validAfter > BigInt(now)) return { ok: false, reason: 'authorization not yet valid' }
    if (validBefore - BigInt(now) > 600n) return { ok: false, reason: 'authorization window too long (max 600s)' }

    if (usedNoncesHas(intent.nonce)) return { ok: false, reason: 'nonce already used' }

    const signer = ethers.verifyTypedData(DOMAIN, INTENT_TYPES, intent, signature)
    if (signer.toLowerCase() !== String(intent.from).toLowerCase()) {
      return { ok: false, reason: 'signature does not match from' }
    }

    const p = provider()
    const token = new ethers.Contract(USDG, [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address,address) view returns (uint256)',
    ], p)
    const spender = settlementWallet()
    if (!spender) return { ok: false, reason: 'facilitator settlement wallet not configured (TRIBUTE_SETTLE_KEY missing)' }

    const balance = await token.balanceOf(signer)
    if (balance < value) return { ok: false, reason: `insufficient USDG balance (${ethers.formatUnits(balance, 6)} < ${ethers.formatUnits(value, 6)})` }
    const allowance = await token.allowance(signer, spender.address)
    if (allowance < value) return { ok: false, reason: `USDG allowance to facilitator too low (${ethers.formatUnits(allowance, 6)} < ${ethers.formatUnits(value, 6)}). Call approve(spender, amount) first.` }

    return { ok: true, payer: signer }
  } catch (e) {
    return { ok: false, reason: 'verify error: ' + String(e.shortMessage || e.message) }
  }
}

/**
 * Execute on-chain settlement: transferFrom(payer, payTo, value).
 * Optional `splits`: after the pull, the facilitator wallet pushes each
 * { to, value } leg (marketplace fee split). Legs are best-effort — a failed
 * leg never voids the buyer's payment; it is logged and retried manually.
 * Returns { success, transaction?, errorReason?, payer? }.
 */
async function settle(intent, signature, splits = null) {
  const v = await verify(intent, signature)
  if (!v.ok) return { success: false, errorReason: v.reason, payer: v.payer || null }

  const w = settlementWallet()
  if (!w) return { success: false, errorReason: 'settlement wallet not configured' }

  const token = new ethers.Contract(USDG, [
    'function transferFrom(address from,address to,uint256 value) returns (bool)',
    'function transfer(address to,uint256 value) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ], w)

  // pre-flight on-chain state — biar error-nya jelas, bukan 'missing revert data'
  try {
    const [bal, allow, gas] = await Promise.all([
      token.balanceOf(intent.from),
      token.allowance(intent.from, w.address),
      w.provider.getBalance(w.address),
    ])
    if (bal < intent.value) return { success: false, errorReason: `payer USDG balance too low — wallet has ${ethers.formatUnits(bal, USDG_DECIMALS)}, needs ${ethers.formatUnits(intent.value, USDG_DECIMALS)}`, payer: intent.from }
    if (allow < intent.value) return { success: false, errorReason: `USDG allowance too low — approve the facilitator for at least ${ethers.formatUnits(intent.value, USDG_DECIMALS)} USDG, then retry`, payer: intent.from }
    // facilitator pays the gas — fail LOUD with a clear reason instead of a
    // confusing 'insufficient funds for intrinsic transaction cost' from ethers
    const gasNeeded = (await w.provider.getFeeData()).maxFeePerGas * 160000n
    if (gas < gasNeeded) return { success: false, errorReason: `gateway settlement wallet is low on gas (${ethers.formatEther(gas)} ETH, needs ~${ethers.formatEther(gasNeeded)}) — payment NOT taken, top up the facilitator wallet`, payer: intent.from }
  } catch (e) {
    return { success: false, errorReason: 'cannot read USDG state from chain — RPC may be busy, retry in a moment', payer: intent.from }
  }

  try {
    const tx = await token.transferFrom(intent.from, intent.to, intent.value)
    const receipt = await tx.wait()
    const rec = {
      t: Date.now(),
      payer: intent.from,
      to: intent.to,
      value: String(intent.value),
      valueFormatted: ethers.formatUnits(intent.value, USDG_DECIMALS),
      resource: intent.resource || '',
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed?.toString?.() || null,
    }
    stmts.nonceInsert.run(intent.nonce, rec.txHash, rec.t, rec.payer, rec.value)
    stmts.settleInsert.run(rec.txHash, rec.t, rec.payer, rec.to, rec.value, rec.valueFormatted, rec.resource, rec.gasUsed, null, null)

    // Marketplace fee split: the full pull lands on the facilitator wallet
    // (intent.to). The seller leg is NOT pushed here — it is deferred until
    // the gateway confirms the buyer actually received the seller's payload
    // (finalizeSplits after delivery). That way a failed upstream can be
    // refunded in full without clawing back from the seller. Best-effort.
    if (Array.isArray(splits) && splits.length) {
      const total = splits.reduce((s, x) => s + BigInt(x.value), 0n)
      if (total <= BigInt(intent.value)) {
        rec.pendingSplits = splits.map(s => ({ to: s.to, value: String(s.value) }))
        stmts.settleSetSplits.run(JSON.stringify(rec.pendingSplits), rec.txHash)
      } else {
        console.error('settle: split total exceeds payment — skipping legs', String(total), '>', String(intent.value))
      }
    }

    // payment receipt the client replays as X-PAYMENT to unlock the resource
    const paymentReceipt = Buffer.from(JSON.stringify({ x402Version: 1, intent, txHash: rec.txHash })).toString('base64')
    return { success: true, payer: intent.from, transaction: receipt.hash, network: 'eip155:4663', payment: paymentReceipt }
  } catch (e) {
    const m = String(e.shortMessage || e.message || e)
    if (/missing revert data|CALL_EXCEPTION/i.test(m)) {
      return { success: false, errorReason: 'on-chain transfer was rejected by the chain (balance/allowance changed mid-payment) — retry the payment', payer: intent.from }
    }
    return { success: false, errorReason: 'settle error: ' + m, payer: intent.from }
  }
}

/**
 * Decode an X-PAYMENT header (base64 JSON of { intent, txHash }) and confirm
 * the nonce was settled on-chain for this resource. Returns { txHash, from } or null.
 */
function paymentRecordFor(header, resource) {
  try {
    if (!header) return null
    const decoded = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'))
    const intent = decoded.intent || decoded
    const rec = stmts.nonceGet.get(intent.nonce)
    if (!rec) return null
    if (resource && intent.resource && intent.resource !== resource) return null
    return { txHash: rec.tx_hash, from: rec.from_addr, value: rec.value, nonce: intent.nonce }
  } catch { return null }
}

/**
 * One-time claim on a settled receipt (balance top-up redemption).
 * Returns true the first time for a given nonce, false on replay — so the
 * same X-PAYMENT header can never credit the ledger twice.
 */
function claimReceipt(nonce) {
  const rec = stmts.nonceGet.get(nonce)
  if (!rec || rec.redeemed) return false
  return stmts.nonceRedeem.run(nonce).changes > 0
}



/** Live block probe for /x402/health — throws if the RPC is unreachable. */
async function currentBlock() {
  return provider().send('eth_blockNumber', [])
}

/**
 * Marketplace delivery guarantee: the buyer paid but the seller's endpoint
 * failed — push the full amount back to the payer from the facilitator wallet.
 * Best-effort; returns { txHash } or throws.
 */
async function refundPayment({ to, value, reason }) {
  const w = settlementWallet()
  if (!w) throw new Error('settlement wallet not configured')
  const token = new ethers.Contract(USDG, [
    'function transfer(address to,uint256 value) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ], w)
  const val = BigInt(value)
  const bal = await token.balanceOf(w.address)
  if (bal < val) throw new Error(`facilitator balance ${bal} < refund ${val}`)
  const tx = await token.transfer(to, val)
  const r = await tx.wait()
  console.log('refund sent:', to, String(val), r.hash, '—', reason || '')
  return { txHash: r.hash }
}

function settleLogAll() { return stmts.settleAll.all().map(rowToSettleRecord) }

/**
 * Pay an arbitrary recipient from the facilitator (escrow) wallet — used for
 * balance-funded seller legs and withdrawals. Same mechanics as refundPayment.
 */
async function payout({ to, value, reason }) {
  return refundPayment({ to, value, reason })
}

/**
 * Claim a nonce for a non-payment signed action (withdrawals, key creation).
 * Returns true when the nonce was unseen (and records it), false on replay.
 */
function claimNonce(nonce) {
  const k = 'act:' + String(nonce)
  const info = stmts.nonceClaim.run(k, Date.now())
  return info.changes > 0
}
function releaseNonce(nonce) {
  const k = 'act:' + String(nonce)
  stmts.nonceDelete.run(k)
}

/**
 * Delivery confirmed → push the deferred seller legs now (95% share).
 * Returns the executed legs, or null when nothing was pending.
 */
async function finalizeSplits(txHash) {
  const row = stmts.settleByTx.get(txHash)
  if (!row || !row.pending_splits) return null
  const pending = JSON.parse(row.pending_splits)
  if (!Array.isArray(pending) || !pending.length) return null
  const w = settlementWallet()
  if (!w) throw new Error('settlement wallet not configured')
  const token = new ethers.Contract(USDG, ['function transfer(address to,uint256 value) returns (bool)'], w)
  const done = []
  for (const leg of pending) {
    try {
      const t2 = await token.transfer(leg.to, leg.value)
      const r2 = await t2.wait()
      done.push({ to: leg.to, value: leg.value, txHash: r2.hash })
    } catch (e) { console.error('split leg failed:', leg.to, String(e.shortMessage || e.message)) }
  }
  stmts.settleFinalizeSplits.run(JSON.stringify(done), txHash)
  return done
}

/** Payment refunded to the buyer → drop the pending seller legs. */
function cancelSplits(txHash) {
  const row = stmts.settleByTx.get(txHash)
  if (!row || !row.pending_splits) return false
  stmts.settleCancelSplits.run(txHash)
  return true
}

module.exports = { verify, settle, publicView, paymentRecordFor, claimReceipt, settleLogAll, finalizeSplits, cancelSplits, DOMAIN, INTENT_TYPES, USDG, CHAIN_ID, DOMAIN_NAME, DOMAIN_VERSION, currentBlock, refundPayment, payout, claimNonce, releaseNonce }
