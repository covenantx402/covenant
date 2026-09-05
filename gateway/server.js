// tribute-rpc-proxy — x402 gateway for AI agents on Robinhood Chain 4663.
// Read-only RPC whitelist + x402 paid routes + agent credential vault + on-chain settlement.
// Never forwards arbitrary RPC methods; upstream RPC comes from env, never shipped to clients.
const http = require('http')
const https = require('https')
const x402r = require('./x402-routes')
const dataProviders = require('./data-providers.js')
const vault = require('./agent-vault')
const wallets = require('./wallets')
const keys = require('./keys')
const facilitator = require('./facilitator')
const marketplace = require('./marketplace')
const { ethers } = require('ethers')
const { DOMAIN_NAME, DOMAIN_VERSION } = require('./facilitator')
const ratelimit = require('./ratelimit')
const sessions = require('./sessions')
const reputation = require('./reputation')

// marketplace slugs must never collide with TRIBUTE's own paid routes
marketplace.setReservedSlugCheck((slug) => x402r.has(slug))

const UPSTREAM = process.env.TRIBUTE_RPC_UPSTREAM
const PORT = Number(process.env.TRIBUTE_PORT || 8792)
const ALLOW = new Set(['eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_getBlockByNumber', 'net_version', 'eth_call'])

if (!UPSTREAM) { console.error('TRIBUTE_RPC_UPSTREAM missing'); process.exit(1) }

// Endpoints that require an agent API key (Authorization: Bearer trb_...).
const AUTH_REQUIRED = new Set([
  'POST /vault/entries', 'DELETE /vault/entries', 'GET /vault/entries', 'POST /vault/broker',
  'POST /wallets/create', 'GET /wallets',
  'GET /keys', 'DELETE /keys', 'DELETE /keys/self',
  'GET /analytics/keys',
])

// Rate limits (per agent key where authenticated, per IP otherwise).
// /keys is deliberately the tightest bucket — it's the open onboarding door.
let deniedCount = 0
const RATE_LIMITS = {
  'POST /keys': { limit: 5, windowMs: 3600000 },          // 5 keys/hour
  'POST /facilitator/settle': { limit: 60, windowMs: 60000 },  // 60 settles/min
  'POST /facilitator/verify': { limit: 120, windowMs: 60000 },
  'POST /vault/entries': { limit: 60, windowMs: 60000 },
  'POST /vault/broker': { limit: 120, windowMs: 60000 },
  'POST /wallets/create': { limit: 10, windowMs: 3600000 },
  'GET /x402/premium': { limit: 60, windowMs: 60000 },
  DEFAULT: { limit: 300, windowMs: 60000 },
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown'
}

function rateCheck(req, agentKey) {
  const cfg = RATE_LIMITS[req.method + ' ' + req.url.split('?')[0]] || RATE_LIMITS.DEFAULT
  const bucket = agentKey ? `key:${agentKey.id}` : `ip:${clientIp(req)}`
  const r = ratelimit.check(bucket + ':' + req.method + ' ' + req.url.split('?')[0], cfg.limit, cfg.windowMs)
  return { ...r, cfg }
}

function authKey(req) {
  const h = req.headers['authorization'] || req.headers['x-api-key'] || ''
  const raw = h.startsWith('Bearer ') ? h.slice(7) : h
  return keys.verify(raw)
}

function send(res, code, obj) {
  res.statusCode = code
  res.end(JSON.stringify(obj))
}

/* Marketplace fee split, derived SERVER-SIDE from the payment intent's
   resource — the client never dictates legs. If the paid resource maps to an
   active listing, push the seller's share; the fee stays in the facilitator
   wallet. Guard: intent.to must be the facilitator wallet itself. */
