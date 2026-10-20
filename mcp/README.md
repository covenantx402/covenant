# @covenantx402/mcp

MCP server for [COVENANT](https://covenantx402.com): let an agent **discover paid APIs, inspect x402 challenges, read real receipts**, and (only if you opt in) **pay in USDG on Robinhood Chain**.

Works with Claude Code, Claude Desktop, Cursor, and any MCP client.

## Tools

| Tool | What it does | Spends money? |
|---|---|---|
| `covenant_status` | Gateway health + which chains are settlement-ready | no |
| `covenant_list_apis` | Paid routes (core + marketplace) with USDG prices | no |
| `covenant_inspect_route` | The 402 challenge for one route: price, network, asset | no |
| `covenant_receipts` | Recent real settlements with tx hash + explorer link | no |
| `covenant_reputation` | Explainable 0-100 score for an address | no |
| `covenant_explorer_link` | Explorer URL for a tx hash | no |
| `covenant_pay` | Pay for one route. **Only exists when a wallet is configured** | **yes** |

## Install

Read-only (no key, nothing can be spent):

```bash
claude mcp add covenant -- npx -y @covenantx402/mcp
```

Claude Desktop / Cursor (`mcp.json`):

```json
{ "mcpServers": { "covenant": { "command": "npx", "args": ["-y", "@covenantx402/mcp"] } } }
```

From this repo: `cd mcp && npm install && node src/index.js`.

## Enabling payments (opt-in)

```json
{
  "mcpServers": {
    "covenant": {
      "command": "npx", "args": ["-y", "@covenantx402/mcp"],
      "env": {
        "COVENANT_WALLET_KEY_FILE": "/home/you/.covenant-wallet",
        "COVENANT_MAX_PAYMENT_USDG": "0.05",
        "COVENANT_SESSION_BUDGET_USDG": "0.10"
      }
    }
  }
}
```

Use a **disposable wallet holding only a few cents of USDG plus a little gas**. Prefer `COVENANT_WALLET_KEY_FILE` (must be `chmod 600`) over putting a key in a config file.

| Variable | Default | Meaning |
|---|---|---|
| `COVENANT_GATEWAY` | `https://gateway.covenantx402.com` | https only (http only for localhost) |
| `COVENANT_WALLET_KEY_FILE` / `COVENANT_WALLET_KEY` | none | enables `covenant_pay` |
| `COVENANT_MAX_PAYMENT_USDG` | `0.05` | hard ceiling per payment |
| `COVENANT_SESSION_BUDGET_USDG` | `0.10` | total this server process may ever spend |
| `COVENANT_RPC_URL` | public Robinhood RPC | used only for the one-time approval |

## Safety model

- **No wallet, no pay tool.** `tools/list` does not even contain `covenant_pay` unless a key is configured.
- **Dry run first.** `covenant_pay` without `confirm: true` returns a plan and signs nothing. The tool description tells the model to show that plan to you and only pay after explicit approval.
- **Server-enforced limits**, independent of what the model says: per-call `maxUsdg`, a hard per-payment cap, and a session budget.
- **Model input can't choose where money goes.** Routes are slugs only (URLs are rejected). Before signing, the server refuses any challenge whose network isn't Robinhood Chain 4663, whose asset isn't the known USDG contract, whose `payTo` differs from the facilitator spender, or whose resource is outside the configured gateway.
- **The key is never an input and never output.** It is read from the environment or a file only; tests assert it never appears in tool output or logs.
- **Idempotent settlement.** The gateway settles one signed intent at most once, so a retry after a timeout cannot double-charge.

Limitations: one chain (Robinhood Chain), one asset (USDG). Ethereum, Base and Arbitrum rails are not settlement-ready yet (see `covenant_status`).

## Test

```bash
npm test   # unit + real stdio protocol round-trip + live read-only calls
```
