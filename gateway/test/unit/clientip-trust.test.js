// test/unit/clientip-trust.test.js — regression test for a rate-limit
// bucket-sharing gap found during security audit: when the gateway is
// fronted by a reverse proxy/tunnel (Cloudflare Tunnel's cloudflared
// connects via plain loopback), req.socket.remoteAddress is the SAME for
// every real-world client. Without COVENANT_TRUSTED_PROXIES configured,
// every anonymous request across the entire public domain shared ONE
// rate-limit bucket — worse than no limiting at the per-client level,
// since one abusive client could exhaust the budget for everyone else.
//
// The fix: clientIp() now ALSO recognizes cf-connecting-ip (preferred
// over x-forwarded-for when both present) — but ONLY when the immediate
// socket peer is in COVENANT_TRUSTED_PROXIES. This test spawns two
// server instances: one WITHOUT trust configured (the header must be
// ignored, confirming an untrusted deployment can't be spoofed into
// fragmenting its own rate limit) and one WITH 127.0.0.1 trusted (the
// header must be honored, confirming the Cloudflare Tunnel fix works).
'use strict'
const assert = require('assert')
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

function req(base, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + p, { method: 'GET', headers }, res => {
      let out = ''
      res.on('data', c => out += c)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }))
    })
    r.on('error', reject)
    r.end()
  })
}

function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covenant-clientip-test-'))
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        COVENANT_RPC_UPSTREAM: process.env.COVENANT_RPC_UPSTREAM || 'https://robinhood-rpc.publicnode.com',
        COVENANT_PORT: String(port),
        COVENANT_SETTLE_KEY: '0x' + '11'.repeat(32),
        COVENANT_VAULT_KEY: 'unit-test-vault-key-0123456789abcdef',
        COVENANT_DB_PATH: path.join(tmp, 'gateway.db'),
        COVENANT_ROUTES_STORE: path.join(tmp, 'routes.json'),
        ...extraEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const t = setInterval(async () => {
      try { await req(`http://127.0.0.1:${port}`, '/x402/health'); clearInterval(t); resolve({ child, tmp }) } catch { /* not up yet */ }
    }, 300)
    child.on('exit', c => reject(new Error('server exited early: ' + c)))
  })
}

async function main() {
  // -- UNTRUSTED deployment (no COVENANT_TRUSTED_PROXIES): spoofing
  //    cf-connecting-ip with a different value on every request must
  //    NOT let a client dodge rate limiting by claiming a fresh identity
  //    each time — the real peer (127.0.0.1, this test harness) is what
  //    must get rate-limited, proving the header is ignored. --
  {
    const { child, tmp } = await startServer(9101, {})
    try {
      const r1 = await req('http://127.0.0.1:9101', '/x402/health', { 'cf-connecting-ip': '1.1.1.1' })
      const r2 = await req('http://127.0.0.1:9101', '/x402/health', { 'cf-connecting-ip': '2.2.2.2' })
      // Both requests must consume from the SAME bucket (decreasing remaining),
      // proving the spoofed header was ignored and both were keyed by the
      // real peer address, not two independent "clients".
      const remaining1 = Number(r1.headers['x-ratelimit-remaining'])
      const remaining2 = Number(r2.headers['x-ratelimit-remaining'])
      assert.strictEqual(remaining2, remaining1 - 1, `an UNtrusted deployment must ignore a spoofed cf-connecting-ip and bucket both requests under the same real peer — remaining went ${remaining1} -> ${remaining2}, expected a decrease of exactly 1 (same bucket), not independent buckets`)
      ok('[security] an untrusted deployment ignores a spoofed cf-connecting-ip header — cannot fragment its own rate limit')
    } finally {
      child.kill()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  // -- TRUSTED deployment (COVENANT_TRUSTED_PROXIES=127.0.0.1, the
  //    Cloudflare Tunnel fix): cf-connecting-ip IS honored, so two
  //    DIFFERENT claimed client IPs get INDEPENDENT rate-limit buckets
  //    instead of collapsing into one shared bucket for the whole tunnel. --
  {
    const { child, tmp } = await startServer(9102, { COVENANT_TRUSTED_PROXIES: '127.0.0.1' })
    try {
      const rA1 = await req('http://127.0.0.1:9102', '/x402/health', { 'cf-connecting-ip': '3.3.3.3' })
      const rB1 = await req('http://127.0.0.1:9102', '/x402/health', { 'cf-connecting-ip': '4.4.4.4' })
      const rA2 = await req('http://127.0.0.1:9102', '/x402/health', { 'cf-connecting-ip': '3.3.3.3' })
      const remA1 = Number(rA1.headers['x-ratelimit-remaining'])
      const remB1 = Number(rB1.headers['x-ratelimit-remaining'])
      const remA2 = Number(rA2.headers['x-ratelimit-remaining'])
      // client A's second request decrements from client A's first — proves
      // they share a bucket keyed by "3.3.3.3", independent of client B.
      assert.strictEqual(remA2, remA1 - 1, `the trusted deployment must bucket repeat requests from the SAME claimed cf-connecting-ip together — remaining went ${remA1} -> ${remA2} for client A's two requests`)
      // client B's first request should NOT show a decrement relative to
      // client A's bucket — it's a fresh/independent bucket for "4.4.4.4".
      assert.ok(remB1 >= remA1, `client B (different cf-connecting-ip) must get an INDEPENDENT rate-limit bucket, not share client A's — this is the whole point of the fix: without it, one shared Cloudflare Tunnel peer would mean one client's traffic exhausts everyone else's budget`)
      ok('[security fix verified] a trusted deployment (Cloudflare Tunnel pattern) gives each distinct cf-connecting-ip its own independent rate-limit bucket')
    } finally {
      child.kill()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  console.log(`\nUNIT PASS (clientip-trust) — ${pass} checks`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
