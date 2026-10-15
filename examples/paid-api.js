// examples/paid-api.js — register a paid route on a running COVENANT gateway.
//
// Assumes the gateway is already running (node gateway/server.js) on
// 127.0.0.1:8792. This script just calls the admin endpoint that registers
// a new paid route — the actual 402 / settle flow is in examples/pay.js.
//
// Run: node examples/paid-api.js [path] [priceUsdg] [payToAddress]

const GATEWAY = process.env.COVENANT_GATEWAY || 'http://127.0.0.1:8792'

async function main() {
  const path = process.argv[2] || '/alerts'
  const price = process.argv[3] || '0.01'
  const payTo = process.argv[4] || process.env.COVENANT_X402_PAYTO
  if (!payTo) {
    console.error('usage: node examples/paid-api.js <path> <priceUsdg> <payToAddress>')
    console.error('   or: set COVENANT_X402_PAYTO and omit the third argument')
    process.exit(1)
  }

  const res = await fetch(`${GATEWAY}/x402/apis`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, price, description: 'COVENANT example route', payTo }),
  })
  const body = await res.json()

  if (!res.ok) {
    console.error('registration failed:', res.status, body)
    process.exit(1)
  }

  console.log('route registered:', body)
  console.log(`unpaid test:   curl ${GATEWAY}/x402/api${path}`)
  console.log('paying client: node examples/pay.js <private-key-with-USDG>')
}

main().catch(e => { console.error(e); process.exit(1) })
