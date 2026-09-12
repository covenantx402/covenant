// reputation.js — agent reputation scores derived from settled TRIBUTE payments.
// A session/settlement history is an on-chain-grounded trust signal: an agent
// that has paid for resources repeatedly is accountable (has skin in the game).
// This module scores agents locally from the facilitator's settlement log;
// every claim is anchored to a verifiable tx hash, not a self-reported number.
// SQLite-backed: leaderboard queries are indexed, not a full in-memory scan
// re-derived from a JSON blob on every request.
const db = require('./db')

const stmts = {
  get: db.prepare('SELECT * FROM reputation WHERE address = ?'),
  insert: db.prepare('INSERT INTO reputation (address, first_seen, last_seen, settled_count, total_usdg, resources, txs) VALUES (?,?,?,0,0,\'{}\',\'[]\')'),
  update: db.prepare('UPDATE reputation SET last_seen=?, settled_count=?, total_usdg=?, resources=?, txs=? WHERE address=?'),
  top: db.prepare('SELECT address FROM reputation ORDER BY settled_count DESC, total_usdg DESC LIMIT ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM reputation'),
  totalSettled: db.prepare('SELECT COALESCE(SUM(settled_count), 0) AS n FROM reputation'),
}

function record(payer, { valueFormatted, resource, txHash } = {}) {
  if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer)) return
  payer = payer.toLowerCase()
  let a = stmts.get.get(payer)
  const now = Date.now()
  if (!a) {
    stmts.insert.run(payer, now, now)
    a = stmts.get.get(payer)
  }
  const resources = JSON.parse(a.resources || '{}')
  const txs = JSON.parse(a.txs || '[]')
  const settledCount = a.settled_count + 1
  const totalUsdg = a.total_usdg + Number(valueFormatted || 0)
  if (resource) resources[resource] = (resources[resource] || 0) + 1
  if (txHash) {
    txs.unshift(txHash)
    if (txs.length > 50) txs.length = 50
  }
  stmts.update.run(now, settledCount, totalUsdg, JSON.stringify(resources), JSON.stringify(txs), payer)
}

/**
 * Score model (0-100), deliberately simple and explainable:
 *   40 pts  settled payments count (log scale: 1 → ~13, 4 → ~26, 16+ → 40)
 *   25 pts  cumulative USDG paid (log scale, capped)
 *   15 pts  longevity (days since firstSeen, capped at 30 days)
 *   20 pts  recency (active in last 7d = full, decays to 0 at 30d)
 */
function score(address) {
  const a = stmts.get.get(String(address || '').toLowerCase())
  if (!a) return { address, score: 0, tier: 'unknown', settledCount: 0, totalUsdg: 0, firstSeen: null }
  const pay = Math.min(40, Math.log2(a.settled_count + 1) * 10)
  const volume = Math.min(25, Math.log10(a.total_usdg + 1) * 10)
  const days = (Date.now() - a.first_seen) / 86400000
  const longevity = Math.min(15, days * 0.5)
  const daysSince = (Date.now() - a.last_seen) / 86400000
  const recency = Math.max(0, 20 - daysSince * (20 / 30))
  const total = Math.round(pay + volume + longevity + recency)
  const tier = total >= 75 ? 'trusted' : total >= 40 ? 'established' : total > 0 ? 'new' : 'unknown'
  const txs = JSON.parse(a.txs || '[]')
  return {
    address,
    score: total,
    tier,
    settledCount: a.settled_count,
    totalUsdg: Math.round(a.total_usdg * 1e6) / 1e6,
    firstSeen: a.first_seen,
    lastSeen: a.last_seen,
    resources: JSON.parse(a.resources || '{}'),
    // verifiable anchors: any third party can check these tx hashes on-chain
    txHashes: txs.slice(0, 10),
  }
}

function leaderboard(limit = 10) {
  return stmts.top.all(limit).map(r => score(r.address))
}

function stats() {
  return { knownAgents: stmts.count.get().n, totalSettlements: stmts.totalSettled.get().n }
}

module.exports = { record, score, leaderboard, stats }
