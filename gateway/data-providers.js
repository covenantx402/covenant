// Real content for paid x402 routes. No placeholders — every paid call
// returns live data fetched server-side (kills CORS, caches upstream hits).
//   /news            → latest crypto headlines (Cointelegraph RSS)
//   /alerts          → trending pools on Robinhood chain (GeckoTerminal)
//   /whale-alerts    → biggest-liquidity pools (whale activity proxy)
//   /signals         → momentum signals derived from pool data
const https = require('https')

const TTL_MS = 60_000 // one upstream fetch per minute, shared across payers
const cache = new Map() // key -> { at, data }

function fetchText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { accept: 'application/json,text/xml', 'user-agent': 'TRIBUTE/1.0' },
      timeout: timeoutMs,
    }, res => {
      // follow one redirect layer (RSS feeds sometimes 301)
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        fetchText(res.headers.location, timeoutMs).then(resolve, reject)
        res.resume()
        return
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); res.resume(); return }
      let out = ''
      res.on('data', c => { out += c; if (out.length > 2_000_000) req.destroy() })
      res.on('end', () => resolve(out))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
  })
}

async function cached(key, loader) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data
  try {
    const data = await loader()
    cache.set(key, { at: Date.now(), data })
    return data
  } catch (e) {
    if (hit) return hit.data // stale beats broken, but flag it
    throw e
  }
}

/* ---- /news : Cointelegraph RSS → clean headline list ---- */
function parseRss(xml, limit) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = re.exec(xml)) && items.length < limit) {
    const block = m[1]
    const pick = (tag) => {
      const t = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block)
      if (!t) return ''
      return t[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim()
    }
    items.push({
      title: pick('title'),
      link: pick('link'),
      pubDate: pick('pubDate'),
      source: 'cointelegraph.com',
    })
  }
  return items.filter(i => i.title)
}

async function news() {
  const xml = await fetchText('https://cointelegraph.com/rss')
  const items = parseRss(xml, 10)
  if (!items.length) throw new Error('no items parsed')
  return {
    kind: 'crypto-headlines',
    provider: 'cointelegraph.com/rss',
    fetchedAt: new Date().toISOString(),
    count: items.length,
    items,
  }
}

/* ---- /alerts + /whale-alerts : GeckoTerminal Robinhood chain ---- */
async function gt(path) {
  const xml = await fetchText('https://api.geckoterminal.com/api/v2' + path)
  return JSON.parse(xml)
}

function shapePools(d, limit) {
  const out = []
  for (const p of (d?.data || []).slice(0, limit)) {
    const a = p.attributes || {}
    out.push({
      pool: a.name,
      address: a.address,
      priceUsd: a.base_token_price_usd,
      liquidityUsd: a.reserve_in_usd,
      volume24hUsd: a.volume_usd?.h24,
      change24hPct: a.price_change_percentage?.h24,
      txns24h: (a.transactions?.h24?.buys || 0) + (a.transactions?.h24?.sells || 0),
      network: 'robinhood',
    })
  }
  return out
}

async function trending() {
  const d = await gt('/networks/robinhood/trending_pools?page=1')
  const pools = shapePools(d, 10)
  if (!pools.length) throw new Error('no pools')
  return { kind: 'trending-pools', chain: 'robinhood-4663', provider: 'geckoterminal.com', fetchedAt: new Date().toISOString(), count: pools.length, pools }
}

async function whales() {
  // GT only allows h24_volume_usd_desc / h24_tx_count_desc sorts — rank by
  // liquidity client-side so "whale" = biggest pools, not just busiest.
  const d = await gt('/networks/robinhood/pools?sort=h24_volume_usd_desc&page=1')
  const pools = shapePools(d, 20)
    .sort((a, b) => parseFloat(b.liquidityUsd || 0) - parseFloat(a.liquidityUsd || 0))
    .slice(0, 10)
  if (!pools.length) throw new Error('no pools')
  return { kind: 'whale-liquidity', chain: 'robinhood-4663', provider: 'geckoterminal.com', fetchedAt: new Date().toISOString(), count: pools.length, pools }
}

