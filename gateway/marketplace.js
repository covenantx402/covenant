// marketplace.js — third-party paid APIs on the COVENANT x402 gateway.
//
// Anyone with a wallet can LIST their JSON API here. Buyers pay per call in
// USDG (same 402 → sign → settle flow as COVENANT's own routes). Settlement is
// split server-side: seller gets (price - fee), COVENANT keeps the fee.
//
// Listing authority is proven cryptographically, not with an account system:
// the seller signs an EIP-712 ListingIntent with their wallet; we recover the
// signer and require signer === seller. Revoke works the same way.
//
// Fee: COVENANT_MARKETPLACE_FEE_BPS (basis points, default 500 = 5%).
//
// SQLite-backed (see db.js) — was the last flat-JSON-rewrite-per-mutation
// module in the gateway (full marketplace.json rewritten on every
// hit/settle/refund). Public API (function signatures/return shapes)
// unchanged from the JSON-backed version — no caller edits needed.
const dns = require('dns')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { URL } = require('url')
const { ethers } = require('ethers')
const db = require('./db')

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const CHAIN_ID = 4663
const DOMAIN = { name: 'COVENANT', version: '1', chainId: CHAIN_ID, verifyingContract: USDG }

const stmts = {
  insertListing: db.prepare(`INSERT INTO marketplace_listings
    (slug, kind, name, description, upstream, price, seller, status, created_at,
     hits, paid, failed, refunded, earned_atomic, refunded_atomic,
     plan_calls, plan_price, plan_atomic, private_headers_enc)
    VALUES (?,?,?,?,?,?,?,?,?, 0,0,0,0,'0','0', ?,?,?,?)`),
  getListing: db.prepare('SELECT * FROM marketplace_listings WHERE slug = ?'),
  hasSlug: db.prepare('SELECT 1 FROM marketplace_listings WHERE slug = ?'),
  allActiveListings: db.prepare("SELECT * FROM marketplace_listings WHERE status = 'active'"),
  listingsBySeller: db.prepare('SELECT * FROM marketplace_listings WHERE seller = ? COLLATE NOCASE'),
  delist: db.prepare("UPDATE marketplace_listings SET status = 'delisted', delisted_at = ? WHERE slug = ?"),
  bumpHits: db.prepare('UPDATE marketplace_listings SET hits = hits + 1 WHERE slug = ?'),
  bumpFailed: db.prepare('UPDATE marketplace_listings SET failed = failed + 1 WHERE slug = ?'),
  bumpRefund: db.prepare('UPDATE marketplace_listings SET refunded = refunded + 1, refunded_atomic = ? WHERE slug = ?'),
  recordSettleUpd: db.prepare(`UPDATE marketplace_listings SET paid = paid + 1, earned_atomic = ?,
    lat_sum_ms = lat_sum_ms + ?, lat_n = lat_n + ?, last_latency_ms = COALESCE(?, last_latency_ms) WHERE slug = ?`),

  getSub: db.prepare('SELECT * FROM marketplace_subs WHERE slug = ? AND buyer = ?'),
  upsertSub: db.prepare(`INSERT INTO marketplace_subs (slug, buyer, plan_calls, plan_price, atomic, remaining, used, purchased_at, tx_hash)
    VALUES (?,?,?,?,?,?,0,?,?)
    ON CONFLICT(slug, buyer) DO UPDATE SET remaining = excluded.remaining + marketplace_subs.remaining, tx_hash = excluded.tx_hash`),
  setSubCounts: db.prepare('UPDATE marketplace_subs SET remaining = ?, used = ? WHERE slug = ? AND buyer = ?'),
  subsForBuyer: db.prepare('SELECT * FROM marketplace_subs WHERE buyer = ? COLLATE NOCASE AND remaining > 0'),

  nonceSeen: db.prepare('SELECT 1 FROM marketplace_nonces WHERE nonce = ?'),
  nonceInsert: db.prepare('INSERT INTO marketplace_nonces (nonce, t) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING'),
}

