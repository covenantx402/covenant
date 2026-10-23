// proofkit.js — public, read-mostly "proof" features for the COVENANT web app.
//
//   GET  /x402/tx/<hash>            is this transaction a settlement in the ledger?
//   GET  /x402/receipt/<hash>.svg   shareable receipt card for a ledger settlement
//   GET  /x402/badge/<slug>.svg     "settled via COVENANT" badge for a route / listing
//   GET  /x402/uptime?days=30       recorded availability, per day, with an honest start date
//   GET  /x402/demo/status          is the live-payment demo available, and how much is left
//   POST /x402/demo/pay             pay a real 0.01 USDG call from the demo wallet (rate limited)
//   POST /x402/marketplace/probe    test a seller endpoint before listing it (SSRF-safe, rate limited)
//
// Nothing here fabricates data: every number comes from the settlement ledger, the chain, or
// the samples this process recorded itself.
'use strict'
const { ethers } = require('ethers')
const db = require('./db')
const demoWallet = require('./demo-wallet')

const HASH = /^0x[0-9a-fA-F]{64}$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const DEMO_ROUTES = ['alerts', 'news', 'href']    // 0.01 USDG each; anything else is refused
const DEMO_MAX_ATOMIC = 20000n                       // hard cap: 0.02 USDG per click
const DEMO_PER_IP = { limit: 3, windowMs: 3600000 }  // 3 live payments / hour / visitor
const DEMO_GLOBAL = { limit: 24, windowMs: 86400000 } // 24 live payments / day in total
const DEMO_MIN_USDG = 0.05                           // below this the demo pauses itself
const APPROVE_ALLOWANCE = 2_000_000n                 // 2 USDG, re-approved only when it runs low

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const short = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '')

// ---------------------------------------------------------------- uptime recorder
db.exec(`CREATE TABLE IF NOT EXISTS uptime_samples (
  t INTEGER PRIMARY KEY, rpc_ok INTEGER NOT NULL, rpc_ms INTEGER
)`)
const upIns = db.prepare('INSERT OR REPLACE INTO uptime_samples (t, rpc_ok, rpc_ms) VALUES (?,?,?)')
const upPrune = db.prepare('DELETE FROM uptime_samples WHERE t < ?')
const upFirst = db.prepare('SELECT MIN(t) AS t FROM uptime_samples')
const upDays = db.prepare(`SELECT strftime('%Y-%m-%d', t/1000, 'unixepoch') AS d, COUNT(*) AS n, SUM(rpc_ok) AS ok,
  AVG(CASE WHEN rpc_ok = 1 THEN rpc_ms END) AS ms FROM uptime_samples WHERE t >= ? GROUP BY d ORDER BY d`)
const SAMPLE_EVERY_MS = 60000

async function recordSample(probe) {
  const t0 = Date.now(); let ok = 0, ms = null
  try { await probe(); ok = 1; ms = Date.now() - t0 } catch { /* a failed probe is a recorded failure, not a skipped sample */ }
  upIns.run(Math.floor(t0 / SAMPLE_EVERY_MS) * SAMPLE_EVERY_MS, ok, ms)   // one slot per minute: restarts cannot double count
  upPrune.run(Date.now() - 60 * 86400000)
}
function startUptimeRecorder(probe) {
  recordSample(probe).catch(() => {})
  return setInterval(() => recordSample(probe).catch(() => {}), SAMPLE_EVERY_MS).unref()
}

