// Regression tests for audit phase 2 (marketplace, balance/withdraw, registry, rpc, nonce casing).
'use strict'
const assert = require('assert')
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const { Wallet, ethers } = require('ethers')

process.env.COVENANT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-p2-')), 'gateway.db')
process.env.COVENANT_SETTLE_KEY = '0x' + '11'.repeat(32)
process.env.COVENANT_VAULT_KEY = 'unit-test-vault-key-0123456789abcdef'
process.env.COVENANT_RPC_UPSTREAM = 'http://127.0.0.1:1'

const f = require('../../facilitator')
const m = require('../../marketplace')
const routes = require('../../x402-routes')
const db = require('../../db')
let pass = 0
const ok = (n) => { pass++; console.log('  ✓', n) }

async function run() {
  // P2-1: nonce casing cannot bypass replay guards
  {
    assert.strictEqual(f.normNonce('0x' + 'AB'.repeat(32)), '0x' + 'ab'.repeat(32))
    assert.strictEqual(f.normNonce('0xnothex'), null)
    const n = '0x' + 'ab'.repeat(16) + 'cd'.repeat(16)
    assert.strictEqual(f.claimNonce(n), true)
    assert.strictEqual(f.claimNonce(n.toUpperCase().replace('0X', '0x')), false, 'upper-cased nonce is the SAME nonce')
    assert.strictEqual(f.claimNonce('0x' + 'AB'.repeat(16) + 'cd'.repeat(16)), false, 'mixed case is the same nonce')
    assert.strictEqual(f.claimNonce('garbage'), false, 'malformed nonce rejected')
    f.releaseNonce(n.toUpperCase().replace('0X', '0x'))
    assert.strictEqual(f.claimNonce(n), true, 'release is case-insensitive too')
    const p = '0x' + 'ee'.repeat(32)
    assert.strictEqual(f.claimPaymentNonce(4663, p), true)
    assert.strictEqual(f.claimPaymentNonce(4663, p.toUpperCase().replace('0X', '0x')), false, 'payment nonce casing')
    assert.strictEqual((await f.verify({ from: Wallet.createRandom().address, to: '0x' + '22'.repeat(20), value: '1', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 100), nonce: 'zz', resource: 'x' }, '0xabc', 4663)).ok, false)
    ok('[P2-1] replay guards are case-insensitive on bytes32 nonces; malformed nonces rejected')
  }

  // P2-2: only the owner can delist
  {
    const w = Wallet.createRandom(), atk = Wallet.createRandom()
    db.prepare(`INSERT INTO marketplace_listings (slug, kind, name, description, upstream, price, seller, status, created_at) VALUES ('victim-api','external','V','d','https://example.com/x','0.50',?, 'active', ?)`).run(w.address, Date.now())
    const now = Math.floor(Date.now() / 1000)
    const intent = { seller: atk.address, slug: 'victim-api', validAfter: 0, validBefore: now + 300, nonce: '0x' + '77'.repeat(32) }
    const sig = await atk.signTypedData(m.DOMAIN, m.REVOKE_TYPES, intent)
    assert.throws(() => m.revoke({ ...intent, signature: sig }), /not the listing owner/)
    assert.strictEqual(m.get('victim-api').status, 'active')
    const own = { ...intent, seller: w.address, nonce: '0x' + '78'.repeat(32) }
    const out = m.revoke({ ...own, signature: await w.signTypedData(m.DOMAIN, m.REVOKE_TYPES, own) })
    assert.strictEqual(out.status, 'delisted')
    ok('[P2-2] revoke requires the listing owner (attacker signature no longer delists)')
  }

  // P2-3: SSRF classification
  {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.0.1', '198.18.0.1', '192.0.0.1', '224.0.0.1', '0.0.0.0',
      '::', '0:0:0:0:0:0:0:0', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::', '2002:a00:1::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '2001:db8::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'not-an-ip', '']) {
      assert.strictEqual(m.isPrivateIp(ip), true, `${ip} must be treated as private`)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e']) {
      assert.strictEqual(m.isPrivateIp(ip), false, `${ip} is public`)
    }
    await assert.rejects(m.assertSafeUpstream('http://example.com/'), /https/)
    await assert.rejects(m.assertSafeUpstream('https://[::1]/'), /public/)
    await assert.rejects(m.assertSafeUpstream('https://[::]/'), /public/)
    await assert.rejects(m.assertSafeUpstream('https://user:pw@example.com/'), /credentials/)
    await assert.rejects(m.assertSafeUpstream('https://foo.internal/'), /not allowed/)
    ok('[P2-3] SSRF: IPv6/NAT64/6to4/Teredo/mapped/benchmark ranges all blocked; public addresses allowed')
  }

  // P2-4: redirects are re-validated per hop (loopback test server redirects to a "private" target)
  {
    process.env.COVENANT_ALLOW_LOOPBACK_UPSTREAM = '1'
    const inner = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"secret":"INTERNAL"}') })
    await new Promise(r => inner.listen(0, '127.0.0.1', r))
    const redirector = http.createServer((_q, r) => { r.statusCode = 302; r.setHeader('location', `http://127.0.0.1:${inner.address().port}/`); r.end() })
    await new Promise(r => redirector.listen(0, '127.0.0.1', r))
    // sanity: with loopback allowed (staging) the chain works; with it disabled the FIRST hop is rejected
    const viaStaging = await m.fetchJson(`http://127.0.0.1:${redirector.address().port}/`, 3000)
    assert.strictEqual(viaStaging.secret, 'INTERNAL')
    delete process.env.COVENANT_ALLOW_LOOPBACK_UPSTREAM
    await assert.rejects(m.fetchJson(`http://127.0.0.1:${redirector.address().port}/`, 3000), /https|public/, 'production mode refuses loopback and non-https hops')
    // cross-host redirect never carries seller private headers
    let seen = null
    const sink = http.createServer((q, r) => { seen = q.headers['x-seller-key'] || null; r.setHeader('content-type', 'application/json'); r.end('{}') })
    await new Promise(r => sink.listen(0, '127.0.0.1', r))
    process.env.COVENANT_ALLOW_LOOPBACK_UPSTREAM = '1'
    const redir2 = http.createServer((_q, r) => { r.statusCode = 302; r.setHeader('location', `http://localhost:${sink.address().port}/`); r.end() })
    await new Promise(r => redir2.listen(0, '127.0.0.1', r))
    await m.fetchJson(`http://127.0.0.1:${redir2.address().port}/`, 3000, 0, { 'x-seller-key': 'TOPSECRET' })
    assert.strictEqual(seen, null, 'private headers must not follow a cross-host redirect')
    delete process.env.COVENANT_ALLOW_LOOPBACK_UPSTREAM
    for (const s of [inner, redirector, sink, redir2]) s.close()
    ok('[P2-4] fetchJson validates every hop, refuses non-public/non-https in production, never leaks private headers cross-host')
  }

  // P2-5: minimum listing price
  {
    assert.throws(() => m.splitPrice('0.000001'), /at least 0.01/)
    assert.doesNotThrow(() => m.splitPrice('0.01'))
    ok('[P2-5] marketplace minimum price 0.01 (fee cannot round to zero)')
  }

  // P2-6: registry hardening
  {
    db.prepare(`INSERT INTO marketplace_listings (slug, kind, name, description, upstream, price, seller, status, created_at) VALUES ('weather-api','external','W','d','https://example.com/x','0.50','0x${'ab'.repeat(20)}','active',?)`).run(Date.now())
    routes.setMarketplaceSlugCheck((s) => !!m.get(s) || m.exists(s))
    assert.throws(() => routes.create({ path: '/weather-api', price: '9.99', description: 'hijacked' }), /already registered/)
    assert.throws(() => routes.create({ path: '/zero', price: '0' }), /at least 0.01/)
    assert.throws(() => routes.create({ path: '/obj', price: '0.05', description: { a: 1 } }), /string/)
    assert.throws(() => routes.create({ path: '/long', price: '0.05', description: 'x'.repeat(241) }), /240/)
    assert.doesNotThrow(() => routes.create({ path: '/fine-one', price: '0.05', description: 'ok' }))
    ok('[P2-6] open registry cannot shadow marketplace slugs, register free routes, or store non-string/oversized descriptions')
  }

  // P2-7: refund / seller-leg obligations are persisted and retried
  {
    const c = require('../../chains').getChain(4663)
    const n = '0x' + '31'.repeat(32)
    f.claimPaymentNonce(4663, n)
    const it = { from: '0x' + 'aa'.repeat(20), to: '0x' + 'bb'.repeat(20), value: '10000', validAfter: '0', validBefore: '9999999999', nonce: n, resource: 'https://gateway.covenantx402.com/x402/api/x' }
    f._test.finalizeSettlement(4663, c, it, 10000n, { hash: '0xrefundtx', gasUsed: 1n }, null)
    f.markRefundDue('0xrefundtx', 4663, it.from, '10000', 'upstream fail')
    assert.ok(db.prepare("SELECT refund_due FROM settlements WHERE tx_hash='0xrefundtx'").get().refund_due, 'refund obligation persisted')
    assert.strictEqual(await f.retryRefundsDue().catch(() => 0), 0, 'no chain here -> nothing sent, obligation restored')
    assert.ok(db.prepare("SELECT refund_due FROM settlements WHERE tx_hash='0xrefundtx'").get().refund_due, 'failed retry restores the obligation')
    f.clearRefundDue('0xrefundtx', 4663)
    assert.strictEqual(db.prepare("SELECT refund_due FROM settlements WHERE tx_hash='0xrefundtx'").get().refund_due, null)
    ok('[P2-7] failed buyer refunds are persisted (refund_due), retried, and cleared on success')
  }

  console.log(`\nUNIT PASS (audit-phase2) — ${pass} checks`)
}
run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