function rowToListing(r) {
  if (!r) return null
  const rec = {
    slug: r.slug, kind: r.kind, name: r.name, description: r.description,
    upstream: r.upstream, price: r.price, seller: r.seller, status: r.status,
    createdAt: r.created_at, hits: r.hits, paid: r.paid, failed: r.failed,
    refunded: r.refunded, earnedAtomic: r.earned_atomic, refundedAtomic: r.refunded_atomic,
    latSumMs: r.lat_sum_ms, latN: r.lat_n, lastLatencyMs: r.last_latency_ms,
  }
  if (r.delisted_at) rec.delistedAt = r.delisted_at
  if (r.plan_calls != null) rec.plan = { calls: r.plan_calls, price: r.plan_price, atomic: r.plan_atomic }
  if (r.private_headers_enc) rec.privateHeadersEnc = JSON.parse(r.private_headers_enc)
  return rec
}

/* ---------- private upstream headers (Tahap 4) ----------
 * Sellers whose upstream needs auth (e.g. an OpenAI key behind it) attach
 * request headers at listing time. They are AES-256-GCM encrypted with a
 * server key before being written to the store — plaintext never hits disk,
 * never appears in the catalog, and are only ever injected into the seller's
 * own upstream request at delivery time. */
function headerKey() {
  const raw = process.env.COVENANT_MARKETPLACE_HEADER_KEY ||
    crypto.createHash('sha256').update('covenant-marketplace-headers:' + (process.env.COVENANT_VAULT_KEY || process.env.COVENANT_RPC_UPSTREAM || 'covenant-local')).digest()
  return crypto.createHash('sha256').update(raw).digest()
}
function encryptHeaders(obj) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', headerKey(), iv)
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  return { v: 1, enc: enc.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}
function decryptHeaders(blob) {
  if (!blob || !blob.enc) return null
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', headerKey(), Buffer.from(blob.iv, 'base64'))
    d.setAuthTag(Buffer.from(blob.tag, 'base64'))
    return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.enc, 'base64')), d.final()]).toString('utf8'))
  } catch { return null }
}
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,48}$/
function sanitizePrivateHeaders(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('privateHeaders must be an object of header: value')
  const keys = Object.keys(raw)
  if (keys.length === 0) return null
  if (keys.length > 8) throw new Error('too many private headers (max 8)')
  const out = {}
  for (const k of keys) {
    if (!HEADER_NAME_RE.test(k)) throw new Error(`bad header name: ${k}`)
    const lk = k.toLowerCase()
    if (['host', 'content-length', 'connection', 'x-payment', 'x-api-key', 'cookie', 'set-cookie'].includes(lk))
      throw new Error(`header not allowed: ${k}`)
    const v = String(raw[k])
    if (!v || v.length > 512 || /[\r\n]/.test(v)) throw new Error(`bad value for header ${k}`)
    out[k] = v
  }
  return out
}
const LISTING_TYPES = {
  ListingIntent: [
    { name: 'seller', type: 'address' },
    { name: 'name', type: 'string' },
    { name: 'upstream', type: 'string' },
    { name: 'price', type: 'string' },
    { name: 'planCalls', type: 'uint256' },  // Tahap 5: 0 = no subscription plan
    { name: 'planPrice', type: 'string' },   // total USDG for planCalls (discounted)
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}
const REVOKE_TYPES = {
  RevokeIntent: [
    { name: 'seller', type: 'address' },
    { name: 'slug', type: 'string' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}
// Tahap 5 — seller signs the subscription plan definition once; buyers then
// purchase it with a normal x402 payment (no seller signature per sale).
// Not wired up yet (no caller) — kept as the EIP-712 type schema for when
// seller-signed plan creation ships; prefixed so the linter doesn't flag
// intentionally-unused scaffolding as dead code.
const _SUBSCRIBE_TYPES = {
  PlanIntent: [
    { name: 'seller', type: 'address' },
    { name: 'slug', type: 'string' },
    { name: 'calls', type: 'uint256' },
    { name: 'price', type: 'string' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

const FEE_BPS = Math.min(2000, Math.max(0, Number(process.env.COVENANT_MARKETPLACE_FEE_BPS ?? 500)))

function getSub(slug, buyer) {
  const r = stmts.getSub.get(String(slug), String(buyer).toLowerCase())
  if (!r) return null
  return { slug: r.slug, buyer: r.buyer, planCalls: r.plan_calls, planPrice: r.plan_price, atomic: r.atomic, remaining: r.remaining, used: r.used, purchasedAt: r.purchased_at, txHash: r.tx_hash }
}
function grantSub(slug, buyer, txHash) {
  const l = stmts.getListing.get(slug)
  if (!l || l.plan_calls == null) throw new Error('listing has no subscription plan')
  const buyerL = String(buyer).toLowerCase()
  stmts.upsertSub.run(slug, buyerL, l.plan_calls, l.plan_price, l.plan_atomic, l.plan_calls, Date.now(), txHash)
  // stacking: buying twice adds quota. ON CONFLICT above adds plan_calls to
  // existing remaining; tx_hash is overwritten to the latest purchase.
  return getSub(slug, buyerL)
}
function consumeSub(slug, buyer) {
  const s = stmts.getSub.get(String(slug), String(buyer).toLowerCase())
  if (!s || s.remaining <= 0) return null
  stmts.setSubCounts.run(s.remaining - 1, s.used + 1, slug, String(buyer).toLowerCase())
  return { ...getSub(slug, buyer) }
}
function refundSub(slug, buyer) { // upstream failed after a quota call — give the call back
  const s = stmts.getSub.get(String(slug), String(buyer).toLowerCase())
  if (!s) return
  stmts.setSubCounts.run(s.remaining + 1, Math.max(0, s.used - 1), slug, String(buyer).toLowerCase())
}
function subsView(buyer) { // for the balance card: quota buckets this buyer owns
  return stmts.subsForBuyer.all(String(buyer).toLowerCase())
    .map(s => ({ slug: s.slug, planCalls: s.plan_calls, planPrice: s.plan_price, remaining: s.remaining, used: s.used, purchasedAt: s.purchased_at }))
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'api'
}

function uniqueSlug(base) {
  let slug = base, i = 2
  while (stmts.hasSlug.get(slug) || usedSlugsExternal(slug)) slug = base + '-' + (i++)
  return slug
}
// route slugs shared with the x402-routes registry — filled in by server.js
let reservedSlugCheck = () => false
function setReservedSlugCheck(fn) { reservedSlugCheck = fn }
function usedSlugsExternal(slug) { return reservedSlugCheck(slug) }

/* ---------- fee math (atomic USDG = 6 decimals) ---------- */
const MIN_LISTING_ATOMIC = 10000n // 0.01 USDG
function splitPrice(price) {
  const [w, f = ''] = String(price).split('.')
  const atomic = BigInt((w + (f + '000000').slice(0, 6)).replace(/^0+(?=\d)/, '') || '0')
  if (atomic <= 0n) throw new Error('price must be > 0')
  const fee = atomic * BigInt(FEE_BPS) / 10000n
  const sellerShare = atomic - fee
  if (sellerShare <= 0n) throw new Error('price too small to split after fee')
  if (atomic < MIN_LISTING_ATOMIC) throw new Error('price must be at least 0.01 USDG (below that the fee rounds to zero and settlement gas exceeds revenue)')
  return { atomic, fee, sellerShare }
}

/* ---------- SSRF guard: only public https JSON endpoints ---------- */
// Strict allowlist approach (audit phase 2): an address is usable ONLY if net.isIP() accepts it AND it is
// global unicast. Every IPv6 form embedding an IPv4 (mapped, compat, NAT64, 6to4, Teredo) is judged on the
// embedded IPv4. Anything we cannot parse is private.
const net = require('net')
function v4ToInt(ip) { const p = ip.split('.').map(Number); return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 }
function inV4(ip, base, bits) { const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask) }
const V4_BLOCKS = [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]
function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true
  ip = ip.replace(/^\[|\]$/g, '').split('%')[0]
  const kind = net.isIP(ip)
  if (kind === 4) return V4_BLOCKS.some(([b, n]) => inV4(ip, b, n))
  if (kind !== 6) return true
  const v = ip.toLowerCase()
  const dotted = v.match(/(\d+\.\d+\.\d+\.\d+)$/)                      // ::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4
  if (dotted) return isPrivateIp(dotted[1])
  // expand to 8 hextets
  let [head, tail] = v.split('::'); const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : []
  const full = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  if (full.length !== 8) return true
  const g = full.map(x => parseInt(x || '0', 16))
  const emb = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  if (g.every(x => x === 0) || (g.slice(0, 7).every(x => x === 0) && g[7] === 1)) return true      // :: and ::1
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateIp(emb(g[6], g[7])) // mapped / compat
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateIp(emb(g[6], g[7]))                         // NAT64
  if (g[0] === 0x2002) return isPrivateIp(emb(g[1], g[2]))                                          // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true                                                    // Teredo
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return true // ULA, link-local, multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true                                                // documentation
  return !((g[0] & 0xe000) === 0x2000)                                                              // only 2000::/3 is global unicast
}

const LOOPBACK_OK = () => process.env.COVENANT_ALLOW_LOOPBACK_UPSTREAM === '1' // staging tests only

/** Validate a URL AND resolve it once. Returns { url, address, family } to pin the connection to. */
async function resolveSafeUpstream(rawUrl) {
  let u
  try { u = new URL(rawUrl) } catch { throw new Error('upstream must be a valid URL') }
  const loopbackOk = LOOPBACK_OK()
  const hostIsLoop = /^(127\.|\[?::1\]?$|localhost$)/.test(u.hostname)
  if (u.protocol !== 'https:' && !(loopbackOk && u.protocol === 'http:' && hostIsLoop)) throw new Error('upstream must be https')
  if (u.username || u.password) throw new Error('upstream URL must not embed credentials')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/(^|\.)(local|localhost|internal|localdomain|lan|home\.arpa)$/i.test(host) && !(loopbackOk && hostIsLoop)) throw new Error('upstream host not allowed')
  if (net.isIP(host)) {
    if (isPrivateIp(host) && !loopbackOk) throw new Error('upstream must be a public address')
    return { url: u, address: host, family: net.isIP(host) }
  }
  const addrs = await dns.promises.lookup(host, { all: true })
  if (!addrs.length) throw new Error('upstream host does not resolve')
  if (addrs.some(a => isPrivateIp(a.address)) && !loopbackOk) throw new Error('upstream resolves to a private address')
  return { url: u, address: addrs[0].address, family: addrs[0].family }
}
async function assertSafeUpstream(rawUrl) { return (await resolveSafeUpstream(rawUrl)).url }

/* ---------- listing / revoke ---------- */
function verifyIntent(intent, signature, types) {
  // `types` is the full EIP-712 types map, e.g. { ListingIntent: [...] }
  const now = Math.floor(Date.now() / 1000)
  if (!intent || typeof intent !== 'object') throw new Error('bad intent')
  if (!/^0x[0-9a-fA-F]{130,132}$/.test(String(signature || ''))) throw new Error('signature must be a 65-byte hex signature')
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(intent.nonce || ''))) throw new Error('nonce must be bytes32')
  intent.nonce = String(intent.nonce).toLowerCase()
  if (stmts.nonceSeen.get(intent.nonce)) throw new Error('intent nonce already used')
  const vb = BigInt(intent.validBefore || 0), va = BigInt(intent.validAfter || 0)
  if (vb <= BigInt(now)) throw new Error('intent expired')
  if (va > BigInt(now)) throw new Error('intent not yet valid')
  if (vb - BigInt(now) > 3600n) throw new Error('intent window too long (max 1h)')
  const signer = ethers.verifyTypedData(DOMAIN, types, intent, signature)
  if (signer.toLowerCase() !== String(intent.seller).toLowerCase()) throw new Error('signature does not match seller address')
  return signer
}

async function createListing({ name, description, upstream, price, seller, signature, nonce, validAfter, validBefore, privateHeaders, plan, planCalls: planCallsIn, planPrice: planPriceIn }) {
  if (!name || String(name).length > 48) throw new Error('name required (max 48 chars)')
  if (description && String(description).length > 240) throw new Error('description too long (max 240)')
  if (!/^\d+(\.\d{1,6})?$/.test(String(price || ''))) throw new Error('price must be a decimal, e.g. 0.02')
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(seller || ''))) throw new Error('seller must be a 0x address')
  const priv = sanitizePrivateHeaders(privateHeaders) // throws on malformed; null when absent
  const { atomic, fee, sellerShare } = splitPrice(price) // validates price
  // Tahap 5 — optional subscription plan: N calls for a discounted total.
  // planCalls/planPrice are part of the SIGNED ListingIntent, so the seller
  // commits to the deal price; buyers then buy it with a normal x402 payment.
  const planCalls = Number(plan?.calls ?? planCallsIn ?? 0)
  const planPrice = String(plan?.price ?? planPriceIn ?? '0')
  let planRec = null
  if (planCalls || planPrice !== '0') {
    if (!Number.isInteger(planCalls) || planCalls < 2 || planCalls > 1000) throw new Error('plan.calls must be an integer 2..1000')
    if (!/^\d+(\.\d{1,6})?$/.test(planPrice)) throw new Error('plan.price must be a decimal, e.g. 0.80')
    const planAtomic = splitPrice(planPrice).atomic
    if (planAtomic >= atomic * BigInt(planCalls)) throw new Error(`plan must be cheaper than pay-per-call (${price} × ${planCalls})`)
    planRec = { calls: planCalls, price: planPrice, atomic: String(planAtomic) }
  }
  await assertSafeUpstream(String(upstream))
  verifyIntent({ seller, name: String(name), upstream: String(upstream), price: String(price),
    planCalls: String(planRec ? planRec.calls : 0), planPrice: planRec ? planRec.price : '0',
    validAfter: validAfter || 0, validBefore, nonce }, signature, LISTING_TYPES)
  stmts.nonceInsert.run(String(nonce).toLowerCase(), Date.now())

  const slug = uniqueSlug(slugify(name))
  // Phase-1 guard: probe the seller's endpoint once. A listing that can't
  // answer with JSON today would only produce refunds later — reject it now.
  // Phase-4: the probe carries the seller's private headers, same as delivery.
  try { await fetchJson(String(upstream), 8000, 0, priv || undefined) }
  catch (e) { throw new Error(`upstream test failed — endpoint must answer GET with JSON (200): ${e.message}`, { cause: e }) }
  const description2 = description || `${name} — paid API on COVENANT marketplace (USDG, Robinhood 4663)`
  stmts.insertListing.run(
    slug, 'external', String(name), description2, String(upstream), String(price), seller, 'active', Date.now(),
    planRec ? planRec.calls : null, planRec ? planRec.price : null, planRec ? planRec.atomic : null,
    priv ? JSON.stringify(encryptHeaders(priv)) : null,
  )
  const rec = rowToListing(stmts.getListing.get(slug))
  return { rec, split: { atomic: String(atomic), fee: String(fee), sellerShare: String(sellerShare) } }
}

