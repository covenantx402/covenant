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
const fs = require('fs')
const path = require('path')

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

// replay protection: nonces consumed by this facilitator process
// (persisted so restarts don't allow replay)
const STORE_PATH = process.env.TRIBUTE_SETTLE_STORE ||
  path.join(__dirname, 'data', 'settlements.json')
const usedNonces = new Map() // nonce -> { txHash, t, from, value }
const settleLog = []         // recent settlements (kept for dashboard)

function load() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
      // v1 shape: { nonce: rec }. v2 shape: { nonces: {...}, log: [...] }
      if (data.nonces) {
        for (const [k, v] of Object.entries(data.nonces)) usedNonces.set(k, v)
        if (Array.isArray(data.log)) for (const r of data.log.slice(0, 100)) settleLog.push(r)
      } else {
        for (const [k, v] of Object.entries(data)) usedNonces.set(k, v)
      }
    }
  } catch (e) { console.error('settlement load failed:', e.message) }
}
function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const tmp = STORE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ nonces: Object.fromEntries(usedNonces), log: settleLog.slice(0, 100) }))
  fs.renameSync(tmp, STORE_PATH)
}
load()

function provider() {
  return new ethers.JsonRpcProvider(process.env.TRIBUTE_RPC_UPSTREAM)
}

function settlementWallet() {
  const pk = process.env.TRIBUTE_SETTLE_KEY
  if (!pk) return null
  return new ethers.Wallet(pk, provider())
}

function publicView() {
  const w = settlementWallet()
  return {
    chainId: CHAIN_ID,
    asset: USDG,
    assetName: 'USDG',
    decimals: USDG_DECIMALS,
    eip3009: false,
    pattern: 'approve+transferFrom',
    spender: w ? w.address : null,
    settled: settleLog.length,
    totalSettledUsdg: settleLog.reduce((s, x) => s + Number(x.valueFormatted || 0), 0),
    recent: settleLog.slice(0, 12),
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

    if (usedNonces.has(intent.nonce)) return { ok: false, reason: 'nonce already used' }

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
 * Returns { success, transaction?, errorReason?, payer? }.
 */
async function settle(intent, signature) {
  const v = await verify(intent, signature)
  if (!v.ok) return { success: false, errorReason: v.reason, payer: v.payer || null }

  const w = settlementWallet()
  if (!w) return { success: false, errorReason: 'settlement wallet not configured' }

  const token = new ethers.Contract(USDG, [
    'function transferFrom(address from,address to,uint256 value) returns (bool)',
  ], w)

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
    usedNonces.set(intent.nonce, { txHash: rec.txHash, t: rec.t, from: rec.payer, value: rec.value })
    settleLog.unshift(rec)
    if (settleLog.length > 100) settleLog.length = 100
    save()
    // payment receipt the client replays as X-PAYMENT to unlock the resource
    const paymentReceipt = Buffer.from(JSON.stringify({ x402Version: 1, intent, txHash: rec.txHash })).toString('base64')
    return { success: true, payer: intent.from, transaction: receipt.hash, network: 'eip155:4663', payment: paymentReceipt }
  } catch (e) {
    return { success: false, errorReason: 'settle error: ' + String(e.shortMessage || e.message), payer: intent.from }
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
    const rec = usedNonces.get(intent.nonce)
    if (!rec) return null
    if (resource && intent.resource && intent.resource !== resource) return null
    return { txHash: rec.txHash, from: rec.from, value: rec.value }
  } catch { return null }
}

module.exports = { verify, settle, publicView, paymentRecordFor, DOMAIN, INTENT_TYPES, USDG, CHAIN_ID, DOMAIN_NAME, DOMAIN_VERSION }
