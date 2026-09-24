// examples/pay.js — an agent client that PAYS for a resource via TRIBUTE.
//
// Flow:
//   1. GET the paid endpoint  → 402 + payment requirements
//   2. approve the facilitator spender once (per amount)
//   3. sign an EIP-712 PaymentIntent in the USDG domain
//   4. POST { intent, signature } to /facilitator/settle
//
// Run: node examples/pay.js <private-key-with-USDG>
const { ethers } = require('ethers')

const GATEWAY = process.env.TRIBUTE_GATEWAY || 'http://127.0.0.1:8792'
const RPC = process.env.TRIBUTE_RPC_UPSTREAM || 'https://robinhood-rpc.publicnode.com'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const CHAIN_ID = 4663

// Must match the gateway's facilitator domain (see gateway/facilitator.js)
const DOMAIN = {
  name: 'TRIBUTE',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: USDG,
}

const TYPES = {
  PaymentIntent: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'resource', type: 'string' },
  ],
}

async function main() {
  const pk = process.argv[2]
  if (!pk) { console.error('usage: node examples/pay.js <private-key-with-USDG>'); process.exit(1) }
  const wallet = new ethers.Wallet(pk, new ethers.JsonRpcProvider(RPC))

  // 1. hit the paid endpoint, get the 402 requirements
  const res = await fetch(`${GATEWAY}/x402/premium`)
  if (res.status !== 402) { console.error('expected 402, got', res.status); process.exit(1) }
  // x-payment-required-v1 carries the legacy v1 JSON body this example
  // speaks (maxAmountRequired etc). The v2 header (Payment-Required /
  // X-PAYMENT-REQUIRED) uses a different codec + field names (`amount`) —
  // don't parse that one as plain JSON here.
  const required = JSON.parse(Buffer.from(res.headers.get('x-payment-required-v1'), 'base64').toString())
  const req = required.accepts[0]
  console.log('payment required:', req.description, '—', Number(req.maxAmountRequired) / 1e6, 'USDG')

  const spender = req.extra.spender
  if (!spender) { console.error('gateway has no settlement wallet configured'); process.exit(1) }

  const usdg = new ethers.Contract(USDG, [
    'function approve(address spender,uint256 value) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ], wallet)

  // 2. approve if needed
  const allowance = await usdg.allowance(wallet.address, spender)
  if (allowance < BigInt(req.maxAmountRequired)) {
    console.log('approving', spender, '…')
    const tx = await usdg.approve(spender, req.maxAmountRequired)
    await tx.wait()
  }

  // 3. sign the intent
  const now = Math.floor(Date.now() / 1000)
  const intent = {
    from: wallet.address,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: String(now - 10),
    validBefore: String(now + 300),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
    resource: req.resource,
  }
  const signature = await wallet.signTypedData(DOMAIN, TYPES, intent)

  // 4. settle
  const settle = await fetch(`${GATEWAY}/facilitator/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent, signature }),
  }).then(r => r.json())

  if (settle.success) {
    console.log('SETTLED on-chain:', settle.transaction)
    console.log('→ resource delivered (in production the gateway serves the payload here)')
  } else {
    console.error('settle failed:', settle.errorReason)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
