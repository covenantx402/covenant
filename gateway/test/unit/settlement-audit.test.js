// test/unit/settlement-audit.test.js — the public audit export must classify
// self-payments as self-tests on ANY facilitator address, and must never count
// them as external usage. This is the number outsiders will check.
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.COVENANT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-audit-export-')), 'gateway.db')
process.env.COVENANT_SETTLE_KEY = '0x' + '11'.repeat(32)
process.env.COVENANT_RPC_UPSTREAM = 'http://127.0.0.1:1' // never called: classification is pure ledger math

const facilitator = require('../../facilitator')
const { ethers } = require('ethers')

const CUR = new ethers.Wallet(process.env.COVENANT_SETTLE_KEY).address
const OLD = '0x' + 'aa'.repeat(20)
const BUYER = '0x' + 'bb'.repeat(20)
const OTHER = '0x' + 'cc'.repeat(20)

const insert = (n, payer, to) =>
  facilitator._test.stmts.settleInsert.run(4663, '0x' + String(n).padStart(64, '0'), n, payer, to, '10000', '0.01', 'https://x/x402/api/news', '1', null, null)

insert(1, BUYER, CUR)   // external
insert(2, BUYER, CUR)   // external
insert(3, CUR, CUR)     // self-test, current facilitator
insert(4, OLD, OLD)     // self-test, earlier facilitator address
insert(5, OLD, OLD)     // self-test, earlier facilitator address
insert(6, BUYER, OTHER) // paid to some other address

const a = facilitator.settlementAudit()
const t = a.totals
assert.strictEqual(t.count, 6)
assert.strictEqual(t.externalPayer.count, 2)
assert.strictEqual(t.selfTest.count, 3)
assert.strictEqual(t.selfTest.current.count, 1)
assert.strictEqual(t.selfTest.legacy.count, 2)
assert.strictEqual(t.otherFacilitator.count, 1)
assert.strictEqual(t.externalPayer.count + t.selfTest.count + t.otherFacilitator.count, t.count, 'categories must add up to the total')
assert.ok(a.rows.every(r => r.category), 'every row is categorised')
console.log('  ✓ self-payments (any facilitator address) are self-tests, never external; categories sum to the total')
console.log('\nUNIT PASS (settlement-audit) — 1 check')
