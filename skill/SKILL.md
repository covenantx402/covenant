---
name: covenant-x402
description: Pay for and monetize agent APIs with USDG on Robinhood Chain 4663 via COVENANT. Use when an agent needs to discover paid endpoints, make an approved payment, or store credentials safely.
version: 1.1.0
---

# COVENANT — x402 payments + vault for agents

COVENANT is payment infrastructure for AI agents on **Robinhood Chain (4663)**. It gates APIs with x402, settles payments in **USDG**, and provides an encrypted credential vault so secret values do not enter an agent prompt or context window.

## Safety boundary

Start with discovery and inspection. Do **not** approve tokens, sign a `PaymentIntent`, settle a payment, mint an agent key, create a wallet, or store a secret unless the user explicitly asks for that action. Never print, persist, or repeat a private key, API key, or vault secret in chat output.

## Gateway selection

Use the public gateway unless the user supplies a self-hosted endpoint:

```bash
export COVENANT_GATEWAY="${COVENANT_GATEWAY:-https://gateway.covenantx402.com}"
```

For a self-hosted gateway:

```bash
export COVENANT_GATEWAY="http://127.0.0.1:8792"
```

## Safe discovery: inspect paid APIs first

```bash
curl -sS "$COVENANT_GATEWAY/x402/apis"
curl -si "$COVENANT_GATEWAY/x402/premium"
```

An unpaid request returns HTTP `402 Payment Required` with:

- an `accepts[]` payment requirement in the JSON body;
- a standards-compatible `Payment-Required` header for x402 v2 clients;
- an `exact` per-call option and a `covenant-session` option for repeated calls.

On the public Robinhood rail, the asset is USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` with 6 decimals.

## Approved payment flow

Only continue after the user explicitly approves a payment.

1. Request a paid route and read its requirement.
2. Approve the advertised `extra.spender` to spend no more than the route price.
3. Sign the EIP-712 `PaymentIntent`:

```js
{
  from,
  to: payTo,
  value: maxAmountRequired,
  validAfter,
  validBefore,
  nonce,
  resource
}
```

Use this domain exactly:

```js
{
  name: 'COVENANT',
  version: '1',
  chainId: 4663,
  verifyingContract: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
}
```

4. Submit `{ intent, signature }` to `POST /facilitator/settle`.
5. Replay the returned receipt as the `X-PAYMENT` header on the same resource request.

The reference implementation is `examples/pay.js`.

## Paid sessions

For repeated requests, select the `accepts[]` entry whose scheme is `covenant-session`. Set `resource: "session"` when settling. A successful response includes a session id and call budget; redeem calls with:

```bash
curl -sS -X POST "$COVENANT_GATEWAY/session/redeem" \
  -H 'content-type: application/json' \
  -d '{"sessionId":"..."}'
```

No additional wallet signature or on-chain transaction is needed for each redemption.

## Agent identity and vault

These are explicit write actions. Request user approval first.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/keys` | Mint an agent API key; it is shown once. |
| `POST` | `/vault/entries` | Encrypt and store a secret for that key. |
| `POST` | `/vault/broker` | Resolve `{{secret_name}}` server-side and scrub readback. |
| `POST` | `/wallets/create` | Create an agent wallet; its private key is shown once. |
| `GET` | `/reputation/:address` | Inspect a tx-anchored payment reputation score. |

## Non-negotiable rules

- Never put plaintext secrets in prompts, agent memory, logs, terminal recordings, or chat.
- A `PaymentIntent` must expire within 600 seconds.
- Each nonce is single-use; a replay is rejected.
- Treat `X-PAYMENT` receipts as sensitive payment capability material until redeemed.
- The public demo rail is **USDG on Robinhood Chain 4663**. Do not claim a successful payment until a settlement response and transaction receipt are available.