function revoke({ slug, seller, signature, nonce, validAfter, validBefore }) {
  const row = stmts.getListing.get(String(slug))
  if (!row || row.status !== 'active') throw new Error('listing not found or already delisted')
  // Only the listing's own seller may delist it (audit phase 2: any wallet could delist any listing).
  if (String(seller || '').toLowerCase() !== String(row.seller || '').toLowerCase()) throw new Error('not the listing owner')
  verifyIntent({ seller, slug: String(slug), validAfter: validAfter || 0, validBefore, nonce }, signature, REVOKE_TYPES)
  stmts.nonceInsert.run(String(nonce).toLowerCase(), Date.now())
  stmts.delist.run(Date.now(), String(slug))
  return rowToListing(stmts.getListing.get(slug))
}

/* ---------- delivery + accounting ---------- */
function get(slug) {
  const row = stmts.getListing.get(String(slug))
  return row && row.status === 'active' ? rowToListing(row) : null
}
function catalog() {
  return stmts.allActiveListings.all()
    .map(rowToListing)
    .sort((a, b) => (b.paid - a.paid) || (b.createdAt - a.createdAt))
    .map(l => ({
      slug: l.slug, name: l.name, description: l.description, price: l.price,
      plan: l.plan || null, // Tahap 5: { calls, price, atomic } when offered
      seller: l.seller, hits: l.hits, paid: l.paid,
      failed: l.failed || 0, refunded: l.refunded || 0,
      reputation: reputationOf(l),
      earned: ethers.formatUnits(BigInt(l.earnedAtomic || 0), 6),
      createdAt: l.createdAt,
    }))
}
function recordHit(slug) {
  if (stmts.getListing.get(slug)) stmts.bumpHits.run(slug)
}
function recordFail(slug) {
  if (stmts.getListing.get(slug)) stmts.bumpFailed.run(slug)
}
function recordRefund(slug, { sellerShareAtomic }) {
  const row = stmts.getListing.get(slug)
  if (!row) return
  const next = String(BigInt(row.refunded_atomic || 0) + BigInt(sellerShareAtomic || 0))
  stmts.bumpRefund.run(next, slug)
}
function recordSettle(slug, { sellerShareAtomic, latencyMs }) {
  const row = stmts.getListing.get(slug)
  if (!row) return
  const nextEarned = String(BigInt(row.earned_atomic || 0) + BigInt(sellerShareAtomic))
  const validLat = Number.isFinite(latencyMs) && latencyMs >= 0
  stmts.recordSettleUpd.run(
    nextEarned,
    validLat ? Math.round(latencyMs) : 0,
    validLat ? 1 : 0,
    validLat ? Math.round(latencyMs) : null,
    slug,
  )
}
/* Seller reputation: delivery success rate + average latency, from real
 * paid traffic only (delivered vs refunded). No traffic yet => null (shown as NEW). */
