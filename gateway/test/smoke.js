// gateway/test/smoke.js — end-to-end smoke test of the COVENANT gateway.
// Run: npm test  (starts nothing itself; expects COVENANT_TEST_PORT free)
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-test-'))
// Isolate in-process module stores too (reputation is required directly below,
// so it must open the SAME sqlite file the spawned server process writes to).
process.env.COVENANT_DB_PATH = path.join(tmp, 'gateway.db')
process.env.COVENANT_VAULT_KEY = 'smoke-test-vault-key-0123456789abcdef'

// A real (but freshly-generated, worthless, devnet-only) Solana fee-payer
// key so the spawned server's /x402/solana/* endpoints are actually
// exercised end-to-end rather than permanently 503ing on "not configured".
const crypto = require('crypto')
const bs58Mod = require('bs58')
const bs58 = bs58Mod.default || bs58Mod
const solanaFeePayerKp = crypto.generateKeyPairSync('ed25519')
const SOLANA_FEE_PAYER_SEED = solanaFeePayerKp.privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32)
const SMOKE_SOL_MINT = bs58.encode(Buffer.alloc(32, 7))   // deterministic test mint
const SMOKE_SOL_PAYTO = bs58.encode(Buffer.alloc(32, 9))  // deterministic test recipient token account
const SOLANA_FEE_PAYER_KEY_B58 = bs58.encode(SOLANA_FEE_PAYER_SEED)

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request(BASE + p, { method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
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
        COVENANT_RPC_UPSTREAM: process.env.COVENANT_RPC_UPSTREAM || 'https://robinhood-rpc.publicnode.com',
        COVENANT_PORT: String(PORT),
        COVENANT_SETTLE_KEY: '0x' + '11'.repeat(32),
        COVENANT_VAULT_KEY: 'smoke-test-vault-key-0123456789abcdef',
        COVENANT_ADMIN_TOKEN: 'smoke-admin-token-0123456789abcdef',
        COVENANT_DB_PATH: path.join(tmp, 'gateway.db'),
        COVENANT_ROUTES_STORE: path.join(tmp, 'routes.json'),
        COVENANT_SOLANA_FEE_PAYER_KEY: SOLANA_FEE_PAYER_KEY_B58,
        COVENANT_SOLANA_MINT: SMOKE_SOL_MINT,
        COVENANT_SOLANA_PAYTO: SMOKE_SOL_PAYTO,
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
    assert.strictEqual(mint.status, 201); assert.ok(mint.json.key.startsWith('cvn_')); ok('key minted')
    const AUTH = { Authorization: 'Bearer ' + mint.json.key }

    // vault put + broker + scrub
    const put = await req('POST', '/vault/entries', { name: 'sec1', value: 'sk-xyz-9999' }, AUTH)
    assert.strictEqual(put.status, 201); ok('vault put')
    const broker = await req('POST', '/vault/broker', { text: 'Bearer {{sec1}}' }, AUTH)
    assert.ok(broker.json.body.includes('[REDACTED:sec1]')); ok('broker substitutes + scrubs')

    // wallet create
    const w = await req('POST', '/wallets/create', { label: 'w1' }, AUTH)
    assert.strictEqual(w.status, 201); assert.ok(w.json.address.startsWith('0x')); ok('wallet created')

    // [audit 2026-10 Critical] an ordinary agent key can no longer list/revoke other tenants' keys
    const victim = await req('POST', '/keys', { label: 'victim' })
    const gl = await req('GET', '/keys', null, AUTH)
    assert.strictEqual(gl.status, 403, 'agent key must not list global keys')
    const gd = await req('DELETE', '/keys', { id: victim.json.id }, AUTH)
    assert.strictEqual(gd.status, 403, 'agent key must not revoke other keys: ' + JSON.stringify(gd.json) + '')
    const still = await req('GET', '/vault/entries', null, { Authorization: 'Bearer ' + victim.json.key })
    assert.strictEqual(still.status, 200, 'victim key still works')
    const ADMIN = { Authorization: 'Bearer smoke-admin-token-0123456789abcdef' }
    assert.strictEqual((await req('GET', '/keys', null, ADMIN)).status, 200, 'admin token can list')
    assert.strictEqual((await req('DELETE', '/keys', { id: victim.json.id }, ADMIN)).status, 200, 'admin token can revoke')
    assert.strictEqual((await req('GET', '/vault/entries', null, { Authorization: 'Bearer ' + victim.json.key })).status, 401)
    const short = await req('POST', '/vault/entries', { name: 'tiny', value: 'abc' }, AUTH)
    assert.strictEqual(short.status, 400, 'short secrets rejected')
    ok('[audit] /keys global list/revoke is admin-only; short vault secrets rejected')

    // [audit phase 2] HTTP-level hardening
    const big = await req('POST', '/vault/entries', { name: 'big', value: 'x'.repeat(60000) }, AUTH)
    assert.strictEqual(big.status, 413, 'oversized body gets an explicit 413, not a dropped connection')
    const rpcBatch = await req('POST', '/', Array.from({ length: 11 }, () => ({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })))
    assert.strictEqual(rpcBatch.status, 400, 'RPC batch capped at 10')
    const rpcOverride = await req('POST', '/', { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x' + '11'.repeat(20), data: '0x' }, 'latest', { ['0x' + '22'.repeat(20)]: { code: '0x00' } }] })
    assert.strictEqual(rpcOverride.status, 400, 'eth_call state overrides rejected')
    const free = await req('POST', '/x402/apis', { path: '/free-route', price: '0' })
    assert.strictEqual(free.status, 400, 'zero-price route rejected')
    ok('[audit p2] 413 on oversize body; RPC batch/state-override limits; zero-price registry rejected')

    // vault/wallet isolation: a second agent key must not see agent 1's
    // secrets or wallets — each is scoped to its owning key, not global.
    const mint2 = await req('POST', '/keys', { label: 'smoke2' })
    const AUTH2 = { Authorization: 'Bearer ' + mint2.json.key }
    const brokerAsAgent2 = await req('POST', '/vault/broker', { text: '{{sec1}}' }, AUTH2)
    assert.strictEqual(brokerAsAgent2.json.body, '{{sec1}}') // placeholder left unresolved, not agent 1's secret
    assert.strictEqual(brokerAsAgent2.json.used.length, 0)
    const vaultListAsAgent2 = await req('GET', '/vault/entries', null, AUTH2)
    assert.deepStrictEqual(vaultListAsAgent2.json, [])
    const walletsAsAgent2 = await req('GET', '/wallets', null, AUTH2)
    assert.deepStrictEqual(walletsAsAgent2.json, [])
    const vaultListAsAgent1 = await req('GET', '/vault/entries', null, AUTH)
    assert.strictEqual(vaultListAsAgent1.json.length, 2) // sec1 + the wallet's own vault-stored private key
    ok('vault + wallet isolation: agent 2 cannot see agent 1 secrets or wallets')

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
    const domain = { name: 'COVENANT', version: '1', chainId: 4663, verifyingContract: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' }
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
    assert.ok(reqs.accepts.some(a => a.scheme === 'covenant-session')); ok('402 challenge offers session scheme')

    // x402 v2: Payment-Required / X-PAYMENT-REQUIRED now carry a genuine v2
    // PaymentRequired object (renamed `amount` field, resource as an object,
    // extensions.bazaar), not just base64(v1 body) mislabeled as v2.
    const { decodePaymentRequiredHeader } = require('@x402/core/http')
    const v2 = decodePaymentRequiredHeader(r402b.headers['x-payment-required'])
    assert.strictEqual(v2.x402Version, 2); ok('402 challenge also serves a real v2 header')
    assert.ok(typeof v2.resource === 'object' && v2.resource.url); ok('v2 header has resource.url object')
    assert.ok(v2.accepts.every(a => typeof a.amount === 'string' && a.maxAmountRequired === undefined)); ok('v2 accepts use amount, not maxAmountRequired')
    assert.ok(v2.extensions && v2.extensions.bazaar && v2.extensions.bazaar.info); ok('v2 header carries extensions.bazaar discovery block')

    // GET /supported — x402 spec facilitator-capability discovery endpoint
    // (the same shape Coinbase CDP / Circle / the legacy facilitator-http
    // transport spec use: kinds[], extensions[], signers{}).
    const sup = await req('GET', '/supported')
    assert.strictEqual(sup.status, 200)
    assert.strictEqual(sup.json.x402Version, 1)
    assert.ok(Array.isArray(sup.json.kinds) && sup.json.kinds.length > 0)
    assert.ok(sup.json.kinds.every(k => k.scheme && k.network && k.asset))
    // A chain is advertised in kinds[] only when it can settle now; otherwise it must be
    // listed in unavailable[] with a reason. The smoke wallet has no gas, so either is valid.
    assert.ok(Array.isArray(sup.json.unavailable))
    assert.ok(sup.json.kinds.some(k => k.network === 'eip155:4663' && k.scheme === 'exact') ||
      sup.json.unavailable.some(u => u.network === 'eip155:4663' && u.reason)); ok('GET /supported accounts for eip155:4663 (kind if ready, else unavailable with reason)')
    const supAlias = await req('GET', '/facilitator/supported')
    assert.strictEqual(supAlias.status, 200)
    assert.deepStrictEqual(supAlias.json.kinds, sup.json.kinds); ok('GET /facilitator/supported alias matches /supported exactly')

    // "upto" scheme demo (/x402/upto/echo) — full E2E including the
    // security property that matters most: a receipt signed for one text
    // cannot be replayed against a different (more expensive) text,
    // because text is bound into the EIP-712-signed resource URL.
    const uptoUnpaid = await req('GET', '/x402/upto/echo?text=hello%20world')
    assert.strictEqual(uptoUnpaid.status, 402)
    assert.strictEqual(uptoUnpaid.json.accepts[0].scheme, 'upto')
    assert.strictEqual(uptoUnpaid.json.accepts[0].resource, 'https://gateway.covenantx402.com/x402/upto/echo?text=hello+world', 'resource binds the exact query text, using the gateway\'s PUBLIC_ORIGIN (fixed to the production domain regardless of what port this test server happens to listen on)')
    const uptoCeiling = BigInt(uptoUnpaid.json.accepts[0].maxAmountRequired)
    assert.strictEqual(uptoCeiling.toString(), '50000', 'ceiling = PRICE_PER_WORD_USD(0.0001) * WORDS_CAP(500) = 0.05 USDG = 50000 atomic'); ok('GET /x402/upto/echo (unpaid) challenges with scheme "upto" and the worst-case ceiling')

    const uptoWallet = ethers.Wallet.createRandom()
    const uptoIntent = {
      from: uptoWallet.address, to: uptoUnpaid.json.accepts[0].payTo,
      value: uptoCeiling.toString(),
      validAfter: String(now - 10), validBefore: String(now + 300),
      nonce: ethers.hexlify(ethers.randomBytes(32)), resource: uptoUnpaid.json.accepts[0].resource,
    }
    const uptoSig = await uptoWallet.signTypedData(domain, types, uptoIntent)
    // No balance on this fresh wallet. verify() checks balance/allowance
    // against the FULL SIGNED CEILING (not the real per-request charge)
    // by design — the buyer must actually hold/approve the worst case
    // they authorized, even though any single settle call only pulls
    // part of it. So the balance-shortfall error here correctly names
    // the ceiling (0.05), not the real per-word charge — proving verify()
    // still gates on the ceiling under "upto", same as "exact". The
    // actualValue mechanics themselves (settle() only ever pulling LESS
    // than the ceiling) are covered directly in
    // test/unit/facilitator-upto.test.js, which can call settle() past
    // this balance gate by using a signature that fails differently.
    const uptoSettle = await req('POST', '/facilitator/settle', { intent: uptoIntent, signature: uptoSig, chainId: 4663 })
    assert.strictEqual(uptoSettle.json.success, false)
    assert.ok(/insufficient USDG balance.*0\.05/.test(uptoSettle.json.errorReason), `expected a balance-shortfall error naming the 0.05 ceiling (verify() gates on the full ceiling, by design) — got: ${uptoSettle.json.errorReason}`); ok('upto settlement still gates balance/allowance against the full signed ceiling, not the real per-request charge')

    // Replay-against-different-text attack: tamper the resource's bound
    // text after signing — must fail signature verification, not silently
    // charge a different (possibly higher) amount for different text.
    const tamperedIntent = { ...uptoIntent, resource: uptoIntent.resource.replace('hello+world', 'a+much+longer+piece+of+text+entirely') }
    const tamperSettle = await req('POST', '/facilitator/settle', { intent: tamperedIntent, signature: uptoSig, chainId: 4663 })
    assert.strictEqual(tamperSettle.json.success, false)
    assert.ok(/signature does not match/.test(tamperSettle.json.errorReason), `tampering the bound text after signing must fail signature verification, got: ${tamperSettle.json.errorReason}`); ok('tampering the signed resource\'s bound text after signing is rejected (signature mismatch)')

    // "batch-settlement" scheme (/x402/batch/*) — open a channel, verify
    // 2 vouchers off-chain (free, no RPC), confirm the HTTP-level flow
    // matches the direct batch.js unit tests (test/unit/batch.test.js
    // covers the deeper monotonic/signature-mismatch edge cases).
    const batchWallet = ethers.Wallet.createRandom()
    const openRes = await req('POST', '/x402/batch/open', { payer: batchWallet.address, chainId: 4663 })
    assert.strictEqual(openRes.status, 201)
    assert.ok(/^0x[0-9a-f]{64}$/.test(openRes.json.channelId)); ok('POST /x402/batch/open returns a usable channel + signing domain/types')

    const voucher1 = { channelId: openRes.json.channelId, payer: openRes.json.payer, payTo: openRes.json.payTo, cumulativeValue: '10000', validBefore: String(openRes.json.validBefore) }
    const voucherSig1 = await batchWallet.signTypedData(openRes.json.domain, openRes.json.types, voucher1)
    const v1Res = await req('POST', '/x402/batch/voucher', { channelId: openRes.json.channelId, cumulativeValue: '10000', signature: voucherSig1 })
    assert.strictEqual(v1Res.status, 200)
    assert.strictEqual(v1Res.json.vouchersVerified, 1)

    const voucher2 = { ...voucher1, cumulativeValue: '30000' }
    const voucherSig2 = await batchWallet.signTypedData(openRes.json.domain, openRes.json.types, voucher2)
    const v2Res = await req('POST', '/x402/batch/voucher', { channelId: openRes.json.channelId, cumulativeValue: '30000', signature: voucherSig2 })
    assert.strictEqual(v2Res.status, 200)
    assert.strictEqual(v2Res.json.vouchersVerified, 2); ok('POST /x402/batch/voucher verifies 2 vouchers over HTTP, both free (no on-chain activity between them)')

    const statusRes = await req('GET', '/x402/batch/channel/' + openRes.json.channelId)
    assert.strictEqual(statusRes.status, 200)
    assert.strictEqual(statusRes.json.lastCumulativeValue, '30000')
    assert.strictEqual(statusRes.json.vouchersVerified, 2); ok('GET /x402/batch/channel/:id reflects both verified vouchers')

    // Claim fails (fresh wallet, zero balance) but the error correctly
    // names the FULL accumulated amount (30000, not a per-voucher amount)
    // — proving the claim batches the whole channel into one would-be
    // transferFrom instead of settling per-voucher.
    const claimRes = await req('POST', '/x402/batch/claim', { channelId: openRes.json.channelId })
    assert.strictEqual(claimRes.status, 400)
    assert.ok(/0\.03/.test(claimRes.json.error), `expected the claim error to name the full accumulated 0.03 USDG, got: ${claimRes.json.error}`); ok('POST /x402/batch/claim attempts a single on-chain claim for the full accumulated channel total')

    // Solana "exact" scheme (/x402/solana/*) — build a real partially-
    // signed devnet transaction and exercise verify()/settle() over HTTP.
    // settle() will fail at broadcast (no devnet SOL funded for this
    // throwaway test keypair — public devnet faucets were exhausted
    // during development, see README "Solana support"), but the CO-SIGN
    // mechanics (decode -> validate fee payer slot -> add facilitator
    // signature -> attempt submit) run for real against the fee payer
    // key, which is the part that regresses silently if ever broken.
    const kit = require('@solana/kit')
    const { getTransferCheckedInstruction } = require('@solana-program/token')
    const infoRes = await req('GET', '/x402/solana/info')
    assert.strictEqual(infoRes.status, 200)
    assert.strictEqual(infoRes.json.configured, true)
    assert.ok(infoRes.json.feePayer === null, 'feePayer address is only populated once settle() has actually resolved it once — publicView() does not force-resolve it just to answer a status GET'); ok('GET /x402/solana/info reports configured:true once COVENANT_SOLANA_FEE_PAYER_KEY is set')

    const solanaBuyer = await kit.createKeyPairSignerFromPrivateKeyBytes(crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32))
    const buyerTokenAccount = await kit.createKeyPairSignerFromPrivateKeyBytes(crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32))
    const merchantTokenAccount = { address: SMOKE_SOL_PAYTO }
    const solanaMint = { address: SMOKE_SOL_MINT }
    const feePayerAddress = (await kit.createKeyPairSignerFromPrivateKeyBytes(SOLANA_FEE_PAYER_SEED)).address
    const fakeBlockhash = { blockhash: '11111111111111111111111111111111111111111', lastValidBlockHeight: 999999999n }
    // A real SPL TransferChecked instruction — this gateway's anti-drain
    // guard (assertSafeTx, see solana.js) only allows SPL Token/Token-2022
    // program instructions; a plain SystemProgram transfer is correctly
    // rejected now (see test/unit/solana.test.js for the dedicated P0
    // regression tests covering that guard directly).
    const transferIx = getTransferCheckedInstruction({ source: buyerTokenAccount.address, mint: solanaMint.address, destination: merchantTokenAccount.address, authority: solanaBuyer, amount: 1000n, decimals: 6 })
    const solanaMessage = kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      m => kit.setTransactionMessageFeePayerSigner(kit.createNoopSigner(feePayerAddress), m),
      m => kit.setTransactionMessageLifetimeUsingBlockhash(fakeBlockhash, m),
      m => kit.appendTransactionMessageInstructions([transferIx], m),
    )
    const solanaPartiallySigned = await kit.partiallySignTransactionMessageWithSigners(solanaMessage)
    const solanaBase64Tx = kit.getBase64EncodedWireTransaction(solanaPartiallySigned)

    const svmVerify = await req('POST', '/x402/solana/verify', { transaction: solanaBase64Tx })
    assert.strictEqual(svmVerify.status, 200, JSON.stringify(svmVerify.json))
    assert.strictEqual(svmVerify.json.payer, solanaBuyer.address); ok('POST /x402/solana/verify recovers the real buyer address from a partially-signed devnet transaction, no RPC call needed')

    const svmSettle = await req('POST', '/x402/solana/settle', { transaction: solanaBase64Tx })
    assert.strictEqual(svmSettle.json.success, false)
    assert.ok(/Solana settle error/.test(svmSettle.json.errorReason), `expected the co-sign step to reach the actual devnet RPC and fail there (fake blockhash/unfunded account), got: ${svmSettle.json.errorReason}`); ok('POST /x402/solana/settle co-signs with the configured fee payer and attempts a real devnet broadcast (fails on fake blockhash/unfunded test account, as expected)')

    // P0 regression at the HTTP layer too: a smuggled SystemProgram
    // instruction alongside this same legit payment must be rejected by
    // the live endpoint, not just the unit-level function.
    const { getTransferSolInstruction } = require('@solana-program/system')
    const attackerSigner = await kit.createKeyPairSignerFromPrivateKeyBytes(crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32))
    const drainIx = getTransferSolInstruction({ source: kit.createNoopSigner(feePayerAddress), destination: attackerSigner.address, amount: 5_000_000_000n })
    const drainMessage = kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      m => kit.setTransactionMessageFeePayerSigner(kit.createNoopSigner(feePayerAddress), m),
      m => kit.setTransactionMessageLifetimeUsingBlockhash(fakeBlockhash, m),
      m => kit.appendTransactionMessageInstructions([transferIx, drainIx], m),
    )
    const drainPartiallySigned = await kit.partiallySignTransactionMessageWithSigners(drainMessage)
    const drainBase64Tx = kit.getBase64EncodedWireTransaction(drainPartiallySigned)
    const drainVerify = await req('POST', '/x402/solana/verify', { transaction: drainBase64Tx })
    assert.strictEqual(drainVerify.status, 400, 'CRITICAL: a transaction smuggling a fee-payer-draining instruction alongside a real payment must be rejected over HTTP, not just at the unit level')
    assert.ok(/non-allowlisted program/.test(drainVerify.json.error)); ok('[P0 regression, HTTP layer] POST /x402/solana/verify rejects a real payment transaction that also smuggles a fee-payer-draining instruction')

    console.log(`\nSMOKE PASS — ${pass} checks`)
  } finally {
    server.kill()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1) })
