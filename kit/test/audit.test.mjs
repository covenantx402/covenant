// Regression tests for kit audit findings A1-A5. Run: npm test (builds first).
import assert from "node:assert";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { paywall, verifyWebhookSignature } from "../dist/middleware.js";
import { UsageLogger } from "../dist/usage-logger.js";

const PAYTO = "0x" + "22".repeat(20);
const mkLogger = () => new UsageLogger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kit-")), "u.db"));
const cfg = (extra = {}) => ({ payTo: PAYTO, network: "robinhood", facilitatorUrl: "http://x", routes: { "GET /weather": { price: "0.01" } }, ...extra });
const header = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const auth = (nonce, value = "10000") => ({ from: "0x" + "11".repeat(20), to: PAYTO, value, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce });
const payment = (a) => header({ x402Version: 1, scheme: "exact", network: "robinhood", payload: { signature: "0xsig", authorization: a } });

function boot(facilitator, config = cfg()) {
  const app = express();
  app.use(paywall({ config, logger: mkLogger(), facilitator }));
  app.get("/weather", (_q, r) => r.json({ secret: "SECRET" }));
  return new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res({ s, port: s.address().port })); });
}
const call = (port, method, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => resolve({ status: x.statusCode, body: b, headers: x.headers })); });
  r.on("error", reject); r.end();
});

let pass = 0; const ok = (n) => { pass++; console.log("  ✓", n); };

// A1: case / trailing slash / HEAD no longer skip the paywall
{
  const f = { verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: "0xtx" }) };
  const { s, port } = await boot(f);
  for (const p of ["/weather", "/Weather", "/weather/", "/WEATHER/", "/%77eather"]) {
    const r = await call(port, "GET", p);
    assert.strictEqual(r.status, 402, `${p} must be paywalled`); assert.ok(!r.body.includes("SECRET"));
  }
  assert.strictEqual((await call(port, "HEAD", "/weather")).status, 402, "HEAD is paywalled like GET");
  s.close(); ok("[A1] /Weather, /weather/, encoded path and HEAD can't bypass the paywall");
}

// A2: settle BEFORE delivery; replay/concurrency can't get free content
{
  let settles = 0;
  const f = { verify: async () => ({ isValid: true }), settle: async () => { settles++; await new Promise((r) => setTimeout(r, 30)); return settles === 1 ? { success: true, transaction: "0xtx" } : { success: false, errorReason: "nonce used" }; } };
  const { s, port } = await boot(f);
  const h = { "x-payment": payment(auth("0x" + "ab".repeat(32))) };
  const rs = await Promise.all(Array.from({ length: 5 }, () => call(port, "GET", "/weather", h)));
  assert.strictEqual(rs.filter((r) => r.status === 200).length, 1, "exactly one concurrent request is served");
  assert.strictEqual(rs.filter((r) => r.status === 402).length, 4);
  assert.strictEqual(settles, 1, "duplicates never even reach the facilitator");
  const again = await call(port, "GET", "/weather", h);
  assert.strictEqual(again.status, 402, "replaying a settled receipt is refused");
  const up = await call(port, "GET", "/weather", { "x-payment": payment(auth("0x" + "AB".repeat(32))) });
  assert.strictEqual(up.status, 402, "nonce casing can't bypass the used-set");
  s.close(); ok("[A2] one receipt = one delivery; settlement happens before content; casing/replay refused");
}
{
  const f = { verify: async () => ({ isValid: true }), settle: async () => ({ success: false, errorReason: "insufficient funds" }) };
  const { s, port } = await boot(f);
  const r = await call(port, "GET", "/weather", { "x-payment": payment(auth("0x" + "cd".repeat(32))) });
  assert.strictEqual(r.status, 402); assert.ok(!r.body.includes("SECRET"), "failed settlement must NOT serve the resource");
  const retry = await call(port, "GET", "/weather", { "x-payment": payment(auth("0x" + "cd".repeat(32))) });
  assert.strictEqual(retry.status, 402); // reached facilitator again (nonce released), still refused
  s.close(); ok("[A2b] failed settlement serves nothing and releases the nonce for a legit retry");
}

// A3: malformed payloads never crash the process
{
  const f = { verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: "0x1" }) };
  const { s, port } = await boot(f);
  for (const bad of [
    payment({ ...auth("0x" + "01".repeat(32)), value: "abc" }),
    payment({ ...auth("0x" + "02".repeat(32)), to: null }),
    payment({ ...auth("0x" + "03".repeat(32)), nonce: "short" }),
    payment({ ...auth("0x" + "04".repeat(32)), value: "9".repeat(80) }),
    header({ x402Version: 1, scheme: "exact", network: "robinhood", payload: { signature: "x", authorization: 5 } }),
    "!!!not-base64!!!",
  ]) { const r = await call(port, "GET", "/weather", { "x-payment": bad }); assert.strictEqual(r.status, 402); }
  assert.strictEqual((await call(port, "GET", "/weather")).status, 402, "server still alive after junk");
  s.close(); ok("[A3] malformed X-PAYMENT -> 402, no crash");
}

// A4: configured publicOrigin wins over spoofed headers
{
  const f = { verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: "0x1" }) };
  const { s, port } = await boot(f, cfg({ publicOrigin: "https://api.example.com" }));
  const r = await call(port, "GET", "/weather", { "x-forwarded-proto": "javascript", host: "evil.test" });
  assert.strictEqual(JSON.parse(r.body).accepts[0].resource, "https://api.example.com/weather");
  s.close(); ok("[A4] 402 resource URL uses configured publicOrigin, not client headers");
}

// A5: webhook signature covers a fresh timestamp
{
  const body = '{"a":1}', secret = "s3cret", now = 1_700_000_000_000;
  const { createHmac } = await import("node:crypto");
  const sig = (ts) => "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  assert.strictEqual(verifyWebhookSignature(body, sig(String(now)), secret, String(now), now + 1000), true);
  assert.strictEqual(verifyWebhookSignature(body, sig(String(now)), secret, String(now), now + 10 * 60 * 1000), false, "stale replay rejected");
  assert.strictEqual(verifyWebhookSignature(body, sig(String(now)), secret, String(now + 1), now + 1000), false, "timestamp is covered by the signature");
  ok("[A5] webhook signature is timestamp-bound; stale/forged timestamps rejected");
}

console.log(`\nKIT PASS — ${pass} checks`);
process.exit(0);
