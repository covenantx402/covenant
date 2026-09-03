// E2E test: PAY flow ON-CHAIN BENERAN (bukan cuma verifikasi kriptografis).
// approve -> sign EIP-712 -> /facilitator/settle -> replay X-PAYMENT
const { ethers } = require('ethers')
const fs = require('fs')
for (const l of fs.readFileSync('/root/tribute/proxy/.env', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const F = require('/root/tribute/proxy/facilitator.js')

const RPC = 'https://robinhood-rpc.publicnode.com'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const GW = process.env.GW || 'http://127.0.0.1:8792'

const line = (s) => console.log(s)
const hr = (t) => { line(''); line('─'.repeat(64)); line('  ' + t); line('─'.repeat(64)) }

async function api(path, init) {
  const r = await fetch(GW + path, init)
  const txt = await r.text()
  let j = null
  try { j = JSON.parse(txt) } catch { /* keep raw */ }
  return { status: r.status, json: j, raw: txt }
}

;(async () => {
  const payerKey = process.env.PAYER_KEY
  if (!payerKey) { console.error('set PAYER_KEY'); process.exit(1) }

  const p = new ethers.JsonRpcProvider(RPC)
  const w = new ethers.Wallet(payerKey, p)
  const tokRO = new ethers.Contract(USDG, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], p)

  hr('SETUP')
  line('  payer           : ' + w.address)
  line('  USDG balance    : ' + ethers.formatUnits(await tokRO.balanceOf(w.address), 6))
  line('  gas             : ' + ethers.formatEther(await p.getBalance(w.address)))
  line('  block           : ' + await p.getBlockNumber())

  // ── STEP 1: 402 challenge ────────────────────────────────────────────
  hr('STEP 1 — GET /x402/api/alerts  (expect 402)')
  const r1 = await api('/x402/api/alerts')
  line('  HTTP            : ' + r1.status)
  const req = r1.json?.accepts?.[0]
  if (!req) { console.error('no accepts[]'); process.exit(1) }
  line('  scheme          : ' + req.scheme)
  line('  network         : ' + req.network)
  line('  maxAmountRequired: ' + req.maxAmountRequired)
  line('  payTo           : ' + req.payTo)
  line('  asset           : ' + req.asset)
  line('  extra.spender   : ' + req.extra?.spender)
  line('  extra.name      : ' + req.extra?.name + '  (EIP-712 domain)')

  if (r1.status !== 402) { console.error('EXPECT 402, got ' + r1.status); process.exit(1) }

  // ── STEP 2: approve ──────────────────────────────────────────────────
  hr('STEP 2 — approve USDG to spender (ON-CHAIN TX)')
  const spender = req.extra.spender
  const value = BigInt(req.maxAmountRequired)
  const tok = new ethers.Contract(USDG, [
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ], w)

  const before = await tok.allowance(w.address, spender)
  line('  allowance before: ' + ethers.formatUnits(before, 6) + ' USDG')
  if (before < value) {
    const tx = await tok.approve(spender, value)
    line('  approve tx      : ' + tx.hash)
    const rc = await tx.wait()
    line('  confirmed block : ' + rc.blockNumber + ' | gas used: ' + rc.gasUsed.toString())
    const after = await tok.allowance(w.address, spender)
    line('  allowance after : ' + ethers.formatUnits(after, 6) + ' USDG')
  } else {
    line('  allowance cukup, skip approve')
  }

  // ── STEP 3: sign EIP-712 ─────────────────────────────────────────────
  hr('STEP 3 — sign EIP-712 PaymentIntent (domain TRIBUTE)')
  const now = Math.floor(Date.now() / 1000)
  const intent = {
    from: w.address,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: now - 120,
    validBefore: now + 300,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
    resource: req.resource || '/api/x402/api/alerts',
  }
  line('  domain.name     : ' + F.DOMAIN.name)
  line('  domain.version  : ' + F.DOMAIN.version)
  line('  domain.chainId  : ' + F.DOMAIN.chainId)
  line('  verifyingContract: ' + F.DOMAIN.verifyingContract)
  line('  intent.value    : ' + intent.value + ' (' + ethers.formatUnits(intent.value, 6) + ' USDG)')
  line('  intent.nonce    : ' + intent.nonce.slice(0, 18) + '…')
  const signature = await w.signTypedData(F.DOMAIN, F.INTENT_TYPES, intent)
  line('  signature       : ' + signature.slice(0, 30) + '…')

  // ── STEP 4: settle ───────────────────────────────────────────────────
  hr('STEP 4 — POST /facilitator/settle  (ON-CHAIN transferFrom)')
  const balBefore = await tokRO.balanceOf(w.address)
  const r4 = await api('/facilitator/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent, signature }),
  })
  line('  HTTP            : ' + r4.status)
  line('  success         : ' + r4.json?.success)
  line('  transaction     : ' + (r4.json?.transaction || '-'))
  line('  network         : ' + (r4.json?.network || '-'))
  if (!r4.json?.success) {
    line('  errorReason     : ' + r4.json?.errorReason)
    process.exit(1)
  }
  const balAfter = await tokRO.balanceOf(w.address)
  line('  balance before  : ' + ethers.formatUnits(balBefore, 6) + ' USDG')
  line('  balance after   : ' + ethers.formatUnits(balAfter, 6) + ' USDG')
  line('  NET PAID        : ' + ethers.formatUnits(balBefore - balAfter, 6) + ' USDG')

  // verifikasi tx on-chain
  const rc = await p.getTransactionReceipt(r4.json.transaction)
  line('  on-chain block  : ' + rc.blockNumber + ' | status: ' + (rc.status === 1 ? 'SUCCESS' : 'FAILED'))
  line('  explorer        : https://explorer.tribute.re/tx/' + r4.json.transaction)

  // ── STEP 5: replay X-PAYMENT ─────────────────────────────────────────
  hr('STEP 5 — GET with X-PAYMENT  (expect 200)')
  const r5 = await api('/x402/api/alerts', { headers: { 'X-PAYMENT': r4.json.payment } })
  line('  HTTP            : ' + r5.status)
  line('  body            : ' + (r5.raw || '').slice(0, 200))
  if (r5.status !== 200) { console.error('EXPECT 200, got ' + r5.status); process.exit(1) }

  // ── STEP 6: replay attack harus ditolak ──────────────────────────────
  hr('STEP 6 — replay nonce yang sama (expect DITOLAK)')
  const r6 = await api('/facilitator/settle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent, signature }),
  })
  line('  success         : ' + r6.json?.success)
  line('  reason          : ' + r6.json?.errorReason)
  if (r6.json?.success !== false) { console.error('REPLAY TIDAK DITOLAK!'); process.exit(1) }
  line('  ✓ replay guard bekerja')

  hr('HASIL')
  line('  ✓ 402 challenge')
  line('  ✓ approve on-chain')
  line('  ✓ EIP-712 signature (domain TRIBUTE)')
  line('  ✓ settle on-chain — tx ' + r4.json.transaction.slice(0, 20) + '…')
  line('  ✓ X-PAYMENT replay → 200')
  line('  ✓ replay attack ditolak')
  line('')
  line('  PAY FLOW VERIFIED ON-CHAIN')
})().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1) })
