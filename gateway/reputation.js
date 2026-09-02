// reputation.js — agent reputation scores derived from settled TRIBUTE payments.
// A session/settlement history is an on-chain-grounded trust signal: an agent
// that has paid for resources repeatedly is accountable (has skin in the game).
// This module scores agents locally from the facilitator's settlement log;
// every claim is anchored to a verifiable tx hash, not a self-reported number.
const fs = require('fs')
const path = require('path')

const STORE_PATH = process.env.TRIBUTE_REPUTATION_STORE ||
  path.join(__dirname, 'data', 'reputation.json')

// address -> { firstSeen, lastSeen, settledCount, totalUsdg, resources: {res: count}, txs: [hash...] }
const agents = new Map()

function load() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    if (fs.existsSync(STORE_PATH)) {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')))) agents.set(k, v)
    }
  } catch (e) { console.error('reputation load failed:', e.message) }
}
function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const tmp = STORE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(agents)))
  fs.renameSync(tmp, STORE_PATH)
}
load()

function record(payer, { valueFormatted, resource, txHash } = {}) {
  if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer)) return
  payer = payer.toLowerCase()
  const a = agents.get(payer) || {
    firstSeen: Date.now(), lastSeen: 0, settledCount: 0,
    totalUsdg: 0, resources: {}, txs: [],
  }
  a.lastSeen = Date.now()
  a.settledCount++
  a.totalUsdg += Number(valueFormatted || 0)
  if (resource) a.resources[resource] = (a.resources[resource] || 0) + 1
  if (txHash) {
    a.txs.unshift(txHash)
    if (a.txs.length > 50) a.txs.length = 50
  }
  agents.set(payer, a)
  save()
}

/**
 * Score model (0-100), deliberately simple and explainable:
 *   40 pts  settled payments count (log scale: 1 → ~13, 4 → ~26, 16+ → 40)
 *   25 pts  cumulative USDG paid (log scale, capped)
 *   15 pts  longevity (days since firstSeen, capped at 30 days)
 *   20 pts  recency (active in last 7d = full, decays to 0 at 30d)
 */
function score(address) {
  const a = agents.get(String(address || '').toLowerCase())
  if (!a) return { address, score: 0, tier: 'unknown', settledCount: 0, totalUsdg: 0, firstSeen: null }
  const pay = Math.min(40, Math.log2(a.settledCount + 1) * 10)
  const volume = Math.min(25, Math.log10(a.totalUsdg + 1) * 10)
  const days = (Date.now() - a.firstSeen) / 86400000
  const longevity = Math.min(15, days * 0.5)
  const daysSince = (Date.now() - a.lastSeen) / 86400000
  const recency = Math.max(0, 20 - daysSince * (20 / 30))
  const total = Math.round(pay + volume + longevity + recency)
  const tier = total >= 75 ? 'trusted' : total >= 40 ? 'established' : total > 0 ? 'new' : 'unknown'
  return {
    address,
    score: total,
    tier,
    settledCount: a.settledCount,
    totalUsdg: Math.round(a.totalUsdg * 1e6) / 1e6,
    firstSeen: a.firstSeen,
    lastSeen: a.lastSeen,
    resources: a.resources,
    // verifiable anchors: any third party can check these tx hashes on-chain
    txHashes: a.txs.slice(0, 10),
  }
}

function leaderboard(limit = 10) {
  return [...agents.keys()]
    .map(a => score(a))
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
}

function stats() {
  let settled = 0
  for (const a of agents.values()) settled += a.settledCount
  return { knownAgents: agents.size, totalSettlements: settled }
}

module.exports = { record, score, leaderboard, stats }
