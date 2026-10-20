// test/unit/examples-pay.test.js — examples/pay.js must pay a route that actually delivers content.
// /x402/premium only ever returns a 402 challenge, so a client that "replays the receipt" there can never see HTTP 200.
'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '../../../examples/pay.js'), 'utf8')
const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

assert.ok(!/\/x402\/premium/.test(code), 'examples/pay.js must not fetch /x402/premium (challenge-only endpoint)')
assert.ok(/\/x402\/api\/alerts/.test(code), 'default resource is a real paid route')
assert.ok(/paid\.status !== 200/.test(code), 'client must fail loudly if delivery is not HTTP 200')
assert.ok(/settle\.pending/.test(code), 'client must handle the 202 pending response by retrying the same intent')
console.log('  ✓ examples/pay.js targets a delivering route, retries pending, and asserts HTTP 200')
console.log('\nUNIT PASS (examples-pay) — 1 check')
