// ratelimit.js — sliding-window rate limiter, SQLite-backed for persistence
// across restarts (in-memory Map stays the read path; every mutation is
// write-through to `ratelimit_buckets` so a routine restart/deploy doesn't
// reset every window to zero — that used to include the 5-keys/hour guard
// on the open POST /keys endpoint, which is exactly the easiest moment to
// mass-mint keys). Bucket state is small (an array of epoch-ms timestamps
// bounded by `limit`), so this stays cheap even at 300 req/min buckets.
const db = require('./db')

const stmts = {
  upsert: db.prepare('INSERT INTO ratelimit_buckets (bucket, hits) VALUES (?,?) ON CONFLICT(bucket) DO UPDATE SET hits = excluded.hits'),
  del: db.prepare('DELETE FROM ratelimit_buckets WHERE bucket = ?'),
  all: db.prepare('SELECT bucket, hits FROM ratelimit_buckets'),
}

const buckets = new Map() // bucket -> number[] (timestamps), in-memory read cache

const MAX_BUCKETS = 10000

// Load persisted state once at boot. Windows are all <= 1h in this codebase,
// so anything already stale gets swept lazily on first check() anyway —
// no need to filter here.
for (const row of stmts.all.all()) {
  try {
    const arr = JSON.parse(row.hits)
    if (Array.isArray(arr)) buckets.set(row.bucket, arr)
  } catch { /* corrupt row, skip */ }
}

/**
 * Check and consume one slot. Returns { allowed, remaining, retryAfterSec }.
 * @param {string} bucket   unique key (e.g. `key:<id>` or `ip:<addr>`)
 * @param {number} limit    max events per window
 * @param {number} windowMs window length
 */
function check(bucket, limit, windowMs) {
  const now = Date.now()
  let arr = buckets.get(bucket)
  if (!arr) {
    if (buckets.size > MAX_BUCKETS) {
      // crude sweep to keep memory (and the DB table) bounded
      for (const [k, v] of buckets) {
        if (!v.length || now - v[v.length - 1] > windowMs) { buckets.delete(k); stmts.del.run(k) }
        if (buckets.size <= MAX_BUCKETS * 0.8) break
      }
    }
    arr = []
    buckets.set(bucket, arr)
  }
  // drop expired
  const cutoff = now - windowMs
  while (arr.length && arr[0] <= cutoff) arr.shift()

  if (arr.length >= limit) {
    const retryAfterSec = Math.ceil((arr[0] + windowMs - now) / 1000)
    return { allowed: false, remaining: 0, retryAfterSec }
  }
  arr.push(now)
  stmts.upsert.run(bucket, JSON.stringify(arr))
  return { allowed: true, remaining: limit - arr.length, retryAfterSec: 0 }
}

function stats() {
  return { trackedBuckets: buckets.size }
}

module.exports = { check, stats }
