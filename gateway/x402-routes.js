// Paid-API registry. Fork of x402-kit route shape, Robinhood 4663 + USDG.
// SQLite-backed (see db.js) — routes + recent activity persist across
// restarts with indexed writes, not a full JSON-file rewrite on every 402
// hit (this used to fs.writeFileSync the whole registry on every single
// unpaid request to any paid route).
const db = require('./db')
const chains = require('./chains')

// Back-compat export for callers that still import x402r.USDG directly —
// points at the old/default Robinhood payment asset. New challenge code uses
// requirement(..., chainId) below and never relies on this constant.
const USDG = chains.getChain(chains.DEFAULT_CHAIN_ID).usdc
/* Must match facilitator.js EIP-712 DOMAIN — the 402 body advertises these
   to the client so the wallet shows the same name the signature uses. */
const DOMAIN_NAME = 'COVENANT'
const DOMAIN_VERSION = '1'

const stmts = {
  insert: db.prepare('INSERT INTO routes (slug, path, price, description, pay_to, created_at, hits) VALUES (?,?,?,?,?,?,0)'),
  get: db.prepare('SELECT * FROM routes WHERE slug = ?'),
  all: db.prepare('SELECT * FROM routes ORDER BY created_at DESC'),
  bumpHits: db.prepare('UPDATE routes SET hits = hits + 1 WHERE slug = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM routes'),
  addActivity: db.prepare('INSERT INTO route_activity (t, kind, slug, path, price, status, network) VALUES (?,?,?,?,?,?,?)'),
  recentActivity: db.prepare('SELECT t, kind, slug, path, price, status, network FROM route_activity ORDER BY t DESC LIMIT ?'),
  countHits402: db.prepare("SELECT COUNT(*) AS n FROM route_activity WHERE kind = '402'"),
  pruneActivity: db.prepare('DELETE FROM route_activity WHERE id NOT IN (SELECT id FROM route_activity ORDER BY t DESC LIMIT 80)'),
}

// Hard cap on total registered routes — POST /x402/apis is intentionally
// open (no auth, the 402 gate is the monetization), so this bounds the
// worst case instead of letting it grow unbounded.
const MAX_ROUTES = 2000

function rowToRoute(r) {
  return { slug: r.slug, path: r.path, price: r.price, description: r.description, payTo: r.pay_to, createdAt: r.created_at, hits: r.hits }
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'api'
}

function priceToAtomic(price, chainId = chains.DEFAULT_CHAIN_ID) {
  const c = chains.getChain(chainId)
  const [w, f = ''] = String(price).split('.')
  const s = (w + (f + '0'.repeat(c.decimals)).slice(0, c.decimals)).replace(/^0+(?=\d)/, '') || '0'
  return String(BigInt(s))
}

function requirement(route, resource, chainId = chains.DEFAULT_CHAIN_ID, spender) {
  const c = chains.getChain(chainId)
  const payTo = spender || route.payTo
  return {
    scheme: 'exact',
    network: `eip155:${c.id}`,
    maxAmountRequired: priceToAtomic(route.price, c.id),
    resource,
    description: route.description,
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: 60,
    asset: c.usdc,
    extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: c.id, spender: payTo }
  }
}

function list() {
  return stmts.all.all().map(rowToRoute)
}

function get(slug) {
  const r = stmts.get.get(slug)
  return r ? rowToRoute(r) : null
}

function has(slug) {
  return !!stmts.get.get(slug)
}

// `activity` used to be a live in-memory array other modules read directly
// (server.js: x402r.activity.slice(0, 20)). Exported below as a getter
// backed by the DB so callers don't need to change.

function log(kind, rec, extra = {}) {
  stmts.addActivity.run(
    Date.now(), kind,
    rec?.slug || extra.slug || 'premium',
    rec?.path || extra.path || '/premium',
    rec?.price || extra.price || '0.01',
    extra.status || 402,
    'eip155:4663',
  )
  stmts.pruneActivity.run()
}

function activityList() {
  return stmts.recentActivity.all(80).map(a => ({ t: a.t, kind: a.kind, slug: a.slug, path: a.path, price: a.price, status: a.status, network: a.network }))
}

function hits() {
  return stmts.countHits402.get().n
}

let marketplaceSlugTaken = () => false
function setMarketplaceSlugCheck(fn) { marketplaceSlugTaken = fn }

function create({ path: p, price, description, payTo }) {
  if (!/^\/[A-Za-z0-9/_-]{1,64}$/.test(p || '')) throw new Error('path must look like /alerts')
  if (!/^\d+(\.\d{1,6})?$/.test(String(price || ''))) throw new Error('price must be a decimal, e.g. 0.01')
  if (!(Number(price) >= 0.01)) throw new Error('price must be at least 0.01 (settlement-cost floor)')
  if (description != null && (typeof description !== 'string' || description.length > 240)) throw new Error('description must be a string of at most 240 chars')
  if (payTo && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error('payTo must be a 0x address')
  if (stmts.count.get().n >= MAX_ROUTES) throw new Error('route registry is full — contact the gateway operator')
  const slug = slugify(p)
  if (has(slug) || marketplaceSlugTaken(slug)) throw new Error('path already registered')
  const rec = {
    slug,
    path: p,
    price: String(price),
    description: description || `COVENANT paid API ${p} — USDG on Robinhood 4663`,
    payTo: payTo || process.env.COVENANT_X402_PAYTO || '0x0000000000000000000000000000000000000000',
    createdAt: Date.now(),
    hits: 0
  }
  stmts.insert.run(rec.slug, rec.path, rec.price, rec.description, rec.payTo, rec.createdAt)
  log('create', rec, { status: 201 })
  return rec
}

function bump(slug) {
  const rec = get(slug)
  if (rec) stmts.bumpHits.run(slug)
  log('402', rec || { slug, path: '/' + slug, price: '0.01' })
  return rec
}

function seed() {
  if (process.env.COVENANT_SEED_ROUTES === '0') return
  if (stmts.count.get().n > 0) return
  const defaults = [
    { path: '/alerts', price: '0.01', description: 'COVENANT whale alerts — USDG on Robinhood 4663' },
    { path: '/signals', price: '0.05', description: 'COVENANT agent signals — USDG on Robinhood 4663' },
    { path: '/market-analytics', price: '0.05', description: 'COVENANT market analytics — liquidity, breadth, turnover rankings on Robinhood 4663' },
  ]
  for (const d of defaults) {
    try { create(d) } catch { /* already present */ }
  }
}

seed()

module.exports = {
  setMarketplaceSlugCheck,
  list, get, has, create, requirement, USDG, hits, bump, log, priceToAtomic,
  get activity() { return activityList() },
}
