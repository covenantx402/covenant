// tribute-rpc-proxy — x402 gateway for AI agents on Robinhood Chain 4663.
// Read-only RPC whitelist + x402 paid routes + agent credential vault + on-chain settlement.
// Never forwards arbitrary RPC methods; upstream RPC comes from env, never shipped to clients.
const http = require('http')
const https = require('https')
const x402r = require('./x402-routes')
const vault = require('./agent-vault')
const wallets = require('./wallets')
const keys = require('./keys')
const facilitator = require('./facilitator')
const ratelimit = require('./ratelimit')
const sessions = require('./sessions')
const reputation = require('./reputation')

const UPSTREAM = process.env.TRIBUTE_RPC_UPSTREAM
const PORT = Number(process.env.TRIBUTE_PORT || 8792)
const ALLOW = new Set(['eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_getBlockByNumber', 'net_version', 'eth_call'])

if (!UPSTREAM) { console.error('TRIBUTE_RPC_UPSTREAM missing'); process.exit(1) }

// Endpoints that require an agent API key (Authorization: Bearer trb_...).
const AUTH_REQUIRED = new Set([
  'POST /vault/entries', 'DELETE /vault/entries', 'GET /vault/entries', 'POST /vault/broker',
  'POST /wallets/create', 'GET /wallets',
  'GET /keys', 'DELETE /keys',
])

// Rate limits (per agent key where authenticated, per IP otherwise).
// /keys is deliberately the tightest bucket — it's the open onboarding door.
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

function readBody(req, cb) {
  let body = ''
  req.on('data', c => { body += c; if (body.length > 5e4) req.destroy() })
  req.on('end', () => {
    let payload = {}
    if (body) { try { payload = JSON.parse(body) } catch { cb(null, null); return } }
    cb(null, payload)
  })
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-api-key,x-payment')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Content-Type', 'application/json')
  if (req.method === 'OPTIONS') { res.end(); return }

  const url = req.url.split('?')[0]
  const routeTag = req.method + ' ' + url

  // ---- auth gate ----
  const agent = authKey(req)
  if (AUTH_REQUIRED.has(routeTag) && !agent) {
    vault.audit('auth-denied', null, { route: routeTag })
    send(res, 401, { error: 'missing or invalid agent key. mint one at POST /keys (open), then send Authorization: Bearer trb_...' })
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

  if (req.method === 'GET' && url.startsWith('/x402/api/')) {
    const slug = url.slice('/x402/api/'.length).split('/')[0]
    const rec = x402r.get(slug)
    if (!rec) { send(res, 404, { error: 'unknown api' }); return }
    x402r.bump(slug)
    send(res, 402, { x402Version: 1, error: 'PAYMENT_REQUIRED', accepts: [x402r.requirement(rec, 'https://tribute.re/x402/api/' + slug)] })
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
        extra: { name: 'USDG', version: '2', spender: (facilitator.publicView().spender || null) }
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
        extra: { name: 'USDG', version: '2', spender: (facilitator.publicView().spender || null), calls: 100, ttlSec: 3600 }
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
      facilitator.settle(payload.intent, payload.signature).then(v => {
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
      onchain: { settled: f.settled, totalSettledUsdg: f.totalSettledUsdg, pattern: f.pattern },
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

  send(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => console.log(`tribute-rpc-proxy on 127.0.0.1:${PORT}`))
