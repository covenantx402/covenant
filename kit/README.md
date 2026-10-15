# @covenantx402/x402-kit

TypeScript x402 paywall middleware for Express. Turn any route into a paid USDG endpoint settled on Robinhood Chain (chain ID 4663) via the [COVENANT](https://github.com/tributelab/covenant) gateway — or any x402 facilitator.

[![npm version](https://img.shields.io/npm/v/%40covenantx402%2Fx402-kit.svg)](https://www.npmjs.com/package/@covenantx402/x402-kit)
[![license](https://img.shields.io/npm/l/%40covenantx402%2Fx402-kit.svg)](https://github.com/tributelab/covenant/blob/main/LICENSE)

## Install

```bash
npm install @covenantx402/x402-kit
```

## What it does

1. Mount `install(app, { config })` on an Express app.
2. Unpaid request to a configured route → `402` with a signed `PaymentRequirements` challenge (price, recipient, asset, network).
3. Agent signs the `X-PAYMENT` payload and retries → middleware calls the facilitator's `/verify` + `/settle`, logs the event to SQLite, lets the route through.
4. Built-in analytics router exposes `/__x402/metrics`, `/__x402/events`, `/__x402/health`.

## Quick start

```ts
import express from 'express'
import { install } from '@covenantx402/x402-kit'

const app = express()

const { close } = install(app, {
  config: {
    payTo: '0xYourAddress',
    network: 'robinhood',           // chain 4663, settles in USDG
    facilitatorUrl: 'https://gateway.covenantx402.com',
    routes: {
      'GET /premium': { price: '0.01', description: 'Premium data feed' },
    },
  },
})

app.get('/premium', (_req, res) => res.json({ data: 'paid content' }))

app.listen(3000)
process.on('SIGTERM', close)
```

Config can also be loaded from a YAML file: `install(app, { config: './x402.yaml' })`.

## Signed settlement webhooks

Set `settlementWebhook` to get a POST after every successful settlement. Set `settlementWebhookSecret` too and every delivery carries an HMAC-SHA256 `X-Covenant-Signature: sha256=<hex>` header (computed over the raw JSON body), with 3-attempt exponential-backoff delivery — a receiver can reject forged callbacks instead of trusting an unauthenticated POST to a guessable URL.

```ts
import { verifyWebhookSignature } from '@covenantx402/x402-kit'

app.post('/webhooks/covenant', express.raw({ type: '*/*' }), (req, res) => {
  const ok = verifyWebhookSignature(
    req.body.toString('utf8'),
    req.header('x-covenant-signature'),
    process.env.WEBHOOK_SECRET!,
  )
  if (!ok) return res.status(401).end()
  // ... trust the payload
  res.status(200).end()
})
```

## Features

- USD-decimal route pricing (`"0.01"`), converted to atomic stablecoin units per network's decimals.
- `FacilitatorClient` — thin HTTP client for `/verify` and `/settle`, usable standalone.
- `UsageLogger` — SQLite-backed per-route, per-payer event log (`better-sqlite3`).
- Per-network asset metadata built in: Base/Polygon/Arbitrum/Optimism (USDC) and Robinhood Chain (USDG).
- HMAC-signed settlement webhooks with retry — see above.

## API surface

| Export | Purpose |
|---|---|
| `install(app, opts)` | Mount paywall + analytics router on an Express app |
| `paywall({ config, logger, facilitator })` | Lower-level middleware factory, if you want to wire pieces yourself |
| `verifyWebhookSignature(rawBody, header, secret)` | Constant-time check for an inbound `X-Covenant-Signature` header |
| `FacilitatorClient` | Verify/settle HTTP client |
| `UsageLogger` | SQLite usage tracker |
| `loadConfigFromFile(path)` / `validateConfig(obj)` | YAML or programmatic config loading |
| `analyticsRouter({ logger, authToken })` | `/metrics`, `/events`, `/health` sub-router |

See `src/types.ts` for the full `PaywallConfig` / `RoutePricing` shape.

## Related

- Gateway + vault + reputation stack: [tributelab/covenant](https://github.com/tributelab/covenant)
- Full protocol docs: repo README and `skill/SKILL.md`

## License

MIT
