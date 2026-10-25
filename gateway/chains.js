// chains.js — supported chain registry for the COVENANT gateway.
//
// Single source of truth for which chains COVENANT settles on. Adding a
// chain = adding one entry here (+ an RPC env var) — no other file should
// hardcode a chain id, RPC URL, or asset address.
//
// Every USDC address below was verified ON-CHAIN before being added here
// (eth_getCode + symbol()/decimals()/name() + DOMAIN_SEPARATOR() via
// eth_call against a public RPC, 2026-09-24) — not copied from a block
// explorer listing without checking. See OPS-MULTICHAIN.md for the
// verification transcript.
//
// Robinhood Chain (4663) stays the default/legacy chain — COVENANT's own
// $COVENANT-adjacent USDG deployment, unaffected by this file structurally
// (kept as its own entry, not special-cased elsewhere).
const CHAINS = {
  4663: {
    id: 4663,
    key: 'robinhood',
    name: 'Robinhood Chain',
    shortName: 'Robinhood',
    rpcEnv: 'COVENANT_RPC_UPSTREAM', // legacy env var name, kept for compat
    usdc: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG on Robinhood — not Circle-issued, kept for backward compat
    usdcSymbol: 'USDG',
    decimals: 6,
    explorer: 'https://robinhoodchain.blockscout.com',
    // Robinhood's native gas token has no meaningful external USD market —
    // settlement cost here rounds to zero in any realistic pricing model.
    minSettlePriceUsd: 0,
  },
  1: {
    id: 1,
    key: 'ethereum',
    name: 'Ethereum',
    shortName: 'ETH',
    rpcEnv: 'COVENANT_RPC_ETHEREUM',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Circle native USDC — verified eth_call 2026-09-24
    usdcSymbol: 'USDC',
    decimals: 6,
    explorer: 'https://etherscan.io',
    // Ethereum L1 settlement gas is the most expensive rail here by a wide
    // margin. Measured ~55,000 gas per transferFrom settlement at ~0.16
    // gwei (2026-10-16 spot check) -> ~$0.028 at ETH≈$3,200. Floor set at
    // 2x that spot measurement (gas price is volatile) so a price above
    // the floor has real margin, not just break-even. Revisit if gas price
    // or ETH/USD moves materially — this is a static guard, not a live
    // oracle, by design (no price-feed dependency for a protective floor).
    minSettlePriceUsd: 0.05,
  },
  8453: {
    id: 8453,
    key: 'base',
    name: 'Base',
    shortName: 'Base',
    rpcEnv: 'COVENANT_RPC_BASE',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Circle native USDC — verified eth_call 2026-09-24
    usdcSymbol: 'USDC',
    decimals: 6,
    explorer: 'https://basescan.org',
    // L2 settlement, cheap: measured ~$0.001/settle (2026-10-16). Floor at
    // 10x spot for real margin against gas-price spikes.
    minSettlePriceUsd: 0.01,
  },
  42161: {
    id: 42161,
    key: 'arbitrum',
    name: 'Arbitrum One',
    shortName: 'Arbitrum',
    rpcEnv: 'COVENANT_RPC_ARBITRUM',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Circle native USDC — verified eth_call 2026-09-24
    usdcSymbol: 'USDC',
    decimals: 6,
    explorer: 'https://arbiscan.io',
    // L2 settlement, cheap: measured ~$0.0035/settle (2026-10-16). Floor at
    // ~6x spot for real margin against gas-price spikes.
    minSettlePriceUsd: 0.02,
  },
}

// BNB Chain was evaluated and deliberately excluded: the USDC there is
// Binance-Peg USDC (bridged, not Circle-issued), uses 18 decimals instead
// of 6 (every other chain here), and lacks EIP-3009/DOMAIN_SEPARATOR —
// different token entirely despite the same ticker. Mixing an 18-decimal
// asset into code that assumes 6 decimals everywhere is exactly the kind
// of silent-wrong-amount bug that shouldn't ship. Add it back only with
// its own decimals handling audited end to end, not by copying this entry.

const DEFAULT_CHAIN_ID = 4663

function isSupported(chainId) {
  return Object.prototype.hasOwnProperty.call(CHAINS, Number(chainId))
}

function getChain(chainId) {
  const c = CHAINS[Number(chainId)]
  if (!c) throw new Error(`unsupported chain id: ${chainId}`)
  return c
}

function listChains() {
  return Object.values(CHAINS)
}

// Treats a price (decimal USDC/USDG string) as "below the settlement-cost
// floor" for a chain if it's cheaper than minSettlePriceUsd. USDC/USDG are
// both ~$1-pegged stablecoins, so the decimal price string IS the USD
// value — no price-feed lookup needed. Used to stop /x402/apis route
// registration and the free playground (/x402/premium) default from
// quietly losing money settling a sub-gas-cost price on an expensive
// chain; callers decide whether a violation is a hard reject or a warning.
function clearsSettleFloor(price, chainId) {
  const c = getChain(chainId)
  return Number(price) >= c.minSettlePriceUsd
}

module.exports = { CHAINS, DEFAULT_CHAIN_ID, isSupported, getChain, listChains, clearsSettleFloor }
