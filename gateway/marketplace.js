// marketplace.js — third-party paid APIs on the TRIBUTE x402 gateway.
//
// Anyone with a wallet can LIST their JSON API here. Buyers pay per call in
// USDG (same 402 → sign → settle flow as TRIBUTE's own routes). Settlement is
// split server-side: seller gets (price - fee), TRIBUTE keeps the fee.
//
// Listing authority is proven cryptographically, not with an account system:
// the seller signs an EIP-712 ListingIntent with their wallet; we recover the
// signer and require signer === seller. Revoke works the same way.
//
// Fee: TRIBUTE_MARKETPLACE_FEE_BPS (basis points, default 500 = 5%).
const fs = require('fs')
const path = require('path')
const dns = require('dns')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { URL } = require('url')
const { ethers } = require('ethers')

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const CHAIN_ID = 4663
const DOMAIN = { name: 'TRIBUTE', version: '1', chainId: CHAIN_ID, verifyingContract: USDG }

/* ---------- private upstream headers (Tahap 4) ----------
 * Sellers whose upstream needs auth (e.g. an OpenAI key behind it) attach
 * request headers at listing time. They are AES-256-GCM encrypted with a
 * server key before being written to the store — plaintext never hits disk,
 * never appears in the catalog, and are only ever injected into the seller's
 * own upstream request at delivery time. */
function headerKey() {
  const raw = process.env.TRIBUTE_MARKETPLACE_HEADER_KEY ||
    crypto.createHash('sha256').update('tribute-marketplace-headers:' + (process.env.TRIBUTE_VAULT_KEY || process.env.TRIBUTE_RPC_UPSTREAM || 'tribute-local')).digest()
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

const STORE_PATH = process.env.TRIBUTE_MARKETPLACE_STORE ||
  path.join(__dirname, 'data', 'marketplace.json')
const FEE_BPS = Math.min(2000, Math.max(0, Number(process.env.TRIBUTE_MARKETPLACE_FEE_BPS ?? 500)))

const listings = new Map()   // slug -> listing
const usedNonces = new Set() // listing/revoke intent replay protection

function save() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    const tmp = STORE_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({
      listings: [...listings.values()],
      nonces: [...usedNonces].slice(-500),
    }))
    fs.renameSync(tmp, STORE_PATH)
  } catch (e) { console.error('marketplace save failed:', e.message) }
}

function load() {
  try {
    if (!fs.existsSync(STORE_PATH)) return
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    for (const l of (data.listings || [])) if (l && l.slug) listings.set(l.slug, l)
    for (const n of (data.nonces || [])) usedNonces.add(n)
  } catch (e) { console.error('marketplace load failed:', e.message) }
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'api'
}

function uniqueSlug(base) {
  let slug = base, i = 2
  while (listings.has(slug) || usedSlugsExternal(slug)) slug = base + '-' + (i++)
  return slug
}
// route slugs shared with the x402-routes registry — filled in by server.js
let reservedSlugCheck = () => false
function setReservedSlugCheck(fn) { reservedSlugCheck = fn }
function usedSlugsExternal(slug) { return reservedSlugCheck(slug) }

/* ---------- fee math (atomic USDG = 6 decimals) ---------- */
function splitPrice(price) {
  const [w, f = ''] = String(price).split('.')
  const atomic = BigInt((w + (f + '000000').slice(0, 6)).replace(/^0+(?=\d)/, '') || '0')
  if (atomic <= 0n) throw new Error('price must be > 0')
  const fee = atomic * BigInt(FEE_BPS) / 10000n
  const sellerShare = atomic - fee
  if (sellerShare <= 0n) throw new Error('price too small to split after fee')
  return { atomic, fee, sellerShare }
}

/* ---------- SSRF guard: only public https JSON endpoints ---------- */
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./]
function isPrivateIp(ip) {
  if (!ip) return true
  if (ip.includes(':')) { // IPv6
    const v = ip.toLowerCase()
    if (v === '::1' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('::ffff:')) return true
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1])
    return false
  }
  return PRIVATE_V4.some(re => re.test(ip))
}

