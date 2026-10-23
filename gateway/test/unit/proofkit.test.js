// test/unit/proofkit.test.js — the public proof features must never overstate anything
// and the live-demo payment must be impossible to abuse.
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-proofkit-'))
process.env.COVENANT_DB_PATH = path.join(tmp, 'gateway.db')
process.env.COVENANT_SETTLE_KEY = '0x' + '11'.repeat(32)
process.env.COVENANT_RPC_UPSTREAM = 'http://127.0.0.1:1'
const keyFile = path.join(tmp, 'demo-key'); fs.writeFileSync(keyFile, '0x' + '22'.repeat(32), { mode: 0o600 })
process.env.COVENANT_DEMO_KEY_FILE = keyFile

const { ethers } = require('ethers')
const demoWallet = require('../../demo-wallet')
const facilitator = require('../../facilitator')
const pk = require('../../proofkit')

const DEMO = new ethers.Wallet('0x' + '22'.repeat(32)).address
const CUR = new ethers.Wallet(process.env.COVENANT_SETTLE_KEY).address
const BUYER = '0x' + 'bb'.repeat(20)
let n = 0
const ins = (payer, to, res = 'https://x/x402/api/news') => facilitator._test.stmts.settleInsert.run(4663, '0x' + String(++n).padStart(64, '0'), n, payer, to, '10000', '0.01', res, '1', null, null)

