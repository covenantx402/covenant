# Contributing to COVENANT

Thanks for considering a contribution. This is a small, focused project —
keep PRs small and focused too.

## Setup

```bash
git clone https://github.com/covenantx402/covenant.git
cd covenant/gateway && npm install
cp .env.example .env   # set COVENANT_RPC_UPSTREAM at minimum
npm test               # smoke.js, preflight.js, pay-once.js, pay-onchain.js, gen-load.js
```

```bash
cd kit && npm install && npm run build   # tsc -p .
```

## Before opening a PR

- `cd gateway && npm test` must pass (24+ checks, all green).
- `cd kit && npm run build` must compile with zero TypeScript errors.
- If you touch an env var, update both `gateway/.env.example` and the
  Environment table in `README.md` — they drift silently otherwise.
- If you touch a paid route or the facilitator, re-read
  `gateway/test/smoke.js` — it's the source of truth for expected behavior,
  not just a test file.

## Scope

- `gateway/` — zero-dependency Node HTTP service. No new runtime
  dependencies without a good reason; this is meant to be self-hostable
  in one `npm install`.
- `kit/` — TypeScript, builds with `tsc`. Keep the public API surface
  (`index.ts` exports) intentional — anything exported is a compatibility
  promise.
- `skill/SKILL.md` — kept in sync with the actual gateway API. If you
  change an endpoint's shape, update this file in the same PR.

## Reporting a security issue

Don't open a public issue for a vulnerability. See `README.md` → Security
notes for the operational assumptions, and reach out privately first.

## License

By contributing, you agree your contribution is licensed under the
project's MIT license (see `LICENSE`).