function uptimeView(daysIn, now = Date.now()) {
  const days = Math.max(1, Math.min(60, Number(daysIn) || 30))
  const first = upFirst.get().t
  const startDay = Date.UTC(...(() => { const d = new Date(now - (days - 1) * 86400000); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()] })())
  const byDay = new Map(upDays.all(startDay).map(r => [r.d, r]))
  const out = []
  let n = 0, ok = 0, expectedAll = 0
  for (let i = 0; i < days; i++) {
    const ds = startDay + i * 86400000, de = ds + 86400000
    const date = new Date(ds).toISOString().slice(0, 10)
    const from = first == null ? Infinity : Math.max(ds, first), to = Math.min(de, now)
    const expected = from >= to ? 0 : Math.floor((to - from) / SAMPLE_EVERY_MS) + 1
    const r = byDay.get(date)
    if (!expected || !r) { out.push({ date, expected, samples: r ? r.n : 0, gatewayPct: null, rpcPct: null, avgRpcMs: null }); continue }
    const samples = Math.min(r.n, expected)
    out.push({
      date, expected, samples,
      gatewayPct: Math.round((samples / expected) * 10000) / 100,
      rpcPct: Math.round((r.ok / r.n) * 10000) / 100,
      avgRpcMs: r.ms == null ? null : Math.round(r.ms),
    })
    n += samples; ok += r.ok; expectedAll += expected
  }
  return {
    since: first == null ? null : new Date(first).toISOString(), intervalSec: SAMPLE_EVERY_MS / 1000,
    note: 'Availability is measured by this gateway sampling itself and the chain RPC once a minute. Minutes with no sample (restarts, outages) count against the gateway figure. Days before recording started show no data.',
    days: out,
    overall: expectedAll ? { gatewayPct: Math.round((Math.min(n, expectedAll) / expectedAll) * 10000) / 100, rpcPct: n ? Math.round((ok / n) * 10000) / 100 : null, samples: n, expected: expectedAll } : null,
  }
}

// ---------------------------------------------------------------- ledger lookups
let auditCache = { t: 0, v: null }
function ledger(audit) {
  const now = Date.now()
  if (now - auditCache.t > 15000) auditCache = { t: now, v: audit() }
  return auditCache.v
}
const slugOf = r => { try { const p = new URL(r).pathname; const i = p.indexOf('/api/'); return i >= 0 ? p.slice(i + 5) : '' } catch { return '' } }

function txView(hash, audit) {
  const find = a => a.rows.find(r => r.txHash.toLowerCase() === hash.toLowerCase())
  let a = ledger(audit), row = find(a)
  if (!row) { auditCache = { t: 0, v: null }; a = ledger(audit); row = find(a) }   // paid seconds ago: look once more, fresh
  if (!row) return { found: false, txHash: hash, note: 'Not a settlement in the COVENANT ledger. It may still be a normal transfer on-chain; check the explorer.' }
  return { found: true, txHash: row.txHash, row: { ...row, slug: slugOf(row.resource) }, asset: a.asset, chainId: a.chainId, methodology: a.methodology }
}

