// In-memory paid-API registry. Fork of x402-kit route shape, Robinhood 4663 + USDG.
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const routes = new Map()
const activity = []

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'api'
}

function priceToAtomic(price) {
  const [w, f = ''] = String(price).split('.')
  return (w + (f + '000000').slice(0, 6)).replace(/^0+(?=\d)/, '') || '0'
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
    extra: { name: 'USDG', version: '2' }
  }
}

function list() {
  return [...routes.values()]
}

function get(slug) {
  return routes.get(slug) || null
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
}

function hits() {
  return activity.filter(a => a.kind === '402').length
}

function create({ path, price, description, payTo }) {
  if (!/^\/[A-Za-z0-9/_-]{1,64}$/.test(path || '')) throw new Error('path must look like /alerts')
  if (!/^\d+(\.\d{1,6})?$/.test(String(price || ''))) throw new Error('price must be a decimal, e.g. 0.01')
  if (payTo && !/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error('payTo must be a 0x address')
  const slug = slugify(path)
  if (routes.has(slug)) throw new Error('path already registered')
  const rec = {
    slug,
    path,
    price: String(price),
    description: description || `TRIBUTE paid API ${path} — USDG on Robinhood 4663`,
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
  return rec
}

module.exports = { list, get, create, requirement, USDG, activity, hits, bump, log }
