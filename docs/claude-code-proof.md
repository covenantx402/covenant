# Claude Code proof recording — USDG on Robinhood Chain

This runbook records a truthful proof of COVENANT as agent payment infrastructure. It demonstrates **USDG on Robinhood Chain (4663)** only.

## What this recording proves

1. A Claude Code project can install the COVENANT skill from the public repository.
2. The agent can discover paid APIs and parse an x402 payment requirement.
3. The gateway returns a live HTTP 402 challenge with v1 body data and a v2 `Payment-Required` header.
4. A user-approved USDG settlement can unlock a paid response, with an explorer-verifiable transaction receipt.

Do not claim other settlement rails, a token launch, or a fresh payment unless those are shown in the recording.

## Prerequisites

- A current public `main` branch.
- Claude Code installed and authenticated.
- For discovery only: no wallet is needed.
- For the optional paid segment: a disposable Robinhood Chain wallet funded with USDG. Never display its private key or seed phrase.

## 1. Install the skill in a Claude Code project

```bash
git clone https://github.com/covenantx402/covenant.git
cd covenant
mkdir -p .claude/skills/covenant-x402
cp skill/SKILL.md .claude/skills/covenant-x402/SKILL.md
export COVENANT_GATEWAY=https://gateway.covenantx402.com
claude
```

In Claude Code, use this prompt:

```text
Use the Covenant skill. Discover the available paid APIs, inspect the x402 requirement for /x402/premium, and explain the Robinhood Chain USDG settlement flow. Do not make a payment.
```

Expected proof:

- `GET /x402/apis` returns the paid API catalog.
- `GET /x402/premium` returns HTTP 402.
- The response includes an `exact` USDG option and a `covenant-session` option.

## 2. Show direct gateway evidence

```bash
curl -sS https://gateway.covenantx402.com/x402/health
curl -si https://gateway.covenantx402.com/x402/premium
curl -sS https://gateway.covenantx402.com/x402/stats
```

The unpaid `/x402/premium` response must be `402`; do not stage a success response.

## 3. Optional: approved fresh paid call

Only after the wallet owner approves the spend, run the reviewed payment client with a disposable USDG-funded wallet. Capture:

```text
402 challenge
→ USDG approval (if required)
→ EIP-712 PaymentIntent signature
→ /facilitator/settle success + transaction hash
→ replay X-PAYMENT receipt
→ HTTP 200 paid payload
```

Do not put a wallet private key in the Claude prompt, terminal recording, repository, or shell history. Supply it via a secure runtime secret mechanism.

## 4. Close on independent verification

Open the returned transaction hash on Robinhood Chain Explorer and then show the live console:

```text
https://covenantx402.com/#/app
```

The console is supporting evidence. The agent-led paid flow and the on-chain transaction are the primary proof.

## Preflight before recording

For a local/self-hosted gateway, run:

```bash
COVENANT_ENV_FILE=/path/to/gateway/.env \
COVENANT_DEMO_DIR=/path/to/gateway \
GW=http://127.0.0.1:8792 \
node gateway/test/preflight.js
```

It checks RPC connectivity, facilitator gas, public endpoint health, and optional demo artifacts. A low facilitator-gas warning means do not start a payment recording.
