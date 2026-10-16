// covenant-rpc-proxy — x402 gateway for AI agents on Robinhood Chain 4663.
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
const balance = require('./balance')
const { ethers } = require('ethers')
const { DOMAIN_NAME, DOMAIN_VERSION } = require('./facilitator')
const ratelimit = require('./ratelimit')
const sessions = require('./sessions')
const reputation = require('./reputation')
const x402v2 = require('./x402-v2')
const uptoDemo = require('./upto-demo')

// marketplace slugs must never collide with COVENANT's own paid routes
marketplace.setReservedSlugCheck((slug) => x402r.has(slug))

// COVENANT_RPC_UPSTREAM may be a comma-separated list (see facilitator.js —
// the settlement path gets real failover via ethers.FallbackProvider). This
// raw passthrough proxy just needs ONE URL to forward whitelisted reads to;
// take the first configured endpoint.
const UPSTREAM = String(process.env.COVENANT_RPC_UPSTREAM || '').split(',')[0].trim()
const PORT = Number(process.env.COVENANT_PORT || 8792)
/* Canonical public origin — used as the `resource` in every 402 challenge and
   in discovery docs (x402scan / CDP Bazaar). Was the placeholder covenant.re. */
const PUBLIC_ORIGIN = (process.env.COVENANT_PUBLIC_ORIGIN || 'https://gateway.covenantx402.com').replace(/\/+$/, '')
const ALLOW = new Set(['eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_getBlockByNumber', 'net_version', 'eth_call'])

if (!UPSTREAM) { console.error('COVENANT_RPC_UPSTREAM missing'); process.exit(1) }

// Endpoints that require an agent API key (Authorization: Bearer cvn_...).
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

/* X-Forwarded-For is only trustworthy behind a KNOWN reverse proxy — anyone
   can set that header directly and mint a fresh IP-keyed rate-limit bucket
   on every request otherwise (defeats the 5-keys/hour guard on the open
   POST /keys endpoint entirely). Only honour it when the immediate peer is
   in COVENANT_TRUSTED_PROXIES (comma-separated IPs, e.g. your own nginx/LB). */
const TRUSTED_PROXIES = new Set((process.env.COVENANT_TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean))
function clientIp(req) {
  const peer = req.socket?.remoteAddress || 'unknown'
  if (TRUSTED_PROXIES.has(peer)) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (xff) return xff
  }
  return peer
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

const { registerDiscoveryRoutes } = require('./routes/discovery')
const discovery = registerDiscoveryRoutes({
  x402r, facilitator, marketplace, vault, wallets, keys, sessions, reputation,
  send, PUBLIC_ORIGIN, DOMAIN_NAME, DOMAIN_VERSION,
})

/* 402 with BOTH real x402 challenge transports:
   - JSON body: v1 legacy shape (`maxAmountRequired`, resource/description/mimeType
     inline per-accept) — unchanged wire format for existing clients/tests.
   - `Payment-Required` / `X-PAYMENT-REQUIRED` headers: a genuine v2-shaped,
     base64-encoded PaymentRequired object (via the official `@x402/core`
     codec) — NOT just the v1 body re-encoded. Previously these headers
     carried base64(v1 JSON), which is mislabeled: v2 clients/scanners that
     decode the header and validate against PaymentRequiredV2Schema (renamed
     `amount` field, `resource` as an object, `extensions.bazaar` discovery
     block) would reject it. Deriving a real v2 body from the same v1
     `accepts[]` here means every 402 call site gets both transports for
     free, with no per-route changes needed. */
function send402(res, body) {
  res.statusCode = 402
  const json = JSON.stringify(body)
  res.setHeader('X-PAYMENT-REQUIRED-V1', Buffer.from(json).toString('base64')) // legacy transport, kept for anything still reading it
  try {
    const v1Accepts = Array.isArray(body.accepts) ? body.accepts : []
    if (v1Accepts.length) {
      const first = v1Accepts[0]
      const v2 = x402v2.buildV2Response({
        resourceUrl: first.resource && first.resource !== 'session' ? first.resource : (PUBLIC_ORIGIN + '/x402/premium'),
        description: first.description,
        mimeType: first.mimeType || 'application/json',
        accepts: v1Accepts.map(a => x402v2.acceptV2({
          scheme: a.scheme === 'covenant-session' ? a.scheme : 'exact',
          network: a.network,
          amount: a.maxAmountRequired,
          payTo: a.payTo,
          asset: a.asset,
          maxTimeoutSeconds: a.maxTimeoutSeconds,
          extra: a.extra,
        })),
        bazaarInput: { type: 'http', method: 'GET' },
      })
      if (v2.header) {
        res.setHeader('Payment-Required', v2.header)
        res.setHeader('X-PAYMENT-REQUIRED', v2.header)
      }
    }
  } catch (e) {
    console.error('v2 402 header build failed, v1 body still served:', e.message)
  }
  res.end(json)
}

/* Receipt check that also honours intents signed against the old placeholder
   resource origin (https://covenant.re) so in-flight sessions/receipts keep
   working after the canonical-origin switch. */
function paidFor(header, resource, chainId = facilitator.DEFAULT_CHAIN_ID) {
  return facilitator.paymentRecordFor(header, resource, chainId) ||
    facilitator.paymentRecordFor(header, resource.replace(PUBLIC_ORIGIN, 'https://covenant.re'), chainId)
}

