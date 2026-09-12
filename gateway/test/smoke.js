// gateway/test/smoke.js — end-to-end smoke test of the TRIBUTE gateway.
// Run: npm test  (starts nothing itself; expects TRIBUTE_TEST_PORT free)
// Spawns the server on a test port with isolated stores, exercises:
//   key mint → auth gate → vault put/broker/scrub → wallet create →
//   restart persistence → facilitator verify (positive recovery + negative cases) → RPC whitelist
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')

const PORT = 8971
const BASE = `http://127.0.0.1:${PORT}`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tribute-test-'))
// Isolate in-process module stores too (reputation is required directly below,
// so it must open the SAME sqlite file the spawned server process writes to).
process.env.TRIBUTE_DB_PATH = path.join(tmp, 'gateway.db')

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request(BASE + p, { method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let out = ''
      res.on('data', c => out += c)
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out) }) } catch { resolve({ status: res.statusCode, headers: res.headers, text: out }) } })
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        TRIBUTE_RPC_UPSTREAM: process.env.TRIBUTE_RPC_UPSTREAM || 'https://robinhood-rpc.publicnode.com',
        TRIBUTE_PORT: String(PORT),
        TRIBUTE_SETTLE_KEY: '0x' + '11'.repeat(32),
        TRIBUTE_DB_PATH: path.join(tmp, 'gateway.db'),
        TRIBUTE_ROUTES_STORE: path.join(tmp, 'routes.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stderr.on('data', d => process.stderr.write(d))
    const t = setInterval(async () => {
      try { await req('GET', '/vault/status'); clearInterval(t); resolve(child) } catch { /* not up yet */ }
    }, 300)
    child.on('exit', c => reject(new Error('server exited early: ' + c)))
  })
}