function reputationOf(l) {
  const ok = l.paid || 0, bad = l.refunded || 0
  const total = ok + bad
  return {
    delivered: ok, failed: bad,
    successRate: total ? Math.round((ok / total) * 100) : null,
    avgLatencyMs: l.latN ? Math.round(l.latSumMs / l.latN) : null,
    score: total >= 3 ? Math.round((ok / total) * 100) : null, // needs a little history before we grade
  }
}
function earningsFor(seller) {
  const mine = stmts.listingsBySeller.all(String(seller)).map(rowToListing)
  return {
    seller,
    feeBps: FEE_BPS,
    listings: mine.map(l => ({
      slug: l.slug, name: l.name, status: l.status, price: l.price,
      hits: l.hits, paid: l.paid, failed: l.failed || 0, refunded: l.refunded || 0,
      privateHeaders: !!l.privateHeadersEnc, // flag only — values stay encrypted at rest
      reputation: reputationOf(l),
      earned: ethers.formatUnits(BigInt(l.earnedAtomic || 0), 6),
    })),
    totalPaid: mine.reduce((s, l) => s + (l.paid || 0), 0),
    totalRefunded: mine.reduce((s, l) => s + (l.refunded || 0), 0),
    totalEarned: ethers.formatUnits(mine.reduce((s, l) => s + BigInt(l.earnedAtomic || 0), 0n), 6),
  }
}