function serverSplitsFor(intent) {
  try {
    const res = String(intent?.resource || '')
    if (!res.includes('/x402/api/')) return null
    const slug = res.split('/x402/api/')[1].split(/[/?#]/)[0]
    const mkt = marketplace.get(slug)
    if (!mkt) return null
    const spender = (facilitator.publicView().spender || '').toLowerCase()
    if (!spender || String(intent.to).toLowerCase() !== spender) return null
    const { sellerShare } = marketplace.splitPrice(mkt.price)
    return [{ to: mkt.seller, value: sellerShare }]
  } catch { return null }
}

function readBody(req, cb) {
  let body = ''
  req.on('data', c => { body += c; if (body.length > 5e4) req.destroy() })
  req.on('end', () => {
    let payload = {}
    if (body) { try { payload = JSON.parse(body) } catch { cb(null, null); return } }
    cb(null, payload)
  })
}

const articleCache = new Map() // url -> {t, json}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-api-key,x-payment')
  res.setHeader('Access-Control-Expose-Headers', 'X-PAYMENT,Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Content-Type', 'application/json')
  if (req.method === 'OPTIONS') { res.end(); return }

  const url = req.url.split('?')[0]
  const routeTag = req.method + ' ' + url

  // ---- auth gate ----
  const agent = authKey(req)
  if (AUTH_REQUIRED.has(routeTag) && !agent) {
    /* Jangan audit setiap 401. Console mem-polling /vault/entries + /wallets
       tiap 8 detik tanpa key, dan itu membanjiri audit log (200 entri) sampai
       menutupi aktivitas nyata (settlement, broker). Catat cukup di journal. */
    deniedCount++
    if (deniedCount % 25 === 1) {
      console.log(`[auth] ${deniedCount} denied (terakhir: ${routeTag}) — tidak masuk audit log`)
    }
    send(res, 401, { error: 'missing or invalid agent key. mint one at POST /keys (open), then send Authorization: Bearer ***' })
    return
  }

  // ---- rate limit (per key when authenticated, per IP otherwise) ----
  const rl = rateCheck(req, agent)
  res.setHeader('X-RateLimit-Limit', String(rl.cfg.limit))
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSec))
    vault.audit('rate-limited', agent?.id || null, { route: routeTag })
    send(res, 429, { error: 'rate limit exceeded', retryAfterSec: rl.retryAfterSec })
    return
  }

  // ============ open endpoints (no auth) ============

  if (req.method === 'GET' && url === '/x402/apis') {
    res.end(JSON.stringify({
      network: 'eip155:4663',
      asset: x402r.USDG,
      apis: x402r.list(),
      hits: x402r.hits(),
      activity: x402r.activity.slice(0, 20)
    }))
    return
  }

  // Register a paid route. Open by design — the 402 gate is the monetization, not the registry.
  if (req.method === 'POST' && url === '/x402/apis') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      try {
        const rec = x402r.create(payload || {})
        send(res, 201, rec)
      } catch (e) { send(res, 400, { error: e.message || String(e) }) }
    })
    return
  }

  if (req.method === 'GET' && url.startsWith('/x402/api/')) {
    const slug = url.slice('/x402/api/'.length).split('/')[0]
    let rec = x402r.get(slug)
    const mkt = rec ? null : marketplace.get(slug)
    if (!rec && !mkt) { send(res, 404, { error: 'unknown api' }); return }
    const resource = 'https://tribute.re/x402/api/' + slug
    const paid = facilitator.paymentRecordFor(req.headers['x-payment'], resource)
    if (!paid && !rec) {
      // marketplace listing: build the challenge from the listing record
      marketplace.recordHit(slug)
      const reqt = marketplace.requirement(mkt, resource, facilitator.publicView().spender)
      send(res, 402, { x402Version: 1, error: 'PAYMENT_REQUIRED', accepts: [reqt] })
      return
    }
    if (!paid) {
      x402r.bump(slug)
      const reqt = x402r.requirement(rec, resource)
      reqt.extra = { ...reqt.extra, spender: facilitator.publicView().spender || null }
      send(res, 402, { x402Version: 1, error: 'PAYMENT_REQUIRED', accepts: [reqt] })
      return
    }
    // settled on-chain (nonce anchored to a tx) → deliver the REAL resource.
    if (mkt) {
      // marketplace listing: proxy the seller's upstream JSON.
      // Seller earning is finalized (95% pushed on-chain) ONLY after the buyer
      // actually received the payload. If the seller's endpoint fails, the
      // buyer is refunded in full from the facilitator wallet (best-effort).
      let payload = null, fetchErr = null
      try { payload = await marketplace.fetchJson(mkt.upstream) } catch (e) { fetchErr = e.message }
      let splitLegs = null, refund = null
      if (payload) {
        try { splitLegs = await facilitator.finalizeSplits(paid.txHash) }
        catch (e) { console.error('finalize splits failed', slug, e.message) }
        if (splitLegs && splitLegs.length) {
          const { sellerShare } = marketplace.splitPrice(mkt.price)
          marketplace.recordSettle(slug, { sellerShareAtomic: sellerShare })
        }
      } else {
        marketplace.recordFail(slug)
        facilitator.cancelSplits(paid.txHash)
        try {
          refund = await facilitator.refundPayment({ to: paid.from, value: paid.value, reason: `upstream fail ${slug}: ${fetchErr}` })
          const { sellerShare } = marketplace.splitPrice(mkt.price)
          marketplace.recordRefund(slug, { sellerShareAtomic: sellerShare })
        } catch (e) { console.error('refund failed for', slug, e.message) }
      }
      x402r.log('paid', { slug, path: '/api/' + slug, price: mkt.price }, { status: 200 })
      send(res, 200, {
        ok: true, access: 'granted', api: '/api/' + slug, price: mkt.price,
        marketplace: true, seller: mkt.seller,
        tx: paid.txHash, payer: paid.from, deliveredAt: Date.now(),
        sellerPayment: splitLegs && splitLegs[0] ? { tx: splitLegs[0].txHash } : undefined,
        refund: refund ? { sent: true, tx: refund.txHash, amount: ethers.formatUnits(BigInt(paid.value), 6) } : undefined,
        payload: payload || {
          message: `Payment confirmed for ${mkt.name} — seller endpoint failed (${fetchErr}). Your payment has been refunded${refund ? '' : ' processing'}.`,
          tx: paid.txHash, refunded: !!refund, receiptOnly: true,
        },
      })
      return
    }
    // TRIBUTE's own route: payloadFor() hits live feeds (RSS / GeckoTerminal)
    // with a 60s cache. If upstream is down we still honour the payment
    // receipt — but say so.
    let payload = null
    try { payload = await dataProviders.payloadFor(rec.slug) } catch (e) {
      console.error('payload fetch failed for', rec.slug, e.message)
    }
    x402r.log('paid', rec, { status: 200 })
    send(res, 200, {
      ok: true, access: 'granted', api: rec.path, price: rec.price,
      tx: paid.txHash, payer: paid.from, deliveredAt: Date.now(),
      payload: payload || {
        message: `Payment confirmed for ${rec.path} — upstream feed temporarily unavailable, retry shortly`,
        tx: paid.txHash, receiptOnly: true,
      },
    })
    return
  }

  // /gt/* → GeckoTerminal allowlist (public market data, no key). Server-side fetch kills CORS.
  if (req.url.startsWith('/gt/')) {
    https.get('https://api.geckoterminal.com/api/v2' + req.url.slice(3), { headers: { accept: 'application/json' } }, ur => {
      let out = ''
      ur.on('data', c => out += c)
      ur.on('end', () => { res.statusCode = ur.statusCode; res.end(out) })
    }).on('error', e => { res.statusCode = 502; res.end(JSON.stringify({ error: String(e.message || e) })) })
    return
  }

  // x402 playground — Apache-2.0 protocol shape (x402-foundation/x402). Unpaid GET → 402.
  if (req.url.startsWith('/x402/premium') || req.url === '/x402' || req.url === '/x402/') {
    const payTo = process.env.TRIBUTE_X402_PAYTO || '0x0000000000000000000000000000000000000000'
    const body = JSON.stringify({
      x402Version: 1,
      error: 'PAYMENT_REQUIRED',
      accepts: [{
        scheme: 'tribute-intent',        // approve+transferFrom settlement (USDG on 4663 has no EIP-3009)
        network: 'eip155:4663',
        maxAmountRequired: '10000',
        resource: req.url,
        description: 'TRIBUTE premium alert sample — 0.01 USDG',
        mimeType: 'application/json',
        payTo,
        maxTimeoutSeconds: 60,
        asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
        extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION, spender: (facilitator.publicView().spender || null) }
      },
      {
        // session option: pay once, call N times (Stripe MPP-style session intent)
        scheme: 'tribute-session',
        network: 'eip155:4663',
        maxAmountRequired: '10000',
        resource: 'session',
        description: 'TRIBUTE session — 0.01 USDG for 100 calls / 1h (set extra.calls/ttlSec to customize)',
        mimeType: 'application/json',
        payTo,
        maxTimeoutSeconds: 60,
        asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
        extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION, spender: (facilitator.publicView().spender || null), calls: 100, ttlSec: 3600 }
      }]
    })
    res.statusCode = 402
    res.setHeader('X-PAYMENT-REQUIRED', Buffer.from(body).toString('base64'))
    x402r.log('402', { slug: 'premium', path: '/premium', price: '0.01' })
    res.end(body)
    return
  }

  // facilitator status (shows settlement config, no secrets)
  if (req.method === 'GET' && url === '/facilitator') {
    res.end(JSON.stringify(facilitator.publicView()))
    return
  }

  // verify a signed payment intent (no settlement)
  if (req.method === 'POST' && url === '/facilitator/verify') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      facilitator.verify(payload.intent, payload.signature).then(v => {
        send(res, 200, { isValid: v.ok, invalidReason: v.reason || undefined, payer: v.payer || undefined })
      })
    })
    return
  }

  // settle a signed payment intent on-chain (approve+transferFrom).
  // Two resource shapes:
  //   - "session" (with calls/ttl in extra) → opens a paid session for N calls
  //   - anything else → one-shot resource payment
  if (req.method === 'POST' && url === '/facilitator/settle') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      facilitator.settle(payload.intent, payload.signature, serverSplitsFor(payload.intent)).then(v => {
        vault.audit(v.success ? 'settle-ok' : 'settle-fail', v.payer || null, { tx: v.transaction || v.errorReason })
        let out = v
        if (v.success) {
          reputation.record(v.payer, {
            valueFormatted: (Number(payload.intent?.value || 0) / 1e6).toFixed(6),
            resource: payload.intent?.resource,
            txHash: v.transaction,
          })
          const extra = payload.extra || {}
          if (String(payload.intent?.resource) === 'session' || extra.session) {
            const s = sessions.open({
              payer: v.payer,
              payTo: payload.intent?.to,
              value: payload.intent?.value,
              calls: extra.calls,
              ttlSec: extra.ttlSec,
              txHash: v.transaction,
            })
            out = { ...v, session: { id: s.sessionId, callsMax: s.calls.max, expiresAt: s.expiresAt } }
          }
        }
        send(res, 200, out)
      })
    })
    return
  }

  // redeem a paid session for one call
  if (req.method === 'POST' && url === '/session/redeem') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const r = sessions.redeem(payload.sessionId)
      if (!r.ok) { send(res, 402, { error: 'PAYMENT_REQUIRED', reason: r.reason }); return }
      send(res, 200, { ok: true, callsRemaining: r.remaining })
    })
    return
  }

  // session status
  if (req.method === 'GET' && url.startsWith('/session/')) {
    const id = url.slice('/session/'.length)
    const s = sessions.status(id)
    if (!s) { send(res, 404, { error: 'unknown or expired session' }); return }
    send(res, 200, s)
    return
  }

  // agent reputation (self or any address)
  if (req.method === 'GET' && url === '/reputation') {
    const addr = (req.url.split('?')[1] || '').match(/address=(0x[0-9a-fA-F]{40})/i)?.[1] || agent?.id && null
    send(res, 200, {
      self: agent ? { id: agent.id, label: agent.label, hits: agent.hits, lastUsed: agent.lastUsed } : null,
      note: 'pass ?address=0x... to score an on-chain payer. scores are derived from settled payments, every claim anchored to a tx hash.',
      leaderboard: reputation.leaderboard(10),
    })
    return
  }

  /* Per-key analytics: agregat ringan untuk console.
     Hanya boleh diakses dengan agent key (AUTH_REQUIRED), jadi tidak
     membocorkan data antar-agen. */
  if (req.method === 'GET' && url === '/analytics/keys') {
    if (!agent) { send(res, 401, { error: 'missing or invalid agent key' }); return }
    const all = keys.list().map(k => ({
      id: k.id,
      label: k.label,
      prefix: k.prefix,
      hits: k.hits || 0,
      createdAt: k.createdAt,
      lastUsed: k.lastUsed,
    }))
    const now = Date.now()
    const active = all.filter(k => k.lastUsed && now - k.lastUsed < 24 * 3600 * 1000).length
    const totalHits = all.reduce((s, k) => s + k.hits, 0)
    send(res, 200, {
      self: agent ? {
        id: agent.id, label: agent.label, prefix: agent.prefix,
        hits: agent.hits || 0, createdAt: agent.createdAt, lastUsed: agent.lastUsed,
      } : null,
      totals: {
        keys: all.length,
        active24h: active,
        hits: totalHits,
      },
      // Top key by usage — cukup 5, sisanya tidak perlu dikirim ke UI.
      top: all.sort((a, b) => b.hits - a.hits).slice(0, 5).map(k => ({
        label: k.label,
        prefix: k.prefix,
        hits: k.hits,
        lastUsed: k.lastUsed,
      })),
    })
    return
  }

  if (req.method === 'GET' && url.startsWith('/reputation/')) {
    const addr = url.slice('/reputation/'.length)
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { send(res, 400, { error: 'pass a 0x address' }); return }
    send(res, 200, reputation.score(addr))
    return
  }

  // mint an agent API key (raw shown once). Open by design: key creation must be
  // frictionless for new agents; everything sensitive is behind the key itself.
  if (req.method === 'POST' && url === '/keys') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const rec = keys.mint(payload.label)
      vault.audit('key-mint', rec.id, { label: rec.label })
      send(res, 201, rec)
    })
    return
  }

  if (req.url === '/vault/status') {
    res.end(JSON.stringify({ ...vault.stats(), service: 'tribute-vault' }))
    return
  }

  // ---- health: every check is a REAL probe, never a canned 'ok' ----
  if (req.method === 'GET' && url === '/x402/health') {
    const t0 = Date.now()
    let rpc = { ok: false, block: null, ms: null, err: null }
    try {
      const tr = Date.now()
      const bn = await facilitator.currentBlock()
      rpc = { ok: true, block: Number(bn), ms: Date.now() - tr, err: null }
    } catch (e) { rpc.err = String(e.message || e).slice(0, 120) }
    const f = facilitator.publicView()
    res.end(JSON.stringify({
      ok: rpc.ok,
      uptimeSec: Math.round(process.uptime()),
      version: require('./package.json').version,
      time: Date.now(),
      checks: {
        gateway: { ok: true, ms: Date.now() - t0 },
        rpc: rpc,
        settlement: { ok: !!f.spender, settled: f.settled, spender: f.spender },
        vault: { ok: true, entries: vault.list().length },
        keys: { ok: true, count: keys.count() },
        wallets: { ok: true, count: wallets.count() },
        apis: { ok: true, count: x402r.list().length },
      },
    }))
    return
  }

  // ---- public leaderboard: real settlement history, grouped by payer
  if (req.url === '/x402/leaderboard') {
    const log = facilitator.settleLogAll()
    const routeOf = (r) => { try { const pn = new URL(r).pathname; return pn.includes('/api/') ? '/api' + pn.slice(pn.indexOf('/api/') + 4) : pn } catch (e) { return 'general' } }
    const byPayer = new Map()
    const byRoute = new Map()
    for (const e of log) {
      if (!e.payer) continue
      const amt = Number(e.valueFormatted || 0)
      const rt = e.resource ? routeOf(e.resource) : 'general'
      const p = byPayer.get(e.payer) || { payer: e.payer, count: 0, usdg: 0, last: 0, routes: new Set() }
      p.count += 1; p.usdg += amt; p.last = Math.max(p.last, e.t || 0); p.routes.add(rt)
      byPayer.set(e.payer, p)
      const r = byRoute.get(rt) || { route: rt, count: 0, usdg: 0 }
      r.count += 1; r.usdg += amt
      byRoute.set(rt, r)
    }
    const payers = [...byPayer.values()]
      .map((x) => ({ payer: x.payer, count: x.count, usdg: Math.round(x.usdg * 10000) / 10000, last: x.last, routes: [...x.routes].slice(0, 6) }))
      .sort((a, b) => b.count - a.count || b.usdg - a.usdg)
      .slice(0, 20)
    const routes = [...byRoute.values()].sort((a, b) => b.count - a.count)
    send(res, 200, { payers, routes, totalPayers: byPayer.size, totalSettled: log.length })
    return
  }

  // ---- marketplace: third-party paid APIs (list / browse / revoke / earnings)
  if (req.method === 'GET' && url === '/x402/marketplace') {
    send(res, 200, { ok: true, feeBps: marketplace.FEE_BPS, apis: marketplace.catalog() })
    return
  }
  if (req.method === 'GET' && url === '/x402/marketplace/earnings') {
    const seller = new URL(req.url, 'http://x').searchParams.get('seller')
    if (!/^0x[0-9a-fA-F]{40}$/.test(seller || '')) { send(res, 400, { error: 'seller=0x… required' }); return }
    send(res, 200, { ok: true, ...marketplace.earningsFor(seller) })
    return
  }
  if (req.method === 'POST' && url === '/x402/marketplace/list') {
    readBody(req, async (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      try {
        const { rec, split } = await marketplace.createListing(payload || {})
        x402r.log('create', { slug: rec.slug, path: '/api/' + rec.slug, price: rec.price }, { status: 201 })
        send(res, 201, {
          ok: true, api: { slug: rec.slug, name: rec.name, price: rec.price, seller: rec.seller },
          endpoint: '/x402/api/' + rec.slug,
          economics: { priceUsdg: rec.price, feeUsdg: ethers.formatUnits(BigInt(split.fee), 6), sellerUsdg: ethers.formatUnits(BigInt(split.sellerShare), 6) },
        })
      } catch (e) {
        send(res, 400, { error: String(e.message || e) })
      }
    })
    return
  }
  if (req.method === 'POST' && url === '/x402/marketplace/revoke') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      try {
        const rec = marketplace.revoke(payload || {})
        send(res, 200, { ok: true, slug: rec.slug, status: rec.status })
      } catch (e) {
        send(res, 400, { error: String(e.message || e) })
      }
    })
    return
  }

  // ---- in-app article reader: fetches the source page and extracts
  // the body text so the console can render the story WITHOUT leaving it.
  if (req.url.startsWith('/x402/article?')) {
    const u = new URL(req.url, 'http://x')
    const target = u.searchParams.get('url') || ''
    let tu
    try {
      tu = new URL(target)
    } catch {
      return send(res, 400, { error: 'bad url param' })
    }
    const ALLOWED_HOSTS = ['cointelegraph.com', 'theblock.co', 'decrypt.co', 'bitcoinmagazine.com', 'coindesk.com']
    const bare = tu.hostname.replace(/^www\./, '')
    if (!/^https:$/.test(tu.protocol) || !ALLOWED_HOSTS.some((h) => bare === h || bare.endsWith('.' + h))) {
      return send(res, 400, { error: 'host not allowed' })
    }
    const cached = articleCache.get(target)
    if (cached && Date.now() - cached.t < 10 * 60 * 1000) {
      return send(res, 200, cached.json)
    }
    try {
      const r = await fetch('https://r.jina.ai/' + target, {
        headers: { 'User-Agent': 'tribute-console/1.0', 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(15000),
      })
      if (!r.ok) return send(res, 502, { error: 'reader upstream ' + r.status })
      const raw = await r.text()
      const { title: aTitle, published: aPub, body } = require('./article-extract').extractArticle(raw)
      const title = aTitle || tu.pathname.split('/').pop().replace(/-/g, ' ')
      const published = aPub || null
      const words = body.split(/\s+/).length
      const payload = {
        provider: 'in-app reader (r.jina.ai)', v: 3,
        source: tu.hostname.replace(/^www\./, ''),
        url: target,
        title,
        published,
        words,
        minutes: Math.max(1, Math.round(words / 220)),
        body: body.slice(0, 12000),
        fetchedAt: Date.now(),
      }
      articleCache.set(target, { t: Date.now(), json: payload })
      send(res, 200, payload)
    } catch (e) {
      send(res, 502, { error: 'reader failed: ' + (e && e.message ? e.message : String(e)) })
    }
    return
  }

  // ---- free news feed (same real provider as the paid /news API, cached 60s)
  // Powers the console Newsroom — clickable headlines, no payment needed.
  if (req.url === '/x402/news') {
    try {
      const payload = await dataProviders.payloadFor('news')
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, ...payload }))
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
    }
    return
  }

  // ---- usage dashboard data: daily hit/payment counts + per-API breakdown.
  // Free by design (like /x402/stats) — it only exposes aggregate counts.
  if (req.url === '/x402/usage') {
    const acts = x402r.activity
    const now = Date.now()
    const DAY = 86400000
    const days = 14
    const grid = Array.from({ length: days }, (_, i) => {
      const d = new Date(now - (days - 1 - i) * DAY)
      return { date: d.toISOString().slice(0, 10), hits: 0, paid: 0, usdg: 0 }
    })
    const byApi = new Map()
    for (const a of acts) {
      const idx = days - 1 - Math.floor((now - a.t) / DAY)
      if (idx >= 0 && idx < days) {
        grid[idx].hits += 1
        if (a.kind === 'paid') { grid[idx].paid += 1; grid[idx].usdg += Number(a.price || 0) }
      }
      const k = a.path || '/' + (a.slug || 'unknown')
      const row = byApi.get(k) || { api: k, price: a.price || '0', hits: 0, paid: 0, usdg: 0, lastT: 0 }
      row.hits += 1
      if (a.kind === 'paid') { row.paid += 1; row.usdg += Number(a.price || 0) }
      row.lastT = Math.max(row.lastT, a.t || 0)
      byApi.set(k, row)
    }
    const apis = [...byApi.values()].sort((a, b) => b.hits - a.hits)
      .map(r => ({ ...r, usdg: Math.round(r.usdg * 10000) / 10000 }))
    const f = facilitator.publicView()
    send(res, 200, {
      days: grid,
      apis,
      totals: {
        hits: acts.length,
        paid: acts.filter(a => a.kind === 'paid').length,
        usdg: Math.round(acts.filter(a => a.kind === 'paid').reduce((s, a) => s + Number(a.price || 0), 0) * 10000) / 10000,
        onchainSettled: f.settled,
        onchainUsdg: Math.round(f.totalSettledUsdg * 10000) / 10000,
      },
      windowNote: 'activity log holds the most recent 80 gate events',
    })
    return
  }

  // ---- billing history: real on-chain settlements from the settle log.
  if (req.url === '/x402/billing') {
    const log = facilitator.settleLogAll()
    const routeOf = (r) => { try { const pn = new URL(r).pathname; return pn.includes('/api/') ? '/api' + pn.slice(pn.indexOf('/api/') + 4) : pn } catch (e) { return 'general' } }
    const rows = log.map(e => ({
      t: e.t,
      api: e.resource ? routeOf(e.resource) : 'general',
      payer: e.payer,
      payTo: e.to,
      usdg: Number(e.valueFormatted || 0),
      txHash: e.txHash,
      gasUsed: e.gasUsed || null,
    }))
    const total = Math.round(rows.reduce((s, r) => s + r.usdg, 0) * 10000) / 10000
    send(res, 200, { rows, count: rows.length, totalUsdg: total })
    return
  }

  if (req.url === '/x402/stats') {
    const acts = x402r.activity
    const now = Date.now()
    const inWindow = ms => acts.filter(a => now - a.t < ms)
    const byPrice = {}
    let settled = 0
    for (const a of acts) { if (a.kind === 'paid') { settled += Number(a.price || 0) } byPrice[a.path] = (byPrice[a.path] || 0) + 1 }
    const top = Object.entries(byPrice).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([path, hits]) => ({ path, hits }))
    const buckets = Array(24).fill(0)
    for (const a of acts) {
      const h = Math.floor((now - a.t) / 3600000)
      if (h >= 0 && h < 24) buckets[23 - h]++
    }
    const f = facilitator.publicView()
    res.end(JSON.stringify({
      apis: x402r.list().length,
      hits402: x402r.hits(),
      activity24h: inWindow(86400000).length,
      settledUsdg: settled,
      onchain: { settled: f.settled, totalSettledUsdg: f.totalSettledUsdg, pattern: f.pattern, recent: f.recent || [] },
      sessions: sessions.stats(),
      reputation: reputation.stats(),
      vault: { entries: vault.list().length, brokered: vault.stats().brokered },
      wallets: wallets.count(),
      keys: keys.count(),
      topPaths: top,
      hourly: buckets
    }))
    return
  }

  // ---- read-only RPC proxy (whitelisted methods only) ----
  if (req.method === 'POST' && !AUTH_REQUIRED.has(routeTag) && !url.startsWith('/vault') && !url.startsWith('/wallets') && !url.startsWith('/keys') && !url.startsWith('/x402') && !url.startsWith('/facilitator')) {
    readBody(req, (err, payload) => {
      if (err || !payload) { send(res, 400, { error: 'bad json' }); return }
      const items = Array.isArray(payload) ? payload : [payload]
      if (!items.every(x => ALLOW.has(x && x.method))) { send(res, 403, { error: 'method not allowed' }); return }
      const up = https.request(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' } }, ur => {
        let out = ''
        ur.on('data', c => out += c)
        ur.on('end', () => { res.statusCode = ur.statusCode; res.end(out) })
      })
      up.on('error', e => { res.statusCode = 502; res.end(JSON.stringify({ error: String(e.message || e) })) })
      up.end(JSON.stringify(payload))
    })
    return
  }

  // ============ authenticated endpoints ============

  if (req.method === 'GET' && url === '/vault/entries') {
    res.end(JSON.stringify(vault.list()))
    return
  }

  if (req.method === 'POST' && url === '/vault/entries') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      try {
        const rec = vault.put(payload.name, payload.value)
        vault.audit('set', payload.name)
        send(res, 201, { ...rec, note: 'value stored encrypted; never returned' })
      } catch (e) { send(res, 400, { error: e.message || String(e) }) }
    })
    return
  }

  if (req.method === 'DELETE' && url === '/vault/entries') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const had = vault.del(payload.name)
      vault.audit('delete', payload.name)
      send(res, had ? 200 : 404, had ? { ok: true } : { error: 'not found' })
    })
    return
  }

  if (req.method === 'POST' && url === '/vault/broker') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const r = vault.resolve(String(payload.text || ''), { scrub: payload.scrub !== false })
      vault.audit('broker', r.used[0] || null, { placeholders: r.used.length })
      send(res, 200, { body: r.body, used: r.used, scrubbed: true })
    })
    return
  }

  if (req.method === 'POST' && url === '/wallets/create') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      try {
        const rec = wallets.create(payload)
        send(res, 201, rec)
      } catch (e) { send(res, 400, { error: e.message || String(e) }) }
    })
    return
  }

  if (req.method === 'GET' && url === '/wallets') {
    res.end(JSON.stringify(wallets.list()))
    return
  }

  if (req.method === 'GET' && url === '/keys') {
    res.end(JSON.stringify(keys.list()))
    return
  }

  if (req.method === 'DELETE' && url === '/keys') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const had = keys.revoke(payload.id)
      vault.audit('key-revoke', payload.id || null)
      send(res, had ? 200 : 404, had ? { ok: true } : { error: 'not found' })
    })
    return
  }

  // revoke the key that is authenticating this very request (console "revoke" button)
  if (req.method === 'DELETE' && url === '/keys/self') {
    const had = keys.revoke(agent.id)
    vault.audit('key-revoke', agent.id)
    send(res, had ? 200 : 404, had ? { ok: true } : { error: 'not found' })
    return
  }

  send(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => console.log(`tribute-rpc-proxy on 127.0.0.1:${PORT}`))