async function assertSafeUpstream(rawUrl) {
  let u
  try { u = new URL(rawUrl) } catch { throw new Error('upstream must be a valid URL') }
  const loopbackOk = process.env.TRIBUTE_ALLOW_LOOPBACK_UPSTREAM === '1' // staging tests only
  if (u.protocol !== 'https:' && !(loopbackOk && u.protocol === 'http:' && /^(127\.|::1|localhost)/.test(u.hostname))) throw new Error('upstream must be https')
  if (u.username || u.password) throw new Error('upstream URL must not embed credentials')
  const host = u.hostname
  if (/^(.*\.local|.*\.internal|metadata\.)$/i.test(host)) throw new Error('upstream host not allowed')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIp(host) && !loopbackOk) throw new Error('upstream must be a public address')
    return u
  }
  const addrs = await dns.promises.lookup(host, { all: true })
  if (!addrs.length) throw new Error('upstream host does not resolve')
  if (addrs.some(a => isPrivateIp(a.address)) && !loopbackOk) throw new Error('upstream resolves to a private address')
  return u
}

/* ---------- listing / revoke ---------- */
function verifyIntent(intent, signature, types, typeName) {
  // `types` is the full EIP-712 types map, e.g. { ListingIntent: [...] }
  const now = Math.floor(Date.now() / 1000)
  if (!intent || typeof intent !== 'object') throw new Error('bad intent')
  if (!/^0x[0-9a-fA-F]{130,132}$/.test(String(signature || ''))) throw new Error('signature must be a 65-byte hex signature')
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(intent.nonce || ''))) throw new Error('nonce must be bytes32')
  if (usedNonces.has(intent.nonce)) throw new Error('intent nonce already used')
  const vb = BigInt(intent.validBefore || 0), va = BigInt(intent.validAfter || 0)
  if (vb <= BigInt(now)) throw new Error('intent expired')
  if (va > BigInt(now)) throw new Error('intent not yet valid')
  if (vb - BigInt(now) > 3600n) throw new Error('intent window too long (max 1h)')
  const signer = ethers.verifyTypedData(DOMAIN, types, intent, signature)
  if (signer.toLowerCase() !== String(intent.seller).toLowerCase()) throw new Error('signature does not match seller address')
  return signer
}

async function createListing({ name, description, upstream, price, seller, signature, nonce, validAfter, validBefore, privateHeaders }) {
  if (!name || String(name).length > 48) throw new Error('name required (max 48 chars)')
  if (description && String(description).length > 240) throw new Error('description too long (max 240)')
  if (!/^\d+(\.\d{1,6})?$/.test(String(price || ''))) throw new Error('price must be a decimal, e.g. 0.02')
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(seller || ''))) throw new Error('seller must be a 0x address')
  const priv = sanitizePrivateHeaders(privateHeaders) // throws on malformed; null when absent
  const { atomic, fee, sellerShare } = splitPrice(price) // validates price
  await assertSafeUpstream(String(upstream))
  verifyIntent({ seller, name: String(name), upstream: String(upstream), price: String(price),
    validAfter: validAfter || 0, validBefore, nonce }, signature, LISTING_TYPES)
  usedNonces.add(nonce)

  const slug = uniqueSlug(slugify(name))
  // Phase-1 guard: probe the seller's endpoint once. A listing that can't
  // answer with JSON today would only produce refunds later — reject it now.
  // Phase-4: the probe carries the seller's private headers, same as delivery.
  try { await fetchJson(String(upstream), 8000, 0, priv || undefined) }
  catch (e) { throw new Error(`upstream test failed — endpoint must answer GET with JSON (200): ${e.message}`) }
  const rec = {
    slug,
    kind: 'external',
    name: String(name),
    description: description || `${name} — paid API on TRIBUTE marketplace (USDG, Robinhood 4663)`,
    upstream: String(upstream),
    price: String(price),
    seller: seller,
    status: 'active',
    createdAt: Date.now(),
    hits: 0,
    paid: 0,
    failed: 0,
    refunded: 0,
    earnedAtomic: '0',
    refundedAtomic: '0',
  }
  if (priv) rec.privateHeadersEnc = encryptHeaders(priv) // encrypted at rest; never exposed
  listings.set(slug, rec)
  save()
  return { rec, split: { atomic: String(atomic), fee: String(fee), sellerShare: String(sellerShare) } }
}

