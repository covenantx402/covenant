// Generate REAL load on the TRIBUTE gateway — every iteration is a genuine
// on-chain settlement, not synthetic data. Useful before a live demo so the
// charts and activity feed are populated with verifiable transactions.
//
// Usage:
//   PAYER_KEY=0x... node test/gen-load.js [iterations] [delayMs]
//   PAYER_KEY=0x... node test/gen-load.js 8 3000
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

const ITER = parseInt(process.argv[2] || '6', 10)
const DELAY = parseInt(process.argv[3] || '2500', 10)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Several distinct APIs so the "top routes" chart has more than one bar.
const ROUTES = ['/alerts', '/premium', '/signals', '/whale-alerts']

async function api(path, init) {
  const r = await fetch(GW + path, init)
  const txt = await r.text()
  let j = null
  try { j = JSON.parse(txt) } catch { /* keep raw */ }
  return { status: r.status, json: j, raw: txt }
}

;(async () => {
  const key = process.env.PAYER_KEY
  if (!key) { console.error('set PAYER_KEY'); process.exit(1) }

  const p = new ethers.JsonRpcProvider(RPC)
  const w = new ethers.Wallet(key, p)
  const tokRO = new ethers.Contract(USDG, [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ], p)

  const startBal = await tokRO.balanceOf(w.address)
  console.log('payer          :', w.address)
  console.log('USDG start     :', ethers.formatUnits(startBal, 6))
  console.log('iterations     :', ITER, '| delay:', DELAY + 'ms')
  console.log('')

  let ok = 0, fail = 0
  const txs = []

  for (let i = 0; i < ITER; i++) {
    const route = ROUTES[i % ROUTES.length]
    const apiPath = '/x402/api' + route
    process.stdout.write(`[${i + 1}/${ITER}] ${route.padEnd(14)} `)

    try {
      // 1. 402 challenge
      const c = await api(apiPath)
      if (c.status !== 402) { console.log('skip (HTTP ' + c.status + ')'); fail++; await sleep(DELAY); continue }
      const req = c.json?.accepts?.[0]
      if (!req) { console.log('skip (no accepts)'); fail++; await sleep(DELAY); continue }

      const value = BigInt(req.maxAmountRequired)
      const spender = req.extra?.spender

      // 2. approve if needed (real tx)
      const tok = new ethers.Contract(USDG, [
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
      ], w)
      const allowance = await tok.allowance(w.address, spender)
      if (allowance < value) {
        const tx = await tok.approve(spender, value)
        await tx.wait()
      }

      // 3. sign EIP-712
      const now = Math.floor(Date.now() / 1000)
      const intent = {
        from: w.address,
        to: req.payTo,
        value: req.maxAmountRequired,
        validAfter: now - 120,
        validBefore: now + 300,
        nonce: ethers.hexlify(ethers.randomBytes(32)),
        resource: req.resource || apiPath,
      }
      const signature = await w.signTypedData(F.DOMAIN, F.INTENT_TYPES, intent)

      // 4. settle (real on-chain tx)
      const sr = await api('/facilitator/settle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intent, signature }),
      })
      if (!sr.json?.success) {
        console.log('settle FAIL:', sr.json?.errorReason)
        fail++
        await sleep(DELAY)
        continue
      }
      const rc = await p.getTransactionReceipt(sr.json.transaction)

      // 5. redeem X-PAYMENT
      const dr = await api(apiPath, { headers: { 'X-PAYMENT': String(sr.json.payment || '') } })
      if (dr.status !== 200) {
        console.log('deliver FAIL (HTTP ' + dr.status + ')')
        fail++
        await sleep(DELAY)
        continue
      }

      ok++
      txs.push({ route, tx: sr.json.transaction, block: rc?.blockNumber })
      console.log('✓ ' + sr.json.transaction.slice(0, 14) + '…  block ' + (rc?.blockNumber ?? '?'))

      await sleep(DELAY)
    } catch (e) {
      console.log('ERROR:', String(e.shortMessage || e.message).slice(0, 80))
      fail++
      await sleep(DELAY)
    }
  }

  const endBal = await tokRO.balanceOf(w.address)
  console.log('')
  console.log('────────────────────────────────────────')
  console.log('  settled  :', ok)
  console.log('  failed   :', fail)
  console.log('  USDG spent:', ethers.formatUnits(startBal - endBal, 6))
  console.log('  remaining:', ethers.formatUnits(endBal, 6))
  console.log('────────────────────────────────────────')
  console.log('  transactions (verifiable on explorer):')
  for (const t of txs) {
    console.log('    ' + t.route.padEnd(15) + t.tx)
  }
})().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1) })
