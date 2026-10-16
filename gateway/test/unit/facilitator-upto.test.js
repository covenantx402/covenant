// test/unit/facilitator-upto.test.js — unit tests for the "upto" scheme's
// actualValue parameter in facilitator.settle() (settle less than the
// signed ceiling — rejected if actualValue exceeds it, accepted up to it).
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-upto-test-')), 'gateway.db')
process.env.COVENANT_DB_PATH = tmpDb
process.env.COVENANT_SETTLE_KEY = '0x' + '11'.repeat(32)

const facilitator = require('../../facilitator')
const { ethers } = require('ethers')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

function run() {
  return (async () => {
    const ceiling = ethers.parseUnits('0.05', 6) // the signed ceiling (what the buyer authorized)
    const intent = {
      from: '0x' + '22'.repeat(20),
      to: '0x' + '33'.repeat(20),
      value: ceiling.toString(),
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 300),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
      resource: 'test',
    }

    // -- actualValue > ceiling: rejected outright, no RPC call needed --
    const tooMuch = (ceiling + 1n).toString()
    const r1 = await facilitator.settle(intent, '0xdeadbeef', null, 4663, tooMuch)
    assert.strictEqual(r1.success, false)
    assert.ok(/exceeds the signed ceiling/.test(r1.errorReason), `expected a ceiling-exceeded reason, got: ${r1.errorReason}`)
    ok('actualValue greater than the signed ceiling is rejected before touching the chain')

    // -- actualValue <= 0: rejected outright --
    const r2 = await facilitator.settle(intent, '0xdeadbeef', null, 4663, '0')
    assert.strictEqual(r2.success, false)
    assert.ok(/actualValue must be > 0/.test(r2.errorReason), `expected a must-be-positive reason, got: ${r2.errorReason}`)
    ok('actualValue of 0 is rejected — a $0 settlement makes no sense for "upto"')

    // -- actualValue within the ceiling: passes the ceiling check, proceeds
    //    to the NEXT check (signature mismatch, since '0xdeadbeef' isn't a
    //    real signature) — proving the ceiling gate itself let it through --
    const half = (ceiling / 2n).toString()
    const r3 = await facilitator.settle(intent, '0xdeadbeef', null, 4663, half)
    assert.strictEqual(r3.success, false) // still fails, but NOT for a ceiling reason
    assert.ok(!/exceeds the signed ceiling/.test(r3.errorReason) && !/actualValue must be > 0/.test(r3.errorReason), `expected it to clear the actualValue gate and fail elsewhere, got: ${r3.errorReason}`)
    ok('actualValue within the signed ceiling clears the upto gate and proceeds to signature verification')

    // -- actualValue omitted (null, default): behaves exactly like today's
    //    "exact" scheme — unchanged default behavior, no upto semantics
    //    unless a caller explicitly opts in. --
    const r4 = await facilitator.settle(intent, '0xdeadbeef', null, 4663)
    assert.strictEqual(r4.success, false)
    assert.ok(!/exceeds the signed ceiling/.test(r4.errorReason) && !/actualValue must be > 0/.test(r4.errorReason), `omitting actualValue must behave like "exact" (settle the full signed value), got: ${r4.errorReason}`)
    ok('omitting actualValue preserves the unchanged "exact" scheme default behavior')

    console.log(`\nUNIT PASS (facilitator-upto) — ${pass} checks`)
  })()
}

run().catch(e => { console.error(e); process.exit(1) })
