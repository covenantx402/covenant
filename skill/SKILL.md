---
name: tribute-x402
description: Pay for and monetize agent APIs with USDG on Robinhood Chain 4663 via TRIBUTE. Use when an agent needs to call paid endpoints, store secrets safely, or serve paid APIs.
version: 1.0.0
---

# TRIBUTE — x402 payments + vault for agents (Robinhood Chain 4663)

TRIBUTE gives you three things:

1. **Payments** — call paid endpoints; price is settled in USDG on-chain.
2. **Vault** — store secrets by name. Never put real credentials in prompts; reference them as `{{name}}`.
3. **Wallets** — get a dedicated on-chain wallet for your agent identity.

Base URL: `http://127.0.0.1:8792` (self-hosted gateway) — override with `TRIBUTE_GATEWAY`.

## 1. Get an API key (one time)

```bash
curl -s -X POST $TRIBUTE_GATEWAY/keys -H 'content-type: application/json' \
  -d '{"label":"my-agent"}'
```

Response contains `key: "trb_..."` — **shown once, save it**. Send it as `Authorization: Bearer trb_...` on every authenticated call.

## 2. Store a secret in the vault (never in your context)

```bash
curl -s -X POST $TRIBUTE_GATEWAY/vault/entries \
  -H "Authorization: Bearer trb_..." -H 'content-type: application/json' \
  -d '{"name":"llm_api_key","value":"sk-..."}'
```

To USE a secret without seeing it, send text containing `{{llm_api_key}}` to the broker — the gateway substitutes it server-side and scrubs it from the response:

```bash
curl -s -X POST $TRIBUTE_GATEWAY/vault/broker \
  -H "Authorization: Bearer trb_..." -H 'content-type: application/json' \
  -d '{"text":"{\"model\":\"gpt\",\"api_key\":\"{{llm_api_key}}\",\"prompt\":\"hi\"}"}'
```

You receive the resolved request body with the secret already replaced and any readback redacted. You never handle the raw value.

## 3. Get an agent wallet

```bash
curl -s -X POST $TRIBUTE_GATEWAY/wallets/create \
  -H "Authorization: Bearer trb_..." -H 'content-type: application/json' \
  -d '{"label":"my-agent"}'
```

Returns address + private key **once** (encrypted copy stays in the vault). Fund it with USDG to make payments.

## 4. Call a paid endpoint (x402 flow)

Step 1 — unpaid call returns `402` with requirements:

```bash
curl -si $TRIBUTE_GATEWAY/x402/premium
# header X-PAYMENT-REQUIRED (base64 JSON) → { accepts: [{ maxAmountRequired, payTo, asset, extra: { spender } }] }
```

Step 2 — approve the spender once (see `examples/pay.js` for full code):

```js
usdg.approve(spender, maxAmountRequired)  // USDG: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168, chain 4663
```

Step 3 — sign an EIP-712 `PaymentIntent` in domain `{ name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: USDG }`:

```js
{ from, to: payTo, value: maxAmountRequired, validAfter, validBefore, nonce, resource }
```

Step 4 — settle and receive the resource:

```bash
curl -s -X POST $TRIBUTE_GATEWAY/facilitator/settle \
  -H 'content-type: application/json' \
  -d '{"intent":{...},"signature":"0x..."}'
# → { success: true, transaction: "0x..." }
```

## 5. Paid sessions (pay once, call many times)

Instead of paying per request, settle once with `resource: "session"`:

```bash
curl -s -X POST $TRIBUTE_GATEWAY/facilitator/settle \
  -H 'content-type: application/json' \
  -d '{"intent":{...,"resource":"session"},"signature":"0x...","extra":{"calls":100,"ttlSec":3600}}'
# → { success: true, transaction: "0x...", session: { id: "...", callsMax: 100 } }
```

Then redeem per call — the gateway checks budget/TTL, no on-chain tx needed:

```bash
curl -s -X POST $TRIBUTE_GATEWAY/session/redeem -d '{"sessionId":"..."}'
```

## 6. Reputation

Your agent's settled payments build an on-chain-anchored reputation score:

```bash
curl -s $TRIBUTE_GATEWAY/reputation/0xYOUR_AGENT_WALLET
# → { score: 42, tier: "established", settledCount: 8, txHashes: [...] }
```

Services can gate premium routes on tier (`trusted` agents get better rates) — the score is derived from settled tx hashes anyone can verify on-chain.

## Endpoints reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /keys | — | mint agent key |
| POST/GET/DELETE | /vault/entries | key | store / list / delete secrets |
| POST | /vault/broker | key | server-side `{{secret}}` substitution |
| POST/GET | /wallets/create, /wallets | key | agent wallets |
| GET/DELETE | /keys | key | list / revoke keys |
| GET | /x402/apis, /x402/api/:slug, /x402/premium | — | discover + 402 challenge |
| POST | /facilitator/verify, /facilitator/settle | — | verify / settle payment |
| POST | /session/redeem | — | redeem paid session (1 of N calls) |
| GET | /session/:id | — | session status |
| GET | /reputation, /reputation/:address | — | agent reputation (tx-anchored) |
| GET | /facilitator, /x402/stats, /vault/status | — | telemetry |
| POST | / | — | read-only RPC proxy (whitelisted methods) |

## Rules

- Never store plaintext secrets in your context, memory, or logs — vault them.
- `validBefore` is capped at 600s; sign intents only for payments you intend to make.
- One nonce per intent; replays are rejected.
- Chain is 4663 (Robinhood). Asset is USDG, 6 decimals.
