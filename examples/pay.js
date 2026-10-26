// examples/pay.js — an agent client that PAYS for a resource via COVENANT.
//
// Flow:
//   1. GET the paid endpoint  → 402 + payment requirements
//   2. approve the facilitator spender once (per amount)
//   3. sign an EIP-712 PaymentIntent in the USDG domain
//   4. POST { intent, signature } to /facilitator/settle
//   5. GET the same endpoint with X-PAYMENT header → 200 + paid content
//
// The default resource is /x402/api/alerts, a real paid route that returns content once paid.
// (/x402/premium is only a sample CHALLENGE for discovery and playgrounds: it never returns paid content.)
//
// Run (key via env — safer than a CLI arg which appears in process listings):
//   npm i ethers            # once, in this folder (or run with NODE_PATH pointing at gateway/node_modules)
//   WALLET_KEY=0x... node examples/pay.js
//   WALLET_KEY=0x... COVENANT_RESOURCE=/x402/api/signals node examples/pay.js
//
// Other chains (see GET /chains for which are settlement-ready):
//   COVENANT_CHAIN=8453 WALLET_KEY=0x... node examples/pay.js     # Base, pays in USDC
//   (RPC for that chain: COVENANT_PAY_RPC=<url>; defaults to a public RPC)
//
// Or pass as CLI arg (legacy, still works):
//   node examples/pay.js <private-key-with-USDG>
const { ethers } = require('ethers')

const GATEWAY = process.env.COVENANT_GATEWAY || 'https://gateway.covenantx402.com'
const CHAIN_ID = Number(process.env.COVENANT_CHAIN || 4663)
const PUBLIC_RPC = {
  4663: 'https://robinhood-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  1: 'https://ethereum-rpc.publicnode.com',
}
const RPC = process.env.COVENANT_PAY_RPC || (CHAIN_ID === 4663 && process.env.COVENANT_RPC_UPSTREAM) || PUBLIC_RPC[CHAIN_ID]
const BASE_RESOURCE = process.env.COVENANT_RESOURCE || '/x402/api/alerts'
const RESOURCE = CHAIN_ID === 4663 ? BASE_RESOURCE : `${BASE_RESOURCE}${BASE_RESOURCE.includes('?') ? '&' : '?'}chain=${CHAIN_ID}`
// Robinhood Chain's fee estimate can come back as ~0; some public RPCs then reject the tx. Keep a floor.
const MIN_GAS = ethers.parseUnits('0.1', 'gwei')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))


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
  // Accept key from env var (safer) or CLI arg (legacy)
  const pk = process.env.WALLET_KEY || process.argv[2]
  if (!pk) {
    console.error('usage: WALLET_KEY=0x... node examples/pay.js')
    console.error('   or: node examples/pay.js <private-key-with-USDG>')
    process.exit(1)
  }
  if (!RPC) { console.error('no RPC for chain', CHAIN_ID, '- set COVENANT_PAY_RPC'); process.exit(1) }
  const wallet = new ethers.Wallet(pk, new ethers.JsonRpcProvider(RPC))

  // 1. hit the paid endpoint, get the 402 requirements
  const res = await fetch(`${GATEWAY}${RESOURCE}`)
  if (res.status !== 402) { console.error('expected 402, got', res.status); process.exit(1) }
  // x-payment-required-v1 carries the legacy v1 JSON body this example
  // speaks (maxAmountRequired etc). The v2 header (Payment-Required /
  // X-PAYMENT-REQUIRED) uses a different codec + field names (`amount`) —
  // don't parse that one as plain JSON here.
  const required = JSON.parse(Buffer.from(res.headers.get('x-payment-required-v1'), 'base64').toString())
  const req = required.accepts[0]
  if (req.network !== `eip155:${CHAIN_ID}`) { console.error('gateway answered for', req.network, 'not eip155:' + CHAIN_ID); process.exit(1) }
  const ASSET = req.asset
  // EIP-712 domain is always name COVENANT, verifying contract = the chain's payment asset
  const DOMAIN = { name: 'COVENANT', version: '1', chainId: CHAIN_ID, verifyingContract: ASSET }
  console.log('payment required:', req.description, '—', Number(req.maxAmountRequired) / 1e6, 'on', req.network)

  const spender = req.extra.spender
  if (!spender) { console.error('gateway has no settlement wallet configured'); process.exit(1) }

  const usdg = new ethers.Contract(ASSET, [
    'function approve(address spender,uint256 value) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ], wallet)

  // 2. approve if needed
  const allowance = await usdg.allowance(wallet.address, spender)
  if (allowance < BigInt(req.maxAmountRequired)) {
    console.log('approving', spender, '…')
    // the 0.1 gwei floor is only for Robinhood Chain's ~0 fee estimates; other chains use the node's own estimate
    const opts = CHAIN_ID === 4663 ? { maxFeePerGas: MIN_GAS * 2n, maxPriorityFeePerGas: MIN_GAS, gasLimit: 80000n } : {}
    const tx = await usdg.approve(spender, req.maxAmountRequired, opts)
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

  // 4. settle. The gateway guarantees ONE transfer per signed intent (nonce is claimed before any chain call),
  // so re-sending the SAME intent is always safe:
  //   - 202 / pending:true  → the tx was broadcast but its confirmation isn't known yet: re-send the same request
  //   - transient RPC error → the nonce was released, nothing moved: re-send the same request
  let settle
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(`${GATEWAY}/facilitator/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent, signature, chainId: CHAIN_ID }),
    })
    settle = await r.json()
    if (settle.success) break
    const retryable = settle.pending || /coalesce|RPC|busy|try again|retry/i.test(settle.errorReason || '')
    if (!retryable || attempt === 5) break
    console.log(`settle not final (${settle.pending ? 'pending, tx ' + settle.transaction : settle.errorReason}) — retrying the same intent…`)
    await sleep(6000)
  }

  if (!settle.success) {
    console.error('settle failed:', settle.errorReason || settle.error || JSON.stringify(settle))
    process.exit(1)
  }
  console.log('SETTLED on-chain:', settle.transaction)
  const chainsInfo = await (await fetch(`${GATEWAY}/chains`)).json().catch(() => null)
  const explorer = chainsInfo?.chains?.find(c => c.id === CHAIN_ID)?.explorer || 'https://robinhoodchain.blockscout.com'
  console.log('explorer: ' + explorer + '/tx/' + settle.transaction)

  // 5. replay the receipt as X-PAYMENT to get the paid content (one receipt = one delivery)
  const paid = await fetch(`${GATEWAY}${RESOURCE}`, { headers: { 'X-PAYMENT': settle.payment } })
  const body = await paid.json().catch(() => paid.text())
  console.log('→ HTTP', paid.status)
  if (paid.status !== 200) { console.error('expected 200 with paid content, got', paid.status, JSON.stringify(body)); process.exit(1) }
  console.log('→ paid response:', JSON.stringify(body, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
