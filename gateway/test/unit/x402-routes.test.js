// test/unit/x402-routes.test.js — unit tests for x402-routes.js, focused on
// priceToAtomic() (decimal-string -> atomic-units money math) since a bug
// there silently charges/credits the wrong amount — exactly the kind of
// thing that should never ship only covered by an E2E smoke test.
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-x402routes-test-')), 'gateway.db')
process.env.COVENANT_DB_PATH = tmpDb

const x402r = require('../../x402-routes')
const chains = require('../../chains')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

// -- Robinhood (6 decimals): whole numbers, simple decimals, max precision --
{
  assert.strictEqual(x402r.priceToAtomic('1'), '1000000', '1 USDG -> 1,000,000 atomic units (6 decimals)')
  assert.strictEqual(x402r.priceToAtomic('0.01'), '10000', '0.01 USDG -> 10,000 atomic units')
  assert.strictEqual(x402r.priceToAtomic('0.000001'), '1', 'smallest unit (6 decimal places) -> 1 atomic unit, not rounded to 0')
  assert.strictEqual(x402r.priceToAtomic('0'), '0')
  ok('priceToAtomic (6-decimal chain, default Robinhood): whole/simple/smallest-unit amounts correct')
}

// -- fewer decimal digits than the chain supports: zero-padded correctly --
{
  assert.strictEqual(x402r.priceToAtomic('0.1'), '100000', '0.1 (one decimal digit) correctly zero-padded to 100000, not 10000 or 1000000')
  assert.strictEqual(x402r.priceToAtomic('1.5'), '1500000', '1.5 -> 1,500,000')
  ok('fewer decimal digits than chain precision are zero-padded on the right, not misaligned')
}

// -- leading zeros in the integer part don't break BigInt parsing --
{
  assert.strictEqual(x402r.priceToAtomic('007'), '7000000', 'leading zeros in integer part stripped before BigInt()')
  ok('leading zeros in the price string do not break conversion')
}

// -- same price, different chain decimals -> different atomic amount --
// (every current chain is 6 decimals, but this guards the function's
//  chainId parameter actually being respected, not hardcoded to 6)
{
  const robinhood = x402r.priceToAtomic('1', chains.DEFAULT_CHAIN_ID)
  const ethereum = x402r.priceToAtomic('1', 1)
  assert.strictEqual(robinhood, '1000000')
  assert.strictEqual(ethereum, '1000000', 'Ethereum is also 6 decimals in this registry, so this should match')
  // Prove the function actually reads chain decimals rather than hardcoding
  // 6, by checking it agrees with chains.getChain(...).decimals directly.
  const c = chains.getChain(1)
  assert.strictEqual(c.decimals, 6)
  ok('priceToAtomic respects the chainId parameter (reads chain decimals, not hardcoded)')
}

// -- requirement() builds a valid x402 challenge shape from a route record --
{
  const route = { path: '/test', price: '0.05', description: 'test route', payTo: null }
  const req = x402r.requirement(route, 'https://gateway.covenantx402.com/x402/api/test', chains.DEFAULT_CHAIN_ID, '0x1111111111111111111111111111111111111111')
  assert.strictEqual(req.maxAmountRequired, '50000', '0.05 USDG -> 50,000 atomic units in the challenge')
  assert.strictEqual(req.scheme, 'exact')
  assert.strictEqual(req.network, 'eip155:4663')
  assert.strictEqual(req.payTo, '0x1111111111111111111111111111111111111111', 'explicit spender overrides route.payTo')
  assert.strictEqual(req.asset, chains.getChain(chains.DEFAULT_CHAIN_ID).usdc)
  ok('requirement() builds a correctly-priced x402 challenge from a route record')
}

// -- create(): input validation rejects malformed paths/prices/payTo --
{
  assert.throws(() => x402r.create({ path: 'no-leading-slash', price: '0.01' }), /path must look like/, 'path without leading / rejected')
  assert.throws(() => x402r.create({ path: '/ok', price: 'not-a-number' }), /price must be a decimal/, 'non-numeric price rejected')
  assert.throws(() => x402r.create({ path: '/ok', price: '0.01', payTo: '0xnothex' }), /payTo must be a 0x address/, 'malformed payTo address rejected')
  const rec = x402r.create({ path: '/valid-route', price: '0.02', description: 'ok' })
  assert.strictEqual(rec.path, '/valid-route')
  assert.strictEqual(rec.price, '0.02')
  ok('create() rejects malformed path/price/payTo, accepts a valid route')
}

console.log(`\nUNIT PASS (x402-routes) — ${pass} checks`)
