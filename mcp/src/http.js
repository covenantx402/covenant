#!/usr/bin/env node
// COVENANT MCP, hosted (Streamable HTTP). READ-ONLY BY CONSTRUCTION.
//
// A public endpoint must never hold a wallet, an agent key or vault secrets: anyone who can reach it could use them.
// So this entrypoint strips every credential from the config before building the server. Spending, identity,
// vault and wallet tools do not exist here; users who want them run the local stdio package with their own keys.
//
// Stateless: a fresh server + transport per request (no sessions to hijack, nothing to leak between callers).
import http from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { loadConfig } from './core.js'
import { buildServer, VERSION } from './index.js'

const MAX_BODY = 64 * 1024
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 120                      // requests / IP / minute
const MAX_INFLIGHT = 64

export function remoteConfig(env = process.env) {
  const base = loadConfig({ COVENANT_GATEWAY: env.COVENANT_GATEWAY, COVENANT_FACILITATOR: env.COVENANT_FACILITATOR })
  // Deliberately NOT read from the environment: nothing sensitive can ever be configured on the hosted server.
  return { ...base, walletKey: null, agentKey: null, agentKeyFile: null, walletExportDir: null, env: {} }
}

export function createHttpServer(cfg = remoteConfig(), { trustProxy = false } = {}) {
  const hits = new Map()
  let inflight = 0
  const clientIp = (req) => {
    if (trustProxy) { const x = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x }
    return req.socket.remoteAddress || 'unknown'
  }
  const limited = (ip) => {
    const now = Date.now(); const rec = hits.get(ip)
    if (!rec || now - rec.t > RATE_WINDOW_MS) { hits.set(ip, { t: now, n: 1 }); if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > RATE_WINDOW_MS) hits.delete(k); return false }
    return ++rec.n > RATE_MAX
  }
  const send = (res, code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra }); res.end(JSON.stringify(obj)) }
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id', 'access-control-expose-headers': 'mcp-session-id' }

  return http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0]
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
    if (url === '/health' || url === '/healthz') { send(res, 200, { ok: true, service: 'covenant-mcp', version: VERSION, mode: 'read-only', transport: 'streamable-http' }, cors); return }
    if (url === '/' && req.method === 'GET') {
      send(res, 200, { name: 'COVENANT MCP', version: VERSION, mode: 'read-only (no spending, no keys, no vault)', endpoint: '/mcp', install_local_for_payments: 'npx -y @covenantx402/mcp', docs: 'https://github.com/covenantx402/covenant/tree/main/mcp' }, cors); return
    }
    if (url !== '/mcp') { send(res, 404, { error: 'not found. MCP endpoint is POST /mcp' }, cors); return }
    // Stateless server: GET (SSE stream) and DELETE (session end) have no meaning here.
    if (req.method !== 'POST') { send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless: POST /mcp only.' }, id: null }, { ...cors, allow: 'POST' }); return }
    if (limited(clientIp(req))) { send(res, 429, { jsonrpc: '2.0', error: { code: -32000, message: 'rate limit exceeded' }, id: null }, { ...cors, 'retry-after': '30' }); return }
    if (inflight >= MAX_INFLIGHT) { send(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'busy, retry shortly' }, id: null }, { ...cors, 'retry-after': '2' }); return }
    const len = Number(req.headers['content-length'] || 0)
    if (len > MAX_BODY) { send(res, 413, { jsonrpc: '2.0', error: { code: -32000, message: 'request too large' }, id: null }, cors); return }

    let raw = '', size = 0, aborted = false
    req.on('data', (d) => { size += d.length; if (size > MAX_BODY && !aborted) { aborted = true; send(res, 413, { jsonrpc: '2.0', error: { code: -32000, message: 'request too large' }, id: null }, cors); req.destroy() } else if (!aborted) raw += d })
    req.on('end', async () => {
      if (aborted) return
      let body; try { body = JSON.parse(raw) } catch { send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }, cors); return }
      inflight++
      const server = buildServer(cfg, undefined, { remote: true })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { try { transport.close() } catch {} try { server.close() } catch {} })
      try {
        for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
      } catch (e) {
        if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }, cors)
      } finally { inflight-- }
    })
  })
}

async function main() {
  const cfg = remoteConfig()
  const port = Number(process.env.COVENANT_MCP_PORT || 8795), host = process.env.COVENANT_MCP_HOST || '127.0.0.1'
  const srv = createHttpServer(cfg, { trustProxy: process.env.COVENANT_MCP_TRUST_PROXY === '1' })
  srv.requestTimeout = 20_000; srv.headersTimeout = 10_000; srv.keepAliveTimeout = 5_000
  srv.listen(port, host, () => console.error(`[covenant-mcp-http ${VERSION}] read-only · http://${host}:${port}/mcp · gateway ${cfg.gateway}`))
}
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error('[covenant-mcp-http] fatal:', e.message); process.exit(1) })
