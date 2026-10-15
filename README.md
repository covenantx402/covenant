<p align="center">
  <img src="assets/logo.svg" width="72" alt="COVENANT logo" />
</p>

<h1 align="center">COVENANT</h1>
<p align="center"><strong>x402 payment rails + agent infrastructure on Robinhood Chain 4663</strong></p>

<p align="center">
  <a href="https://github.com/tributelab/covenant/actions/workflows/ci.yml"><img src="https://github.com/tributelab/covenant/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/@covenantx402/x402-kit"><img src="https://img.shields.io/npm/v/%40covenantx402%2Fx402-kit.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1ecb74.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/x402-v1%20%2B%20v2-1ecb74.svg" alt="x402 v1 + v2">
  <img src="https://img.shields.io/badge/chain-Robinhood%204663-1ecb74.svg" alt="Robinhood Chain 4663">
</p>

<p align="center"><img src="assets/banner.svg" width="100%" alt="COVENANT banner" /></p>

> Paid agent endpoints in USDG over x402, with instant on-chain settlement and credentials that never touch a prompt.

COVENANT turns any endpoint into a paid USDG route, settles through **x402 — v1 and v2 simultaneously** — on Robinhood Chain, and brokers agent credentials through a live vault so models can use secrets without seeing them. Open source, MIT-licensed.

Four pillars, one gateway:

| Layer | What it does | Where |
|---|---|---|
| **Payments** | Any endpoint → paid x402 route. 402 → signed intent → on-chain settlement. Dual-protocol: emits x402 v1 (JSON body) *and* v2 (`Payment-Required` header + `extensions.bazaar` discovery) on every paid response. | `kit/` + `gateway/` |
| **Vault** | Agent credential broker. Secrets referenced as `{{name}}`, AES-256-GCM at rest, scrubbed from every readback. | `gateway/agent-vault.js` |
| **Identity** | Every agent gets a server-generated wallet + a `cvn_...` API key on first use. | `gateway/wallets.js`, `gateway/keys.js` |
| **Reputation** | Every settled payment feeds an explainable 0–100 score, anchored to real tx hashes — not a black box. | `gateway/reputation.js` |

## Why this isn't "just a 402 demo"

