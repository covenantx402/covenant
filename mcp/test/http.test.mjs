// Tests for the hosted (Streamable HTTP) MCP endpoint: read-only by construction, hardened, speaks the real protocol.
import assert from 'node:assert'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHttpServer, remoteConfig } from '../src/http.js'

let pass = 0; const ok = (n) => { pass++; console.log('  ✓', n) }
const KEY = '0x' + '11'.repeat(32), AGENT = 'cvn_' + 'ab'.repeat(24)

// credentials in the environment must be ignored by the hosted config
{
  const cfg = remoteConfig({ COVENANT_WALLET_KEY: KEY, COVENANT_AGENT_KEY: AGENT, COVENANT_WALLET_EXPORT_DIR: '/tmp/x', COVENANT_VAULT_SRC_A: 'secretsecret', COVENANT_GATEWAY: 'https://gateway.covenantx402.com' })
  assert.strictEqual(cfg.walletKey, null); assert.strictEqual(cfg.agentKey, null); assert.strictEqual(cfg.walletExportDir, null); assert.deepStrictEqual(cfg.env, {})
  ok('hosted config strips wallet key, agent key, export dir and vault sources even if set in the environment')
}

const srv = createHttpServer(remoteConfig({ COVENANT_WALLET_KEY: KEY, COVENANT_AGENT_KEY: AGENT }))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`
const post = (body, headers = {}) => fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

// real MCP client over HTTP
{
  const c = new Client({ name: 'http-test', version: '0' }); await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')))
  const tools = (await c.listTools()).tools, names = tools.map((t) => t.name)
  assert.strictEqual(names.length, 18, `expected 18 read-only tools, got ${names.length}: ${names.join(',')}`)
  for (const bad of ['covenant_pay', 'covenant_open_session', 'covenant_session_redeem', 'covenant_wallet_create', 'covenant_register_agent', 'covenant_whoami', 'covenant_revoke_self_key', 'covenant_vault_set', 'covenant_vault_list', 'covenant_vault_delete', 'covenant_vault_broker', 'covenant_wallets_list']) assert.ok(!names.includes(bad), `${bad} must not exist on the hosted server`)
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), 'every hosted tool is read-only')
  assert.strictEqual((await c.listResources()).resources.length, 5); assert.ok((await c.listPrompts()).prompts.length >= 1)
  const st = JSON.parse((await c.callTool({ name: 'covenant_status', arguments: {} })).content[0].text); assert.strictEqual(st.ok, true)
  assert.strictEqual(st.payingEnabled, false, 'hosted server must report paying disabled')
  const bad = await c.callTool({ name: 'covenant_pay', arguments: { route: 'alerts', maxUsdg: 1, confirm: true } }).then((r) => ({ isError: r.isError, text: r.content?.[0]?.text || '' }), (e) => ({ isError: true, text: String(e.message) }))
  assert.strictEqual(bad.isError, true, 'calling a removed tool must fail'); assert.match(bad.text, /not found/i); assert.ok(!/settled|transaction/i.test(bad.text))
  const spend = JSON.parse((await c.readResource({ uri: 'covenant://spend' })).contents[0].text); assert.strictEqual(spend.walletConfigured, false)
  await c.close()
  ok(`real MCP client over HTTP: 18 read-only tools, 5 resources, no spend/identity/vault/wallet tool exists even with credentials in env, live status ok`)
}

// protocol + hardening
{
  const h = await (await fetch(base + '/health')).json(); assert.strictEqual(h.ok, true); assert.strictEqual(h.mode, 'read-only')
  assert.strictEqual((await fetch(base + '/mcp', { method: 'GET' })).status, 405); assert.strictEqual((await fetch(base + '/mcp', { method: 'DELETE' })).status, 405)
  assert.strictEqual((await fetch(base + '/nope')).status, 404)
  assert.strictEqual((await post('{not json')).status, 400)
  const big = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(200_000) } })); assert.strictEqual(big.status, 413)
  const pre = await fetch(base + '/mcp', { method: 'OPTIONS' }); assert.strictEqual(pre.status, 204); assert.strictEqual(pre.headers.get('access-control-allow-origin'), '*')
  assert.ok(!pre.headers.get('access-control-allow-headers').toLowerCase().includes('authorization'), 'no credentials accepted cross-origin')
  const r = await post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'covenant_inspect_route', arguments: { route: 'https://evil.test' } } }); const j = await r.json()
  assert.strictEqual(j.result.isError, true); assert.match(j.result.content[0].text, /slug/)
  assert.ok(!JSON.stringify(j).includes(KEY.slice(2)) && !JSON.stringify(j).includes(AGENT))
  ok('hardening: health, GET/DELETE refused, 404, malformed JSON 400, oversize 413, CORS without credentials, hostile input -> tool error, no secret in output')
}

// rate limiting
{
  const limited = createHttpServer(remoteConfig({}))
  await new Promise((r) => limited.listen(0, '127.0.0.1', r)); const b2 = `http://127.0.0.1:${limited.address().port}`
  let first429 = 0
  for (let i = 1; i <= 140; i++) { const r = await fetch(b2 + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }) }); if (r.status === 429) { first429 = i; break } }
  assert.ok(first429 > 100 && first429 <= 125, `rate limit should trip near 120/min, tripped at ${first429}`)
  limited.close()
  ok(`rate limit: 429 after ~120 requests/min per client (tripped at request ${first429})`)
}

srv.close()
console.log(`\nHTTP PASS — ${pass} checks`)
process.exit(0)
