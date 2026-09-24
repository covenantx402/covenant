# TRIBUTE — x402 v2 payment rails for agents on Robinhood Chain 4663

> Huge update coming next week: paid agent endpoints in USDG over x402 v2, with instant settlement on Robinhood Chain and credentials that never touch a prompt.

TRIBUTE is open-source, MIT-licensed payment infrastructure for agents. It turns any endpoint into a paid USDG route, settles through x402 v2 on Robinhood Chain, and brokers agent credentials through a live vault so models can use secrets without seeing them — model-proof by design.

TRIBUTE is a three-layer stack for building **paid, stateless AI agent services** on Robinhood Chain (chain ID 4663), settled in USDG:

| Layer | What it does | Where |
|---|---|---|
| **Payments** | Turn any endpoint into a paid x402 route. 402 → signed payment intent → on-chain settlement. | `kit/` + `gateway/` |
| **Vault** | Agent credential broker. Secrets live server-side, referenced as `{{name}}`, scrubbed from every readback. | `gateway/agent-vault.js` |
| **Intelligence** | Live chain telemetry + settlement stats feed for dashboards and alert agents. | `gateway/` stats endpoints |

A fourth pillar — **Identity** (per-agent wallets + API keys + payment-derived reputation with on-chain tx anchors) — is built in: every agent gets a server-generated wallet and a `trb_...` API key; every settled payment raises its reputation score.

## Repository layout

```
gateway/   Zero-dependency HTTP gateway: RPC proxy, x402 routes, vault, facilitator (settlement)
kit/       TypeScript middleware library (@tribute/express-style paywall for Express/Hono/Fastify)
examples/  Runnable examples: paywalled API, agent client that pays
skill/     Agent skill file (SKILL.md) — teach any agent to use TRIBUTE
```

## Quick start (gateway)

```bash
cd gateway
npm install            # pulls ethers
cp .env.example .env   # set RPC upstream + settlement key
node server.js         # listens on 127.0.0.1:8792
```

Environment:

| Variable | Required | Purpose |
|---|---|---|
| `TRIBUTE_RPC_UPSTREAM` | yes | JSON-RPC URL for Robinhood Chain (e.g. `https://robinhood-rpc.publicnode.com`). Comma-separate multiple URLs for automatic failover on the settlement path (`ethers.FallbackProvider`, quorum 1) — recommended in production. |
| `TRIBUTE_PORT` | no | Listen port (default `8792`) |
| `TRIBUTE_SETTLE_KEY` | for settlement | Private key of the facilitator's settlement wallet (the spender agents approve) |
| `TRIBUTE_X402_PAYTO` | no | Default recipient address for paid routes |
| `TRIBUTE_VAULT_KEY` | recommended | Pepper for vault encryption at rest. If unset, derived from the RPC URL — set your own in production |
| `TRIBUTE_VAULT_STORE` | no | Vault persistence path (default `data/vault.json`) |
| `TRIBUTE_KEYS_STORE` | no | Agent API key store path (default `data/keys.json`) |
| `TRIBUTE_WALLETS_STORE` | no | Agent wallet registry path (default `data/wallets.json`) |
| `TRIBUTE_SETTLE_STORE` | no | Settlement nonce replay-guard path (default `data/settlements.json`) |

## How settlement works (honest version)