- **Machine-readable discovery that's actually complete.** `GET /openapi.json` returns a full OpenAPI 3.1 document — every paid route carries `x-payment-info` with *both* the per-call and session protocols, so an agent scanner (e.g. [x402scan](https://www.x402scan.com)) discovers the cheaper session option without a human reading the README first.
- **Dual x402 transport, same route.** The ecosystem moved from v1 (JSON-body challenge) to v2 (`Payment-Required` header + `extensions.bazaar`) in Dec 2025. COVENANT's `x402-v2.js` adapter encodes a spec-compliant v2 header with the official `@x402/core` codec on top of the same route data — old clients and new clients both get a valid 402, no flag-flipping.
- **Settlement is the honest `approve+transferFrom` pattern, not a claimed EIP-3009.** USDG on Robinhood Chain 4663 does **not** implement `transferWithAuthorization` — verified against the on-chain bytecode, documented in the code rather than assumed. See [How settlement works](#how-settlement-works).
- **Sessions aren't a toy feature.** Settle once (0.01 USDG → 100 calls / 1h), then `POST /session/redeem` per call with **no wallet interaction, no signature, no on-chain tx** — a 100x cost reduction for agents that hammer an API, and it's advertised in the OpenAPI doc's `x-payment-info.protocols[1]`, not hidden behind a support thread.
- **Reputation is explainable, not vibes.** `score(address)` = settled-count (log scale, 40pt) + cumulative volume (25pt) + longevity (15pt) + recency (20pt) — every point traceable to a real settlement tx hash via `GET /reputation/:address`.

## Repository layout

```
gateway/   Zero-dependency HTTP gateway: RPC proxy, x402 v1+v2, vault, facilitator (settlement), reputation
kit/       TypeScript middleware (@covenantx402/x402-kit) — Express paywall + usage analytics
examples/  Runnable examples: paywalled API, agent client that pays
skill/     Agent skill file (SKILL.md) — teach any agent (Claude/Cursor/Hermes) to use COVENANT
```

## Quick start (gateway)

```bash
cd gateway
npm install            # pulls ethers, better-sqlite3, @x402/core
cp .env.example .env   # set RPC upstream + settlement key
node server.js         # listens on 127.0.0.1:8792
```

Then explore the machine-readable contract: `curl http://127.0.0.1:8792/openapi.json`

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `COVENANT_RPC_UPSTREAM` | yes | JSON-RPC URL for Robinhood Chain (e.g. `https://robinhood-rpc.publicnode.com`). Comma-separate for automatic failover (`ethers.FallbackProvider`, quorum 1) on the settlement path — recommended in production. |
| `COVENANT_PORT` | no | Listen port (default `8792`) |
| `COVENANT_SETTLE_KEY` | for settlement | Private key of the facilitator's settlement wallet (the spender agents approve) |
| `COVENANT_X402_PAYTO` | no | Default recipient address for paid routes |
| `COVENANT_VAULT_KEY` | recommended | Pepper for vault encryption at rest. Derived from the RPC URL if unset — set your own in production |
| `COVENANT_VAULT_STORE` / `COVENANT_KEYS_STORE` / `COVENANT_WALLETS_STORE` / `COVENANT_SETTLE_STORE` | no | Storage paths (default under `data/`) |
| `COVENANT_TRUSTED_PROXIES` | no | Comma-separated reverse-proxy IPs trusted to set `X-Forwarded-For` for per-IP rate limiting. Leave empty when reached directly. |

## How settlement works

USDG on Robinhood Chain 4663 (`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`) does **not** implement EIP-3009 `transferWithAuthorization` — verified against the on-chain bytecode. COVENANT settles with **approve + transferFrom**:

1. Gateway returns `402` describing price, asset, recipient, and the facilitator's spender address (v1 JSON body *and* v2 `Payment-Required` header, both on the same response).
2. Agent approves the spender once (`USDG.approve(spender, amount)`), then signs an **EIP-712 `PaymentIntent`**:
   ```
   PaymentIntent { from, to, value, validAfter, validBefore, nonce, resource }
   ```
   Domain: `name "COVENANT"`, `version "1"`, `chainId 4663`, `verifyingContract` = USDG.
3. Agent POSTs `{ intent, signature }` to `POST /facilitator/settle`.
4. Facilitator verifies signature + balance + allowance + authorization window + nonce replay, executes `transferFrom`, returns the tx hash.

Every settlement is replay-guarded by a persisted nonce and auditable by tx hash. Set `resource: "session"` instead to open a 100-call / 1h prepaid session in the same settle call — see [`/x402/premium`'s `x-payment-info.protocols[1]`](#why-this-isnt-just-a-402-demo).

## Gateway endpoints

**Discovery (free, no auth):**

- `GET /openapi.json` — full OpenAPI 3.1 contract, every route's price + both payment protocols
- `GET /.well-known/x402` — x402scan-compatible resource index
- `GET /x402/apis` — registered paid routes + live hit counts
- `GET /reputation` — leaderboard · `GET /reputation/:address` — score + tx anchors

**Paid (402 until settled):**

- `GET /x402/api/:slug`, `GET /x402/premium` — pay-per-call or session
- `POST /facilitator/verify` — verify a signed intent without settling
- `POST /facilitator/settle` — settle on-chain (per-call or session)
- `POST /session/redeem` — spend one session call, zero on-chain interaction
- `GET /session/:id` — session status

**Agent identity (key-authed via `Authorization: Bearer cvn_...`):**

- `POST /keys` — mint an agent API key (shown once)
- `POST /vault/entries`, `POST /vault/broker` — store secrets, or run a prompt with secrets injected server-side (**the secret never reaches the agent's context**)
- `POST /wallets/create` — server-generated agent wallet
- `GET /analytics/keys` — per-key usage stats

## Rate limiting

Sliding-window per agent key (authenticated) or per IP (open endpoints), `X-RateLimit-*` + `Retry-After` headers. Defaults: 5 keys/hour/IP on `POST /keys`, 60 settles/min, 120 verifies/min, 300 req/min generic. `X-Forwarded-For` is only trusted from IPs listed in `COVENANT_TRUSTED_PROXIES` — unlisted, it's ignored in favor of the raw socket address, closing the classic rate-limit-bypass-by-header-spoofing hole. Tune in `gateway/server.js` → `RATE_LIMITS`.

## The kit — `@covenantx402/x402-kit`

Self-contained TypeScript x402 paywall middleware for Express:

```bash
npm install @covenantx402/x402-kit
```

```ts
import express from 'express'
import { install } from '@covenantx402/x402-kit'

const app = express()
install(app, {
  config: {
    payTo: '0xYourAddress',
    network: 'robinhood',
    facilitatorUrl: 'https://gateway.tributex402.com',
    routes: { 'GET /premium': { price: '0.01' } },
  },
})
app.get('/premium', (_req, res) => res.json({ data: 'paid content' }))
app.listen(3000)
```

Full usage: [`kit/README.md`](kit/README.md).

## Examples

- `examples/paid-api.js` — spin up a paid endpoint with the gateway
- `examples/pay.js` — agent client: fetch 402 → sign intent → settle → receive resource

## Testing

```bash
cd gateway && npm test     # smoke.js, preflight.js, pay-once.js, pay-onchain.js, gen-load.js
cd kit && npm run build    # tsc -p .
```
CI (`.github/workflows/ci.yml`) runs both on every push/PR to `main`.

## Agent skill

[`skill/SKILL.md`](skill/SKILL.md) is a drop-in Markdown skill file — point Claude/Cursor/Hermes/any skill-aware agent at it and it learns the full payment + vault flow without further prompting.

## Security notes (read before deploying)

- Set `COVENANT_VAULT_KEY` in production; otherwise the vault key derives from the RPC URL.
- `POST /keys` is intentionally open for frictionless onboarding — rate-limit it at your edge if you expose the gateway publicly.
- `COVENANT_SETTLE_KEY` can pull any USDG amount agents have approved to it. Run it hot with a small float; keep the bulk cold.
- The RPC proxy (`POST /`) is a strict method whitelist — no state-changing methods pass through.

## License

MIT