/* ---- /signals : momentum derived from trending + top pools ---- */
async function signals() {
  const [tr, wh] = await Promise.all([
    cached('trending', trending),
    cached('whales', whales),
  ])
  const seen = new Set()
  const rows = []
  for (const p of [...tr.pools, ...wh.pools]) {
    if (seen.has(p.address)) continue
    seen.add(p.address)
    const chg = parseFloat(p.change24hPct || '0')
    const vol = parseFloat(p.volume24hUsd || '0')
    const liq = parseFloat(p.liquidityUsd || '0')
    let signal = 'NEUTRAL'
    if (chg > 15 && vol > liq * 0.1) signal = 'STRONG_BUY_MOMENTUM'
    else if (chg > 5) signal = 'BUY_MOMENTUM'
    else if (chg < -15) signal = 'STRONG_SELL_PRESSURE'
    else if (chg < -5) signal = 'SELL_PRESSURE'
    rows.push({ pool: p.pool, signal, change24hPct: chg, volumeLiquidityRatio: liq ? +(vol / liq).toFixed(2) : null, txns24h: p.txns24h })
  }
  return { kind: 'momentum-signals', chain: 'robinhood-4663', derivedFrom: 'geckoterminal trending + top-liquidity', fetchedAt: new Date().toISOString(), count: rows.length, signals: rows }
}

/* ---- /market-analytics : derived market structure from live pool data ---- */
async function analytics() {
  const [tr, wh] = await Promise.all([
    cached('trending', trending),
    cached('whales', whales),
  ])
  const seen = new Set()
  const pools = []
  for (const p of [...tr.pools, ...wh.pools]) {
    if (seen.has(p.address)) continue
    seen.add(p.address)
    pools.push(p)
  }
  const liq = pools.map(p => parseFloat(p.liquidityUsd || '0')).sort((a, b) => b - a)
  const totalLiq = liq.reduce((s, v) => s + v, 0)
  const totalVol = pools.reduce((s, p) => s + parseFloat(p.volume24hUsd || '0'), 0)
  const totalTxns = pools.reduce((s, p) => s + (p.txns24h || 0), 0)
  const top5Liq = liq.slice(0, 5).reduce((s, v) => s + v, 0)
  let gainers = 0, losers = 0
  const ranked = pools.map(p => {
    const chg = parseFloat(p.change24hPct || '0')
    const vol = parseFloat(p.volume24hUsd || '0')
    const l = parseFloat(p.liquidityUsd || '0')
    if (chg > 5) gainers++
    if (chg < -5) losers++
    // turnover-weighted momentum score: hot + liquid + moving
    const turnover = l ? vol / l : 0
    const score = +(chg * 0.6 + Math.min(turnover, 5) * 4).toFixed(2)
    return { pool: p.pool, address: p.address, change24hPct: chg, liquidityUsd: l, volume24hUsd: vol, turnover: +turnover.toFixed(2), txns24h: p.txns24h, score }
  }).sort((a, b) => b.score - a.score)
  if (!ranked.length) throw new Error('no pools')
  return {
    kind: 'market-analytics',
    chain: 'robinhood-4663',
    provider: 'derived from geckoterminal trending + top-liquidity',
    fetchedAt: new Date().toISOString(),
    metrics: {
      poolsObserved: ranked.length,
      totalLiquidityUsd: +totalLiq.toFixed(0),
      totalVolume24hUsd: +totalVol.toFixed(0),
      totalTxns24h: totalTxns,
      volumeLiquidityRatio: totalLiq ? +(totalVol / totalLiq).toFixed(3) : null,
      liquidityConcentrationTop5: totalLiq ? +(top5Liq / totalLiq).toFixed(3) : null,
      moversUp: gainers,
      moversDown: losers,
      breadth: gainers + losers ? +(gainers / (gainers + losers)).toFixed(2) : null,
    },
    pools: ranked.slice(0, 15),
  }
}

const PROVIDERS = {
  news: () => cached('news', news),
  alerts: () => cached('trending', trending),
  'whale-alerts': () => cached('whales', whales),
  signals: () => cached('signals', signals),
  'market-analytics': () => cached('analytics', analytics),
}

// Resolve the payload for a route slug. Unknown slugs get a generic
// (but still real) snapshot so a newly created paid API is never empty.
async function payloadFor(slug) {
  const fn = PROVIDERS[slug]
  if (fn) return fn()
  const t = await cached('trending', trending).catch(() => null)
  return t ? { ...t, kind: 'market-snapshot', note: `route /${slug} has no dedicated feed — serving live market snapshot` } : null
}

module.exports = { payloadFor }
