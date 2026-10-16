// test/unit/facilitator-nonce-lock.test.js — regression test for a race
// condition found during security audit: facilitator.settle()'s nonce
// uniqueness check (usedNoncesHas) and the actual nonce-recording insert
// (nonceInsert, after a successful on-chain transferFrom) were separated
// by the ENTIRE RPC round-trip + transferFrom + tx.wait() — a long
// window. Two concurrent settle() calls for the IDENTICAL signed intent
// both passed verify()'s check and both reached transferFrom; if the
// buyer's allowance covered it twice, the same single signature could be
// spent twice. Confirmed with a live PoC before the fix: two concurrent
// settle() calls for one intent both reached the identical balance-check
// failure point, proving neither was rejected for nonce reuse before the
// on-chain attempt.
//
// The fix: claimPaymentNonce() atomically reserves the nonce (a real
// SQLite INSERT ... ON CONFLICT DO NOTHING, serialized per-connection —
// not just an app-level check-then-act) BEFORE any on-chain work;
// releasePaymentNonce() frees it on any failure so legitimate retries
// (RPC hiccup, gas top-up) aren't permanently locked out.
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-nonce-lock-test-')), 'gateway.db')
process.env.COVENANT_DB_PATH = tmpDb
process.env.COVENANT_SETTLE_KEY = '0x' + '11'.repeat(32)

const facilitator = require('../../facilitator')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

function run() {
  const nonce1 = '0x' + '11'.repeat(32)
  const nonce2 = '0x' + '22'.repeat(32)

  // -- the core fix: a second claim on the SAME nonce while the first is
  //    still "in flight" (not yet released) must fail. This is exactly
  //    the condition that let two concurrent settle() calls both reach
  //    transferFrom for the identical signed intent. --
  {
    assert.strictEqual(facilitator.claimPaymentNonce(4663, nonce1), true, 'first claim on an unclaimed nonce succeeds')
    assert.strictEqual(facilitator.claimPaymentNonce(4663, nonce1), false, 'CRITICAL: a second concurrent claim on the SAME nonce must fail — this exact condition let two settle() calls both reach the on-chain transferFrom for one signature')
    ok('[race-condition regression] claimPaymentNonce rejects a concurrent duplicate claim on the same nonce')
  }

  // -- release frees the nonce for a legitimate retry (transient RPC/gas
  //    failure, not an attack) --
  {
    facilitator.releasePaymentNonce(4663, nonce1)
    assert.strictEqual(facilitator.claimPaymentNonce(4663, nonce1), true, 'after releasing, the same nonce can be claimed again — a legitimate retry after a transient failure must not be permanently locked out')
    facilitator.releasePaymentNonce(4663, nonce1)
    ok('releasePaymentNonce frees a claimed-but-failed nonce for a legitimate retry')
  }

  // -- claims on DIFFERENT nonces never contend with each other --
  {
    assert.strictEqual(facilitator.claimPaymentNonce(4663, nonce1), true)
    assert.strictEqual(facilitator.claimPaymentNonce(4663, nonce2), true, 'claiming one nonce must never block claiming a DIFFERENT nonce')
    facilitator.releasePaymentNonce(4663, nonce1)
    facilitator.releasePaymentNonce(4663, nonce2)
    ok('nonce claims are independent per-nonce, not globally serialized')
  }

  // -- the same nonce on a DIFFERENT chain is a distinct slot (the real
  //    nonces table is keyed by (chain_id, nonce), not nonce alone) --
  {
    assert.strictEqual(facilitator.claimPaymentNonce(4663, nonce1), true)
    assert.strictEqual(facilitator.claimPaymentNonce(1, nonce1), true, 'the same nonce value on a DIFFERENT chainId must be claimable independently — the composite key is (chainId, nonce)')
    facilitator.releasePaymentNonce(4663, nonce1)
    facilitator.releasePaymentNonce(1, nonce1)
    ok('nonce claims are scoped per-chain — the same nonce value on two different chains does not collide')
  }

  // -- releasePaymentNonce must NEVER delete a real, already-recorded
  //    settlement row (only the unsettled placeholder, tx_hash IS NULL).
  //    Simulate a real settlement record directly against the nonces
  //    table the way settle()'s own nonceInsert UPSERT would leave it,
  //    then confirm release is a no-op against it. --
  {
    const db = require('../../db')
    facilitator.claimPaymentNonce(4663, nonce1) // placeholder, tx_hash NULL
    db.prepare("UPDATE nonces SET tx_hash = ? WHERE chain_id = ? AND nonce = ?").run('0xrealtxhash', 4663, nonce1)
    facilitator.releasePaymentNonce(4663, nonce1) // must be a no-op — tx_hash is no longer NULL
    const row = db.prepare('SELECT * FROM nonces WHERE chain_id = ? AND nonce = ?').get(4663, nonce1)
    assert.ok(row, 'CRITICAL: a real settlement record must never be deleted by releasePaymentNonce')
    assert.strictEqual(row.tx_hash, '0xrealtxhash')
    ok('releasePaymentNonce never deletes a real, already-recorded settlement — only the unsettled placeholder')
  }

  console.log(`\nUNIT PASS (facilitator-nonce-lock) — ${pass} checks`)
}

run()