function revoke({ slug, seller, signature, nonce, validAfter, validBefore }) {
  const rec = listings.get(String(slug))
  if (!rec || rec.status !== 'active') throw new Error('listing not found or already delisted')
  verifyIntent({ seller, slug: String(slug), validAfter: validAfter || 0, validBefore, nonce }, signature, REVOKE_TYPES)
  usedNonces.add(nonce)
  rec.status = 'delisted'
  rec.delistedAt = Date.now()
  save()
  return rec
}

/* ---------- delivery + accounting ---------- */
function get(slug) {
  const rec = listings.get(String(slug))
  return rec && rec.status === 'active' ? rec : null
}
function catalog() {
  return [...listings.values()]
    .filter(l => l.status === 'active')
    .sort((a, b) => (b.paid - a.paid) || (b.createdAt - a.createdAt))
    .map(l => ({
      slug: l.slug, name: l.name, description: l.description, price: l.price,
      seller: l.seller, hits: l.hits, paid: l.paid,
      failed: l.failed || 0, refunded: l.refunded || 0,
      reputation: reputationOf(l),
      earned: ethers.formatUnits(BigInt(l.earnedAtomic || 0), 6),
      createdAt: l.createdAt,
    }))
}
function recordHit(slug) {
  const l = listings.get(slug)
  if (l) { l.hits = (l.hits || 0) + 1; save() }
}
function recordFail(slug) {
  const l = listings.get(slug)
  if (l) { l.failed = (l.failed || 0) + 1; save() }
}
function recordRefund(slug, { sellerShareAtomic }) {
  const l = listings.get(slug)
  if (!l) return
  l.refunded = (l.refunded || 0) + 1
  l.refundedAtomic = String(BigInt(l.refundedAtomic || 0) + BigInt(sellerShareAtomic || 0))
  save()
}
function recordSettle(slug, { sellerShareAtomic, latencyMs }) {
  const l = listings.get(slug)
  if (!l) return
  l.paid = (l.paid || 0) + 1
  l.earnedAtomic = String(BigInt(l.earnedAtomic || 0) + BigInt(sellerShareAtomic))
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    l.latSumMs = (l.latSumMs || 0) + latencyMs
    l.latN = (l.latN || 0) + 1
    l.lastLatencyMs = Math.round(latencyMs)
  }
  save()
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
  const mine = [...listings.values()].filter(l => l.seller.toLowerCase() === String(seller).toLowerCase())
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
function fetchJson(urlStr, timeoutMs = 8000, depth = 0, extraHeaders) {
  return new Promise((resolve, reject) => {
    const lib = String(urlStr).startsWith('http:') ? http : https
    const headers = { accept: 'application/json', 'user-agent': 'TRIBUTE-marketplace/1.0', ...(extraHeaders || {}) }
    lib.get(urlStr, { headers, timeout: timeoutMs }, res => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && depth < 2) {
        res.resume()
        const next = new URL(res.headers.location, urlStr)
        // Private headers must never follow a redirect to a different host.
        const carry = next.host === new URL(urlStr).host ? extraHeaders : undefined
        resolve(fetchJson(next.toString(), timeoutMs, depth + 1, carry))
        return
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('upstream HTTP ' + res.statusCode)); return }
      let out = ''
      res.on('data', c => { out += c; if (out.length > 262144) { res.destroy(new Error('upstream response too large (>256KB)')) } })
      res.on('end', () => {
        try { resolve(JSON.parse(out)) } catch { reject(new Error('upstream did not return valid JSON')) }
      })
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('upstream timeout')) })
  })
}

load()

module.exports = {
  createListing, revoke, get, catalog, recordHit, recordFail, recordRefund, recordSettle, earningsFor, reputationOf,
  fetchJson, assertSafeUpstream, splitPrice, setReservedSlugCheck, requirement,
  privateHeadersFor: (rec) => (rec && rec.privateHeadersEnc ? decryptHeaders(rec.privateHeadersEnc) : null),
  DOMAIN, LISTING_TYPES, REVOKE_TYPES, FEE_BPS, listings,
}