/* ---------- 402 challenge for a marketplace listing ---------- */
function requirement(rec, resource, spender) {
  const { atomic } = splitPrice(rec.price)
  return {
    scheme: 'exact',
    network: 'eip155:4663',
    maxAmountRequired: String(atomic),
    resource,
    description: rec.description,
    mimeType: 'application/json',
    payTo: spender, // lands on the facilitator wallet; seller leg is pushed at settle
    maxTimeoutSeconds: 60,
    asset: USDG,
    extra: { name: DOMAIN.name, version: DOMAIN.version, marketplace: true, seller: rec.seller, feeBps: FEE_BPS, spender },
  }
}

/* ---------- upstream fetch (post-payment delivery) ---------- */
async function fetchJson(urlStr, timeoutMs = 8000, depth = 0, extraHeaders) {
  const { url: u, address, family } = await resolveSafeUpstream(urlStr)       // validates THIS hop
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'http:' ? http : https
    const headers = { accept: 'application/json', 'user-agent': 'COVENANT-marketplace/1.0', ...(extraHeaders || {}) }
    // lookup() is pinned to the address we just validated: DNS cannot change between check and connect.
    const lookup = (_h, _o, cb) => (_o && _o.all) ? cb(null, [{ address, family }]) : cb(null, address, family)
    const req = lib.get(u, { headers, timeout: timeoutMs, lookup }, res => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        res.resume()
        if (depth >= 2) { reject(new Error('too many redirects')); return }
        let next
        try { next = new URL(res.headers.location, u) } catch { reject(new Error('bad redirect')); return }
        const carry = next.host === u.host ? extraHeaders : undefined          // never leak seller secrets cross-host
        fetchJson(next.toString(), timeoutMs, depth + 1, carry).then(resolve, reject)  // re-validated on entry
        return
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('upstream HTTP ' + res.statusCode)); return }
      let out = ''
      res.on('data', c => { out += c; if (out.length > 262144) { res.destroy(new Error('upstream response too large (>256KB)')) } })
      res.on('end', () => {
        try { resolve(JSON.parse(out)) } catch { reject(new Error('upstream did not return valid JSON')) }
      })
      res.on('error', reject)
    })
    req.on('error', reject).on('timeout', function () { this.destroy(new Error('upstream timeout')) })
  })
}

module.exports = {
  createListing, revoke, get, catalog, recordHit, recordFail, recordRefund, recordSettle, earningsFor, reputationOf,
  fetchJson, assertSafeUpstream, sanitizePrivateHeaders, isPrivateIp, exists: (slug) => !!stmts.getListing.get(String(slug)), splitPrice, setReservedSlugCheck, requirement,
  getSub, grantSub, consumeSub, refundSub, subsView,
  privateHeadersFor: (rec) => (rec && rec.privateHeadersEnc ? decryptHeaders(rec.privateHeadersEnc) : null),
  DOMAIN, LISTING_TYPES, REVOKE_TYPES, FEE_BPS,
}