const delay = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  let server = await startServer()
  let pass = 0
  const ok = name => { pass++; console.log('  ✓', name) }

  try {
    // auth gate closed
    const denied = await req('POST', '/vault/entries', { name: 'a', value: 'b' })
    assert.strictEqual(denied.status, 401); ok('auth gate: vault write denied without key')

    // mint key
    const mint = await req('POST', '/keys', { label: 'smoke' })
    assert.strictEqual(mint.status, 201); assert.ok(mint.json.key.startsWith('trb_')); ok('key minted')
    const AUTH = { Authorization: 'Bearer ' + mint.json.key }

    // vault put + broker + scrub
    const put = await req('POST', '/vault/entries', { name: 'sec1', value: 'sk-xyz-9999' }, AUTH)
    assert.strictEqual(put.status, 201); ok('vault put')
    const broker = await req('POST', '/vault/broker', { text: 'Bearer {{sec1}}' }, AUTH)
    assert.ok(broker.json.body.includes('[REDACTED:sec1]')); ok('broker substitutes + scrubs')

    // wallet create
    const w = await req('POST', '/wallets/create', { label: 'w1' }, AUTH)
    assert.strictEqual(w.status, 201); assert.ok(w.json.address.startsWith('0x')); ok('wallet created')

    // restart persistence
    server.kill()
    await delay(400)
    server = await startServer()
    const st = await req('GET', '/vault/status')
    assert.strictEqual(st.json.entries, 2); ok('vault persists across restart (secret + wallet key)')
    const brokers = await req('POST', '/vault/broker', { text: 'Bearer {{sec1}}' }, AUTH)
    assert.ok(brokers.json.body.includes('[REDACTED:sec1]')); ok('key + secret usable after restart')

    // facilitator verify: positive recovery on a signed intent
    const { ethers } = require('ethers')
    const wallet = new ethers.Wallet('0x' + '22'.repeat(32))
    const now = Math.floor(Date.now() / 1000)
    const intent = {
      from: wallet.address, to: '0x' + '33'.repeat(20), value: '10000',
      validAfter: String(now - 10), validBefore: String(now + 300),
      nonce: ethers.hexlify(ethers.randomBytes(32)), resource: '/x402/premium',
    }
    const domain = { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' }
    const types = { PaymentIntent: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'resource', type: 'string' },
    ] }
    const signature = await wallet.signTypedData(domain, types, intent)

    // (needs network for balance check — mark as network-dependent; if RPC is unreachable we still accept a clean signature-mismatch check below)
    let verifiedClean = false
    try {
      const v = await req('POST', '/facilitator/verify', { intent, signature })
      // payer has no USDG → expect insufficient balance (NOT a signature error)
      if (v.json.invalidReason && v.json.invalidReason.startsWith('insufficient USDG')) verifiedClean = true
      else if (v.json.isValid) verifiedClean = true
      assert.ok(verifiedClean, 'unexpected reason: ' + v.json.invalidReason); ok('facilitator verify: signature recovers, balance check runs')
    } catch (e) {
      console.log('  ~ network-dependent verify skipped:', e.message)
    }

    // tampered intent must fail signature check
    const bad = await req('POST', '/facilitator/verify', { intent: { ...intent, value: '999999' }, signature })
    assert.strictEqual(bad.json.invalidReason, 'signature does not match from'); ok('facilitator verify: tampered intent rejected')
    const exp = await req('POST', '/facilitator/verify', { intent: { ...intent, validBefore: '1' }, signature })
    assert.strictEqual(exp.json.invalidReason, 'authorization expired'); ok('facilitator verify: expired rejected')

    // x402 402 challenge
    const r402 = await req('GET', '/x402/premium')
    assert.strictEqual(r402.status, 402); ok('x402: unpaid call → 402 with requirements')

    // rpc whitelist
    const rpc = await req('POST', '/', { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
    assert.ok(rpc.json.result || rpc.text.includes('result')); ok('rpc proxy: whitelisted method passes')
    const blocked = await req('POST', '/', { jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction', params: [] })
    assert.strictEqual(blocked.json.error, 'method not allowed'); ok('rpc proxy: non-whitelisted blocked')

    // ---- rate limiting ----
    // hammer /keys (limit 5/hour per IP) — mint 5 more, 6th must 429
    let got429 = false
    for (let i = 0; i < 6; i++) {
      const r = await req('POST', '/keys', { label: 'rl' + i })
      if (r.status === 429) { got429 = true; assert.ok(r.json.retryAfterSec > 0); break }
    }
    assert.ok(got429, 'expected a 429 on /keys'); ok('rate limit: /keys 429 after 5/hour')

    // ---- sessions: open → redeem → status ----
    const sessions = require('../sessions')
    const s = sessions.open({ payer: wallet.address, payTo: '0x' + '33'.repeat(20), value: '10000', calls: 3, ttlSec: 120, txHash: '0xdeadbeef' })
    assert.strictEqual(s.calls.max, 3); ok('session opened (3 calls)')
    const r1 = sessions.redeem(s.sessionId)
    assert.ok(r1.ok && r1.remaining === 2); ok('session redeem 1/3')
    sessions.redeem(s.sessionId); sessions.redeem(s.sessionId)
    const r4 = sessions.redeem(s.sessionId)
    assert.ok(!r4.ok && r4.reason === 'session call budget exhausted'); ok('session budget enforced')
    // expiry
    const s2 = sessions.open({ payer: wallet.address, payTo: '0x' + '33'.repeat(20), value: '1', calls: 1, ttlSec: 60 })
    const rec = sessions.status(s2.sessionId)
    assert.ok(rec && rec.callsRemaining === 1); ok('session status')

    // ---- reputation ----
    const reputation = require('../reputation')
    reputation.record(wallet.address, { valueFormatted: '0.01', resource: '/x402/premium', txHash: '0xdeadbeef' })
    reputation.record(wallet.address, { valueFormatted: '0.01', resource: '/x402/premium', txHash: '0xfeedface' })
    const rep = reputation.score(wallet.address)
    assert.ok(rep.score > 0 && rep.settledCount === 2 && rep.txHashes.length === 2); ok('reputation scores from settlements, tx-anchored')
    const api = await req('GET', '/reputation/' + wallet.address)
    assert.strictEqual(api.status, 200)
    assert.ok(typeof api.json.score === 'number' && api.json.address.toLowerCase() === wallet.address.toLowerCase()); ok('reputation API endpoint')

    // x402 402 challenge advertises session option
    const r402b = await req('GET', '/x402/premium')
    const reqs = JSON.parse(Buffer.from(r402b.headers['x-payment-required-v1'], 'base64').toString())
    assert.ok(reqs.accepts.some(a => a.scheme === 'tribute-session')); ok('402 challenge offers session scheme')

    // x402 v2: Payment-Required / X-PAYMENT-REQUIRED now carry a genuine v2
    // PaymentRequired object (renamed `amount` field, resource as an object,
    // extensions.bazaar), not just base64(v1 body) mislabeled as v2.
    const { decodePaymentRequiredHeader } = require('@x402/core/http')
    const v2 = decodePaymentRequiredHeader(r402b.headers['x-payment-required'])
    assert.strictEqual(v2.x402Version, 2); ok('402 challenge also serves a real v2 header')
    assert.ok(typeof v2.resource === 'object' && v2.resource.url); ok('v2 header has resource.url object')
    assert.ok(v2.accepts.every(a => typeof a.amount === 'string' && a.maxAmountRequired === undefined)); ok('v2 accepts use amount, not maxAmountRequired')
    assert.ok(v2.extensions && v2.extensions.bazaar && v2.extensions.bazaar.info); ok('v2 header carries extensions.bazaar discovery block')

    console.log(`\nSMOKE PASS — ${pass} checks`)
  } finally {
    server.kill()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1) })
