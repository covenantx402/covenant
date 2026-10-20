#!/usr/bin/env node
// COVENANT MCP server (stdio): tools + resources + prompts.
// Spend tools exist only when a wallet is configured; wallet creation only when an export dir is configured.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadConfig, createCore } from './core.js'

export const VERSION = '0.2.2'
const ADDR = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const ROUTE = z.string().min(1).max(40).describe('route slug, e.g. "alerts" (not a URL)')
const NAME = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/).describe('vault entry name, 1-64 chars of [A-Za-z0-9_.-]')

export const SAFETY_TEXT = `COVENANT MCP safety model

- Read tools never spend and need no key.
- Spending tools (covenant_pay, covenant_open_session) exist ONLY when the server has a wallet configured.
- Every tool that changes state or spends is a dry run until called again with confirm:true. Show the dry-run plan to the user and get an explicit yes for that exact action first.
- The server enforces a per-call maxUsdg, a hard per-payment cap and a session budget, regardless of what you request.
- You can only name a route slug, an address, a vault entry name or an environment variable name. You can never supply a URL, a header, a method or a secret value.
- Secrets never enter your context: the agent API key and wallet keys are kept in files (mode 600), vault values are read from the server's environment, and covenant_vault_broker output is scrubbed.
- Chain: Robinhood Chain (4663), asset USDG. Other rails listed by the gateway are not settlement-ready; check covenant_status.`