USDG on Robinhood Chain 4663 (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`) does **not** implement EIP-3009 `transferWithAuthorization` — we verified the implementation bytecode on-chain. So TRIBUTE settles with the **approve + transferFrom** pattern:

1. The gateway returns `402` with `X-PAYMENT-REQUIRED` describing the price, asset, recipient, and the facilitator's spender address.
2. The paying agent approves the spender once (`USDG.approve(spender, amount)`), then signs an **EIP-712 `PaymentIntent`** in the TRIBUTE domain:
   ```
   PaymentIntent { from, to, value, validAfter, validBefore, nonce, resource }
   ```
   Domain: `name "TRIBUTE"`, `version "1"`, `chainId 4663`, `verifyingContract` = USDG.
3. The agent POSTs `{ intent, signature }` to `POST /facilitator/settle`.
4. The facilitator verifies the signature, checks balance + allowance + authorization window + nonce replay, then executes `transferFrom(from, to, value)` on-chain and returns the tx hash.

Every settlement is replay-guarded by nonce (persisted to disk) and auditable by tx hash.

## Gateway endpoints

Open (no auth):

- `GET /x402/apis` — registered paid routes
- `GET /x402/api/:slug` — unpaid call → `402` + payment requirements
- `GET /x402/premium` — sample paid endpoint
- `POST /facilitator/verify` — verify a signed payment intent (no settlement)
- `POST /facilitator/settle` — settle on-chain
- `GET /facilitator` — settlement config + stats
- `POST /keys` — mint an agent API key (raw key shown once)
- `GET /analytics/keys` (key auth) — per-key usage: self, fleet totals, top 5
- `GET /reputation/:address` — 0-100 score anchored to tx hashes
- `GET /vault/status`, `GET /x402/stats` — dashboards
- `POST /` — whitelisted read-only RPC proxy (`eth_chainId`, `eth_blockNumber`, `eth_gasPrice`, `eth_getBlockByNumber`, `net_version`, `eth_call`)

Agent-key authed (`Authorization: Bearer trb_...`):

- `POST /vault/entries` — store a secret by name (value never returned)
- `GET /vault/entries` / `DELETE /vault/entries` — list / delete
- `POST /vault/broker` — substitute `{{placeholders}}` server-side, scrub output
- `POST /wallets/create` — server-generated wallet, private key vaulted, shown once
- `GET /wallets`, `GET /keys`, `DELETE /keys`

## Paid sessions (pay once, call N times)

Settle once with `resource: "session"` and the gateway issues a bearer session id:

```bash
curl -s -X POST $GATEWAY/facilitator/settle \
  -H 'content-type: application/json' \
  -d '{"intent":{...,"resource":"session"},"signature":"0x...","extra":{"calls":100,"ttlSec":3600}}'
# → { success: true, transaction: "0x...", session: { id: "...", callsMax: 100, expiresAt: ... } }
```

Then each call redeems the session — no per-request on-chain payment:

```bash
curl -s -X POST $GATEWAY/session/redeem -d '{"sessionId":"..."}'
# → { ok: true, callsRemaining: 99 }   (402 when budget/TTL exhausted)
```

The `402` challenge advertises both schemes: `tribute-intent` (per-call) and `tribute-session` (budget + TTL).

## Reputation

Every settled payment feeds a per-address reputation score (0-100) with an explainable model: settled count (40 pts, log), cumulative volume (25 pts), longevity (15 pts), recency (20 pts). Every claim is anchored to a verifiable transaction hash.

- `GET /reputation/:address` — score, tier (`new` / `established` / `trusted`), settlement count, tx anchors
- `GET /reputation` — leaderboard

## Rate limiting

Sliding-window per agent key (authenticated) or IP (open endpoints), with `X-RateLimit-*` and `Retry-After` headers. Defaults: 5 keys/hour per IP on `POST /keys`, 60 settles/min, 120 verifies/min, 300 req/min generic. Tune in `server.js` → `RATE_LIMITS`.

## The kit (TypeScript middleware)

`kit/` is a self-contained x402 paywall middleware (Express-style) with:

- YAML/programmatic route pricing in USD decimals, converted to atomic units
- Facilitator client for `/verify` + `/settle`
- SQLite usage analytics
- Per-network stablecoin metadata (Robinhood → USDG, 6 decimals)

See `kit/src/middleware.ts` and `examples/`.

## Examples

- `examples/paid-api.js` — spin up a paid endpoint with the gateway
- `examples/pay.js` — an agent client: fetch 402 → sign intent → settle → receive resource

## Security notes (read before deploying)

- Set `TRIBUTE_VAULT_KEY` in production; otherwise the vault key is derived from the RPC URL.
- `POST /keys` is intentionally open (frictionless onboarding for new agents); rate-limit it at your edge if you expose the gateway publicly.
- The settlement wallet (`TRIBUTE_SETTLE_KEY`) can pull any USDG amount agents have approved to it. Run it hot with a small float; keep the bulk cold.
- The RPC proxy is a strict method whitelist — no state-changing methods pass through.

## License

MIT

