// test/unit/ratelimit.test.js — unit tests for ratelimit.js (sliding-window
// limiter, SQLite-backed). Uses an isolated temp DB per run so it never
// touches real gateway data and can run standalone or alongside other
// test files without state bleeding between them.
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-ratelimit-test-')), 'gateway.db')
process.env.COVENANT_DB_PATH = tmpDb

const ratelimit = require('../../ratelimit')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

// -- basic allow/deny at the limit boundary --
{
  const bucket = 'test:basic:' + Date.now()
  for (let i = 0; i < 3; i++) {
    const r = ratelimit.check(bucket, 3, 60000)
    assert.strictEqual(r.allowed, true, `request ${i + 1}/3 should be allowed`)
  }
  const blocked = ratelimit.check(bucket, 3, 60000)
  assert.strictEqual(blocked.allowed, false, '4th request over a limit of 3 must be blocked')
  assert.strictEqual(blocked.remaining, 0)
  assert.ok(blocked.retryAfterSec > 0, 'blocked response includes a positive retryAfterSec')
  ok('allows exactly `limit` requests, blocks the next one, reports retryAfterSec')
}

// -- remaining count decrements correctly --
{
  const bucket = 'test:remaining:' + Date.now()
  const r1 = ratelimit.check(bucket, 5, 60000)
  assert.strictEqual(r1.remaining, 4)
  const r2 = ratelimit.check(bucket, 5, 60000)
  assert.strictEqual(r2.remaining, 3)
  ok('remaining count decrements by 1 per allowed request')
}

// -- separate buckets don't interfere with each other --
{
  const bucketA = 'test:isolation:a:' + Date.now()
  const bucketB = 'test:isolation:b:' + Date.now()
  for (let i = 0; i < 5; i++) ratelimit.check(bucketA, 5, 60000)
  const blockedA = ratelimit.check(bucketA, 5, 60000)
  assert.strictEqual(blockedA.allowed, false, 'bucket A is now exhausted')
  const freshB = ratelimit.check(bucketB, 5, 60000)
  assert.strictEqual(freshB.allowed, true, 'bucket B is completely unaffected by bucket A being exhausted')
  ok('rate limit buckets are isolated from each other (no cross-key leakage)')
}

// -- sliding window: old hits expire, freeing up slots --
{
  const bucket = 'test:expiry:' + Date.now()
  const windowMs = 50 // short window so the test doesn't need to sleep long
  ratelimit.check(bucket, 1, windowMs)
  const blocked = ratelimit.check(bucket, 1, windowMs)
  assert.strictEqual(blocked.allowed, false, 'limit of 1 is exhausted immediately')
  return new Promise(resolve => {
    setTimeout(() => {
      const afterExpiry = ratelimit.check(bucket, 1, windowMs)
      assert.strictEqual(afterExpiry.allowed, true, 'after the window elapses, the slot frees up again')
      ok('sliding window expires old hits, freeing capacity after windowMs')
      console.log(`\nUNIT PASS (ratelimit) — ${pass} checks`)
      resolve()
    }, windowMs + 20)
  })
}
