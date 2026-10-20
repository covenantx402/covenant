#!/usr/bin/env node
// COVENANT MCP server (stdio). Read tools always; `covenant_pay` only when a wallet is configured.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadConfig, createCore } from './core.js'

export function buildServer(cfg, core = createCore(cfg)) {
  const server = new McpServer({ name: 'covenant', version: '0.1.0' })
  const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })
  const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${String(e?.message || e)}` }] })
  const wrap = (fn) => async (args) => { try { return ok(await fn(args || {})) } catch (e) { return fail(e) } }
  const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }

  server.registerTool('covenant_status', {
    title: 'Gateway status', annotations: RO,
    description: 'Live health of the COVENANT gateway and which chains are settlement-ready. Read-only, no key needed.',
    inputSchema: {},
  }, wrap(() => core.status()))

  server.registerTool('covenant_list_apis', {
    title: 'List paid APIs', annotations: RO,
    description: 'List paid API routes (core + marketplace) with USDG prices on Robinhood Chain. Read-only. Use a returned `route` slug with covenant_inspect_route.',
    inputSchema: {},
  }, wrap(() => core.listApis()))

  server.registerTool('covenant_inspect_route', {
    title: 'Inspect a 402 challenge', annotations: RO,
    description: 'Fetch the x402 payment requirement for one route and explain the price, network and asset. Never pays. Takes a route slug such as "alerts", not a URL.',
    inputSchema: { route: z.string().min(1).max(40).describe('route slug, e.g. "alerts"') },
  }, wrap(({ route }) => core.inspectRoute(route)))

  server.registerTool('covenant_receipts', {
    title: 'Recent on-chain receipts', annotations: RO,
    description: 'Most recent real settlements with transaction hashes and explorer links.',
    inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('how many (default 10)') },
  }, wrap(({ limit }) => core.receipts(limit)))

  server.registerTool('covenant_reputation', {
    title: 'Reputation score', annotations: RO,
    description: 'Explainable 0-100 reputation of an address, derived from its settled payments (each anchored to a tx hash).',
    inputSchema: { address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('0x… EVM address') },
  }, wrap(({ address }) => core.reputation(address)))

  server.registerTool('covenant_explorer_link', {
    title: 'Explorer link', annotations: RO,
    description: 'Build the Robinhood Chain explorer URL for a transaction hash.',
    inputSchema: { tx: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('transaction hash') },
  }, wrap(({ tx }) => ({ url: core.explorerLink(tx) })))

  if (cfg.walletKey) {
    server.registerTool('covenant_pay', {
      title: 'Pay for a route (USDG)', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description: 'SPENDS REAL USDG on Robinhood Chain from the configured wallet. First call WITHOUT confirm to get a dry-run plan and show it to the user. Only call with confirm:true after the user has explicitly approved this exact route and price. Enforced by the server: per-call maxUsdg, a hard per-payment cap and a session budget.',
      inputSchema: {
        route: z.string().min(1).max(40).describe('route slug, e.g. "alerts"'),
        maxUsdg: z.number().positive().max(10).describe('the most you are willing to pay for this call, in USDG'),
        confirm: z.boolean().optional().describe('must be true to actually pay; omit for a dry run'),
      },
    }, wrap((a) => core.pay(a)))
  }
  return server
}

async function main() {
  const cfg = loadConfig()
  const server = buildServer(cfg)
  await server.connect(new StdioServerTransport())
  // stderr only: stdout is the protocol channel
  console.error(`[covenant-mcp] ready · gateway ${cfg.gateway} · paying ${cfg.walletKey ? `ENABLED (cap ${cfg.maxPaymentUsdg} USDG/payment, budget ${cfg.sessionBudgetUsdg} USDG)` : 'disabled (read-only)'}`)
}

import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error('[covenant-mcp] fatal:', e.message); process.exit(1) })