;(async () => {
  // ---- 1. a demo-wallet payment is a self-test, never "external", and the totals still add up
  assert.strictEqual(demoWallet.address(), DEMO.toLowerCase())
  ins(BUYER, CUR)      // real external
  ins(DEMO, CUR)       // demo payment to the facilitator: would LOOK external if we did not special-case it
  ins(CUR, CUR)        // classic self-test
  const a = facilitator.settlementAudit(), t = a.totals
  assert.strictEqual(t.externalPayer.count, 1, 'demo payment must not count as external')
  assert.strictEqual(t.selfTest.demo.count, 1)
  assert.strictEqual(t.selfTest.count, 2)
  assert.strictEqual(t.externalPayer.count + t.selfTest.count + t.otherFacilitator.count, t.count)
  assert.strictEqual(a.rows.find(r => r.payer.toLowerCase() === DEMO.toLowerCase()).category, 'self-test-demo')

  // ---- 2. tx lookup, receipt and badge read the ledger and nothing else
  const audit = () => facilitator.settlementAudit()
  const hit = pk.txView('0x' + '1'.padStart(64, '0'), audit)
  assert.strictEqual(hit.found, true); assert.strictEqual(hit.row.category, 'external-payer'); assert.strictEqual(hit.row.slug, 'news')
  assert.strictEqual(pk.txView('0x' + 'f'.repeat(64), audit).found, false)
  const svg = pk.receiptSvg({ ...hit.row, resource: 'https://x/x402/api/<script>' })
  assert.ok(svg.includes('EXTERNAL PAYER') && !svg.includes('<script>'), 'receipt must escape untrusted text')
  const b = pk.badgeFor('news', audit, () => true)
  assert.ok(b.includes('1 paid'), 'badge counts external payments only: ' + b.slice(0, 200))
  assert.ok(pk.badgeFor('nope', audit, () => false).includes('unknown listing'))
  assert.ok(pk.badgeFor('covenant', audit, () => true).includes('1 on-chain'))

  // ---- 3. uptime: honest about when recording started, never invents a day
  const day = 86400000, now = Date.UTC(2026, 9, 23, 12, 0, 0)
  const ins2 = db => db
  const db = require('../../db')
  const up = db.prepare('INSERT OR REPLACE INTO uptime_samples (t, rpc_ok, rpc_ms) VALUES (?,?,?)')
  const startAt = now - 90 * 60000                       // recording began 90 minutes before "now"
  for (let i = 0; i <= 60; i++) up.run(startAt + i * 60000, i === 30 ? 0 : 1, 120)   // 61 samples, 1 rpc failure, 30 min missing at the end
  const v = pk.uptimeView(30, now)
  assert.strictEqual(v.days.length, 30)
  assert.strictEqual(v.days.filter(d => d.gatewayPct !== null).length, 1, 'only the recorded day has data')
  assert.ok(v.days.slice(0, 29).every(d => d.gatewayPct === null && d.expected === 0), 'days before recording show NO data, not 100%')
  const today = v.days[29]
  assert.ok(today.gatewayPct < 100, 'missing minutes count against availability: ' + today.gatewayPct)
  assert.ok(today.rpcPct < 100 && today.rpcPct > 95, 'one failed probe lowers rpc availability: ' + today.rpcPct)
  assert.strictEqual(v.since, new Date(startAt).toISOString())

  // ---- 4. the live demo cannot be abused
  const calls = []
  const tokenBase = { balanceOf: async () => 1_000_000n, allowance: async () => 0n, approve: async () => ({ hash: '0xapprove', wait: async () => {} }) }
  const mk = (over = {}) => {
    const rl = new Map()
    return {
      wallet: new ethers.Wallet('0x' + '22'.repeat(32)), token: { ...tokenBase, ...(over.token || {}) }, usdg: facilitator.USDG,
      domain: facilitator.DOMAIN, types: facilitator.INTENT_TYPES, now: () => 1_800_000_000,
      limit: (b, l) => { const c = (rl.get(b) || 0) + 1; rl.set(b, c); return c > l ? { allowed: false, retryAfterSec: 60 } : { allowed: true } },
      call: async (method, p, body, headers) => {
        calls.push([method, p, !!headers])
        if (method === 'GET' && !headers) return { status: 402, json: { accepts: [{ maxAmountRequired: over.price || '10000', asset: over.asset || facilitator.USDG, payTo: CUR, resource: 'https://x/x402/api/alerts', extra: { spender: CUR } }] } }
        if (p === '/facilitator/settle') return { status: 200, json: { success: true, transaction: '0x' + 'ee'.repeat(32), payment: 'p' } }
        return { status: 200, json: { payload: { kind: 'alerts', items: [1, 2, 3] } } }
      },
    }
  }
  const fails = async (args, deps, status) => { try { await pk.demoPay(args, deps); assert.fail('should have refused') } catch (e) { assert.strictEqual(e.status, status, `${e.message}`) } }

  const ok = await pk.demoPay({ slug: 'alerts', ip: '1.1.1.1' }, mk())
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.ledgerCategory, 'self-test-demo'); assert.strictEqual(ok.label, 'demo-payment')
  assert.strictEqual(ok.payer, DEMO); assert.strictEqual(ok.content.items, 3)
  assert.deepStrictEqual(ok.steps.map(s => s.name), ['quote', 'approve', 'sign', 'settle', 'redeem'])

  await fails({ slug: 'premium', ip: '1.1.1.1' }, mk(), 400)                                  // route not on the allow-list
  await fails({ slug: 'alerts', ip: '1.1.1.1' }, mk({ price: '500000' }), 502)                 // quote above the 0.02 cap
  await fails({ slug: 'alerts', ip: '1.1.1.1' }, mk({ asset: '0x' + '99'.repeat(20) }), 502)   // not USDG
  await fails({ slug: 'alerts', ip: '1.1.1.1' }, mk({ token: { balanceOf: async () => 10_000n } }), 503)   // wallet nearly empty: pauses itself
  const shared = mk(); let last
  for (let i = 0; i < 3; i++) await pk.demoPay({ slug: 'news', ip: '9.9.9.9' }, shared)
  await fails({ slug: 'news', ip: '9.9.9.9' }, shared, 429)                                   // 4th click from one visitor in an hour
  await pk.demoPay({ slug: 'news', ip: '8.8.8.8' }, shared)                                    // a different visitor still works
  // concurrent clicks: only one settles at a time
  const slow = mk(); const origCall = slow.call; slow.call = async (...a) => { await new Promise(r => setTimeout(r, 30)); return origCall(...a) }
  const results = await Promise.allSettled([pk.demoPay({ slug: 'alerts', ip: '5.5.5.1' }, slow), pk.demoPay({ slug: 'alerts', ip: '5.5.5.2' }, slow)])
  assert.strictEqual(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.strictEqual(results.find(r => r.status === 'rejected').reason.status, 409)

  // ---- 5. demo is OFF without a key file (status says so, pay refuses)
  demoWallet._reset(null)
  assert.deepStrictEqual(await pk.demoStatus(mk()), { enabled: false })
  await fails({ slug: 'alerts', ip: '3.3.3.3' }, mk(), 404)
  console.log('proofkit: all checks passed')
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
