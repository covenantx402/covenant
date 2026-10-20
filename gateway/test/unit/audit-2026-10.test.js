// Regression tests for the 2026-10 security audit. Each block names the finding it locks down.
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Wallet } = require('ethers')

process.env.COVENANT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-audit-')), 'gateway.db')
process.env.COVENANT_SETTLE_KEY = '0x' + '11'.repeat(32)
process.env.COVENANT_VAULT_KEY = 'unit-test-vault-key-0123456789abcdef'
process.env.COVENANT_RPC_UPSTREAM = 'http://127.0.0.1:1'

const facilitator = require('../../facilitator')
const db = require('../../db')
const batch = require('../../batch')
const vault = require('../../agent-vault')

let pass = 0
const ok = (n) => { pass++; console.log('  ✓', n) }
const ID = 4663
const RES = 'https://gateway.covenantx402.com/x402/api/alpha'
const FROM = '0x' + 'aa'.repeat(20)
const header = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
const intentFor = (nonce, resource = RES) => ({ from: FROM, to: '0x' + 'bb'.repeat(20), value: '10000', validAfter: '0', validBefore: '9999999999', nonce, resource })
const wait = (ms) => new Promise(r => setTimeout(r, ms))

async function run() {
  const c = require('../../chains').getChain(ID)

  // F1/F2 — receipt must be a CONFIRMED, server-recorded settlement bound to its resource
  {
    const n = '0x' + '01'.repeat(32)
    assert.ok(facilitator.claimPaymentNonce(ID, n))
    const h = header({ intent: intentFor(n), txHash: '0xfake', chainId: ID })
    assert.strictEqual(facilitator.paymentRecordFor(h, RES, ID), null, 'in-flight placeholder must not unlock content')
    assert.strictEqual(facilitator.claimReceipt(n, ID), false, 'placeholder must not be redeemable')
    facilitator.releasePaymentNonce(ID, n)
    ok('[F1] in-flight nonce placeholder is not a payment receipt and cannot be redeemed')
  }
  {
    const n = '0x' + '02'.repeat(32)
    facilitator.claimPaymentNonce(ID, n)
    const out = facilitator._test.finalizeSettlement(ID, c, intentFor(n), 10000n, { hash: '0xrealtx', gasUsed: 1n }, null)
    assert.strictEqual(out.success, true)
    const good = header({ intent: intentFor(n), txHash: '0xrealtx', chainId: ID })
    assert.ok(facilitator.paymentRecordFor(good, RES, ID), 'genuine receipt accepted')
    assert.strictEqual(facilitator.paymentRecordFor(header({ intent: intentFor(n, RES.replace('alpha', 'pricey')), txHash: '0xrealtx', chainId: ID }), RES.replace('alpha', 'pricey'), ID), null, 'receipt for resource A cannot unlock B')
    assert.strictEqual(facilitator.paymentRecordFor(header({ intent: intentFor(n), txHash: '0xother', chainId: ID }), RES, ID), null, 'forged txHash rejected')
    assert.strictEqual(facilitator.paymentRecordFor(header({ intent: { nonce: n }, txHash: '0xrealtx', chainId: ID }), RES, ID) !== null, true, 'resource is taken from the server record, not the header')
    assert.strictEqual(facilitator.paymentRecordFor(good, null, ID), null, 'no resource -> no match')
    const again = facilitator._test.finalizeSettlement(ID, c, intentFor(n), 10000n, { hash: '0xrealtx2', gasUsed: 1n }, null)
    assert.strictEqual(again.success, false, 'a settled nonce cannot be finalized twice')
    ok('[F2] receipt is bound to the stored settlement (txHash+resource); header-supplied resource is not trusted')
  }
  {
    const n = '0x' + '03'.repeat(32)
    facilitator.claimNonce(n, ID) // act: namespaced row
    assert.strictEqual(facilitator.claimReceipt('act:' + n, ID), false, 'non-payment action nonces are never redeemable')
    ok('[F2b] action nonces cannot be redeemed as payment receipts')
  }

  // F3 — a broadcast-but-unconfirmed tx must keep its nonce locked, and resolve by tx hash
  {
    const n = '0x' + '04'.repeat(32)
    const it = intentFor(n)
    facilitator.claimPaymentNonce(ID, n)
    facilitator._test.stmts.noncePending.run(JSON.stringify({ txHash: '0xpending', intent: it, settleValue: '10000', t: Date.now() }), ID, n)
    facilitator.releasePaymentNonce(ID, n)
    assert.ok(db.prepare('SELECT 1 FROM nonces WHERE chain_id=? AND nonce=?').get(ID, n), 'pending nonce must NOT be released by a generic failure path')

    const fake = { receipt: null, tx: { hash: '0xpending' }, net: { chainId: BigInt(ID) } }
    facilitator._test._providers.set(ID, {
      getNetwork: async () => fake.net,
      getTransactionReceipt: async () => fake.receipt,
      getTransaction: async () => fake.tx,
    })
    let r = await facilitator._test.resolvePending(ID, it, null)
    assert.strictEqual(r.pending, true, 'still unknown -> report pending, never re-charge')
    assert.ok(db.prepare('SELECT 1 FROM nonces WHERE chain_id=? AND nonce=?').get(ID, n))

    fake.receipt = { status: 1, hash: '0xpending', gasUsed: 5n }
    r = await facilitator._test.resolvePending(ID, it, null)
    assert.strictEqual(r.success, true, 'confirmed pending tx finalizes exactly once')
    assert.strictEqual(r.transaction, '0xpending')
    r = await facilitator._test.resolvePending(ID, it, null).catch(e => ({ success: false }))
    assert.strictEqual(r.success, false, 'second resolve cannot double-finalize')

    const n2 = '0x' + '05'.repeat(32)
    const it2 = intentFor(n2)
    facilitator.claimPaymentNonce(ID, n2)
    facilitator._test.stmts.noncePending.run(JSON.stringify({ txHash: '0xrev', intent: it2, settleValue: '10000', t: Date.now() }), ID, n2)
    fake.receipt = { status: 0, hash: '0xrev' }
    r = await facilitator._test.resolvePending(ID, it2, null)
    assert.strictEqual(r.success, false)
    assert.strictEqual(db.prepare('SELECT 1 FROM nonces WHERE chain_id=? AND nonce=?').get(ID, n2), undefined, 'proven revert frees the nonce')

    const n3 = '0x' + '06'.repeat(32)
    facilitator.claimPaymentNonce(ID, n3)
    facilitator._test.stmts.noncePending.run(JSON.stringify({ txHash: '0xold', intent: intentFor(n3), settleValue: '10000', t: Date.now() - 31 * 60 * 1000 }), ID, n3)
    fake.receipt = null; fake.tx = null
    assert.strictEqual(await facilitator.reconcilePending(), 1, 'long-dropped tx is reconciled')
    ok('[F3] timeout after broadcast keeps the nonce locked; resolves by tx hash; revert/drop frees it; no double charge')
  }

  // F4 — batch claim lock is DB-backed and survives a "second process"
  {
    const id = '0x' + 'ee'.repeat(32)
    db.prepare('INSERT INTO batch_channels (id, chain_id, payer, pay_to, opened_at, valid_before) VALUES (?,?,?,?,?,?)').run(id, ID, FROM, FROM, Date.now(), Math.floor(Date.now() / 1000) + 600)
    assert.strictEqual(batch.tryLockChannel(id), true)
    const other = require('better-sqlite3')(process.env.COVENANT_DB_PATH) // simulates a second gateway process
    const takenByOther = other.prepare('UPDATE batch_channels SET claim_lock = ? WHERE id = ? AND (claim_lock IS NULL OR claim_lock < ?)').run(Date.now(), id, Date.now() - 600000).changes
    other.close()
    assert.strictEqual(takenByOther, 0, 'a second process cannot take a held lock')
    batch.setClaimPending(id, { txHash: '0xclaim', totalValue: '30000', netValue: '30000', t: Date.now() })
    batch.unlockChannel(id)
    assert.strictEqual(batch.getClaimPending(id).txHash, '0xclaim', 'pending claim survives unlock/restart')
    batch.recordClaim(id, '0xclaim', false, '30000')
    assert.strictEqual(batch.getClaimPending(id), null)
    assert.strictEqual(db.prepare('SELECT claimed_value FROM batch_channels WHERE id=?').get(id).claimed_value, '30000', 'claimed = value the tx covered, not the live high-water mark')
    ok('[F4] batch claim lock + pending claim are DB-backed (multi-process / restart safe)')
  }

  // F5 — vault
  {
    assert.throws(() => vault.put('o', 'short', 'abc'), /4-4096/)
    vault.put('o', 'ok', 'abcd')
    db.prepare('INSERT INTO vault_entries (owner,name,enc,iv,tag,created_at,hits) SELECT owner,\'legacy\',enc,iv,tag,created_at,0 FROM vault_entries WHERE name=\'ok\'').run()
    ok('[F5] vault rejects secrets < 4 chars (cannot be scrubbed) and requires COVENANT_VAULT_KEY')
  }
  {
    const { spawnSync } = require('child_process')
    const r = spawnSync(process.execPath, ['-e', "require('./agent-vault')"], { cwd: path.join(__dirname, '../..'), env: { ...process.env, COVENANT_VAULT_KEY: '', COVENANT_DB_PATH: path.join(os.tmpdir(), 'nokey.db') }, encoding: 'utf8' })
    assert.notStrictEqual(r.status, 0, 'must refuse to start without COVENANT_VAULT_KEY')
    assert.ok(/COVENANT_VAULT_KEY is required/.test(r.stderr))
    ok('[F5b] vault module refuses to load without a real COVENANT_VAULT_KEY (no derived fallback)')
  }

  console.log(`\nUNIT PASS (audit-2026-10) — ${pass} checks`)
}
run().catch(e => { console.error(e); process.exit(1) })
