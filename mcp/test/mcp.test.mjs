// MCP tests: core safety (mocked gateway), real stdio protocol round-trip, and live read-only calls.
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, createCore, USDG } from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0; const ok = (n) => { pass++; console.log('  ✓', n) }
const KEY = '0x' + '11'.repeat(32)
const GW = 'https://gateway.example.test'
const SPENDER = '0x' + 'aa'.repeat(20)

// ---------- mock gateway
const challenge = (over = {}) => ({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'eip155:4663', maxAmountRequired: '10000', resource: `${GW}/x402/api/alerts`, payTo: SPENDER, asset: USDG, description: 'alerts', extra: { spender: SPENDER }, ...over }] })
const mockFetch = (handlers) => async (url, init) => {
  const p = String(url).replace(GW, '')
  const h = handlers[p] || handlers['*']
  const out = h ? await h(init) : { status: 404, body: {} }
  return { status: out.status, headers: new Headers(), text: async () => JSON.stringify(out.body) }
}
const cfg = (o = {}) => ({ ...loadConfig({ COVENANT_GATEWAY: GW, ...o }) })

// 1. config safety
{
  assert.throws(() => loadConfig({ COVENANT_GATEWAY: 'http://evil.example' }), /https/)
  assert.doesNotThrow(() => loadConfig({ COVENANT_GATEWAY: 'http://127.0.0.1:8792' }))
  assert.throws(() => loadConfig({ COVENANT_WALLET_KEY: 'nothex' }), /32-byte/)
  assert.strictEqual(loadConfig({ COVENANT_GATEWAY: GW }).walletKey, null)
  assert.strictEqual(loadConfig({}).maxPaymentUsdg, 0.05)
  ok('config: https-only gateway, key validated, safe default caps, no key by default')
}

// 2. model input can never choose a URL
{
  const core = createCore(cfg(), { fetchImpl: mockFetch({}) })
  for (const bad of ['https://evil.test/x', '../../etc/passwd', 'a b', '', 'x'.repeat(40), 'alerts?x=1', 'ALERTS']) {
    await assert.rejects(core.inspectRoute(bad), /slug/, `must reject ${JSON.stringify(bad)}`)
  }
  ok('route input is slug-only: URLs, traversal, queries and junk are rejected')
}

// 3. inspect never pays and flags unsafe rails
{
  const core = createCore(cfg(), { fetchImpl: mockFetch({ '/x402/api/alerts': () => ({ status: 402, body: challenge() }), '/x402/api/other': () => ({ status: 402, body: challenge({ network: 'eip155:1' }) }) }) })
  const r = await core.inspectRoute('alerts'); assert.strictEqual(r.priceUsdg, 0.01); assert.strictEqual(r.safeToPayHere, true); assert.match(r.payment, /nothing has been paid/)
  assert.strictEqual((await core.inspectRoute('other')).safeToPayHere, false)
  ok('inspect: reports price, never pays, flags a non-Robinhood rail as unsafe')
}

// 4. pay is impossible without a wallet; dry-run never signs
{
  const noWallet = createCore(cfg(), { fetchImpl: mockFetch({}) })
  await assert.rejects(noWallet.pay({ route: 'alerts', maxUsdg: 1, confirm: true }), /disabled/)
  const core = createCore(cfg({ COVENANT_WALLET_KEY: KEY }), { fetchImpl: mockFetch({ '/x402/api/alerts': () => ({ status: 402, body: challenge() }), '/facilitator/settle': () => { throw new Error('settle must NOT be called on a dry run') } }) })
  const r = await core.pay({ route: 'alerts', maxUsdg: 1 })
  assert.strictEqual(r.executed, false); assert.match(r.note, /DRY RUN/); assert.strictEqual(r.plan.priceUsdg, 0.01)
  assert.strictEqual(core._state().spent, 0)
  ok('pay: refuses without a wallet; without confirm it is a dry run that never signs or settles')
}

