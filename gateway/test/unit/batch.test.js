// test/unit/batch.test.js — unit tests for batch.js (x402 "batch-
// settlement" channel/voucher mechanics). Vouchers are verified entirely
// off-chain (pure signature + monotonic check, no RPC), which is the
// whole economic point of this scheme — these tests confirm that holds.
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-batch-test-')), 'gateway.db')
process.env.COVENANT_DB_PATH = tmpDb

const batch = require('../../batch')
const { ethers } = require('ethers')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

const wallet = new ethers.Wallet('0x' + '44'.repeat(32))
const payTo = '0x' + '55'.repeat(20)

function signVoucher(ch, cumulativeValue) {
  const voucher = { channelId: ch.channelId, payer: ch.payer, payTo: ch.payTo, cumulativeValue: String(cumulativeValue), validBefore: String(ch.validBefore) }
  return wallet.signTypedData(batch.domainFor(ch.chainId), batch.VOUCHER_TYPES, voucher)
}

function run() {
  return (async () => {
    // -- open: validates addresses, returns a channel the buyer can sign against --
    {
      assert.throws(() => batch.openChannel({ payer: 'not-an-address', payTo, chainId: 4663 }), /payer must be/)
      assert.throws(() => batch.openChannel({ payer: wallet.address, payTo: 'nope', chainId: 4663 }), /payTo must be/)
      const ch = batch.openChannel({ payer: wallet.address, payTo, chainId: 4663 })
      assert.ok(/^0x[0-9a-f]{64}$/.test(ch.channelId), 'channelId is a proper bytes32')
      assert.strictEqual(ch.payer, wallet.address.toLowerCase())
      ok('openChannel validates addresses and returns a usable channel record')
    }

    // -- verifyVoucher: happy path, monotonic increase, signature binding --
    {
      const ch = batch.openChannel({ payer: wallet.address, payTo, chainId: 4663 })
      const sig1 = await signVoucher(ch, 10000)
      const v1 = batch.verifyVoucher({ ethers, channelId: ch.channelId, cumulativeValue: '10000', signature: sig1 })
      assert.strictEqual(v1.ok, true)
      assert.strictEqual(v1.vouchersVerified, 1)
      ok('first voucher verifies, no RPC call needed (pure signature + DB check)')

      const sig2 = await signVoucher(ch, 25000)
      const v2 = batch.verifyVoucher({ ethers, channelId: ch.channelId, cumulativeValue: '25000', signature: sig2 })
      assert.strictEqual(v2.ok, true)
      assert.strictEqual(v2.vouchersVerified, 2)
      ok('second (higher) voucher verifies, high-water mark advances')

      // replay the FIRST (lower) voucher — must be rejected
      const replay = batch.verifyVoucher({ ethers, channelId: ch.channelId, cumulativeValue: '10000', signature: sig1 })
      assert.strictEqual(replay.ok, false)
      assert.ok(/must exceed the channel's current high-water mark/.test(replay.reason))
      ok('a lower cumulativeValue than the current high-water mark is rejected — vouchers can only raise the total')

      // wrong signer (different wallet) signs for this channel's address — signature mismatch
      const otherWallet = ethers.Wallet.createRandom()
      const voucher3 = { channelId: ch.channelId, payer: ch.payer, payTo: ch.payTo, cumulativeValue: '30000', validBefore: String(ch.validBefore) }
      const badSig = await otherWallet.signTypedData(batch.domainFor(4663), batch.VOUCHER_TYPES, voucher3)
      const v3 = batch.verifyVoucher({ ethers, channelId: ch.channelId, cumulativeValue: '30000', signature: badSig })
      assert.strictEqual(v3.ok, false)
      assert.ok(/does not match channel payer/.test(v3.reason))
      ok('a voucher signed by the wrong wallet is rejected (signature does not match channel payer)')
    }

    // -- unknown channel / closed channel --
    {
      const unknown = batch.verifyVoucher({ ethers, channelId: '0x' + '99'.repeat(32), cumulativeValue: '1', signature: '0xdead' })
      assert.strictEqual(unknown.ok, false)
      assert.ok(/unknown channel/.test(unknown.reason))
      ok('verifying a voucher against an unknown channel is rejected')
    }

    // -- netClaimable: correct net math across multiple claims --
    {
      const ch = batch.openChannel({ payer: wallet.address, payTo, chainId: 4663 })
      const sig = await signVoucher(ch, 50000)
      batch.verifyVoucher({ ethers, channelId: ch.channelId, cumulativeValue: '50000', signature: sig })

      const nc1 = batch.netClaimable(ch.channelId)
      assert.strictEqual(nc1.ok, true)
      assert.strictEqual(nc1.netValue, '50000', 'first claim: net = full cumulative (nothing claimed yet)')

      // simulate a successful on-chain claim being recorded
      batch.recordClaim(ch.channelId, '0xdeadbeef', false, batch.netClaimable(ch.channelId).totalValue)
      const nc2 = batch.netClaimable(ch.channelId)
      assert.strictEqual(nc2.ok, false, 'after claiming everything, nothing new is claimable')
      assert.ok(/nothing new to claim/.test(nc2.reason))
      ok('netClaimable computes net-new correctly and recordClaim is reflected immediately')

      // a new, higher voucher after the claim -> only the DELTA is claimable
      const sig2 = await signVoucher(ch, 80000)
      batch.verifyVoucher({ ethers, channelId: ch.channelId, cumulativeValue: '80000', signature: sig2 })
      const nc3 = batch.netClaimable(ch.channelId)
      assert.strictEqual(nc3.ok, true)
      assert.strictEqual(nc3.netValue, '30000', 'second claim: net = 80000 - 50000 already claimed = 30000, not the full 80000 (no double-spend of the already-settled portion)')
      ok('a second claim after new vouchers only claims the NET-NEW delta, never re-claims the already-settled portion')
    }

    // -- storage-growth hardening: an expired channel that was opened but
    //    NEVER used (no vouchers verified, nothing claimed) is swept away
    //    on the next openChannel() call. A channel that WAS used (even if
    //    expired) keeps its history — only truly-abandoned channels are
    //    garbage-collected. --
    {
      const abandoned = batch.openChannel({ payer: wallet.address, payTo, chainId: 4663, validForSec: 60 })
      // can't easily fast-forward real time in a unit test, so directly
      // age the row past its validBefore via a raw UPDATE — equivalent to
      // waiting out the 60s window, without actually waiting 60s.
      require('../../db').prepare('UPDATE batch_channels SET valid_before = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 10, abandoned.channelId)
      assert.ok(batch.getChannel(abandoned.channelId), 'abandoned channel still exists before the sweep runs')

      batch.openChannel({ payer: wallet.address, payTo, chainId: 4663 }) // triggers the sweep as a side effect
      assert.strictEqual(batch.getChannel(abandoned.channelId), null, 'an expired, never-used channel must be swept away by the next openChannel() call')
      ok('an expired channel with zero activity is garbage-collected on the next openChannel() call (storage-growth hardening)')

      // a USED channel (even if expired) must survive the sweep — its
      // settlement history is real data, not abandonment.
      const used = batch.openChannel({ payer: wallet.address, payTo, chainId: 4663, validForSec: 60 })
      const sigUsed = await signVoucher(used, 500)
      batch.verifyVoucher({ ethers, channelId: used.channelId, cumulativeValue: '500', signature: sigUsed })
      require('../../db').prepare('UPDATE batch_channels SET valid_before = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 10, used.channelId)
      batch.openChannel({ payer: wallet.address, payTo, chainId: 4663 }) // triggers the sweep again
      assert.ok(batch.getChannel(used.channelId), 'a channel that actually accumulated a voucher must survive the sweep even after expiring')
      ok('an expired channel that WAS used (has real accumulated value) is NOT swept — only zero-activity abandonment is garbage-collected')
    }

    // -- per-channel claim lock. Why:
    //    two concurrent POST /x402/batch/claim requests for the same
    //    channel both read the same net-claimable amount before either
    //    recorded its claim — both would have executed a real on-chain
    //    transferFrom, overcharging the buyer beyond what any single
    //    cumulative voucher total actually authorized. Verified live
    //    over HTTP (5 concurrent requests, exactly 1 proceeded past the
    //    lock) before this fix; this test locks the mechanism itself. --
    {
      const ch = batch.openChannel({ payer: wallet.address, payTo, chainId: 4663 })
      assert.strictEqual(batch.tryLockChannel(ch.channelId), true, 'first lock attempt on an unlocked channel succeeds')
      assert.strictEqual(batch.tryLockChannel(ch.channelId), false, 'a second concurrent lock attempt on the SAME channel while still held must fail — this is the exact condition that let two claims double-spend the same voucher total')
      batch.unlockChannel(ch.channelId)
      assert.strictEqual(batch.tryLockChannel(ch.channelId), true, 'after unlocking, a fresh lock attempt succeeds again')
      batch.unlockChannel(ch.channelId)
      ok('[race-condition regression] tryLockChannel/unlockChannel correctly serializes concurrent claim attempts on the same channel')

      // locks on DIFFERENT channels must never block each other
      const ch2 = batch.openChannel({ payer: wallet.address, payTo, chainId: 4663 })
      assert.strictEqual(batch.tryLockChannel(ch.channelId), true)
      assert.strictEqual(batch.tryLockChannel(ch2.channelId), true, 'locking one channel must never block locking a DIFFERENT channel')
      batch.unlockChannel(ch.channelId)
      batch.unlockChannel(ch2.channelId)
      ok('the claim lock is per-channel, not global — concurrent claims on different channels never contend')
    }

    console.log(`\nUNIT PASS (batch) — ${pass} checks`)
  })()
}

run().catch(e => { console.error(e); process.exit(1) })
