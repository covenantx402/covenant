// facilitator.js — on-chain settlement verifier for COVENANT, multichain.
//
// Supports Robinhood Chain 4663 (USDG, legacy default) plus Ethereum,
// Base, and Arbitrum (Circle-native USDC on each — verified on-chain
// 2026-09-24, see chains.js). Every function that touches chain state now
// takes a chainId and looks up its provider/wallet/asset from the per-chain
// registry below instead of a single hardcoded provider/token.
//
// None of the four supported chains' USDC/USDG deployments support EIP-3009
// transferWithAuthorization (verified via eth_call: DOMAIN_SEPARATOR exists
// on Circle's USDC but authorizationState() always reverts — Circle's v2.2
// contracts ship the EIP-3009 selectors but the Robinhood USDG contract this
// gateway launched against does not, so the shared code path uses
// approve+transferFrom uniformly rather than branching two settlement
// mechanisms per chain). Verification here checks:
//   - signature is a valid EIP-712 payment intent signed by `from`, in the
//     domain for the SPECIFIC chain the payment targets (chainId is part of
//     the EIP-712 domain — a signature for chain A cannot replay on chain B)
//   - the signer holds sufficient balance (or has approved the spender) on
//     that chain's asset
//   - the authorization window is valid and the (chainId, nonce) pair unused
// The signed intent is the server's proof-of-authorization to execute transferFrom.
//
// EIP-712 domain name is "COVENANT" (not the token name) on every chain —
// wallets flag a domain matching the token contract's own name as a
// phishing-shaped approval. Must stay in sync with frontend
// /root/covenantx402/src/lib/pay.ts DOMAIN.
const { ethers } = require('ethers')
const db = require('./db')
const chains = require('./chains')

const DEFAULT_CHAIN_ID = chains.DEFAULT_CHAIN_ID
const DOMAIN_NAME = 'COVENANT'
const DOMAIN_VERSION = '1'

function domainFor(chainId) {
  const c = chains.getChain(chainId)
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: c.id, verifyingContract: c.usdc }
}

// Back-compat export: some callers (tests, older code) import DOMAIN/USDG/
// CHAIN_ID directly, assuming the single-chain era. Keep them pointed at
// the default chain (Robinhood 4663) so nothing importing the old shape breaks.
const DEFAULT = chains.getChain(DEFAULT_CHAIN_ID)
const DOMAIN = domainFor(DEFAULT_CHAIN_ID)
const USDG = DEFAULT.usdc
const CHAIN_ID = DEFAULT.id

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

// nonce + settlement log live in SQLite (see db.js), keyed by (chain_id, ...)
// since the multichain migration — indexed lookups, no full-file rewrite.
const stmts = {
  nonceGet: db.prepare('SELECT * FROM nonces WHERE chain_id = ? AND nonce = ?'),
  // UPSERT, not DO NOTHING: settle() now writes a placeholder row via
  // nonceClaim BEFORE the on-chain transferFrom (the race-condition fix
  // — see settle()'s comment). This insert must overwrite that
  // placeholder with the REAL settlement data on success, or the actual
  // tx_hash/payer/value would silently never get recorded (DO NOTHING
  // would make this a no-op against the already-existing placeholder
  // row). The WHERE clause on the UPDATE half still guards against
  // overwriting an already-real row (tx_hash IS NULL) — defensive only,
  // since claimPaymentNonce's own exclusivity should prevent two
  // genuine settlements ever reaching this insert for the same nonce.
  nonceInsert: db.prepare(`INSERT INTO nonces (chain_id, nonce, tx_hash, t, from_addr, value, redeemed) VALUES (?,?,?,?,?,?,0)
    ON CONFLICT(chain_id, nonce) DO UPDATE SET tx_hash = excluded.tx_hash, t = excluded.t, from_addr = excluded.from_addr, value = excluded.value, pending = NULL
    WHERE nonces.tx_hash IS NULL`),
  // A broadcast-but-unconfirmed transferFrom. While set, the nonce is NEVER released.
  noncePending: db.prepare('UPDATE nonces SET pending = ? WHERE chain_id = ? AND nonce = ? AND tx_hash IS NULL'),
  noncePendingAll: db.prepare('SELECT chain_id, nonce, pending FROM nonces WHERE pending IS NOT NULL AND tx_hash IS NULL'),
  nonceReleasePending: db.prepare('DELETE FROM nonces WHERE chain_id = ? AND nonce = ? AND tx_hash IS NULL AND pending IS NOT NULL'),
  nonceClaim: db.prepare("INSERT INTO nonces (chain_id, nonce, tx_hash, t, from_addr, value, redeemed) VALUES (?,?,NULL,?,NULL,'0',0) ON CONFLICT(chain_id, nonce) DO NOTHING"),
  // tx_hash IS NOT NULL: a placeholder / 'act:' / pending row is not a settled payment and can never be redeemed.
  nonceRedeem: db.prepare('UPDATE nonces SET redeemed = 1 WHERE chain_id = ? AND nonce = ? AND redeemed = 0 AND tx_hash IS NOT NULL'),
  nonceDelete: db.prepare('DELETE FROM nonces WHERE chain_id = ? AND nonce = ?'),
  settleInsert: db.prepare('INSERT INTO settlements (chain_id, tx_hash, t, payer, pay_to, value, value_formatted, resource, gas_used, pending_splits, splits, splits_cancelled) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)'),
  settleByTx: db.prepare('SELECT * FROM settlements WHERE chain_id = ? AND tx_hash = ?'),
  settleByTxAnyChain: db.prepare('SELECT * FROM settlements WHERE tx_hash = ? LIMIT 1'),
  settleRecent: db.prepare('SELECT * FROM settlements WHERE chain_id = ? ORDER BY t DESC LIMIT ?'),
  settleRecentAllChains: db.prepare('SELECT * FROM settlements ORDER BY t DESC LIMIT ?'),
  settleAll: db.prepare('SELECT * FROM settlements ORDER BY t DESC'),
  settleCount: db.prepare('SELECT COUNT(*) AS n FROM settlements WHERE chain_id = ?'),
  settleCountAllChains: db.prepare('SELECT COUNT(*) AS n FROM settlements'),
  settleTotalUsdg: db.prepare('SELECT COALESCE(SUM(CAST(value_formatted AS REAL)), 0) AS n FROM settlements WHERE chain_id = ?'),
  settleSetSplits: db.prepare('UPDATE settlements SET pending_splits = ? WHERE chain_id = ? AND tx_hash = ?'),
  settleFinalizeSplits: db.prepare('UPDATE settlements SET splits = ?, pending_splits = NULL WHERE chain_id = ? AND tx_hash = ?'),
  settleKeepFailedLegs: db.prepare('UPDATE settlements SET splits = ?, pending_splits = NULL, failed_splits = ? WHERE chain_id = ? AND tx_hash = ?'),
  failedLegsAll: db.prepare('SELECT chain_id, tx_hash, splits, failed_splits FROM settlements WHERE failed_splits IS NOT NULL'),
  settleSetRetry: db.prepare('UPDATE settlements SET splits = ?, failed_splits = ? WHERE chain_id = ? AND tx_hash = ?'),
  settleRefundDue: db.prepare('UPDATE settlements SET refund_due = ? WHERE chain_id = ? AND tx_hash = ?'),
  refundDueAll: db.prepare('SELECT chain_id, tx_hash, refund_due FROM settlements WHERE refund_due IS NOT NULL'),
  refundDueClaim: db.prepare('UPDATE settlements SET refund_due = NULL WHERE chain_id = ? AND tx_hash = ? AND refund_due IS NOT NULL'),
  settleCancelSplits: db.prepare('UPDATE settlements SET pending_splits = NULL, splits_cancelled = 1 WHERE chain_id = ? AND tx_hash = ?'),
}