// A payment's selected network is carried twice: the signed EIP-712 domain
// (payload.chainId) and the resource URL query (`?chain=`). Require them to
// agree BEFORE a transferFrom can happen. Without this, a client could pay
// on chain A while naming a chain-B resource, creating a receipt that cannot
// legitimately unlock anything (or worse, becomes a cross-rail confusion
// bug if a future caller forgets the receipt-side check).
function resourceChainMatches(resource, chainId) {
  if (String(resource || '') === 'session') return true
  try {
    const u = new URL(String(resource), PUBLIC_ORIGIN)
    const requested = u.searchParams.get('chain')
    return requested == null || Number(requested) === Number(chainId)
  } catch { return true } // non-URL/custom resource: no chain assertion to make
}

// Settle only a requirement this gateway could have quoted. The EIP-712
// signature authorizes a transfer, but it is not a server-side price quote:
// bind all quote-controlled fields here before calling transferFrom.
function validateQuotedIntent(intent, chainId) {
  if (!intent || typeof intent !== 'object') return 'missing payment intent'
  const c = facilitator.chains.getChain(chainId)
  const spender = facilitator.publicView(chainId).spender
  if (!spender || String(intent.to || '').toLowerCase() !== spender.toLowerCase()) return 'intent.to must equal the advertised facilitator payTo address'
  const base = PUBLIC_ORIGIN
  let expectedResource, expectedValue
  if (intent.resource === 'session') {
    expectedResource = 'session'
    expectedValue = String(10n ** BigInt(c.decimals - 2))
  } else {
    let u
    try { u = new URL(String(intent.resource), base) } catch { return 'intent.resource is not a valid gateway resource' }
    const allowedOrigin = u.origin === new URL(base).origin || u.origin === 'https://covenant.re'
    if (!allowedOrigin) return 'intent.resource must use the gateway origin'
    const selected = u.searchParams.get('chain')
    if ((chainId === facilitator.DEFAULT_CHAIN_ID && selected !== null) || (chainId !== facilitator.DEFAULT_CHAIN_ID && selected !== String(chainId))) return 'intent.resource chain does not match payload.chainId'
    if (u.pathname === '/x402/premium' && [...u.searchParams.keys()].every(k => k === 'chain')) {
      expectedResource = base + '/x402/premium' + (chainId === facilitator.DEFAULT_CHAIN_ID ? '' : `?chain=${chainId}`)
      expectedValue = String(10n ** BigInt(c.decimals - 2))
    } else if (u.pathname.startsWith('/x402/api/')) {
      const slug = u.pathname.slice('/x402/api/'.length)
      if (!/^[a-z0-9-]{1,32}$/.test(slug)) return 'unknown paid API resource'
      const rec = x402r.get(slug)
      const mkt = rec ? null : marketplace.get(slug)
      if (!rec && !mkt) return 'unknown paid API resource'
      if (mkt && chainId !== facilitator.DEFAULT_CHAIN_ID) return 'marketplace listings settle on Robinhood Chain 4663 only'
      const plan = u.searchParams.get('plan') === '1'
      if ([...u.searchParams.entries()].some(([k, v]) => (k !== 'chain' && !(k === 'plan' && v === '1')))) return 'intent.resource has unsupported query parameters'
      if (plan && (!mkt || !mkt.plan)) return 'this API has no subscription plan'
      expectedResource = base + '/x402/api/' + slug + (plan ? '?plan=1' : '') + (chainId === facilitator.DEFAULT_CHAIN_ID ? '' : `${plan ? '&' : '?'}chain=${chainId}`)
      expectedValue = plan ? String(mkt.plan.atomic) : x402r.priceToAtomic((mkt || rec).price, chainId)
    } else if (u.pathname === '/x402/upto/echo') {
      // "upto" scheme: the signed intent.value must equal the advertised
      // CEILING exactly (same floor-clamped ceiling the 402 handler
      // quoted) — the buyer authorizes the worst case once; the actual
      // per-request charge is computed server-side in /facilitator/settle
      // via actualValue, always <= this ceiling, never equal to the real
      // usage at the signature level (that's the whole point of upto).
      // `text` is bound into the resource URL (like `chain` is) so the
      // settled receipt can only unlock a reply for THIS exact text —
      // without that binding, a buyer could settle against a short/cheap
      // text then replay the receipt against a longer ?text= value on
      // the actual GET and get extra words delivered for free.
      if ([...u.searchParams.keys()].some(k => k !== 'chain' && k !== 'text')) return 'intent.resource has unsupported query parameters'
      const boundText = u.searchParams.get('text') || ''
      const qs = new URLSearchParams()
      qs.set('text', boundText)
      if (chainId !== facilitator.DEFAULT_CHAIN_ID) qs.set('chain', String(chainId))
      expectedResource = base + '/x402/upto/echo?' + qs.toString()
      const uptoCeilingUsd = Math.max(uptoDemo.ceilingPriceUsd(), c.minSettlePriceUsd)
      expectedValue = uptoDemo.toAtomic(uptoCeilingUsd, chainId)
    } else return 'intent.resource is not a paid gateway endpoint'
  }
  const actualResource = String(intent.resource).replace('https://covenant.re', base)
  if (actualResource !== expectedResource) return 'intent.resource does not match the quoted gateway resource'
  try { if (BigInt(intent.value) !== BigInt(expectedValue)) return 'intent.value does not match the quoted price' } catch { return 'intent.value is invalid' }
  return null
}

/* Marketplace fee split, derived SERVER-SIDE from the payment intent's
   resource — the client never dictates legs. If the paid resource maps to an
   active listing, push the seller's share; the fee stays in the facilitator
   wallet. Guard: intent.to must be the facilitator wallet itself. */
