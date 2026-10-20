# @covenantx402/mcp

MCP server for [COVENANT](https://covenantx402.com): x402 paid APIs, an encrypted credential vault and agent wallets on **Robinhood Chain**. Lets an agent discover paid APIs, read real receipts, keep secrets out of the model, and (only if you opt in) pay in USDG within hard limits.

Works with Claude Code, Claude Desktop, Cursor and any MCP client. **28 tools · 5 resources · 4 prompts** (24 tools until you configure a wallet).

## Install

Read-only (no key, nothing can be spent):

```bash
claude mcp add covenant -- npx -y @covenantx402/mcp
```

Claude Desktop / Cursor (`mcp.json`):

```json
{ "mcpServers": { "covenant": { "command": "npx", "args": ["-y", "@covenantx402/mcp"] } } }
```

## Hosted endpoint (no install)

A read-only instance is hosted at **`https://mcp.covenantx402.com/mcp`** (Streamable HTTP, stateless):

```bash
claude mcp add --transport http covenant https://mcp.covenantx402.com/mcp
```

It exposes the **16 discovery/read tools, 5 resources and 4 prompts**. It holds no wallet, no agent key and no vault, and the spending, identity, vault and wallet tools are **not registered at all** (tested with credentials deliberately placed in its environment). It is rate-limited (120 requests/min per client) and limited to 64 KB requests. To pay, store secrets or create wallets, run the local package below with your own keys.

## Tools

**Discovery and read (no key, never spend)**

| Tool | What it does |
|---|---|
| `covenant_status` | Gateway health and which chains are settlement-ready |
| `covenant_list_apis` | Paid routes (core + marketplace) with USDG prices |
| `covenant_inspect_route` | The 402 challenge for one route: price, network, asset |
| `covenant_receipts` | Recent real settlements with tx hash and explorer link |
| `covenant_reputation` | Explainable 0-100 score for an address |
| `covenant_stats` / `covenant_leaderboard` / `covenant_usage` | Aggregate counters, top payers, daily usage |
| `covenant_supported_rails` / `covenant_solana_info` | Declared schemes and networks |
| `covenant_marketplace_earnings` / `covenant_balance` | Seller earnings, buyer prepaid balance |
| `covenant_session_status` | Remaining calls of a prepaid session |
| `covenant_vault_status` / `covenant_explorer_link` / `covenant_spend_summary` | Aggregate vault counters, explorer URL, what this server may spend |

**Agent identity** (needs the gateway's open key mint; dry-run first)

| Tool | What it does |
|---|---|
| `covenant_register_agent` | Mint an agent API key. Stored in a mode-600 file, **never returned** to the model |
| `covenant_whoami` | Your key id, label, prefix and usage |
| `covenant_revoke_self_key` | Revoke your key (destructive, dry-run first) |

**Vault** (needs a registered agent)

| Tool | What it does |
|---|---|
| `covenant_vault_set` | Store a secret. The model **cannot pass the value**: it names an env var `COVENANT_VAULT_SRC_<NAME>` that you set on the server |
| `covenant_vault_list` | Names, use counts, lengths. Never values |
| `covenant_vault_delete` | Delete an entry (dry-run first) |
| `covenant_vault_broker` | Substitute `{{name}}` server-side and return the text with every secret scrubbed to `[REDACTED:name]` |
| `covenant_wallets_list` | Agent wallets (address, label, chain). No keys |

**Spending** (only listed when a wallet is configured)

| Tool | What it does |
|---|---|
| `covenant_pay` | Pay for one route in USDG |
| `covenant_open_session` | Pay once for a prepaid session (100 calls / 1h) |
| `covenant_session_redeem` | Consume one prepaid call |
| `covenant_wallet_create` | Create an agent wallet (also needs `COVENANT_WALLET_EXPORT_DIR`); the key and mnemonic go to a mode-600 file, **not** to the model |

**Resources:** `covenant://safety`, `covenant://catalog`, `covenant://status`, `covenant://receipts`, `covenant://spend`.
**Prompts:** `covenant_discover`, `covenant_pay_safely`, `covenant_secure_credentials`, `covenant_audit_receipts`.

## Enabling payments (opt-in)

```json
{
  "mcpServers": {
    "covenant": {
      "command": "npx", "args": ["-y", "@covenantx402/mcp"],
      "env": {
        "COVENANT_WALLET_KEY_FILE": "/home/you/.covenant-wallet",
        "COVENANT_AGENT_KEY_FILE": "/home/you/.covenant-agent-key",
        "COVENANT_MAX_PAYMENT_USDG": "0.05",
        "COVENANT_SESSION_BUDGET_USDG": "0.10"
      }
    }
  }
}
```

Use a **disposable wallet holding only a few cents of USDG plus a little gas**. Prefer `*_KEY_FILE` (must be `chmod 600`) over putting a key in a config file.

| Variable | Default | Meaning |
|---|---|---|
| `COVENANT_GATEWAY` | `https://gateway.covenantx402.com` | https only (http only for localhost) |
| `COVENANT_WALLET_KEY_FILE` / `COVENANT_WALLET_KEY` | none | enables the spending tools |
| `COVENANT_AGENT_KEY_FILE` / `COVENANT_AGENT_KEY` | none | agent key for vault and wallets; `register_agent` writes it to the file |
| `COVENANT_WALLET_EXPORT_DIR` | none | enables `covenant_wallet_create`; keys are written here |
| `COVENANT_VAULT_SRC_<NAME>` | none | secret values the model may *name* (never see) for `covenant_vault_set` |
| `COVENANT_FACILITATOR` | COVENANT's known spender | the only address the server will ever approve/pay; set only if it legitimately changes |
| `COVENANT_MAX_PAYMENT_USDG` | `0.05` | hard ceiling per payment |
| `COVENANT_SESSION_BUDGET_USDG` | `0.10` | total this server process may ever spend |
| `COVENANT_RPC_URL` | public Robinhood RPC | used only for the one-time approval |

## Safety model

- **No wallet, no spending tools.** `tools/list` doesn't contain them unless a key is configured.
- **Dry run first.** Every tool that spends or changes state does nothing until called again with `confirm: true`. Tool descriptions and the `covenant://safety` resource tell the model to show you the plan and get an explicit yes.
- **Server-enforced limits**, independent of what the model says: per-call `maxUsdg`, a hard per-payment cap, and a session budget.
- **The model can't choose where money or secrets go.** It can name a route slug, an address, a vault entry name or an env-var name. It can never supply a URL, header, method or secret value. Before signing, the server refuses any challenge whose network isn't Robinhood Chain 4663, whose asset isn't the known USDG contract, whose `payTo` differs from the facilitator spender, or whose resource is outside the configured gateway.
- **Secrets never enter the model's context.** The agent key, wallet keys and mnemonics live in mode-600 files; vault values are read from the server environment; broker output is scrubbed. Tests assert none of them appear in tool output or logs.
- **Pinned facilitator and serialized payments.** Only COVENANT's known facilitator address is ever approved or paid, even if the gateway says otherwise. Confirmed payments run one at a time, and the price is reserved against the budget before signing (a pending or failed settle stays counted, so a retry can't silently double-spend).
- **Hostile-gateway hardening.** Redirects are refused, amounts are parsed strictly, responses are size-capped, wallet/RPC errors never reveal the RPC URL, and gateway text in errors is labelled untrusted.
- **Idempotent settlement.** The gateway settles one signed intent at most once, so a retry after a timeout cannot double-charge.

## Limitations

- One chain (Robinhood Chain 4663), one asset (USDG). Ethereum, Base and Arbitrum are declared by the gateway but are **not settlement-ready**; `covenant_status` shows the live state.
- The hosted endpoint is read-only by design. Spending, identity, vault and wallet tools exist only in the local stdio package.
- `covenant_register_agent` relies on the gateway's open key mint; the agent key is not tied to a wallet identity.
- The spend budget counts only payments made by this server process and resets on restart.

## Test

```bash
npm install && npm test   # mocked safety tests + stdio protocol round-trip + live read-only calls + hosted HTTP server tests
npm run start:http        # run the read-only hosted server locally (COVENANT_MCP_PORT, default 8795)
```
