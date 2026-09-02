// ratelimit.js — sliding-window rate limiter (in-memory, per bucket).
// Buckets are keyed by whatever the caller wants: agent key id, IP, or route.
// Designed for a single gateway node; swap the store for Redis if you cluster.
const buckets = new Map() // bucket -> number[] (timestamps)

const MAX_BUCKETS = 10000

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
      // crude sweep to keep memory bounded
      for (const [k, v] of buckets) {
        if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k)
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
  return { allowed: true, remaining: limit - arr.length, retryAfterSec: 0 }
}

function stats() {
  return { trackedBuckets: buckets.size }
}

module.exports = { check, stats }
