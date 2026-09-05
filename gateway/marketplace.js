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
const https = require('https')
const { URL } = require('url')
const { ethers } = require('ethers')

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const CHAIN_ID = 4663
const DOMAIN = { name: 'TRIBUTE', version: '1', chainId: CHAIN_ID, verifyingContract: USDG }
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
  if (u.protocol !== 'https:') throw new Error('upstream must be https')
  if (u.username || u.password) throw new Error('upstream URL must not embed credentials')
  const host = u.hostname
  if (/^(localhost|.*\.local|.*\.internal|metadata\.)$/i.test(host)) throw new Error('upstream host not allowed')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isPrivateIp(host)) throw new Error('upstream must be a public address')
    return u
  }
  const addrs = await dns.promises.lookup(host, { all: true })
  if (!addrs.length) throw new Error('upstream host does not resolve')
  if (addrs.some(a => isPrivateIp(a.address))) throw new Error('upstream resolves to a private address')
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

async function createListing({ name, description, upstream, price, seller, signature, nonce, validAfter, validBefore }) {
  if (!name || String(name).length > 48) throw new Error('name required (max 48 chars)')
  if (description && String(description).length > 240) throw new Error('description too long (max 240)')
  if (!/^\d+(\.\d{1,6})?$/.test(String(price || ''))) throw new Error('price must be a decimal, e.g. 0.02')
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(seller || ''))) throw new Error('seller must be a 0x address')
  const { atomic, fee, sellerShare } = splitPrice(price) // validates price
  await assertSafeUpstream(String(upstream))
  verifyIntent({ seller, name: String(name), upstream: String(upstream), price: String(price),
    validAfter: validAfter || 0, validBefore, nonce }, signature, LISTING_TYPES)
  usedNonces.add(nonce)

  const slug = uniqueSlug(slugify(name))
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
    earnedAtomic: '0',
  }
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
      earned: ethers.formatUnits(BigInt(l.earnedAtomic || 0), 6),
      createdAt: l.createdAt,
    }))
}
function recordHit(slug) {
  const l = listings.get(slug)
  if (l) { l.hits = (l.hits || 0) + 1; save() }
}
function recordSettle(slug, { sellerShareAtomic }) {
  const l = listings.get(slug)
  if (!l) return
  l.paid = (l.paid || 0) + 1
  l.earnedAtomic = String(BigInt(l.earnedAtomic || 0) + BigInt(sellerShareAtomic))
  save()
}
function earningsFor(seller) {
  const mine = [...listings.values()].filter(l => l.seller.toLowerCase() === String(seller).toLowerCase())
  return {
    seller,
    feeBps: FEE_BPS,
    listings: mine.map(l => ({
      slug: l.slug, name: l.name, status: l.status, price: l.price,
      hits: l.hits, paid: l.paid, earned: ethers.formatUnits(BigInt(l.earnedAtomic || 0), 6),
    })),
    totalPaid: mine.reduce((s, l) => s + (l.paid || 0), 0),
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
    extra: { name: DOMAIN.name, version: DOMAIN.version, marketplace: true, seller: rec.seller, feeBps: FEE_BPS },
  }
}

/* ---------- upstream fetch (post-payment delivery) ---------- */
function fetchJson(urlStr, timeoutMs = 8000, depth = 0) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, { headers: { accept: 'application/json', 'user-agent': 'TRIBUTE-marketplace/1.0' }, timeout: timeoutMs }, res => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && depth < 2) {
        res.resume()
        resolve(fetchJson(new URL(res.headers.location, urlStr).toString(), timeoutMs, depth + 1))
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
  createListing, revoke, get, catalog, recordHit, recordSettle, earningsFor,
  fetchJson, assertSafeUpstream, splitPrice, setReservedSlugCheck, requirement,
  DOMAIN, LISTING_TYPES, REVOKE_TYPES, FEE_BPS, listings,
}
