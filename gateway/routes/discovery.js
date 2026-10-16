// routes/discovery.js — free, read-only, no-side-effect endpoints that
// exist purely for humans/scanners to discover what this gateway offers:
// /health, /metrics, /chains, /favicon.(ico|svg), /openapi.json,
// /.well-known/x402.
//
// Extracted from server.js as the first module in an incremental split —
// these routes were picked FIRST specifically because none of them mutate
// state, touch auth, or sit in the RPC-proxy exclusion chain, so moving
// them carries near-zero behavioral risk. Payment-critical routes
// (/x402/api/*, /facilitator/*, /vault/*, the RPC proxy fallback) are
// deliberately NOT here yet — those have load-bearing ordering/exclusion
// logic that needs its own careful pass, not a blind lift-and-shift.
//
// Call registerDiscoveryRoutes(deps) once at startup to get back a
// `handle(req, res, url)` function; call it early in the request handler
// and return immediately if it returns true (route was handled here).
function registerDiscoveryRoutes({
  x402r, facilitator, marketplace, vault, wallets, keys, sessions, reputation,
  send, PUBLIC_ORIGIN, DOMAIN_NAME, DOMAIN_VERSION,
}) {
  function health(req, res) {
    send(res, 200, { ok: true, network: 'eip155:4663', asset: x402r.USDG, origin: PUBLIC_ORIGIN, apis: x402r.list().length })
  }

  // Prometheus text-exposition metrics, sourced from the same live counters
  // as /x402/stats (no separate tracking path to drift out of sync). Free,
  // no auth — standard for a scrape target; put it behind your own
  // reverse-proxy ACL if the gateway is reachable from the public internet
  // and you don't want aggregate volume visible.
  function metrics(req, res) {
    const f = facilitator.publicView()
    const rep = reputation.stats()
    const vaultStats = vault.stats()
    const lines = [
      '# HELP covenant_apis_total Number of registered paid API routes.',
      '# TYPE covenant_apis_total gauge',
      `covenant_apis_total ${x402r.list().length}`,
      '# HELP covenant_x402_hits_total Total 402 challenges issued.',
      '# TYPE covenant_x402_hits_total counter',
      `covenant_x402_hits_total ${x402r.hits()}`,
      '# HELP covenant_settled_usdg_total Cumulative USDG settled on-chain (default/Robinhood rail).',
      '# TYPE covenant_settled_usdg_total counter',
      `covenant_settled_usdg_total ${Number(f.totalSettledUsdg || 0)}`,
      '# HELP covenant_settlements_total Count of successful on-chain settlements (default/Robinhood rail).',
      '# TYPE covenant_settlements_total counter',
      `covenant_settlements_total ${Number(f.settled || 0)}`,
      '# HELP covenant_sessions_active Active prepaid call-budget sessions.',
      '# TYPE covenant_sessions_active gauge',
      `covenant_sessions_active ${Number(sessions.stats().activeSessions || 0)}`,
      '# HELP covenant_vault_entries Encrypted secrets currently stored in the vault.',
      '# TYPE covenant_vault_entries gauge',
      `covenant_vault_entries ${vault.count()}`,
      '# HELP covenant_vault_broker_calls_total Prompts run with vault-injected secrets.',
      '# TYPE covenant_vault_broker_calls_total counter',
      `covenant_vault_broker_calls_total ${Number(vaultStats.brokered || 0)}`,
      '# HELP covenant_reputation_agents Distinct addresses with a reputation score.',
      '# TYPE covenant_reputation_agents gauge',
      `covenant_reputation_agents ${Number(rep.knownAgents || 0)}`,
      '# HELP covenant_wallets_total Agent wallets provisioned.',
      '# TYPE covenant_wallets_total gauge',
      `covenant_wallets_total ${Number(wallets.count() || 0)}`,
      '# HELP covenant_keys_total Agent API keys minted.',
      '# TYPE covenant_keys_total gauge',
      `covenant_keys_total ${Number(keys.count() || 0)}`,
      '# HELP covenant_chains_supported Number of chains this gateway can settle on.',
      '# TYPE covenant_chains_supported gauge',
      `covenant_chains_supported ${facilitator.chains.listChains().length}`,
      '# HELP covenant_up Gateway process liveness.',
      '# TYPE covenant_up gauge',
      'covenant_up 1',
    ]
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.end(lines.join('\n') + '\n')
  }

  // Chain discovery — every chain COVENANT can settle on. Agents that want
  // to pay on Base/Arbitrum/Ethereum instead of the Robinhood default read
  // this first to get the chainId + asset address to sign against, then
  // pass ?chain=<id> (GET) or intent chainId / body.chainId (POST) on every
  // subsequent facilitator/x402 call. Omitting chain everywhere keeps the
  // pre-multichain behavior (defaults to Robinhood 4663) — nothing existing
  // breaks.
  async function chains(req, res) {
    const items = await Promise.all(facilitator.chains.listChains().map(async c => ({
      ...c,
      readiness: await facilitator.chainReadiness(c.id),
    })))
    send(res, 200, { ok: true, default: facilitator.DEFAULT_CHAIN_ID, chains: items })
  }

  // Tiny SVG favicon so discovery auditors (x402scan) don't flag FAVICON_MISSING.
  function favicon(req, res) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'image/svg+xml')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAPFBMVEUKDRMAAAAXFxcoKChHR0dmZmZ3d3dWVlY3Nzewr7DHx8fn5+f29vbX19eHh4e3t7eYmJimpqbAv7+Qj5DzjTz2AAAEtklEQVRYw62X63rjKgxFuQkEmJt5/3c9W7bT2ond83Vm+NGkAS2LjS5YqdfQvxnqY/zK/Ibxe/sr4U/sT4Q/Mz8RnhcYq7Wx6n8ID5PWkSentCOiYH8ivP+0m5N3Fh4wW2MMe8/n2Qvh+oPZViryrNjHlJcll+jZWE9GuNX+DOBWt2VBuV5KGtX7OlIpwym32frGdw6/hisR81zZ1Nbw9/DK1XWt1lbM2VHclXCxzzJrp7U91ov4XGNnIShXsnsCcFmq0mYy90Hv2tIYzNNoVZeLD6d1ti0F2/Rk57i6uS0MY9jgsawsyd4BVM8LFORhaqS7M/dtmg4Z/JKHugEQxMb0DG6dt8Flegphbjst9AmwOK0hH3asTt8Ol4aFC6ovpdkPAAEQ8EGu9IfoViMjrrUOuSSv3gCMeFmBJa6Z9MMIeTImbSpr5zcAAQBpFHMqT5mjbU6OlXjSBl0B1te+ehGo5NU8Acy6FAkCX9p4JcUBcAQAJAgADP04Rs6ywVBar+EMUER+RrCppEcNMXouxctxtO6PWD2yPxwAn1rqzx508KsA4vTengAcCCpKlLXYnregRkpJAOuoRHwGOLggCUCDRnwWMTaKsgXZQXAngHMu+C4iduujewJwqlbOj7CDcAYoBoC632qJG/4J4FtwXZSKFQ44dQLIHirkt0SmjodIsqNbwvmrMQTAVwAiIVptgrdh1HtAbWQ9ksCsQyRw5gtgDoCTiHKoB+HOPqwdFSUoycrNA3PxIPgqm8KBMsd2Q3BpdSjuLMWpv2lgxAEvFVMZnKcJW2ZfQwBBHoxHd1BOtEbTOgE0JCQIMHPQTF4IuV+UtBNVyPjpHXIaIkMLCidAkL7jGlqJwlOmty4tpX61EFtRSKHNwIxquaBkGTqy6QDAd9/GHEgVV/voDG9KOgg2ZTjEow3EGuXY4+rxvDNAKa6IbqkqrPyIKXkHd46iQQX79yhDsSpGIlZkHhQ/Z6MKJNGM7Y+pzGyp4PlYukvc15QKmixqqppxVgmCQNd64KxEM6SUjOBWUDhKint/4Rhhv+S8sg6QAfYIAuazBxr3AN4SgiraV80ZD2wHwI24ArDkCWdgH2CPcS1pZgOwOIF4CFi+fAN2D5aFcP7Vb+bsXq37q6zz4QMiUZshD0xtD2kX2wZAqvDm/g7QV4B1fDBwpNpUuZmkPaLDbi+dOdBujmXmDaAd25cTgBvKC85hByTcdLK0It7s91X6HWCILcbmw5YwCS7sAJT6LTeY3OGnI/MBQGRh5vBCFHaHGQB5u5TY/fREbPqueqceEEB4OYEHGMTOC1Dk//At06l7ngCGvnyQamNOHgBwsTe3ACF8LeJ3AN/bX29phnaZnKhg0gFwuLqgAuwHIMF66RvXPqjCHmhyEAJwBwC3KpbfJVCv9vr9NhfqliwCaKntgJYStoBsJ19reLfQbwNXlYmId9LHIh/ZiG7nap19TH5f/9nKDY0WUeFNH2MH4IsUvLZG+mybd68LaI+4x5nZ96rIs3eDstT8Tcd6eN/AoWs15w6wdU7R4Lbh/fDGYl4A9gK4Hz+98ij0GrvvyDv1BwD9XbJ/WPF3733/7MXzH7z6/v3L928Z31b/AbNjPDsIlbkLAAAAAElFTkSuQmCC" width="64" height="64"/></svg>')
  }

  /* ---- x402scan / agent discovery (docs/DISCOVERY.md, Merit-Systems/x402scan)
     Precedence: 1) /openapi.json  2) /.well-known/x402. Paid ops need
     x-payment-info + a 402 response + input/output schemas; free ops need
     "security": [] so the scanner doesn't probe them. Resources are dynamic —
     rebuilt per request from the live route + marketplace registries. */
  function openapi(req, res) {
    const spender = facilitator.publicView().spender || process.env.COVENANT_X402_PAYTO || '0x0000000000000000000000000000000000000000'
    /* Session scheme (pay once → 100 calls/1h, ~100x cheaper per call than
       per-call payment) previously only appeared in the runtime 402 body for
       /x402/premium — invisible to any agent/scanner discovering routes via
       this doc, which is the documented integration path. Every paid op now
       advertises BOTH protocols so the flagship "instant settlement, pay
       once call many" feature is actually discoverable, not just true if
       you already know to hit the route directly. */
    const sessionProtocol = { scheme: 'covenant-session', network: 'eip155:4663', payTo: spender, asset: x402r.USDG, extra: { calls: 100, ttlSec: 3600 } }
    const paidOp = (slug, summary, price, extraDesc) => ({
      get: {
        operationId: 'paid_' + slug.replace(/-/g, '_'),
        summary,
        description: (extraDesc || `Pay-per-call in USDG on Robinhood Chain (eip155:4663) via x402. Unpaid GET returns a 402 challenge; settle it with POST /facilitator/settle, then replay the receipt as X-PAYMENT.`) +
          ' High-volume agents: settle once with resource "session" (0.01 USDG = 100 calls / 1h) then POST /session/redeem per call — see x-payment-info.protocols[1].',
        tags: ['Paid APIs'],
        parameters: [{ name: 'X-PAYMENT', in: 'header', required: false, description: 'Base64 x402 receipt from POST /facilitator/settle. Omit → HTTP 402 challenge.', schema: { type: 'string' } }],
        'x-payment-info': {
          price: { mode: 'fixed', currency: 'USD', amount: String(price) },
          protocols: [
            { x402: { network: 'eip155:4663', scheme: 'exact', payTo: spender, asset: x402r.USDG } },
            { x402: sessionProtocol },
          ]
        },
        security: [{ x402: [] }],
        responses: {
          '200': {
            description: 'Delivered payload (application/json) once payment is settled',
            content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, api: { type: 'string' }, tx: { type: 'string' }, payload: { type: 'object', additionalProperties: true } }, required: ['payload'] } } }
          },
          '402': { description: 'Payment Required — x402 challenge in body and Payment-Required header. accepts[] includes both scheme "exact" (per-call) and scheme "covenant-session" (pay once, 100 calls/1h).' }
        }
      }
    })
    const paths = {}
    for (const rec of x402r.list()) {
      paths['/x402/api/' + rec.slug] = paidOp(rec.slug, rec.description || rec.slug, rec.price)
    }
    for (const l of marketplace.catalog()) {
      paths['/x402/api/' + l.slug] = paidOp(l.slug, l.description || l.name, l.price,
        `Marketplace listing by ${l.seller}. ${l.description || l.name} Pay-per-call in USDG on Robinhood Chain (eip155:4663) via x402.`)
    }
    paths['/x402/premium'] = paidOp('premium', 'COVENANT premium alert sample — 0.01 USDG (also opens a 100-call session option)', '0.01')
    send(res, 200, {
      openapi: '3.1.0',
      info: {
        title: 'COVENANT x402 Gateway',
        version: '2.0.0',
        description: 'A next-gen x402 distribution layer for smarter launches. Pay-per-call APIs settled in USDG/USDC across four chains (Robinhood 4663, Ethereum, Base, Arbitrum — see GET /chains) — no accounts, no API keys, payment is authentication. Serves x402 v1 (JSON body) and v2 (Payment-Required header, extensions.bazaar discovery) simultaneously on every paid route.',
        'x-guidance': 'Every /x402/api/<slug> route returns HTTP 402 with an x402 challenge until paid — GET/POST/HEAD all reach the challenge. Flow: GET /chains to pick a settlement chain (defaults to Robinhood 4663) → read the 402 (v1: JSON body accepts[]; v2: decode the base64 Payment-Required header) → approve the chain stablecoin to extra.spender → sign the EIP-712 PaymentIntent (domain name COVENANT, chainId = your chosen chain, verifyingContract = that chain stablecoin) → POST /facilitator/settle {intent,signature,chainId} → replay the returned base64 receipt as X-PAYMENT header on the same GET. High-volume agents: settle once with resource "session" (0.01 USDG = 100 calls / 1h) then POST /session/redeem per call. Discovery catalog of routes: GET /x402/apis (free).',
        contact: { name: 'COVENANT', url: 'https://gateway.covenantx402.com' },
        'x-discovery': { protocolVersions: [1, 2] }
      },
      servers: [{ url: PUBLIC_ORIGIN, description: 'COVENANT gateway (Robinhood Chain 4663 / USDG)' }],
      security: [{ x402: [] }],
      tags: [{ name: 'Paid APIs', description: 'x402 pay-per-call endpoints in USDG' }],
      components: {
        securitySchemes: {
          x402: { type: 'http', scheme: 'BAP', description: 'x402 HTTP payments — pay-per-call in USDG on eip155:4663 (no credentials). See https://docs.x402.org' }
        }
      },
      paths: {
        ...paths,
        '/x402/apis': { get: { operationId: 'list_apis', summary: 'Catalog of paid APIs + prices (free)', security: [], responses: { '200': { description: 'JSON catalog' } } } },
        '/x402/marketplace': { get: { operationId: 'list_marketplace', summary: 'Third-party marketplace listings (free)', security: [], responses: { '200': { description: 'JSON catalog' } } } },
        '/facilitator': { get: { operationId: 'facilitator_status', summary: 'Settlement config (free)', security: [], responses: { '200': { description: 'JSON status' } } } },
        '/supported': { get: { operationId: 'supported_kinds', summary: 'x402 spec-standard facilitator capability discovery: (x402Version, scheme, network) kinds + signer addresses (free). Also at /facilitator/supported.', security: [], responses: { '200': { description: '{ x402Version, kinds[], extensions[], signers{} }' } } } },
        '/x402/upto/echo': {
          get: {
            operationId: 'upto_echo', summary: 'x402 "upto" scheme demo: word-count echo with a genuinely variable price (every other paid route here is flat-rate "exact")',
            description: 'Challenge advertises a worst-case CEILING (500 words); settlement only ever pulls the real per-word cost, computed server-side from ?text=, never from a client-supplied amount. See README "Variable pricing" section for the honest framing of what this demo does and doesn\'t prove.',
            parameters: [
              { name: 'text', in: 'query', required: false, schema: { type: 'string' }, description: 'Text to echo back with its word count. Bound into the signed resource URL — a receipt for one text cannot be replayed against a different one.' },
              { name: 'X-PAYMENT', in: 'header', required: false, description: 'Base64 x402 receipt from POST /facilitator/settle. Omit → HTTP 402 challenge.', schema: { type: 'string' } },
            ],
            'x-payment-info': { price: { mode: 'variable', currency: 'USD', amount: '0.0001 per word, capped at 500 words (0.05 ceiling)' }, protocols: [{ x402: { network: 'eip155:4663', scheme: 'upto' } }] },
            security: [{ x402: [] }],
            responses: {
              '200': { description: 'Delivered payload: { text, wordCount, actualChargeUsd }' },
              '402': { description: 'Payment Required — accepts[0].scheme is "upto", maxAmountRequired is the worst-case ceiling.' }
            }
          }
        },
        '/health': { get: { operationId: 'health', summary: 'Health check (free)', security: [], responses: { '200': { description: 'ok' } } } },
        '/metrics': { get: { operationId: 'metrics', summary: 'Prometheus text-exposition metrics (free)', security: [], responses: { '200': { description: 'text/plain; version=0.0.4' } } } },
        '/session/redeem': {
          post: {
            operationId: 'session_redeem', summary: 'Redeem one call from a paid session (no wallet interaction, no on-chain tx)',
            description: 'Opened by settling a PaymentIntent with resource "session" against POST /facilitator/settle. Each redeem decrements the session budget server-side.',
            security: [], responses: { '200': { description: '{ ok: true, callsRemaining }' }, '402': { description: 'session exhausted or unknown — open a new one via /facilitator/settle' } }
          }
        },
        '/session/{id}': {
          get: {
            operationId: 'session_status', summary: 'Session status (calls used/remaining, expiry)',
            security: [], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'session status' }, '404': { description: 'unknown or expired' } }
          }
        }
      }
    })
  }

  function wellKnown(req, res) {
    const resources = [
      PUBLIC_ORIGIN + '/x402/premium',
      ...x402r.list().map(r2 => PUBLIC_ORIGIN + '/x402/api/' + r2.slug),
      ...marketplace.catalog().map(l => PUBLIC_ORIGIN + '/x402/api/' + l.slug)
    ]
    send(res, 200, {
      version: 1,
      resources,
      instructions: 'COVENANT x402 gateway — USDG on Robinhood Chain 4663. See /openapi.json for the canonical machine-readable contract. Every resource above accepts two payment schemes: "exact" (per-call) and "covenant-session" (settle once for 100 calls / 1h via POST /facilitator/settle {resource:"session"}, then POST /session/redeem per call — no further wallet interaction).'
    })
  }

  /* GET /supported — the x402 spec's facilitator-capability discovery
     endpoint (see docs.cdp.coinbase.com, developers.circle.com,
     the legacy x402 facilitator-http transport spec). A generic x402
     client is supposed to hit this FIRST to learn which (x402Version,
     scheme, network) combinations a facilitator can verify/settle,
     before ever building a PaymentIntent — COVENANT had GET /chains for
     the same job but in a COVENANT-specific shape, which a spec-generic
     client doesn't know to look for. This mirrors the spec's documented
     shape (kinds[], extensions[], signers{}) built from the same live
     chain registry /chains uses, so the two never drift out of sync.
     Exposed at both the bare spec path (/supported) and under this
     gateway's /facilitator/* convention (/facilitator/supported) since
     COVENANT's other facilitator ops (verify/settle/status) all live
     under that prefix — callers that guessed either path find it. */
  async function supported(req, res) {
    const chainList = facilitator.chains.listChains()
    const kinds = []
    const signers = {}
    for (const c of chainList) {
      const network = `eip155:${c.id}`
      // publicView() constructs a provider for the chain's RPC env var,
      // which throws if that chain simply isn't configured here (e.g. a
      // deployment that only set up Robinhood + Ethereum, skipping
      // Base/Arbitrum). That's an expected, non-fatal state — the chain
      // still belongs in `kinds` (it's a scheme/network COVENANT CAN
      // support, code-wise), it just has no live signer address to list
      // yet. Swallow it as "no view available" rather than 500ing the
      // whole discovery response over one unconfigured chain.
      let view = {}
      try { view = facilitator.publicView(c.id) } catch (_e) { /* chain not configured — kinds entry still included */ }
      kinds.push({
        x402Version: 1,
        scheme: 'exact',
        network,
        asset: c.usdc,
        extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION },
      })
      kinds.push({
        x402Version: 1,
        scheme: 'covenant-session',
        network,
        asset: c.usdc,
        extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION, calls: 100, ttlSec: 3600 },
      })
      // "upto" is live today only on /x402/upto/echo (see upto-demo.js),
      // which is chain-agnostic — advertise it for every chain here too,
      // not just Robinhood, since the route itself accepts ?chain=<id>.
      kinds.push({
        x402Version: 1,
        scheme: 'upto',
        network,
        asset: c.usdc,
        extra: { name: DOMAIN_NAME, version: DOMAIN_VERSION },
      })
      if (view.spender) signers[network] = [view.spender]
    }
    send(res, 200, {
      x402Version: 1,
      kinds,
      // bazaar: discovery extension is live on at least one route
      // (/x402/premium) today — see openapi() above for the fuller
      // per-route coverage status.
      extensions: ['bazaar'],
      signers,
    })
  }

  // Returns true if the request was handled (caller should `return`
  // immediately after), false if no discovery route matched.
  async function handle(req, res, url) {
    if (req.method !== 'GET') return false
    if (url === '/health') { health(req, res); return true }
    if (url === '/metrics') { metrics(req, res); return true }
    if (url === '/chains') { await chains(req, res); return true }
    if (url === '/favicon.ico' || url === '/favicon.svg') { favicon(req, res); return true }
    if (url === '/openapi.json') { openapi(req, res); return true }
    if (url === '/.well-known/x402') { wellKnown(req, res); return true }
    if (url === '/supported' || url === '/facilitator/supported') { await supported(req, res); return true }
    return false
  }

  return { handle }
}

module.exports = { registerDiscoveryRoutes }