function serverSplitsFor(intent, chainId = facilitator.DEFAULT_CHAIN_ID) {
  try {
    const res = String(intent?.resource || '')
    if (!res.includes('/x402/api/')) return null
    const slug = res.split('/x402/api/')[1].split(/[/?#]/)[0]
    const mkt = marketplace.get(slug)
    if (!mkt) return null
    const spender = (facilitator.publicView(chainId).spender || '').toLowerCase()
    if (!spender || String(intent.to).toLowerCase() !== spender) return null
    // Tahap 5 — a plan purchase pays the discounted PLAN price, not per-call.
    if (/\?plan=1$/.test(res) && mkt.plan) {
      const { sellerShare } = marketplace.splitPrice(mkt.plan.price)
      return [{ to: mkt.seller, value: sellerShare }]
    }
    const { sellerShare } = marketplace.splitPrice(mkt.price)
    return [{ to: mkt.seller, value: sellerShare }]
  } catch { return null }
}

/**
 * Deliver a paid API response for the API-key (prepaid balance) path.
 * Marketplace listings: pay the seller's 95% leg from escrow AFTER the buyer
 * receives the payload; on upstream failure the debit is refunded to the
 * balance instantly (the escrow never left the wallet).
 */
async function deliverByKey(res, slug, mkt, rec, owner, priceAtomic, sub) {
  if (mkt) {
    let payload = null, fetchErr = null, latencyMs = null
    const t0 = Date.now()
    try { payload = await marketplace.fetchJson(mkt.upstream, 8000, 0, marketplace.privateHeadersFor(mkt) || undefined) } catch (e) { fetchErr = e.message }
    latencyMs = Date.now() - t0
    let sellerTx = null
    if (payload) {
      if (sub) {
        // Tahap 5 — quota call: the seller was already paid (95% of the plan
        // price) when the subscription was bought. Just deliver + count it.
        marketplace.recordSettle(slug, { sellerShareAtomic: 0n, latencyMs })
      } else {
        const { sellerShare } = marketplace.splitPrice(mkt.price)
        try {
          const leg = await facilitator.payout({ to: mkt.seller, value: sellerShare, reason: `balance call ${slug}` })
          sellerTx = leg.txHash
          marketplace.recordSettle(slug, { sellerShareAtomic: sellerShare, latencyMs })
        } catch (e) {
          // escrow still holds the money — give the buyer their debit back
          balance.credit(owner.address, priceAtomic, `auto-refund ${slug}: payout failed`)
          console.error('balance seller payout failed', slug, e.message)
          send(res, 200, { ok: false, refunded: true, message: `Seller endpoint failed after payment — balance refunded.`, error: fetchErr || e.message })
          return
        }
      }
    } else {
      marketplace.recordFail(slug)
      if (sub) marketplace.refundSub(slug, owner.address) // call goes back in the bucket
      else balance.credit(owner.address, priceAtomic, `auto-refund ${slug}: upstream failed`)
      x402r.log('paid', { slug, path: '/api/' + slug, price: mkt.price }, { status: 200 })
      send(res, 200, {
        ok: true, access: 'granted', api: '/api/' + slug, price: mkt.price,
        marketplace: true, seller: mkt.seller, via: 'api-key', balanceCharged: false,
        subscription: sub ? true : undefined, callsRemaining: sub ? sub.remaining : undefined,
        deliveredAt: Date.now(),
        payload: { message: `Payment for ${mkt.name} — seller endpoint failed (${fetchErr}). ${sub ? 'Your subscription call was refunded.' : 'Your balance was refunded.'}`, refunded: true },
      })
      return
    }
    x402r.log('paid', { slug, path: '/api/' + slug, price: mkt.price }, { status: 200 })
    send(res, 200, {
      ok: true, access: 'granted', api: '/api/' + slug, price: mkt.price,
      marketplace: true, seller: mkt.seller, via: 'api-key',
      subscription: sub ? true : undefined, callsRemaining: sub ? sub.remaining : undefined,
      balanceRemaining: ethers.formatUnits(BigInt(owner.balanceAtomic || 0), 6),
      sellerPayment: sellerTx ? { tx: sellerTx } : undefined,
      deliveredAt: Date.now(), payload,
    })
    return
  }
  // COVENANT's own route, paid from balance
  let payload = null
  try { payload = await dataProviders.payloadFor(rec.slug) } catch (e) {
    console.error('payload fetch failed for', rec.slug, e.message)
    balance.credit(owner.address, priceAtomic, `auto-refund ${rec.slug}: feed failed`)
  }
  x402r.log('paid', rec, { status: 200 })
  send(res, 200, {
    ok: true, access: 'granted', api: rec.path, price: rec.price, via: 'api-key',
    balanceRemaining: payload ? ethers.formatUnits(BigInt(owner.balanceAtomic || 0), 6) : undefined,
    deliveredAt: Date.now(),
    payload: payload || { message: `Payment for ${rec.path} — upstream feed temporarily unavailable, retry shortly`, refunded: !payload ? true : undefined },
  })
}

function readBody(req, cb) {
  let body = ''
  req.on('data', c => { body += c; if (body.length > 5e4) req.destroy() })
  req.on('end', () => {
    if (!body) { cb(null, {}); return }
    let payload
    try { payload = JSON.parse(body) } catch { cb(new Error('bad json')); return }
    // JSON `null` and scalars parse without error, but handlers read fields off them.
    if (payload === null || typeof payload !== 'object') { cb(new Error('bad json')); return }
    cb(null, payload)
  })
}

const articleCache = new Map() // url -> {t, json}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-api-key,x-payment')
  res.setHeader('Access-Control-Expose-Headers', 'X-PAYMENT,X-PAYMENT-REQUIRED,X-PAYMENT-REQUIRED-V1,Payment-Required,Content-Type')
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

  // ============ discovery routes (routes/discovery.js) ============
  if (await discovery.handle(req, res, url)) return

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

  /* x402 "upto" scheme demo — the one resource on this gateway with a
     genuinely variable price (every other paid route is flat-rate
     "exact"). See upto-demo.js for the honest framing of what this does
     and doesn't prove. Standalone route (not routed through the generic
     /x402/api/:slug registry/marketplace dispatcher, which assumes a
     fixed per-route price end to end) so the exact/upto code paths stay
     separable instead of threading a scheme branch through that whole
     flow for a single demo endpoint.
     GET ?text=... — the 402 challenge always advertises the WORST-CASE
     ceiling (upto-demo's WORDS_CAP words); settlement only ever pulls the
     real per-request cost, computed server-side from the actual text,
     never from a buyer-supplied amount. */
  if ((req.method === 'GET' || req.method === 'POST') && url.startsWith('/x402/upto/echo')) {
    const reqUrl = new URL(req.url, PUBLIC_ORIGIN)
    const chainParam = reqUrl.searchParams.get('chain')
    let chainId = facilitator.DEFAULT_CHAIN_ID
    if (chainParam) {
      if (!facilitator.chains.isSupported(chainParam)) { send(res, 400, { error: `unsupported chain: ${chainParam}`, supported: facilitator.chains.listChains().map(c => c.id) }); return }
      chainId = Number(chainParam)
    }
    if (!facilitator.isConfigured(chainId)) { send(res, 503, { error: `chain unavailable: settlement RPC is not configured for ${facilitator.chains.getChain(chainId).name}` }); return }
    const chain = facilitator.chains.getChain(chainId)
    const text = reqUrl.searchParams.get('text') || ''
    // Resource URL binds `text` the same way validateQuotedIntent expects
    // it (text always present, chain only when non-default) — the settled
    // receipt can only unlock a reply for THIS exact text.
    const resQs = new URLSearchParams()
    resQs.set('text', text)
    if (chainParam) resQs.set('chain', String(chainId))
    const resource = PUBLIC_ORIGIN + '/x402/upto/echo?' + resQs.toString()

    const paid = paidFor(req.headers['x-payment'], resource, chainId)
    if (!paid) {
      const payTo = facilitator.publicView(chainId).spender || process.env.COVENANT_X402_PAYTO || '0x0000000000000000000000000000000000000000'
      // Ceiling: sized for the worst case (WORDS_CAP words), floor-clamped
      // per chain the same way /x402/premium's sample price is — a
      // ceiling below the chain's own settlement-cost floor would be
      // unsettleable even in the best case.
      const ceilingUsd = Math.max(uptoDemo.ceilingPriceUsd(), chain.minSettlePriceUsd)
      const ceilingAtomic = uptoDemo.toAtomic(ceilingUsd, chainId)
      send402(res, {
        x402Version: 1,
        error: 'PAYMENT_REQUIRED',
        accepts: [{
          scheme: 'upto',
          network: `eip155:${chainId}`,
          maxAmountRequired: ceilingAtomic,
          resource,
          description: `COVENANT upto-scheme demo: word-count echo, up to ${uptoDemo.WORDS_CAP} words. Ceiling ${ceilingUsd} ${chain.usdcSymbol} on ${chain.name} — actual charge is per-word, computed server-side, settled by POST /facilitator/settle with the real usage (never more than this ceiling).`,
          mimeType: 'application/json',
          payTo,
          maxTimeoutSeconds: 60,
          asset: chain.usdc,
          extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, spender: payTo, pricePerWordUsd: uptoDemo.PRICE_PER_WORD_USD, wordsCap: uptoDemo.WORDS_CAP },
        }],
      })
      return
    }

    if (!facilitator.claimReceipt(paid.nonce, paid.chainId)) { send(res, 409, { error: 'receipt already redeemed' }); return }
    const n = uptoDemo.wordCount(text)
    const actualUsd = uptoDemo.actualPriceUsd(text)
    send(res, 200, {
      ok: true,
      api: 'upto-echo',
      scheme: 'upto',
      tx: paid.txHash,
      payer: paid.from,
      payload: { text, wordCount: Math.min(n, uptoDemo.WORDS_CAP), actualChargeUsd: actualUsd, note: n > uptoDemo.WORDS_CAP ? `input truncated to the ${uptoDemo.WORDS_CAP}-word cap for pricing` : undefined },
    })
    return
  }

  // x402scan / agent probes use method-aware fallback (often POST or HEAD
  // before GET). Any of GET/POST/HEAD must reach the same 402-challenge path
  // instead of falling through to the generic 404 — that 404 is exactly what
  // made these routes register as "no valid x402 response found".
  if ((req.method === 'GET' || req.method === 'POST' || req.method === 'HEAD') && url.startsWith('/x402/api/')) {
    const slug = url.slice('/x402/api/'.length).split('/')[0]
    const reqUrl = new URL(req.url, PUBLIC_ORIGIN)
    const chainParam = reqUrl.searchParams.get('chain')
    let chainId = facilitator.DEFAULT_CHAIN_ID
    if (chainParam) {
      if (!facilitator.chains.isSupported(chainParam)) { send(res, 400, { error: `unsupported chain: ${chainParam}`, supported: facilitator.chains.listChains().map(c => c.id) }); return }
      chainId = Number(chainParam)
    }
    if (!facilitator.isConfigured(chainId)) { send(res, 503, { error: `chain unavailable: settlement RPC is not configured for ${facilitator.chains.getChain(chainId).name}` }); return }
    const wantPlan = /[?&]plan=1/.test(req.url) // Tahap 5: buy an N-call subscription
    let rec = x402r.get(slug)
    const mkt = rec ? null : marketplace.get(slug)
    if (!rec && !mkt) { send(res, 404, { error: 'unknown api' }); return }
    // Marketplace's seller fee split / subscription ledger is still anchored
    // to the Robinhood escrow wallet. Core COVENANT APIs are multichain now;
    // reject a marketplace purchase on another chain loudly instead of
    // accepting USDC there and accidentally attempting a seller payout from
    // a different escrow balance. Marketplace multichain is a separate
    // financial-product migration, not something to fake with a dropdown.
    if (mkt && chainId !== facilitator.DEFAULT_CHAIN_ID) {
      send(res, 400, { error: 'marketplace listings currently settle on Robinhood Chain 4663 only; choose Robinhood or use a core COVENANT API on this chain' })
      return
    }
    const resource = PUBLIC_ORIGIN + '/x402/api/' + slug + (wantPlan ? '?plan=1' : '') + (chainParam ? `${wantPlan ? '&' : '?'}chain=${chainId}` : '')
    // ---- API-key path (prepaid balance): no per-call wallet signature ----
    const apiKey = req.headers['x-api-key']
    if (apiKey) {
      if (wantPlan) { send(res, 400, { error: 'subscription purchase requires a wallet payment (X-PAYMENT), not an API-key debit' }); return }
      const owner = balance.ownerByKey(String(apiKey))
      if (!owner) { send(res, 401, { error: 'invalid api key' }); return }
      // Tahap 5 — a purchased subscription is spent BEFORE any balance debit.
      const sub = mkt && !wantPlan ? marketplace.consumeSub(slug, owner.address) : null
      const priceAtomic = x402r.priceToAtomic((mkt || rec).price)
      let debitAmt = BigInt(priceAtomic)
      if (!sub) {
        const d = balance.debit(owner.address, priceAtomic, 'call /api/' + slug)
        if (!d.ok) { send(res, 402, { error: 'insufficient balance', balance: ethers.formatUnits(BigInt(owner.balanceAtomic || 0), 6), topUp: '/x402/balance/topup' }); return }
      }
      balance.touchKey(owner.address, String(apiKey))
      await deliverByKey(res, slug, mkt, rec, owner, sub ? 0n : debitAmt, sub)
      return
    }
    const paid = paidFor(req.headers['x-payment'], resource, chainId)
    if (!paid && !rec) {
      // marketplace listing: build the challenge from the listing record
      marketplace.recordHit(slug)
      const reqt = marketplace.requirement(mkt, resource, facilitator.publicView().spender)
      if (wantPlan) {
        // Tahap 5 — subscription purchase: the challenge carries the PLAN price.
        if (!mkt.plan) { send(res, 400, { error: 'this API has no subscription plan' }); return }
        reqt.maxAmountRequired = mkt.plan.atomic
        reqt.description = `${mkt.name} — ${mkt.plan.calls} calls for ${mkt.plan.price} USDG (subscription)`
        reqt.extra = { ...reqt.extra, plan: true, planCalls: mkt.plan.calls, planPrice: mkt.plan.price }
      }
      send402(res, { x402Version: 1, error: 'PAYMENT_REQUIRED', accepts: [reqt] })
      return
    }
    if (!paid) {
      x402r.bump(slug)
      const reqt = x402r.requirement(rec, resource, chainId, facilitator.publicView(chainId).spender)
      // requirement() includes chainId/asset/spender; explicit assignment
      // keeps the original response shape for older callers too.
      reqt.extra = { ...reqt.extra, spender: facilitator.publicView(chainId).spender || null, chainId }
      send402(res, { x402Version: 1, error: 'PAYMENT_REQUIRED', accepts: [reqt] })
      return
    }
    // One receipt = one delivery. Without this, a single X-PAYMENT replays
    // forever: plan grants and marketplace payouts re-run on every request.
    if (!facilitator.claimReceipt(paid.nonce, paid.chainId)) { send(res, 409, { error: 'receipt already redeemed' }); return }
    // settled on-chain (nonce anchored to a tx) → deliver the REAL resource.
    if (mkt && wantPlan) {
      // Tahap 5 — plan purchase: payment already settled at the discounted
      // price. Finalize the seller leg, grant the quota, no upstream fetch.
      if (!mkt.plan) { send(res, 400, { error: 'this API has no subscription plan' }); return }
      let splitLegs = null
      try { splitLegs = await facilitator.finalizeSplits(paid.txHash) }
      catch (e) { console.error('finalize plan splits failed', slug, e.message) }
      if (splitLegs && splitLegs.length) {
        const { sellerShare } = marketplace.splitPrice(mkt.plan.price)
        marketplace.recordSettle(slug, { sellerShareAtomic: sellerShare, latencyMs: 0 })
      }
      const s = marketplace.grantSub(slug, paid.from, paid.txHash)
      x402r.log('paid', { slug, path: '/api/' + slug, price: mkt.plan.price, plan: true }, { status: 200 })
      send(res, 200, {
        ok: true, access: 'granted', api: '/api/' + slug, marketplace: true, seller: mkt.seller,
        subscription: true, planCalls: s.planCalls, planPrice: s.planPrice,
        callsRemaining: s.remaining, tx: paid.txHash, payer: paid.from,
        sellerPayment: splitLegs && splitLegs[0] ? { tx: splitLegs[0].txHash } : undefined,
        payload: { message: `${s.planCalls} calls granted for ${mkt.name}. Use your API key or X-PAYMENT receipts — remaining: ${s.remaining}.` },
      })
      return
    }
    if (mkt) {
      // marketplace listing: proxy the seller's upstream JSON.
      // Seller earning is finalized (95% pushed on-chain) ONLY after the buyer
      // actually received the payload. If the seller's endpoint fails, the
      // buyer is refunded in full from the facilitator wallet (best-effort).
      let payload = null, fetchErr = null, latencyMs = null
      const t0 = Date.now()
      try { payload = await marketplace.fetchJson(mkt.upstream, 8000, 0, marketplace.privateHeadersFor(mkt) || undefined) } catch (e) { fetchErr = e.message }
      latencyMs = Date.now() - t0
      let splitLegs = null, refund = null
      if (payload) {
        try { splitLegs = await facilitator.finalizeSplits(paid.txHash) }
        catch (e) { console.error('finalize splits failed', slug, e.message) }
        if (splitLegs && splitLegs.length) {
          const { sellerShare } = marketplace.splitPrice(mkt.price)
          marketplace.recordSettle(slug, { sellerShareAtomic: sellerShare, latencyMs })
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
    // COVENANT's own route: payloadFor() hits live feeds (RSS / GeckoTerminal)
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

  // x402 playground — Apache-2.0 protocol shape (x402-foundation/x402). Unpaid GET/POST/HEAD → 402.
  // scheme is "exact" to match the OpenAPI x-payment-info declaration — x402scan's
  // parser rejects challenges whose runtime scheme doesn't match the discovery doc.
  // Settlement itself (facilitator.settle) verifies the signed EIP-712 intent, not
  // this label, so relabeling covenant-intent -> exact is safe and doesn't change
  // the actual approve+transferFrom flow.
  //
  // ?chain=<id> selects which supported chain (see GET /chains) to challenge
  // for — defaults to Robinhood 4663 (facilitator.DEFAULT_CHAIN_ID) so every
  // pre-multichain caller that never passes ?chain keeps working unchanged.
  if (req.url.startsWith('/x402/premium') || req.url === '/x402' || req.url === '/x402/') {
    const reqUrl = new URL(req.url, PUBLIC_ORIGIN)
    const chainParam = reqUrl.searchParams.get('chain')
    let chainId = facilitator.DEFAULT_CHAIN_ID
    if (chainParam) {
      if (!facilitator.chains.isSupported(chainParam)) { send(res, 400, { error: `unsupported chain: ${chainParam}`, supported: facilitator.chains.listChains().map(c => c.id) }); return }
      chainId = Number(chainParam)
    }
    if (!facilitator.isConfigured(chainId)) { send(res, 503, { error: `chain unavailable: settlement RPC is not configured for ${facilitator.chains.getChain(chainId).name}` }); return }
    const chain = facilitator.chains.getChain(chainId)
    const payTo = facilitator.publicView(chainId).spender || process.env.COVENANT_X402_PAYTO || '0x0000000000000000000000000000000000000000'
    // Price the sample at max(0.01, this chain's settlement-cost floor) —
    // a flat 0.01 on every chain used to challenge below Ethereum's floor
    // ($0.05), which facilitator.settle() now rejects outright: the agent
    // would sign and "pay" a challenge that can never actually settle.
    // Pick whichever is higher so cheap chains (Robinhood/Base/Arbitrum)
    // keep the familiar $0.01 sample price unchanged.
    const samplePriceUsd = Math.max(0.01, chain.minSettlePriceUsd)
    const priceAtomic = String(BigInt(Math.round(samplePriceUsd * 10 ** chain.decimals)))
    const body = {
      x402Version: 1,
      error: 'PAYMENT_REQUIRED',
      accepts: [{
        scheme: 'exact',
        network: `eip155:${chainId}`,
        maxAmountRequired: priceAtomic,
        resource: PUBLIC_ORIGIN + '/x402/premium' + (chainParam ? `?chain=${chainId}` : ''),
        description: `COVENANT premium alert sample — ${samplePriceUsd} ${chain.usdcSymbol} on ${chain.name}`,
        mimeType: 'application/json',
        payTo,
        maxTimeoutSeconds: 60,
        asset: chain.usdc,
        extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, spender: payTo }
      },
      {
        // session option: pay once, call N times (Stripe MPP-style session intent)
        scheme: 'covenant-session',
        network: `eip155:${chainId}`,
        maxAmountRequired: priceAtomic,
        resource: 'session',
        description: `COVENANT session — ${samplePriceUsd} ${chain.usdcSymbol} for 100 calls / 1h on ${chain.name} (set extra.calls/ttlSec to customize)`,
        mimeType: 'application/json',
        payTo,
        maxTimeoutSeconds: 60,
        asset: chain.usdc,
        extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, spender: payTo, calls: 100, ttlSec: 3600 }
      }]
    }
    x402r.log('402', { slug: 'premium', path: '/premium', price: String(samplePriceUsd) })
    send402(res, body)
    return
  }

  // facilitator status (shows settlement config, no secrets). ?chain=<id>
  // selects which chain's view to return — defaults to Robinhood 4663.
  if (req.method === 'GET' && url === '/facilitator') {
    const reqUrl = new URL(req.url, PUBLIC_ORIGIN)
    const chainParam = reqUrl.searchParams.get('chain')
    if (chainParam && !facilitator.chains.isSupported(chainParam)) { send(res, 400, { error: `unsupported chain: ${chainParam}` }); return }
    res.end(JSON.stringify(facilitator.publicView(chainParam ? Number(chainParam) : undefined)))
    return
  }

  // verify a signed payment intent (no settlement). chainId in the body
  // selects the domain/asset to verify against — defaults to Robinhood 4663.
  if (req.method === 'POST' && url === '/facilitator/verify') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      facilitator.verify(payload.intent, payload.signature, payload.chainId).then(v => {
        send(res, 200, { isValid: v.ok, invalidReason: v.reason || undefined, payer: v.payer || undefined })
      })
    })
    return
  }

  // settle a signed payment intent on-chain (approve+transferFrom).
  // Two resource shapes:
  //   - "session" (with calls/ttl in extra) → opens a paid session for N calls
  //   - anything else → one-shot resource payment
  // payload.chainId picks which chain to settle on — defaults to Robinhood
  // 4663, so callers that never send chainId keep the exact pre-multichain
  // behavior.
  if (req.method === 'POST' && url === '/facilitator/settle') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const chainId = payload.chainId != null ? Number(payload.chainId) : facilitator.DEFAULT_CHAIN_ID
      if (!facilitator.chains.isSupported(chainId)) { send(res, 400, { error: `unsupported chain: ${chainId}` }); return }
      if (!facilitator.isConfigured(chainId)) { send(res, 503, { error: `chain unavailable: settlement RPC is not configured for ${facilitator.chains.getChain(chainId).name}` }); return }
      const quoteError = validateQuotedIntent(payload.intent, chainId)
      if (quoteError) { send(res, 400, { error: quoteError }); return }
      if (!resourceChainMatches(payload.intent?.resource, chainId)) {
        send(res, 400, { error: 'intent resource chain does not match payload.chainId — request a fresh 402 challenge for the selected chain' })
        return
      }
      // "upto" scheme: compute the real charge server-side from the text
      // bound into intent.resource (validateQuotedIntent already confirmed
      // the resource is well-formed and matches the signed ceiling) —
      // NEVER from a client-supplied amount. null (the default) means
      // "exact": settle() charges the full signed value, unchanged.
      let actualValue = null
      try {
        const ru = new URL(String(payload.intent?.resource || ''), PUBLIC_ORIGIN)
        if (ru.pathname === '/x402/upto/echo') {
          const boundText = ru.searchParams.get('text') || ''
          const c = facilitator.chains.getChain(chainId)
          // Clamp the real per-word cost up to this chain's settlement
          // floor, same policy as every other route: never settle below
          // what gas costs. A short text's literal word-count price could
          // otherwise land under Ethereum's $0.05 floor and get rejected
          // by settle()'s own floor check — charging the floor instead of
          // rejecting outright keeps "pay less than the ceiling" working
          // for short inputs instead of failing them.
          const actualUsd = Math.max(uptoDemo.actualPriceUsd(boundText), c.minSettlePriceUsd)
          actualValue = uptoDemo.toAtomic(actualUsd, chainId)
        }
      } catch { /* not a URL resource (e.g. "session") — exact scheme, actualValue stays null */ }
      facilitator.settle(payload.intent, payload.signature, serverSplitsFor(payload.intent, chainId), chainId, actualValue).then(v => {
        vault.audit(v.success ? 'settle-ok' : 'settle-fail', v.payer || null, { tx: v.transaction || v.errorReason, chainId })
        let out = v
        if (v.success) {
          reputation.record(v.payer, {
            valueFormatted: (Number(payload.intent?.value || 0) / (10 ** facilitator.chains.getChain(chainId).decimals)).toFixed(6),
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
              chainId,
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
    const addr = (req.url.split('?')[1] || '').match(/address=(0x[0-9a-fA-F]{40})/i)?.[1] || null
    send(res, 200, {
      self: agent ? { id: agent.id, label: agent.label, hits: agent.hits, lastUsed: agent.lastUsed } : null,
      queried: addr ? reputation.score(addr) : null,
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
    res.end(JSON.stringify({ ...vault.stats(), service: 'covenant-vault' }))
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
        vault: { ok: true, entries: vault.count() },
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
    const routeOf = (r) => { try { const pn = new URL(r).pathname; return pn.includes('/api/') ? '/api' + pn.slice(pn.indexOf('/api/') + 4) : pn } catch (_e) { return 'general' } }
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

  // ---- prepaid balances (Tahap 3): top up once, call with an API key ----
  // 1) challenge: what to sign/pay to top up
  if (req.method === 'GET' && url === '/x402/balance/topup') {
    const u = new URL(req.url, 'http://x')
    const buyer = u.searchParams.get('buyer') || ''
    const amount = u.searchParams.get('amount') || '5'
    if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) { send(res, 400, { error: 'buyer=0x… required' }); return }
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 1000) { send(res, 400, { error: 'amount must be 0.000001 … 1000' }); return }
    send(res, 402, {
      x402Version: 1, error: 'PAYMENT_REQUIRED',
      accepts: [{
        scheme: 'exact', network: 'eip155:4663',
        maxAmountRequired: String(x402r.priceToAtomic(amount)),
        resource: PUBLIC_ORIGIN + '/x402/balance/topup',
        description: `COVENANT balance top-up ${amount} USDG for ${buyer}`,
        mimeType: 'application/json',
        payTo: facilitator.publicView().spender,
        maxTimeoutSeconds: 60, asset: x402r.USDG,
        extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION, topup: true, buyer, amount },
      }],
    })
    return
  }
  // 2) redeem a settled top-up receipt → credit the ledger
  if (req.method === 'POST' && url === '/x402/balance/redeem') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const paid = paidFor(payload['x-payment'] || payload.xPayment, PUBLIC_ORIGIN + '/x402/balance/topup')
      if (!paid) { send(res, 402, { error: 'PAYMENT_REQUIRED', reason: 'settle the top-up intent first (POST /facilitator/settle), then redeem its receipt' }); return }
      if (!facilitator.claimReceipt(paid.nonce)) { send(res, 409, { error: 'receipt already redeemed' }); return }
      const r = balance.credit(paid.from, paid.value, `top-up ${ethers.formatUnits(BigInt(paid.value), 6)} USDG`)
      if (!r.ok) { send(res, 400, { error: r.error }); return }
      send(res, 200, { ok: true, buyer: paid.from, credited: ethers.formatUnits(BigInt(paid.value), 6), balance: ethers.formatUnits(BigInt(r.balanceAtomic), 6), tx: paid.txHash })
    })
    return
  }
  // 3) create an API key (one signature per key, then zero signatures per call)
  if (req.method === 'POST' && url === '/x402/balance/keys') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const v = balance.verifyKeyIntent(payload.intent, payload.signature, facilitator.DOMAIN)
      if (!v.ok) { send(res, 401, { error: v.reason }); return }
      if (!facilitator.claimNonce(payload.intent.nonce)) { send(res, 409, { error: 'nonce already used' }); return }
      const k = balance.createKey(v.buyer)
      send(res, 201, { ok: true, key: k.key, buyer: k.address, note: 'Store it now — shown once. Use header: X-API-KEY' })
    })
    return
  }
  // 4) key list (metadata only, never the secrets)
  if (req.method === 'GET' && url.startsWith('/x402/balance/keys')) {
    const buyer = new URL(req.url, 'http://x').searchParams.get('buyer') || ''
    if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) { send(res, 400, { error: 'buyer=0x… required' }); return }
    send(res, 200, { ok: true, keys: balance.listKeys(buyer) })
    return
  }
  // 5) withdraw escrow back to the owner's wallet (owner-signed, replay-safe)
  if (req.method === 'POST' && url === '/x402/balance/withdraw') {
    readBody(req, async (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const intent = payload.intent || {}
      const v = balance.verifyWithdraw(intent, payload.signature, facilitator.DOMAIN)
      if (!v.ok) { send(res, 401, { error: v.reason }); return }
      if (!facilitator.claimNonce(intent.nonce)) { send(res, 409, { error: 'nonce already used' }); return }
      try {
        const d = balance.debit(v.buyer, v.amount, 'withdrawal')
        if (!d.ok) { facilitator.releaseNonce(intent.nonce); send(res, 400, { error: d.error }); return }
        const tx = await facilitator.payout({ to: v.buyer, value: v.amount, reason: 'balance withdrawal' })
        send(res, 200, { ok: true, buyer: v.buyer, amount: ethers.formatUnits(v.amount, 6), tx: tx.txHash, balance: ethers.formatUnits(BigInt(d.balanceAtomic), 6) })
      } catch (e) {
        balance.credit(v.buyer, v.amount, 'withdrawal failed, restored')
        facilitator.releaseNonce(intent.nonce)
        send(res, 502, { error: 'payout failed: ' + e.message })
      }
    })
    return
  }
  // 6) balance view (public per-address, like earnings)
  if (req.method === 'GET' && url.startsWith('/x402/balance')) {
    const buyer = new URL(req.url, 'http://x').searchParams.get('buyer') || ''
    if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) { send(res, 400, { error: 'buyer=0x… required' }); return }
    // Tahap 5 — include purchased subscriptions (quota buckets) for this buyer.
    const subs = marketplace.subsView(buyer)
    send(res, 200, { ok: true, ...balance.view(buyer), subs })
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
        headers: { 'User-Agent': 'covenant-console/1.0', 'Accept': 'text/plain' },
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
    const routeOf = (r) => { try { const pn = new URL(r).pathname; return pn.includes('/api/') ? '/api' + pn.slice(pn.indexOf('/api/') + 4) : pn } catch (_e) { return 'general' } }
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
      vault: { entries: vault.count(), brokered: vault.stats().brokered },
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
    res.end(JSON.stringify(vault.list(agent.id)))
    return
  }

  if (req.method === 'POST' && url === '/vault/entries') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      try {
        const rec = vault.put(agent.id, payload.name, payload.value)
        vault.audit('set', payload.name)
        send(res, 201, { ...rec, note: 'value stored encrypted; never returned' })
      } catch (e) { send(res, 400, { error: e.message || String(e) }) }
    })
    return
  }

  if (req.method === 'DELETE' && url === '/vault/entries') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const had = vault.del(agent.id, payload.name)
      vault.audit('delete', payload.name)
      send(res, had ? 200 : 404, had ? { ok: true } : { error: 'not found' })
    })
    return
  }

  if (req.method === 'POST' && url === '/vault/broker') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      const r = vault.resolve(agent.id, String(payload.text || ''))
      vault.audit('broker', r.used[0] || null, { placeholders: r.used.length })
      send(res, 200, { body: r.body, used: r.used, scrubbed: true })
    })
    return
  }

  if (req.method === 'POST' && url === '/wallets/create') {
    readBody(req, (err, payload) => {
      if (err) { send(res, 400, { error: 'bad json' }); return }
      try {
        const rec = wallets.create(agent.id, payload)
        send(res, 201, rec)
      } catch (e) { send(res, 400, { error: e.message || String(e) }) }
    })
    return
  }

  if (req.method === 'GET' && url === '/wallets') {
    res.end(JSON.stringify(wallets.list(agent.id)))
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

// Bind host is configurable: 127.0.0.1 by default (safe when a reverse proxy
// / tunnel sits in front, the deployment this was built for), 0.0.0.0 when
// explicitly opted in (e.g. inside a container, where 127.0.0.1 would only
// be reachable from within the container itself and port mapping to the
// host would silently do nothing).
const HOST = process.env.COVENANT_HOST || '127.0.0.1'
server.listen(PORT, HOST, () => console.log(`covenant-rpc-proxy on ${HOST}:${PORT}`))
