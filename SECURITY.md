# Security

## Reporting
Please report vulnerabilities privately via GitHub Security Advisories on this repository. Do not open public issues for security bugs.

## Audit log
- **2026-10 (phase 1)** — payment-gate receipt binding, pending-tx settlement (no double charge on RPC timeout), DB-backed batch claim lock, tenant key isolation, mandatory vault key, fixed session entitlement, Solana payment binding. Regression tests: `gateway/test/unit/audit-2026-10.test.js`.

## Deployment requirements
- `COVENANT_VAULT_KEY` (>= 16 chars) is mandatory; the gateway refuses to start without it.
- `COVENANT_ADMIN_TOKEN` (>= 24 chars) enables admin-only `GET/DELETE /keys`. Unset = disabled.
- Run `COVENANT_SETTLE_KEY` hot with a small float.
- Rate-limit open endpoints (`POST /keys`, `POST /x402/batch/open`) at your edge.