function rowToSettleRecord(r) {
  return {
    chainId: r.chain_id,
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

// EIP-712 `bytes32` hashing ignores hex case, so one signature is valid for every re-casing of its
// nonce. The replay guard MUST therefore key on a canonical (lowercase) form, or a single signed
// intent can be replayed ~2^32 times (audit phase 2). Everything below goes through normNonce().
function normNonce(n) {
  const v = String(n == null ? '' : n)
  return /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null
}
function usedNoncesHas(chainId, nonce) { const n = normNonce(nonce); return !n || !!stmts.nonceGet.get(Number(chainId), n) }

/**
 * Atomically claim a PAYMENT nonce slot before any on-chain work in
 * settle() — see settle()'s own comment for the race this closes.
 * stmts.nonceClaim writes a placeholder row (tx_hash NULL, value '0')
 * via INSERT ... ON CONFLICT DO NOTHING; a true SQLite write is
 * serialized per-connection, so this is a real exclusivity guarantee,
 * not just an app-level check-then-act. On success, settle()'s own
 * stmts.nonceInsert is an UPSERT that overwrites this placeholder with
 * the real settlement data (tx_hash, payer, value) — it has to be an
 * UPSERT, not DO NOTHING, specifically because the placeholder row
 * already exists by the time it runs. On any failure,
 * releasePaymentNonce DELETEs the placeholder so the nonce is claimable
 * again (legitimate retries after a transient RPC/gas failure aren't
 * permanently locked out).
 */
function claimPaymentNonce(chainId, nonce) {
  nonce = normNonce(nonce); if (!nonce) return false
  const info = stmts.nonceClaim.run(Number(chainId), nonce, Date.now())
  return info.changes > 0
}
function releasePaymentNonce(chainId, nonce) {
  nonce = normNonce(nonce); if (!nonce) return
  // Only delete if it's still the unsettled placeholder (tx_hash IS
  // NULL) — never delete a real, already-recorded settlement row. This
  // matters if releasePaymentNonce is ever called on a nonce that (by
  // some other path) already has a real settlement recorded; it must
  // not erase that record.
  db.prepare('DELETE FROM nonces WHERE chain_id = ? AND nonce = ? AND tx_hash IS NULL AND pending IS NULL').run(Number(chainId), nonce)
}

// provider()/settlementWallet() are memoized PER CHAIN — verify()/settle()/
// publicView()/refundPayment()/payout()/finalizeSplits()/currentBlock() each
// used to construct a fresh JsonRpcProvider (and Wallet) per call, so a
// single /facilitator/settle request could spin up 3-4 separate RPC
// connections. One provider per chain, one wallet per chain (same private
// key, different network — a wallet is just key+provider), reused for the
// process lifetime.
//
// RPC failover: each chain's <PREFIX>_RPC_UPSTREAM env var may be a
// comma-separated list of URLs. A single flaky public RPC (seen in prod on
// Robinhood: "JsonRpcProvider failed to detect network") previously meant
// every settlement on that chain stalled until that one endpoint recovered.
// With >1 URL configured, ethers' FallbackProvider (quorum 1 — any one
// healthy responder is enough, no majority-vote needed for a read/write
// proxy like this) routes around a dead/slow endpoint automatically.
const _providers = new Map()
function provider(chainId) {
  const id = Number(chainId)
  if (_providers.has(id)) return _providers.get(id)
  const c = chains.getChain(id)
  const raw = process.env[c.rpcEnv] || ''
  const urls = String(raw).split(',').map(s => s.trim()).filter(Boolean)
  if (!urls.length) throw new Error(`missing RPC config: set ${c.rpcEnv} for chain ${id} (${c.name})`)
  let p
  if (urls.length > 1) {
    p = new ethers.FallbackProvider(urls.map((u, i) => ({
      provider: new ethers.JsonRpcProvider(u),
      priority: i,
      weight: 1,
    })), undefined, { quorum: 1 })
  } else {
    p = new ethers.JsonRpcProvider(urls[0])
  }
  _providers.set(id, p)
  return p
}

const _wallets = new Map()
function isConfigured(chainId) {
  const c = chains.getChain(chainId)
  return !!(process.env.COVENANT_SETTLE_KEY && String(process.env[c.rpcEnv] || '').trim())
}

async function assertProviderChain(chainId) {
  const id = Number(chainId)
  const network = await provider(id).getNetwork()
  if (Number(network.chainId) !== id) throw new Error(`RPC network mismatch: expected ${id}, got ${network.chainId}`)
}

function settlementWallet(chainId) {
  const id = Number(chainId)
  const pk = process.env.COVENANT_SETTLE_KEY
  if (!pk) return null
  if (_wallets.has(id)) return _wallets.get(id)
  const w = new ethers.Wallet(pk, provider(id))
  _wallets.set(id, w)
  return w
}

function publicView(chainId = DEFAULT_CHAIN_ID) {
  const id = Number(chainId)
  const c = chains.getChain(id)
  const w = settlementWallet(id)
  const recent = stmts.settleRecent.all(id, 12).map(rowToSettleRecord)
  return {
    chainId: id,
    chainName: c.name,
    asset: c.usdc,
    assetName: c.usdcSymbol,
    decimals: c.decimals,
    eip3009: false,
    pattern: 'approve+transferFrom',
    spender: w ? w.address : null,
    settled: stmts.settleCount.get(id).n,
    totalSettledUsdg: stmts.settleTotalUsdg.get(id).n,
    recent,
  }
}

/** Overview across every supported chain — used by the /x402/health and
 * dashboard-style endpoints that want a single "is everything OK" call
 * instead of one request per chain. */
function publicViewAll() {
  return chains.listChains().map(c => publicView(c.id))
}

/**
 * A reproducible, settlement-only export for independent verification.
 *
 * It deliberately reads the facilitator's successful settlement ledger, not
 * generic ERC-20 transfer history: payouts, refunds, and operational wallet
 * movements are different events and must not inflate settlement usage.
 */
function settlementAudit(chainId = DEFAULT_CHAIN_ID) {
  const id = Number(chainId)
  const c = chains.getChain(id)
  // The ledger statement is intentionally bounded; 100,000 is comfortably
  // above the current operating history while keeping this public export
  // bounded under pathological growth.
  const currentFacilitator = String(settlementWallet(id)?.address || '').toLowerCase()
  const rows = stmts.settleRecentAllChains.all(100000)
    .filter(row => row.chain_id === id)
    .map(rowToSettleRecord)
    .map(r => {
      const payer = String(r.payer).toLowerCase()
      const payTo = String(r.to).toLowerCase()
      const category = payTo !== currentFacilitator
        ? 'legacy-or-other-facilitator'
        : payer === currentFacilitator ? 'facilitator-self-payer' : 'external-payer'
      return {
        t: r.t,
        txHash: r.txHash,
        payer: r.payer,
        payTo: r.to,
        value: r.value,
        valueFormatted: r.valueFormatted,
        resource: r.resource || null,
        gasUsed: r.gasUsed || null,
        category,
      }
    })
  const summarize = category => {
    const matching = rows.filter(r => r.category === category)
    return {
      count: matching.length,
      total: Math.round(matching.reduce((sum, r) => sum + Number(r.valueFormatted || 0), 0) * 1e6) / 1e6,
    }
  }
  return {
    chainId: id,
    chainName: c.name,
    asset: c.usdc,
    assetSymbol: c.usdcSymbol,
    currentFacilitator: currentFacilitator || null,
    source: 'facilitator successful-settlement ledger',
    methodology: 'Rows are successful facilitator settlement records only. Generic token transfers, seller payouts, refunds, and operational wallet activity are excluded. Records directed to a historical or other facilitator are kept separate from the current facilitator totals.',
    totals: {
      count: rows.length,
      total: Math.round(rows.reduce((sum, r) => sum + Number(r.valueFormatted || 0), 0) * 1e6) / 1e6,
      externalPayer: summarize('external-payer'),
      facilitatorSelfPayer: summarize('facilitator-self-payer'),
      legacyOrOtherFacilitator: summarize('legacy-or-other-facilitator'),
    },
    rows,
  }
}

/** Operational readiness for a chain. A chain can be configured and its RPC
 * live while the settlement wallet has no native gas — accepting a payment
 * challenge in that state would be misleading because transferFrom cannot
 * be broadcast. This endpoint makes that distinction machine-readable for
 * the web app and agents before they choose a rail. */
async function chainReadiness(chainId) {
  const id = Number(chainId)
  const c = chains.getChain(id)
  const pk = process.env.COVENANT_SETTLE_KEY
  if (!pk) return { chainId: id, chainName: c.name, configured: false, rpcOk: false, settlementReady: false, reason: 'COVENANT_SETTLE_KEY missing' }
  try {
    const p = provider(id)
    const w = settlementWallet(id)
    await assertProviderChain(id)
    const [block, gas, fee] = await Promise.all([p.getBlockNumber(), p.getBalance(w.address), p.getFeeData()])
    const needed = (fee.maxFeePerGas || fee.gasPrice || 0n) * 160000n
    const gasOk = gas >= needed && needed > 0n
    return {
      chainId: id,
      chainName: c.name,
      configured: true,
      rpcOk: true,
      block,
      settlementAddress: w.address,
      nativeGas: ethers.formatEther(gas),
      gasNeeded: ethers.formatEther(needed),
      settlementReady: gasOk,
      reason: gasOk ? null : `settlement wallet needs native gas on ${c.name}`,
    }
  } catch (e) {
    return { chainId: id, chainName: c.name, configured: false, rpcOk: false, settlementReady: false, reason: String(e.shortMessage || e.message || e) }
  }
}

/**
 * Verify a signed payment intent. Returns { ok, reason?, payer? }.
 * intent: { from, to, value, validAfter, validBefore, nonce, resource }
 * chainId selects which network's asset/domain/RPC this intent targets —
 * defaults to Robinhood 4663 for callers that predate multichain support.
 */
async function verify(intent, signature, chainId = DEFAULT_CHAIN_ID) {
  try {
    const id = Number(chainId)
    if (!chains.isSupported(id)) return { ok: false, reason: `unsupported chain: ${chainId}` }
    const c = chains.getChain(id)
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

    if (!normNonce(intent.nonce)) return { ok: false, reason: 'nonce must be bytes32 hex' }
    intent = { ...intent, nonce: normNonce(intent.nonce) }
    if (usedNoncesHas(id, intent.nonce)) return { ok: false, reason: 'nonce already used' }

    const signer = ethers.verifyTypedData(domainFor(id), INTENT_TYPES, intent, signature)
    if (signer.toLowerCase() !== String(intent.from).toLowerCase()) {
      return { ok: false, reason: 'signature does not match from' }
    }

    const p = provider(id)
    await assertProviderChain(id)
    const token = new ethers.Contract(c.usdc, [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address,address) view returns (uint256)',
    ], p)
    const spender = settlementWallet(id)
    if (!spender) return { ok: false, reason: 'facilitator settlement wallet not configured (COVENANT_SETTLE_KEY missing)' }
    if (String(intent.to || '').toLowerCase() !== spender.address.toLowerCase()) {
      return { ok: false, reason: 'intent.to must equal the advertised facilitator payTo address' }
    }

    const balance = await token.balanceOf(signer)
    if (balance < value) return { ok: false, reason: `insufficient ${c.usdcSymbol} balance (${ethers.formatUnits(balance, c.decimals)} < ${ethers.formatUnits(value, c.decimals)})` }
    const allowance = await token.allowance(signer, spender.address)
    if (allowance < value) return { ok: false, reason: `${c.usdcSymbol} allowance to facilitator too low (${ethers.formatUnits(allowance, c.decimals)} < ${ethers.formatUnits(value, c.decimals)}). Call approve(spender, amount) first.` }

    return { ok: true, payer: signer }
  } catch (e) {
    return { ok: false, reason: 'verify error: ' + String(e.shortMessage || e.message) }
  }
}

/**
 * Execute on-chain settlement: transferFrom(payer, payTo, settleValue) on
 * the intent's target chain. settleValue defaults to intent.value (the
 * "exact" scheme's fixed-price behavior, unchanged) but can be lower via
 * actualValue — that's the "upto" scheme: the signed intent.value is a
 * CEILING the buyer authorized, not the amount that necessarily gets
 * pulled. COVENANT's approve+transferFrom pattern supports this natively
 * (unlike EIP-3009's transferWithAuthorization, which locks an exact
 * amount into the signature itself) — transferFrom can pull any amount up
 * to the live allowance, so "settle less than the signed ceiling" needs
 * zero new on-chain mechanism, just a actualValue <= intent.value check
 * here plus a resource-specific way for the caller to know the real cost
 * (e.g. token-metered LLM calls, compute-time billing).
 * Optional `splits`: after the pull, the facilitator wallet pushes each
 * { to, value } leg (marketplace fee split). Legs are best-effort — a
 * failed leg never voids the buyer's payment; it is logged and retried
 * manually.
 * Returns { success, transaction?, errorReason?, payer? }.
 */
async function settle(intent, signature, splits = null, chainId = DEFAULT_CHAIN_ID, actualValue = null) {
  if (intent && typeof intent === 'object') {
    const nn = normNonce(intent.nonce)
    if (!nn) return { success: false, errorReason: 'nonce must be bytes32 hex', payer: intent.from || null }
    intent = { ...intent, nonce: nn }
  }
  const id = Number(chainId)
  const c = chains.getChain(id)

  const ceilingValue = BigInt(intent?.value || 0)
  // actualValue selects the "upto" scheme: settle LESS than the signed
  // ceiling. null/undefined means "exact" — settle the full signed value,
  // today's unchanged default behavior.
  let settleValue = ceilingValue
  if (actualValue != null) {
    const av = BigInt(actualValue)
    if (av <= 0n) return { success: false, errorReason: 'actualValue must be > 0', payer: intent?.from || null }
    if (av > ceilingValue) return { success: false, errorReason: `actualValue (${av}) exceeds the signed ceiling (${ceilingValue}) — cannot settle more than the buyer authorized`, payer: intent?.from || null }
    settleValue = av
  }

  // Settlement-cost floor: USDC/USDG are ~$1-pegged, so the formatted
  // decimal amount IS the USD price — no oracle needed. A price below the
  // chain's minSettlePriceUsd means the facilitator pays MORE in gas than
  // it receives; that's a silent-loss bug, not a feature, so reject it
  // loudly before verify() spends an RPC round-trip (balance/allowance
  // reads) on a payment that was never going to settle. This is a floor
  // on what COVENANT will settle, not a separate line-item fee — the
  // full signed amount still goes to payTo; it just can't be priced
  // below the chain's own settlement cost. See chains.js for the
  // per-chain floor values and how they were measured. Checked against
  // settleValue (what's ACTUALLY charged), not the signed ceiling — an
  // "upto" intent with a generous ceiling but a tiny real usage should
  // still be floor-rejected on the real amount, not waved through
  // because the ceiling looked big enough.
  const priceUsd = Number(ethers.formatUnits(settleValue, c.decimals))
  if (!chains.clearsSettleFloor(priceUsd, id)) {
    return {
      success: false,
      errorReason: `price too low to settle on ${c.name}: ${priceUsd} ${c.usdcSymbol} is below the ${c.minSettlePriceUsd} ${c.usdcSymbol} settlement-cost floor for this chain (gas would cost more than the payment) — price the resource higher, or settle on a cheaper chain (see GET /chains)`,
      payer: intent?.from || null,
    }
  }

  // A previous attempt for this nonce may have broadcast a tx whose confirmation we never saw
  // (RPC timeout). Resolve it by tx hash instead of treating the retry as a new payment.
  const prior = stmts.nonceGet.get(id, intent.nonce)
  if (prior && prior.pending && !prior.tx_hash) return resolvePending(id, intent, splits)

  const v = await verify(intent, signature, id)
  if (!v.ok) return { success: false, errorReason: v.reason, payer: v.payer || null }

  // Atomic nonce claim — found by audit (same class of bug fixed in
  // batch.js's claim lock): verify()'s usedNoncesHas() check and the
  // ACTUAL nonce-recording insert (nonceInsert, below after a successful
  // on-chain transferFrom) are separated by the entire RPC round-trip +
  // transferFrom + tx.wait() — a long window. Two concurrent settle()
  // calls for the IDENTICAL signed intent both pass verify()'s check,
  // both reach transferFrom, and (if the buyer's allowance covers it
  // twice) both succeed — spending the same single signature twice.
  // Confirmed with a live PoC: two concurrent settle() calls for one
  // intent both reached the identical balance-check failure point,
  // proving neither was rejected for nonce reuse before the on-chain
  // attempt. stmts.nonceClaim is an atomic INSERT ... ON CONFLICT DO
  // NOTHING (SQLite's writes are serialized per-connection, so this is
  // a real exclusivity guarantee, not just app-level) — claim the nonce
  // HERE, before any chain call, and release it on any failure so a
  // legitimately-retried settlement (RPC hiccup, insufficient gas that
  // gets topped up, etc.) isn't permanently locked out.
  if (!claimPaymentNonce(id, intent.nonce)) {
    return { success: false, errorReason: 'nonce already claimed by a concurrent or prior settlement attempt', payer: intent.from }
  }

  const w = settlementWallet(id)
  if (!w) { releasePaymentNonce(id, intent.nonce); return { success: false, errorReason: 'settlement wallet not configured' } }

  const token = new ethers.Contract(c.usdc, [
    'function transferFrom(address from,address to,uint256 value) returns (bool)',
    'function transfer(address to,uint256 value) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ], w)

  // pre-flight on-chain state — biar error-nya jelas, bukan 'missing revert data'
  // Checked against the SIGNED CEILING (intent.value), not settleValue: the
  // buyer's wallet must actually hold/approve the full ceiling they
  // signed, even if this particular settlement only pulls part of it —
  // that's the whole point of "upto" (the ceiling is what they committed
  // to being able to pay, not what any single settle call takes).
  try {
    const [bal, allow, gas] = await Promise.all([
      token.balanceOf(intent.from),
      token.allowance(intent.from, w.address),
      w.provider.getBalance(w.address),
    ])
    if (bal < settleValue) { releasePaymentNonce(id, intent.nonce); return { success: false, errorReason: `payer ${c.usdcSymbol} balance too low — wallet has ${ethers.formatUnits(bal, c.decimals)}, needs ${ethers.formatUnits(settleValue, c.decimals)}`, payer: intent.from } }
    if (allow < settleValue) { releasePaymentNonce(id, intent.nonce); return { success: false, errorReason: `${c.usdcSymbol} allowance too low — approve the facilitator for at least ${ethers.formatUnits(settleValue, c.decimals)} ${c.usdcSymbol}, then retry`, payer: intent.from } }
    // facilitator pays the gas — fail LOUD with a clear reason instead of a
    // confusing 'insufficient funds for intrinsic transaction cost' from ethers
    const gasNeeded = (await w.provider.getFeeData()).maxFeePerGas * 160000n
    if (gas < gasNeeded) { releasePaymentNonce(id, intent.nonce); return { success: false, errorReason: `gateway settlement wallet on ${c.name} is low on gas (${ethers.formatEther(gas)}, needs ~${ethers.formatEther(gasNeeded)}) — payment NOT taken, top up the facilitator wallet`, payer: intent.from } }
  } catch (_e) {
    releasePaymentNonce(id, intent.nonce)
    return { success: false, errorReason: `cannot read ${c.usdcSymbol} state from ${c.name} — RPC may be busy, retry in a moment`, payer: intent.from }
  }

  let tx
  try {
    tx = await token.transferFrom(intent.from, intent.to, settleValue)
  } catch (e) {
    // No tx handle was returned: nothing we can track. Safe to release.
    releasePaymentNonce(id, intent.nonce)
    const m = String(e.shortMessage || e.message || e)
    if (/missing revert data|CALL_EXCEPTION/i.test(m)) {
      return { success: false, errorReason: 'on-chain transfer was rejected by the chain (balance/allowance changed mid-payment) — retry the payment', payer: intent.from }
    }
    return { success: false, errorReason: 'settle error: ' + m, payer: intent.from }
  }

  // Durably record the broadcast BEFORE waiting. From here the nonce is only released
  // on a PROVEN revert — never on a timeout/ambiguous error (that was a double-charge bug).
  stmts.noncePending.run(JSON.stringify({ txHash: tx.hash, intent, settleValue: String(settleValue), t: Date.now() }), id, intent.nonce)
  let receipt
  try {
    receipt = await tx.wait()
  } catch (e) {
    if (e && e.code === 'CALL_EXCEPTION' && e.receipt) {
      stmts.nonceReleasePending.run(id, intent.nonce)
      return { success: false, errorReason: 'on-chain transfer reverted (no funds moved) — retry the payment', payer: intent.from }
    }
    return pendingResponse(intent, tx.hash)
  }
  if (receipt && receipt.status === 0) {
    stmts.nonceReleasePending.run(id, intent.nonce)
    return { success: false, errorReason: 'on-chain transfer reverted (no funds moved) — retry the payment', payer: intent.from }
  }
  return finalizeSettlement(id, c, intent, settleValue, receipt, splits)
}

function pendingResponse(intent, txHash) {
  return { success: false, pending: true, transaction: txHash, payer: intent.from, errorReason: 'transaction broadcast but confirmation not yet known — do NOT re-sign; retry the same settle request shortly and it will resolve against this tx' }
}

/** Persist a CONFIRMED settlement and build the receipt. Idempotent: only the first caller wins. */
function finalizeSettlement(id, c, intent, settleValue, receipt, splits) {
  const rec = {
    chainId: id,
    t: Date.now(),
    payer: intent.from,
    to: intent.to,
    value: String(settleValue),
    valueFormatted: ethers.formatUnits(settleValue, c.decimals),
    resource: intent.resource || '',
    txHash: receipt.hash,
    gasUsed: receipt.gasUsed?.toString?.() || null,
  }
  const won = db.transaction(() => {
    const info = stmts.nonceInsert.run(id, intent.nonce, rec.txHash, rec.t, rec.payer, rec.value)
    if (info.changes === 0) return false
    stmts.settleInsert.run(id, rec.txHash, rec.t, rec.payer, rec.to, rec.value, rec.valueFormatted, rec.resource, rec.gasUsed, null, null)
    return true
  })()
  if (!won) return { success: false, errorReason: 'settlement already finalized', payer: intent.from }

  // Marketplace fee split: seller leg is deferred until delivery (finalizeSplits). Checked against
  // settleValue (what was ACTUALLY pulled), not the signed ceiling.
  if (Array.isArray(splits) && splits.length) {
    const total = splits.reduce((s, x) => s + BigInt(x.value), 0n)
    if (total <= settleValue) {
      rec.pendingSplits = splits.map(s => ({ to: s.to, value: String(s.value) }))
      stmts.settleSetSplits.run(JSON.stringify(rec.pendingSplits), id, rec.txHash)
    } else {
      console.error('settle: split total exceeds payment — skipping legs', String(total), '>', String(settleValue))
    }
  }
  const paymentReceipt = Buffer.from(JSON.stringify({ x402Version: 1, intent, txHash: rec.txHash, chainId: id })).toString('base64')
  return { success: true, payer: intent.from, transaction: receipt.hash, network: `eip155:${id}`, chainId: id, payment: paymentReceipt, settledValue: String(settleValue) }
}

const PENDING_DROP_MS = 30 * 60 * 1000
/** Look up a pending tx. Returns 'confirmed' (+receipt) | 'reverted' | 'dropped' | 'unknown'. */
async function inspectPending(id, pend) {
  try {
    const p = provider(id)
    const receipt = await p.getTransactionReceipt(pend.txHash)
    if (receipt) return receipt.status === 1 ? { state: 'confirmed', receipt } : { state: 'reverted' }
    const tx = await p.getTransaction(pend.txHash)
    if (!tx && Date.now() - pend.t > PENDING_DROP_MS) return { state: 'dropped' }
    return { state: 'unknown' }
  } catch { return { state: 'unknown' } }
}

async function resolvePending(id, intent, splits) {
  intent = { ...intent, nonce: normNonce(intent.nonce) || intent.nonce }
  const c = chains.getChain(id)
  const row = stmts.nonceGet.get(id, intent.nonce)
  let pend
  try { pend = JSON.parse(row.pending) } catch { return { success: false, errorReason: 'corrupt pending settlement record', payer: intent.from } }
  const same = ['from', 'to', 'value', 'resource', 'validBefore'].every(k => String(pend.intent?.[k]) === String(intent[k]))
  if (!same) return { success: false, errorReason: 'nonce already claimed by a pending settlement of a different intent', payer: intent.from }
  const r = await inspectPending(id, pend)
  if (r.state === 'confirmed') return finalizeSettlement(id, c, pend.intent, BigInt(pend.settleValue), r.receipt, splits)
  if (r.state === 'reverted' || r.state === 'dropped') {
    stmts.nonceReleasePending.run(id, intent.nonce)
    return { success: false, errorReason: `previous settlement attempt ${r.state} (no funds moved) — retry the payment`, payer: intent.from }
  }
  return pendingResponse(intent, pend.txHash)
}

/** Boot/interval sweep: free nonces whose pending tx provably reverted or was dropped.
 *  Confirmed ones are left for the buyer's retry so session/reputation side effects run exactly once. */
async function reconcilePending() {
  let released = 0
  for (const row of stmts.noncePendingAll.all()) {
    let pend; try { pend = JSON.parse(row.pending) } catch { continue }
    const r = await inspectPending(row.chain_id, pend)
    if (r.state === 'reverted' || r.state === 'dropped') { stmts.nonceReleasePending.run(row.chain_id, row.nonce); released++ }
  }
  return released
}

/**
 * Claim an x402 "batch-settlement" channel on-chain: ONE transferFrom for
 * the net-new cumulative value (see batch.js for channel/voucher
 * mechanics — vouchers themselves are verified entirely off-chain, free,
 * no RPC call; this is the ONLY on-chain step in the whole scheme, and it
 * happens once per claim regardless of how many vouchers were verified).
 * Reuses the exact same settlement-cost floor + gas pre-flight checks as
 * settle() so a channel can't be claimed for less than it costs to claim.
 * payer/payTo/netValue/chainId come from batch.netClaimable() — this
 * function does not re-derive them, it just executes + records the tx.
 * Returns { success, transaction?, errorReason? }.
 */
async function claimChannel({ payer, payTo, netValue, chainId, onBroadcast }) {
  const id = Number(chainId)
  const c = chains.getChain(id)
  const value = BigInt(netValue)
  if (value <= 0n) return { success: false, errorReason: 'netValue must be > 0' }

  const priceUsd = Number(ethers.formatUnits(value, c.decimals))
  if (!chains.clearsSettleFloor(priceUsd, id)) {
    return { success: false, errorReason: `claim amount too low to settle on ${c.name}: ${priceUsd} ${c.usdcSymbol} is below the ${c.minSettlePriceUsd} ${c.usdcSymbol} settlement-cost floor — accumulate more vouchers before claiming, or claim on a cheaper chain` }
  }

  const w = settlementWallet(id)
  if (!w) return { success: false, errorReason: 'settlement wallet not configured' }

  const token = new ethers.Contract(c.usdc, [
    'function transferFrom(address from,address to,uint256 value) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ], w)

  try {
    const [bal, allow, gas] = await Promise.all([
      token.balanceOf(payer),
      token.allowance(payer, w.address),
      w.provider.getBalance(w.address),
    ])
    if (bal < value) return { success: false, errorReason: `payer ${c.usdcSymbol} balance too low to claim — wallet has ${ethers.formatUnits(bal, c.decimals)}, channel needs ${ethers.formatUnits(value, c.decimals)}` }
    if (allow < value) return { success: false, errorReason: `${c.usdcSymbol} allowance too low to claim — payer must approve the facilitator for at least ${ethers.formatUnits(value, c.decimals)} ${c.usdcSymbol}` }
    const gasNeeded = (await w.provider.getFeeData()).maxFeePerGas * 160000n
    if (gas < gasNeeded) return { success: false, errorReason: `gateway settlement wallet on ${c.name} is low on gas — channel claim NOT taken, top up the facilitator wallet` }
  } catch (_e) {
    return { success: false, errorReason: `cannot read ${c.usdcSymbol} state from ${c.name} — RPC may be busy, retry in a moment` }
  }

  let tx
  try {
    tx = await token.transferFrom(payer, payTo, value)
  } catch (e) {
    return { success: false, errorReason: 'channel claim error: ' + String(e.shortMessage || e.message || e) }
  }
  // Persist the broadcast before waiting so a timeout/crash cannot cause a second claim of the same value.
  if (onBroadcast) onBroadcast(tx.hash)
  try {
    const receipt = await tx.wait()
    if (receipt && receipt.status === 0) return { success: false, reverted: true, errorReason: 'channel claim reverted on-chain (no funds moved)' }
    return { success: true, transaction: receipt.hash, network: `eip155:${id}`, chainId: id, claimedValue: value.toString() }
  } catch (e) {
    if (e && e.code === 'CALL_EXCEPTION' && e.receipt) return { success: false, reverted: true, errorReason: 'channel claim reverted on-chain (no funds moved)' }
    return { success: false, pending: true, transaction: tx.hash, errorReason: 'claim broadcast but confirmation unknown — retry shortly to resolve against this tx' }
  }
}

/** Inspect a previously broadcast tx: { state: 'confirmed'|'reverted'|'dropped'|'unknown', receipt? }. */
function inspectTx(chainId, txHash, t) { return inspectPending(Number(chainId), { txHash, t }) }

/**
 * Decode an X-PAYMENT header (base64 JSON of { intent, txHash, chainId })
 * and confirm the nonce was settled on-chain for this resource AND expected
 * chain. Headers minted before multichain have no chainId field — they
 * default to Robinhood 4663 for compatibility. The expectedChainId guard is
 * essential: a client must never be able to settle on Ethereum but write a
 * resource string ending in `?chain=8453` and unlock the Base-selected
 * endpoint with that receipt.
 */
function paymentRecordFor(header, resource, expectedChainId = DEFAULT_CHAIN_ID) {
  try {
    if (!header || !resource) return null
    const decoded = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'))
    const intent = decoded.intent || decoded
    const chainId = Number(decoded.chainId || DEFAULT_CHAIN_ID)
    if (chainId !== Number(expectedChainId)) return null
    const nn = normNonce(intent.nonce); if (!nn) return null
    const rec = stmts.nonceGet.get(chainId, nn)
    // Only a CONFIRMED settlement counts: placeholder / pending / 'act:' rows have no tx_hash.
    if (!rec || !rec.tx_hash || !rec.from_addr) return null
    // The header is client-controlled. Trust only server-side records: the receipt's txHash must equal
    // the stored one, and the resource/payer/value come from the settlement row, never from the header.
    if (String(decoded.txHash || '') !== rec.tx_hash) return null
    const st = stmts.settleByTx.get(chainId, rec.tx_hash)
    if (!st || st.resource !== resource) return null
    if (String(st.payer).toLowerCase() !== String(rec.from_addr).toLowerCase() || String(st.value) !== String(rec.value)) return null
    return { txHash: rec.tx_hash, from: rec.from_addr, value: rec.value, nonce: nn, chainId }
  } catch { return null }
}

/**
 * One-time claim on a settled receipt (balance top-up redemption).
 * Returns true the first time for a given (chainId, nonce), false on
 * replay — so the same X-PAYMENT header can never credit the ledger twice.
 */
function claimReceipt(nonce, chainId = DEFAULT_CHAIN_ID) {
  nonce = normNonce(nonce); if (!nonce) return false
  const id = Number(chainId)
  const rec = stmts.nonceGet.get(id, nonce)
  if (!rec || rec.redeemed) return false
  return stmts.nonceRedeem.run(id, nonce).changes > 0
}

/** Live block probe for /x402/health — throws if the RPC is unreachable.
 *  Uses the portable getBlockNumber() (works on both JsonRpcProvider and
 *  FallbackProvider) rather than a raw .send('eth_blockNumber'), which
 *  FallbackProvider doesn't expose. */
async function currentBlock(chainId = DEFAULT_CHAIN_ID) {
  return provider(chainId).getBlockNumber()
}

/**
 * Marketplace delivery guarantee: the buyer paid but the seller's endpoint
 * failed — push the full amount back to the payer from the facilitator wallet.
 * Best-effort; returns { txHash } or throws.
 */
async function refundPayment({ to, value, reason, chainId = DEFAULT_CHAIN_ID }) {
  const id = Number(chainId)
  const c = chains.getChain(id)
  const w = settlementWallet(id)
  if (!w) throw new Error('settlement wallet not configured')
  const token = new ethers.Contract(c.usdc, [
    'function transfer(address to,uint256 value) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ], w)
  const val = BigInt(value)
  const bal = await token.balanceOf(w.address)
  if (bal < val) throw new Error(`facilitator balance on ${c.name} ${bal} < refund ${val}`)
  const tx = await token.transfer(to, val) // throws only BEFORE a tx handle exists: safe for callers to undo
  // Once broadcast, a wait() failure must NOT surface as an error: callers re-credit / retry on throw,
  // which would pay twice if the tx lands (audit phase 2). Report it as sent-but-unconfirmed.
  try {
    const r = await tx.wait()
    if (r && r.status === 0) throw Object.assign(new Error('transfer reverted on-chain'), { reverted: true })
    console.log('refund sent:', c.name, to, String(val), r.hash, '—', reason || '')
    return { txHash: r.hash }
  } catch (e) {
    if (e && (e.reverted || (e.code === 'CALL_EXCEPTION' && e.receipt))) throw e // proven revert: no funds moved
    console.error('payout broadcast but unconfirmed:', tx.hash, String(e.shortMessage || e.message))
    return { txHash: tx.hash, unconfirmed: true }
  }
}

function settleLogAll() { return stmts.settleAll.all().map(rowToSettleRecord) }

/**
 * Pay an arbitrary recipient from the facilitator (escrow) wallet — used for
 * balance-funded seller legs and withdrawals. Same mechanics as refundPayment.
 */
async function payout({ to, value, reason, chainId = DEFAULT_CHAIN_ID }) {
  return refundPayment({ to, value, reason, chainId })
}

/**
 * Claim a nonce for a non-payment signed action (withdrawals, key creation).
 * Returns true when the nonce was unseen (and records it), false on replay.
 * Uses a namespaced key ('act:...') inside the same (chainId, nonce) table —
 * chainId here is nominal (these actions aren't chain-specific) but keeps
 * the same composite-key shape as payment nonces.
 */
function claimNonce(nonce, chainId = DEFAULT_CHAIN_ID) {
  const nn = normNonce(nonce); if (!nn) return false
  const k = 'act:' + nn
  const info = stmts.nonceClaim.run(Number(chainId), k, Date.now())
  return info.changes > 0
}
function releaseNonce(nonce, chainId = DEFAULT_CHAIN_ID) {
  const nn = normNonce(nonce); if (!nn) return
  const k = 'act:' + nn
  stmts.nonceDelete.run(Number(chainId), k)
}

/**
 * Delivery confirmed → push the deferred seller legs now (95% share).
 * txHash lookup tries the default chain first (the common case — most
 * historical calls predate multichain and won't pass chainId), then falls
 * back to a cross-chain scan by tx_hash alone for explicit multichain calls.
 * Returns the executed legs, or null when nothing was pending.
 */
async function finalizeSplits(txHash, chainId) {
  const row = chainId != null
    ? stmts.settleByTx.get(Number(chainId), txHash)
    : (stmts.settleByTx.get(DEFAULT_CHAIN_ID, txHash) || stmts.settleByTxAnyChain.get(txHash))
  if (!row || !row.pending_splits) return null
  const id = row.chain_id
  const c = chains.getChain(id)
  const pending = JSON.parse(row.pending_splits)
  if (!Array.isArray(pending) || !pending.length) return null
  const w = settlementWallet(id)
  if (!w) throw new Error('settlement wallet not configured')
  const token = new ethers.Contract(c.usdc, ['function transfer(address to,uint256 value) returns (bool)'], w)
  const done = []
  const failed = []
  for (const leg of pending) {
    try {
      const t2 = await token.transfer(leg.to, leg.value)
      try {
        const r2 = await t2.wait()
        done.push({ to: leg.to, value: leg.value, txHash: r2.hash })
      } catch (we) {
        if (we && we.code === 'CALL_EXCEPTION' && we.receipt) throw we
        done.push({ to: leg.to, value: leg.value, txHash: t2.hash, unconfirmed: true }) // broadcast: never pay twice
      }
    } catch (e) {
      console.error('split leg failed:', leg.to, String(e.shortMessage || e.message))
      failed.push(leg)
    }
  }
  if (failed.length) stmts.settleKeepFailedLegs.run(JSON.stringify(done), JSON.stringify(failed), id, txHash)
  else stmts.settleFinalizeSplits.run(JSON.stringify(done), id, txHash)
  return done
}

/** Retry seller legs that failed AFTER delivery was confirmed (safe: delivery already happened). */
async function retryFailedSplits() {
  let paid = 0
  for (const row of stmts.failedLegsAll.all()) {
    const id = row.chain_id, c = chains.getChain(id), w = settlementWallet(id)
    if (!w) continue
    const token = new ethers.Contract(c.usdc, ['function transfer(address to,uint256 value) returns (bool)'], w)
    let legs, done
    try { legs = JSON.parse(row.failed_splits); done = JSON.parse(row.splits || '[]') } catch { continue }
    const still = []
    for (const leg of legs) {
      try {
        const t2 = await token.transfer(leg.to, leg.value)
        let h = t2.hash, unconfirmed = false
        try { h = (await t2.wait()).hash } catch (we) { if (we && we.code === 'CALL_EXCEPTION' && we.receipt) throw we; unconfirmed = true }
        done.push({ to: leg.to, value: leg.value, txHash: h, ...(unconfirmed ? { unconfirmed } : {}) }); paid++
      } catch (e) { still.push(leg) }
    }
    stmts.settleSetRetry.run(JSON.stringify(done), still.length ? JSON.stringify(still) : null, id, row.tx_hash)
  }
  return paid
}

function clearRefundDue(txHash, chainId) { stmts.refundDueClaim.run(Number(chainId), txHash) }
/** Persist a buyer refund that could not be sent, so it is retried instead of silently lost. */
function markRefundDue(txHash, chainId, to, value, reason) {
  stmts.settleRefundDue.run(JSON.stringify({ to, value: String(value), reason: String(reason || '').slice(0, 200) }), Number(chainId), txHash)
}
async function retryRefundsDue() {
  let sent = 0
  for (const row of stmts.refundDueAll.all()) {
    let due; try { due = JSON.parse(row.refund_due) } catch { continue }
    if (!stmts.refundDueClaim.run(row.chain_id, row.tx_hash).changes) continue // claim first: no concurrent double refund
    try { await refundPayment({ to: due.to, value: due.value, reason: 'retry: ' + due.reason, chainId: row.chain_id }); sent++ }
    catch (e) { stmts.settleRefundDue.run(row.refund_due, row.chain_id, row.tx_hash) } // restore for next sweep
  }
  return sent
}

/** Payment refunded to the buyer → drop the pending seller legs. */
function cancelSplits(txHash, chainId) {
  const row = chainId != null
    ? stmts.settleByTx.get(Number(chainId), txHash)
    : (stmts.settleByTx.get(DEFAULT_CHAIN_ID, txHash) || stmts.settleByTxAnyChain.get(txHash))
  if (!row || !row.pending_splits) return false
  stmts.settleCancelSplits.run(row.chain_id, txHash)
  return true
}

// _test: internals exposed ONLY for regression tests (fake provider injection).
const _test = { normNonce, _providers, finalizeSettlement, resolvePending, stmts }

module.exports = {
  _test,
  verify, settle, publicView, publicViewAll, settlementAudit, chainReadiness, paymentRecordFor, claimReceipt, settleLogAll,
  isConfigured,
  finalizeSplits, cancelSplits, currentBlock, refundPayment, payout, claimNonce, releaseNonce,
  claimChannel, reconcilePending, inspectTx, retryFailedSplits, retryRefundsDue, markRefundDue, clearRefundDue, normNonce,
  claimPaymentNonce, releasePaymentNonce, // exported for the dedicated race-condition regression unit test
  domainFor, INTENT_TYPES,
  // back-compat single-chain exports (Robinhood 4663, the pre-multichain default)
  DOMAIN, USDG, CHAIN_ID, DOMAIN_NAME, DOMAIN_VERSION,
  DEFAULT_CHAIN_ID,
  chains,
}