export function buildServer(cfg, core = createCore(cfg)) {
  const server = new McpServer({ name: 'covenant', version: VERSION }, {
    instructions: 'COVENANT: x402 paid APIs, a credential vault and agent wallets on Robinhood Chain. Start with covenant_status and covenant_list_apis. Never pay or change state without showing the user the dry-run plan and getting explicit approval. Read the covenant://safety resource for the rules.',
  })
  const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })
  const redact = (t) => {
    let out = String(t)
    for (const secret of [cfg.walletKey, cfg.agentKey, cfg.rpc]) if (secret && String(secret).length >= 8) out = out.split(String(secret)).join('[redacted]')
    return out.replace(/cvn_[0-9a-f]{48}/g, 'cvn_[redacted]').replace(/https?:\/\/[^\s"')]+/g, (u) => (u.startsWith(cfg.gateway) ? u : '[url]'))
  }
  const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${redact(e?.message || e)}` }] })
  const wrap = (fn) => async (args) => { try { return ok(await fn(args || {})) } catch (e) { return fail(e) } }
  const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  const CONFIRM = z.boolean().optional().describe('must be true to actually do it; omit for a dry run')
  const tool = (name, title, description, inputSchema, annotations, fn) => server.registerTool(name, { title, description, inputSchema, annotations }, wrap(fn))

  // -------------------------------------------------- discovery & read (no key, no spend)
  tool('covenant_status', 'Gateway status', 'Live health of the gateway and which chains are settlement-ready.', {}, RO, () => core.status())
  tool('covenant_list_apis', 'List paid APIs', 'Paid routes (core + marketplace) with USDG prices on Robinhood Chain. Use a returned `route` with covenant_inspect_route.', {}, RO, () => core.listApis())
  tool('covenant_inspect_route', 'Inspect a 402 challenge', 'The x402 payment requirement for one route: price, network, asset. Never pays.', { route: ROUTE }, RO, ({ route }) => core.inspectRoute(route))
  tool('covenant_receipts', 'Recent on-chain receipts', 'Most recent real settlements with transaction hashes and explorer links.', { limit: z.number().int().min(1).max(50).optional() }, RO, ({ limit }) => core.receipts(limit))
  tool('covenant_reputation', 'Reputation score', 'Explainable 0-100 reputation of an address, derived from its settled payments (each anchored to a tx hash).', { address: ADDR }, RO, ({ address }) => core.reputation(address))
  tool('covenant_explorer_link', 'Explorer link', 'Robinhood Chain explorer URL for a transaction hash.', { tx: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }, RO, ({ tx }) => ({ url: core.explorerLink(tx) }))
  tool('covenant_stats', 'Gateway statistics', 'Aggregate counters: paid routes, 402 gate hits, on-chain settlements, USDG settled.', {}, RO, () => core.stats())
  tool('covenant_leaderboard', 'Top payers', 'Top paying addresses by settled USDG.', {}, RO, () => core.leaderboard())
  tool('covenant_usage', 'Daily usage', 'Daily hits, paid calls and USDG for the last days.', {}, RO, () => core.usage())
  tool('covenant_supported_rails', 'Declared payment rails', 'The schemes/networks the gateway declares (exact, covenant-session, upto) and its x402 resources. A declared rail is not necessarily settlement-ready: see covenant_status.', {}, RO, () => core.supportedRails())
  tool('covenant_solana_info', 'Solana rail info', 'Solana facilitator info (fee payer, supported assets). Informational.', {}, RO, () => core.solanaInfo())
  tool('covenant_marketplace_earnings', 'Seller earnings', 'Earnings of a marketplace seller address.', { seller: ADDR }, RO, ({ seller }) => core.marketplaceEarnings(seller))
  tool('covenant_balance', 'Prepaid balance', 'Prepaid balance, keys and subscriptions of a buyer address.', { buyer: ADDR }, RO, ({ buyer }) => core.balance(buyer))
  tool('covenant_session_status', 'Session status', 'Remaining calls and expiry of a prepaid session id.', { sessionId: z.string().min(8).max(80) }, RO, ({ sessionId }) => core.sessionStatus(sessionId))
  tool('covenant_vault_status', 'Vault status', 'Aggregate vault counters (entries, brokered calls). Never names or values.', {}, RO, () => core.vaultStatus())
  tool('covenant_spend_summary', 'Spend summary', 'What this MCP server may spend (caps, budget) and what it has spent so far, with receipts.', {}, RO, async () => core.spendSummary())

  // -------------------------------------------------- agent identity
  tool('covenant_register_agent', 'Register this agent', 'Mint an agent API key on the gateway (needed for the vault and wallets). The key is stored server-side (mode-600 file if configured) and is NEVER returned to you. Dry run unless confirm:true.',
    { label: z.string().max(40).optional(), confirm: CONFIRM }, WRITE, (a) => core.registerAgent(a))
  tool('covenant_whoami', 'Agent identity', 'Your agent key id, label, prefix and usage. Requires a registered agent.', {}, RO, () => core.whoami())
  tool('covenant_revoke_self_key', 'Revoke agent key', 'Permanently revoke this agent key (orphans its vault entries and wallets). Dry run unless confirm:true.', { confirm: CONFIRM }, DESTRUCTIVE, (a) => core.revokeSelfKey(a))

  // -------------------------------------------------- vault
  tool('covenant_vault_list', 'List vault entries', 'Names, use counts and lengths of your vault entries. Values are never returned.', {}, RO, () => core.vaultList())
  tool('covenant_vault_set', 'Store a secret', 'Store a secret in the encrypted vault. You cannot pass the value: name an environment variable COVENANT_VAULT_SRC_<NAME> that the server operator set, and the server reads it. Dry run unless confirm:true.',
    { name: NAME, fromEnv: z.string().regex(/^COVENANT_VAULT_SRC_[A-Z0-9_]{1,40}$/).describe('environment variable name on the MCP server, e.g. COVENANT_VAULT_SRC_OPENAI'), confirm: CONFIRM }, WRITE, (a) => core.vaultSet(a))
  tool('covenant_vault_delete', 'Delete a secret', 'Delete a vault entry. Dry run unless confirm:true.', { name: NAME, confirm: CONFIRM }, DESTRUCTIVE, (a) => core.vaultDelete(a))
  tool('covenant_vault_broker', 'Resolve {{placeholders}}', 'Substitute {{name}} placeholders with your vault secrets server-side and return the text with every secret scrubbed to [REDACTED:name]. Use it to prove a credential works without ever seeing it.',
    { text: z.string().min(1).max(20000).describe('text containing {{vault_entry_name}} placeholders') }, WRITE, ({ text }) => core.vaultBroker(text))
  tool('covenant_wallets_list', 'List agent wallets', 'Agent wallets created through the gateway (address, label, chain). No keys.', {}, RO, () => core.walletsList())

  // -------------------------------------------------- spending (wallet only)
  if (cfg.walletKey) {
    tool('covenant_pay', 'Pay for a route (USDG)', 'SPENDS REAL USDG on Robinhood Chain from the configured wallet. First call WITHOUT confirm to get a dry-run plan and show it to the user. Only call with confirm:true after the user explicitly approved this exact route and price. Enforced by the server: per-call maxUsdg, a hard per-payment cap and a session budget.',
      { route: ROUTE, maxUsdg: z.number().positive().max(10).describe('most you will pay for this call, in USDG'), confirm: CONFIRM }, DESTRUCTIVE, (a) => core.pay(a))
    tool('covenant_open_session', 'Open a prepaid session (USDG)', 'SPENDS REAL USDG: pay once to get a prepaid session of 100 calls for 1 hour (size fixed by the gateway). Dry run first; same caps as covenant_pay.',
      { maxUsdg: z.number().positive().max(10), confirm: CONFIRM }, DESTRUCTIVE, (a) => core.openSession(a))
    tool('covenant_session_redeem', 'Redeem a session call', 'Consume one prepaid call from a session. Dry run unless confirm:true.', { sessionId: z.string().min(8).max(80), confirm: CONFIRM }, WRITE, (a) => core.sessionRedeem(a))
  }
  if (cfg.walletExportDir) {
    tool('covenant_wallet_create', 'Create an agent wallet', 'Create a new agent wallet on Robinhood Chain. The private key and mnemonic are written to a mode-600 file on the server and NOT returned to you. Dry run unless confirm:true.',
      { label: z.string().max(40).optional(), confirm: CONFIRM }, WRITE, (a) => core.walletCreate(a))
  }

  // -------------------------------------------------- resources
  const text = (uri, mime, body) => ({ contents: [{ uri: uri.href, mimeType: mime, text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }] })
  server.registerResource('safety', 'covenant://safety', { title: 'Safety model', description: 'The rules every COVENANT tool follows. Read before spending or storing secrets.', mimeType: 'text/markdown' }, async (uri) => text(uri, 'text/markdown', SAFETY_TEXT))
  server.registerResource('catalog', 'covenant://catalog', { title: 'Live API catalog', description: 'Paid routes with prices, read live from the gateway.', mimeType: 'application/json' }, async (uri) => text(uri, 'application/json', await core.listApis()))
  server.registerResource('status', 'covenant://status', { title: 'Gateway status', description: 'Health and chain readiness, read live.', mimeType: 'application/json' }, async (uri) => text(uri, 'application/json', await core.status()))
  server.registerResource('receipts', 'covenant://receipts', { title: 'Recent receipts', description: 'Latest real settlements with tx hashes.', mimeType: 'application/json' }, async (uri) => text(uri, 'application/json', await core.receipts(20)))
  server.registerResource('spend', 'covenant://spend', { title: 'Spend limits and ledger', description: 'Caps, budget and what this server has spent.', mimeType: 'application/json' }, async (uri) => text(uri, 'application/json', core.spendSummary()))

  // -------------------------------------------------- prompts
  const user = (t) => ({ messages: [{ role: 'user', content: { type: 'text', text: t } }] })
  server.registerPrompt('covenant_discover', { title: 'Discover paid APIs (no payment)', description: 'Find paid APIs and explain their 402 requirements without paying.' },
    () => user('Use the COVENANT tools to discover the available paid APIs. Call covenant_status, covenant_list_apis, then covenant_inspect_route on the cheapest route. Explain the price, network and asset, and how settlement works. Do not make a payment.'))
  server.registerPrompt('covenant_pay_safely', { title: 'Pay for one route, with approval', description: 'Dry-run a payment, ask for approval, then pay.', argsSchema: { route: z.string().max(40), maxUsdg: z.string().max(10) } },
    ({ route, maxUsdg }) => user(`I want to call the paid route "${route}" and I will pay at most ${maxUsdg} USDG. First call covenant_inspect_route, then covenant_pay WITHOUT confirm and show me the plan (price, wallet, balance, budget). Wait for my explicit yes. Only then call covenant_pay with confirm:true, and report the transaction hash with its explorer link and the delivered data.`))
  server.registerPrompt('covenant_secure_credentials', { title: 'Use a credential without seeing it', description: 'Store and use an API secret through the vault.', argsSchema: { name: z.string().max(64) } },
    ({ name }) => user(`Help me use a credential through the COVENANT vault. Call covenant_vault_list. If "${name}" is not stored, tell me to set COVENANT_VAULT_SRC_<NAME> on the MCP server, then use covenant_vault_set with fromEnv (dry run first, then confirm after I agree). Never ask me to paste the secret. Prove it works with covenant_vault_broker using the placeholder {{${name}}} and show me that the output is scrubbed.`))
  server.registerPrompt('covenant_audit_receipts', { title: 'Audit recent settlements', description: 'Review recent on-chain receipts and the gateway reputation of a payer.', argsSchema: { address: z.string().max(42).optional() } },
    ({ address }) => user(`Call covenant_receipts (limit 10)${address ? ` and covenant_reputation for ${address}` : ''}. Summarise the settlements, flag anything odd, and give me the explorer link for each transaction.`))

  return server
}

async function main() {
  const cfg = loadConfig()
  const server = buildServer(cfg)
  await server.connect(new StdioServerTransport())
  console.error(`[covenant-mcp ${VERSION}] ready · gateway ${cfg.gateway} · paying ${cfg.walletKey ? `ENABLED (cap ${cfg.maxPaymentUsdg} USDG/payment, budget ${cfg.sessionBudgetUsdg} USDG)` : 'disabled (read-only)'} · agent key ${cfg.agentKey ? 'loaded' : 'not loaded'}`)
}

import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error('[covenant-mcp] fatal:', e.message); process.exit(1) })