// 5. pay refuses hostile / out-of-policy challenges BEFORE touching the wallet
{
  const mk = (over, extra = {}) => createCore(cfg({ COVENANT_WALLET_KEY: KEY, ...extra }), { fetchImpl: mockFetch({ '/x402/api/alerts': () => ({ status: 402, body: challenge(over) }) }) })
  const call = (c, args = { route: 'alerts', maxUsdg: 1, confirm: true }) => c.pay(args)
  await assert.rejects(call(mk({ network: 'eip155:1' })), /not Robinhood/)
  await assert.rejects(call(mk({ asset: '0x' + 'bb'.repeat(20) })), /known USDG/)
  await assert.rejects(call(mk({ payTo: '0x' + 'cc'.repeat(20) })), /facilitator spender/)
  await assert.rejects(call(mk({ resource: 'https://evil.test/x402/api/alerts' })), /outside the configured gateway/)
  await assert.rejects(call(mk({ maxAmountRequired: '60000' })), /per-payment cap/)             // 0.06 > default cap 0.05
  await assert.rejects(call(mk({}), { route: 'alerts', maxUsdg: 0.005, confirm: true }), /exceeds your maxUsdg/)
  await assert.rejects(call(mk({}), { route: 'alerts', maxUsdg: 0, confirm: true }), /maxUsdg/)
  await assert.rejects(call(mk({}, { COVENANT_SESSION_BUDGET_USDG: '0.005' })), /session budget/)
  ok('pay: rejects wrong chain, wrong asset, redirected payTo, foreign resource, over cap, over maxUsdg, over session budget')
}

// 6. real MCP protocol over stdio: tool list, no pay tool without a wallet, error path
const rpc = (env) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(here, '../src/index.js')], { env: { PATH: process.env.PATH, COVENANT_GATEWAY: 'https://gateway.covenantx402.com', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = '', err = ''; const out = []
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) out.push(JSON.parse(l)) } })
  p.stderr.on('data', (d) => (err += d))
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
  setTimeout(() => { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'covenant_inspect_route', arguments: { route: 'https://evil.test' } } }) }, 400)
  setTimeout(() => { p.kill(); resolve({ out, err }) }, 3500)
  p.on('error', reject)
})
{
  const { out, err } = await rpc({})
  const init = out.find((m) => m.id === 1), list = out.find((m) => m.id === 2), bad = out.find((m) => m.id === 3)
  assert.strictEqual(init.result.serverInfo.name, 'covenant')
  const names = list.result.tools.map((t) => t.name)
  assert.deepStrictEqual(names.sort(), ['covenant_explorer_link', 'covenant_inspect_route', 'covenant_list_apis', 'covenant_receipts', 'covenant_reputation', 'covenant_status'])
  assert.ok(!names.includes('covenant_pay'), 'no wallet => the pay tool must not exist at all')
  assert.ok(list.result.tools.every((t) => t.annotations?.readOnlyHint === true))
  assert.strictEqual(bad.result.isError, true); assert.match(bad.result.content[0].text, /slug/)
  assert.match(err, /paying disabled/); assert.ok(!/0x[0-9a-f]{64}/.test(err))
  ok('MCP stdio: initialize + tools/list = 6 read-only tools, NO pay tool, hostile URL input returns a tool error')
}
{
  const { out, err } = await rpc({ COVENANT_WALLET_KEY: KEY })
  const names = out.find((m) => m.id === 2).result.tools.map((t) => t.name)
  assert.ok(names.includes('covenant_pay')); const pay = out.find((m) => m.id === 2).result.tools.find((t) => t.name === 'covenant_pay')
  assert.strictEqual(pay.annotations.destructiveHint, true); assert.match(pay.description, /confirm/)
  assert.ok(!err.includes(KEY) && !JSON.stringify(out).includes(KEY.slice(2)), 'the private key must never appear in output or logs')
  ok('MCP stdio: with a wallet, covenant_pay appears (destructive-flagged, confirm required) and the key never leaks')
}

// 7. LIVE read-only calls against the real gateway (no key, no spend)
{
  const core = createCore(loadConfig({}))
  const s = await core.status(); assert.strictEqual(s.ok, true); assert.ok(s.chains.some((c) => c.chainId === 4663 && c.settlementReady))
  const a = await core.listApis(); assert.ok(a.core.length >= 1)
  const i = await core.inspectRoute(a.core[0].route); assert.strictEqual(i.status, 402); assert.strictEqual(i.safeToPayHere, true)
  const r = await core.receipts(3); assert.ok(r.receipts.length >= 1 && /^0x[0-9a-f]{64}$/.test(r.receipts[0].txHash))
  ok(`LIVE gateway: status ok, ${a.core.length} core routes, 402 inspected, ${r.total} receipts readable (no spend)`)
}

console.log(`\nMCP PASS — ${pass} checks`)
process.exit(0)