function receiptSvg(row) {
  const cat = row.category === 'external-payer' ? 'EXTERNAL PAYER' : row.category === 'self-test-demo' ? 'LIVE DEMO PAYMENT' : row.category.startsWith('self-test') ? 'SELF-TEST' : 'OTHER'
  const when = new Date(row.t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  const api = slugOf(row.resource) || 'session'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="COVENANT settlement receipt">
<rect width="1200" height="630" fill="#0a0a0a"/><rect x="40" y="40" width="1120" height="550" rx="28" fill="#141414" stroke="#2a2a2a"/>
<text x="90" y="112" fill="#8a8a90" font-family="ui-monospace,Menlo,monospace" font-size="22" letter-spacing="4">COVENANT · SETTLEMENT RECEIPT</text>
<text x="90" y="230" fill="#ffffff" font-family="system-ui,Helvetica,Arial,sans-serif" font-size="108" font-weight="700">${esc(Number(row.valueFormatted).toFixed(2))} <tspan font-size="44" fill="#8a8a90">USDG</tspan></text>
<text x="90" y="292" fill="#d1d1d6" font-family="ui-monospace,Menlo,monospace" font-size="30">/${esc(api)}</text>
<g font-family="ui-monospace,Menlo,monospace" font-size="24" fill="#d1d1d6">
<text x="90" y="372" fill="#8a8a90">payer</text><text x="260" y="372">${esc(short(row.payer))}</text>
<text x="90" y="418" fill="#8a8a90">paid to</text><text x="260" y="418">${esc(short(row.payTo))}</text>
<text x="90" y="464" fill="#8a8a90">settled</text><text x="260" y="464">${esc(when)}</text>
<text x="90" y="510" fill="#8a8a90">tx</text><text x="260" y="510">${esc(row.txHash.slice(0, 18))}…${esc(row.txHash.slice(-8))}</text></g>
<rect x="820" y="470" width="290" height="56" rx="28" fill="${row.category === 'external-payer' ? '#12301f' : '#3a2e12'}"/>
<text x="965" y="506" text-anchor="middle" fill="${row.category === 'external-payer' ? '#6ee7a8' : '#fbbf24'}" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="700" letter-spacing="2">${cat}</text>
<text x="90" y="568" fill="#6b6b72" font-family="ui-monospace,Menlo,monospace" font-size="18">Check it yourself: covenantx402.com/#/r/${esc(row.txHash.slice(0, 12))}…</text></svg>`
}

function badgeSvg(label, value, ok = true) {
  const lw = 14 + label.length * 6.6, vw = 14 + value.length * 6.9, w = Math.ceil(lw + vw)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title><clipPath id="r"><rect width="${w}" height="22" rx="4"/></clipPath>
<g clip-path="url(#r)"><rect width="${Math.ceil(lw)}" height="22" fill="#1b1b1b"/><rect x="${Math.ceil(lw)}" width="${Math.ceil(vw)}" height="22" fill="${ok ? '#1f6f4a' : '#555'}"/></g>
<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${Math.ceil(lw / 2)}" y="15">${esc(label)}</text><text x="${Math.ceil(lw + vw / 2)}" y="15" font-weight="700">${esc(value)}</text></g></svg>`
}

function badgeFor(slug, audit, known) {
  const a = ledger(audit)
  if (slug === 'covenant') {
    const n = a.totals.externalPayer.count
    return badgeSvg('settled via COVENANT', `${n} on-chain`, true)
  }
  if (!known(slug)) return badgeSvg('COVENANT', 'unknown listing', false)
  const rows = a.rows.filter(r => r.category === 'external-payer' && slugOf(r.resource) === slug)
  const usd = rows.reduce((s, r) => s + Number(r.valueFormatted || 0), 0)
  return badgeSvg('settled via COVENANT', rows.length ? `${rows.length} paid · ${usd.toFixed(2)} USDG` : 'listed · no payments yet', rows.length > 0)
}

// ---------------------------------------------------------------- live demo payment
let demoBusy = false
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']

/** deps are injectable so the flow is unit-testable without a chain: { wallet, token, call, now } */
async function demoStatus(deps) {
  const addr = demoWallet.checksumAddress()
  if (!addr) return { enabled: false }
  const out = { enabled: true, address: addr, routes: DEMO_ROUTES, priceUsdg: 0.01, perVisitorPerHour: DEMO_PER_IP.limit, perDay: DEMO_GLOBAL.limit }
  try {
    const bal = Number(ethers.formatUnits(await deps.token.balanceOf(addr), 6))
    out.balanceUsdg = Math.round(bal * 1e6) / 1e6
    // the one-time approve() is an on-chain transaction paid by this wallet, so it needs a little native gas too
    const gas = deps.wallet?.provider ? await deps.wallet.provider.getBalance(addr) : 1n
    out.gasOk = gas > 0n
    out.ready = bal >= DEMO_MIN_USDG && out.gasOk
    if (!out.ready) out.reason = bal < DEMO_MIN_USDG ? 'The demo wallet is out of funds. Live payments are paused.' : 'The demo wallet has no gas left. Live payments are paused.'
  } catch { out.ready = false; out.reason = 'Could not read the demo wallet balance.' }
  return out
}

async function demoPay({ slug, ip }, deps) {
  const addr = demoWallet.checksumAddress()
  if (!addr) { const e = new Error('live demo is not enabled on this gateway'); e.status = 404; throw e }
  slug = String(slug || 'alerts')
  if (!DEMO_ROUTES.includes(slug)) { const e = new Error(`demo can only pay: ${DEMO_ROUTES.join(', ')}`); e.status = 400; throw e }
  const ipRl = deps.limit(`demo:ip:${ip}`, DEMO_PER_IP.limit, DEMO_PER_IP.windowMs)
  if (!ipRl.allowed) { const e = new Error(`limit reached: ${DEMO_PER_IP.limit} live payments per hour per visitor`); e.status = 429; e.retryAfterSec = ipRl.retryAfterSec; throw e }
  const gRl = deps.limit('demo:global', DEMO_GLOBAL.limit, DEMO_GLOBAL.windowMs)
  if (!gRl.allowed) { const e = new Error('the daily live-payment budget is used up; try again tomorrow'); e.status = 429; e.retryAfterSec = gRl.retryAfterSec; throw e }
  if (demoBusy) { const e = new Error('another live payment is settling right now; try again in a few seconds'); e.status = 409; throw e }
  demoBusy = true
  const steps = []
  const step = async (name, fn) => { const t0 = Date.now(); const v = await fn(); steps.push({ name, ms: Date.now() - t0 }); return v }
  try {
    const bal = await deps.token.balanceOf(addr)
    if (Number(ethers.formatUnits(bal, 6)) < DEMO_MIN_USDG) { const e = new Error('The demo wallet is out of funds. Live payments are paused.'); e.status = 503; throw e }

    const ch = await step('quote', async () => {
      const r = await deps.call('GET', `/x402/api/${slug}`)
      if (r.status !== 402 || !r.json?.accepts?.length) throw new Error(`expected an HTTP 402 quote, got ${r.status}`)
      return r.json.accepts[0]
    })
    const value = BigInt(ch.maxAmountRequired)
    if (value > DEMO_MAX_ATOMIC) throw new Error('quoted price is above the demo cap; refusing to pay')
    if (String(ch.asset).toLowerCase() !== deps.usdg.toLowerCase()) throw new Error('quote is not in USDG; refusing to pay')
    const spender = ch.extra?.spender || ch.payTo

    await step('approve', async () => {
      const allowance = await deps.token.allowance(addr, spender)
      if (allowance >= value) return 'already approved'
      const tx = await deps.token.approve(spender, APPROVE_ALLOWANCE)
      await tx.wait()
      return tx.hash
    })

    const now = (deps.now || (() => Math.floor(Date.now() / 1000)))()
    const intent = { from: addr, to: ch.payTo, value: ch.maxAmountRequired, validAfter: now - 120, validBefore: now + 300, nonce: ethers.hexlify(ethers.randomBytes(32)), resource: ch.resource }
    const signature = await step('sign', () => deps.wallet.signTypedData(deps.domain, deps.types, intent))

    const settled = await step('settle', async () => {
      const r = await deps.call('POST', '/facilitator/settle', { intent, signature })
      if (!r.json?.success) throw new Error('settlement failed: ' + (r.json?.errorReason || r.json?.error || `HTTP ${r.status}`))
      return r.json
    })

    const content = await step('redeem', async () => {
      const r = await deps.call('GET', `/x402/api/${slug}`, null, { 'X-PAYMENT': String(settled.payment || '') })
      if (r.status !== 200) throw new Error(`paid request answered HTTP ${r.status}`)
      return r.json
    })
    const payload = content?.payload || {}
    const items = payload.items || payload.pools || payload.signals || []
    return {
      ok: true, tx: settled.transaction, route: slug, priceUsdg: Number(ethers.formatUnits(value, 6)),
      payer: addr, label: 'demo-payment', ledgerCategory: 'self-test-demo', steps,
      receiptPath: `#/r/${settled.transaction}`,
      content: { kind: payload.kind || null, items: Array.isArray(items) ? items.length : null },
    }
  } catch (e) {
    if (!e.status) e.status = 502
    e.steps = steps
    throw e
  } finally { demoBusy = false }
}

module.exports = {
  HASH, SLUG, DEMO_ROUTES, DEMO_MIN_USDG, ERC20,
  startUptimeRecorder, recordSample, uptimeView,
  txView, receiptSvg, badgeFor, badgeSvg, slugOf, ledger,
  demoStatus, demoPay, _resetBusy: () => { demoBusy = false },
}
