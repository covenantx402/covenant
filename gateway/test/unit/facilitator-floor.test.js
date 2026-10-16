// test/unit/facilitator-floor.test.js — unit tests for the settlement-cost
// floor gate in facilitator.js (settle() rejects underpriced requests on
// expensive chains before spending any RPC call or gas).
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-floor-test-')), 'gateway.db')
process.env.COVENANT_DB_PATH = tmpDb
// Dummy settlement key + RPC URL — the floor check must reject BEFORE
// either is actually used, so a bogus/unreachable RPC URL here is fine
// and is itself part of what this test proves.
process.env.COVENANT_SETTLE_KEY = '0x' + '11'.repeat(32)
process.env.COVENANT_RPC_ETHEREUM = 'http://127.0.0.1:1' // deliberately unreachable

const facilitator = require('../../facilitator')
const { ethers } = require('ethers')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

function run() {
  return (async () => {
    const value = ethers.parseUnits('0.01', 6) // 0.01 USDC — below Ethereum's $0.05 floor
    const intent = {
      from: '0x' + '22'.repeat(20),
      to: '0x' + '33'.repeat(20),
      value: value.toString(),
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 300),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
      resource: 'test',
    }

    // -- underpriced on Ethereum: rejected, and FAST (no RPC round-trip,
    //    despite COVENANT_RPC_ETHEREUM pointing at an unreachable address) --
    const t0 = Date.now()
    const r1 = await facilitator.settle(intent, '0xdeadbeef', null, 1)
    const elapsedMs = Date.now() - t0
    assert.strictEqual(r1.success, false)
    assert.ok(/settlement-cost floor/.test(r1.errorReason), `expected a floor-rejection reason, got: ${r1.errorReason}`)
    assert.ok(elapsedMs < 2000, `floor rejection should be near-instant (no RPC call) — took ${elapsedMs}ms against an unreachable RPC URL, which would have timed out much slower if it had tried to connect`)
    ok('underpriced intent on Ethereum is rejected by the floor check, fast, before any RPC call')

    // -- same price clears on Robinhood (floor is $0 there) and proceeds
    //    far enough to hit the NEXT check (signature mismatch, since we
    //    signed nothing real) — proving the floor gate itself isn't what's
    //    blocking Robinhood, only the chain-specific floor value is doing
    //    the discriminating. --
    const r2 = await facilitator.settle(intent, '0xdeadbeef', null, 4663)
    assert.strictEqual(r2.success, false) // still fails, but for a DIFFERENT reason
    assert.ok(!/settlement-cost floor/.test(r2.errorReason), `Robinhood ($0 floor) should not be floor-rejected, got: ${r2.errorReason}`)
    ok('same price on Robinhood (0-floor chain) is NOT floor-rejected — the gate is per-chain, not global')

    console.log(`\nUNIT PASS (facilitator-floor) — ${pass} checks`)
  })()
}

run().catch(e => { console.error(e); process.exit(1) })
