// Paid-API registry. Fork of x402-kit route shape, Robinhood 4663 + USDG.
// Routes + recent activity persist to disk so the console survives restarts.
const fs = require('fs')
const path = require('path')

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
/* Must match facilitator.js EIP-712 DOMAIN — the 402 body advertises these
   to the client so the wallet shows the same name the signature uses. */
const DOMAIN_NAME = 'TRIBUTE'
const DOMAIN_VERSION = '1'
const STORE_PATH = process.env.TRIBUTE_ROUTES_STORE ||
  path.join(__dirname, 'data', 'routes.json')

const routes = new Map()
const activity = []

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'api'
}

function priceToAtomic(price) {
  const [w, f = ''] = String(price).split('.')
  const s = (w + (f + '000000').slice(0, 6)).replace(/^0+(?=\d)/, '') || '0'
  return String(BigInt(s))
}

function requirement(route, resource) {
  return {
    scheme: 'exact',
    network: 'eip155:4663',
    maxAmountRequired: priceToAtomic(route.price),
    resource,
    description: route.description,
    mimeType: 'application/json',
    payTo: route.payTo,
    maxTimeoutSeconds: 60,
    asset: USDG,
    extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION }
  }
}

function list() {
  return [...routes.values()]
}

function get(slug) {
  return routes.get(slug) || null
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    const tmp = STORE_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({
      routes: [...routes.values()],
      activity: activity.slice(0, 80),
    }))
    fs.renameSync(tmp, STORE_PATH)
  } catch (e) {
    console.error('routes save failed:', e.message)
  }
}

function log(kind, rec, extra = {}) {
  activity.unshift({
    t: Date.now(),
    kind,
    slug: rec?.slug || extra.slug || 'premium',
    path: rec?.path || extra.path || '/premium',
    price: rec?.price || extra.price || '0.01',
    status: extra.status || 402,
    network: 'eip155:4663'
  })
  if (activity.length > 80) activity.length = 80
  save()
}

function hits() {
  return activity.filter(a => a.kind === '402').length
}

function create({ path: p, price, description, payTo }) {
  if (!/^\/[A-Za-z0-9/_-]{1,64}$/.test(p || '')) throw new Error('path must look like /alerts')
  if (!/^\d+(\.\d{1,6})?$/.test(String(price || ''))) throw new Error('price must be a decimal, e.g. 0.01')
  if (payTo && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error('payTo must be a 0x address')
  const slug = slugify(p)
  if (routes.has(slug)) throw new Error('path already registered')
  const rec = {
    slug,
    path: p,
    price: String(price),
    description: description || `TRIBUTE paid API ${p} — USDG on Robinhood 4663`,
    payTo: payTo || process.env.TRIBUTE_X402_PAYTO || '0x0000000000000000000000000000000000000000',
    createdAt: Date.now(),
    hits: 0
  }
  routes.set(slug, rec)
  log('create', rec, { status: 201 })
  return rec
}

function bump(slug) {
  const rec = routes.get(slug)
  if (rec) rec.hits = (rec.hits || 0) + 1
  log('402', rec || { slug, path: '/' + slug, price: '0.01' })
  save()
  return rec
}

function load() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    if (!fs.existsSync(STORE_PATH)) return
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    for (const rec of (data.routes || [])) {
      if (rec && rec.slug) routes.set(rec.slug, rec)
    }
    if (Array.isArray(data.activity)) {
      for (const a of data.activity.slice(0, 80)) activity.push(a)
    }
  } catch (e) {
    console.error('routes load failed:', e.message)
  }
}

function seed() {
  if (process.env.TRIBUTE_SEED_ROUTES === '0') return
  if (routes.size > 0) return
  const defaults = [
    { path: '/alerts', price: '0.01', description: 'TRIBUTE whale alerts — USDG on Robinhood 4663' },
    { path: '/signals', price: '0.05', description: 'TRIBUTE agent signals — USDG on Robinhood 4663' },
    { path: '/market-analytics', price: '0.05', description: 'TRIBUTE market analytics — liquidity, breadth, turnover rankings on Robinhood 4663' },
  ]
  for (const d of defaults) {
    try { create(d) } catch { /* already present */ }
  }
}

load()
seed()

module.exports = { list, get, create, requirement, USDG, activity, hits, bump, log }
