// One real PAY against a paid route — proves the paid CONTENT actually comes back.
// Mirrors test/gen-load.js (the flow proven on-chain) but prints the payload.
// Usage: PAYER_KEY=0x... node test/pay-once.js [slug]
const { ethers } = require('ethers')
const fs = require('fs')
const path = require('path')
const F = require('/root/tribute/proxy/facilitator.js')

const slug = process.argv[2] || 'news'
const vars = {}
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) vars[m[1]] = m[2].trim()
}

const RPC = 'https://robinhood-rpc.publicnode.com'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const GW = 'https://api-gw.tributex402.com'
const PK = process.env.PAYER_KEY || vars.PAYER_PRIVATE_KEY

async function api(p, opts = {}) {
  const r = await fetch(GW + p, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } })
  let j = null
  try { j = await r.clone().json() } catch { /* raw */ }
  return { status: r.status, json: j }
}

;(async () => {
  const p = new ethers.JsonRpcProvider(RPC)
  const w = new ethers.Wallet(PK, p)
  console.log('payer:', w.address)

  // ① 402 challenge
  const c = await api('/x402/api/' + slug)
  if (c.status !== 402) throw new Error('expected 402, got ' + c.status)
  const req = c.json.accepts[0]
  const value = BigInt(req.maxAmountRequired)
  const spender = req.extra.spender
  console.log('① 402 challenge OK — price:', ethers.formatUnits(value, 6), 'USDG')

  // ② approve (real tx) if needed
  const tok = new ethers.Contract(USDG, [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ], w)
  const bal = await tok.balanceOf(w.address)
  if (bal < value) throw new Error(`insufficient USDG: ${ethers.formatUnits(bal, 6)}`)
  const allow = await tok.allowance(w.address, spender)
  if (allow < value) {
    const tx = await tok.approve(spender, value * 10n)
    await tx.wait()
    console.log('② approve OK', tx.hash.slice(0, 18) + '…')
  } else console.log('② allowance sufficient')

  // ③ sign EIP-712 (free) — same shape as gen-load.js (proven on-chain)
  const now = Math.floor(Date.now() / 1000)
  const intent = {
    from: w.address,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: now - 120,
    validBefore: now + 300,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
    resource: req.resource,
  }
  const signature = await w.signTypedData(F.DOMAIN, F.INTENT_TYPES, intent)
  console.log('③ signed EIP-712 (domain TRIBUTE)')

  // ④ settle — facilitator pays gas, real on-chain transferFrom
  const s = await api('/facilitator/settle', { method: 'POST', body: JSON.stringify({ intent, signature }) })
  if (!s.json?.success) throw new Error('settle failed: ' + (s.json?.errorReason || JSON.stringify(s.json)))
  console.log('④ SETTLED on-chain — tx', String(s.json.transaction).slice(0, 22) + '…')

  // ⑤ redeem with X-PAYMENT → must return the REAL content
  const d = await api('/x402/api/' + slug, { headers: { 'X-PAYMENT': String(s.json.payment || '') } })
  console.log('⑤ HTTP', d.status)
  const pl = d.json?.payload || {}
  const items = pl.items || pl.pools || pl.signals || []
  console.log('   kind:', pl.kind || '?', '| items:', items.length)
  for (const it of items.slice(0, 4)) {
    console.log('   •', (it.title || it.pool || it.name || it.signal || JSON.stringify(it)).slice(0, 90))
  }
  console.log('\nRESULT:', d.status === 200 && items.length > 0 ? 'PAID + REAL CONTENT DELIVERED ✅' : 'NO CONTENT ❌')
})().catch((e) => { console.error('ERR:', e.message); process.exit(1) })
