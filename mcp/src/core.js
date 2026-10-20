// core.js: COVENANT MCP logic, independent of the MCP transport so it can be unit-tested.
//
// Safety model (mirrors skill/SKILL.md):
//  - Read tools need no key and never move funds.
//  - Model input can only choose a route SLUG or an address. It can never choose a URL, header or method.
//  - Paying is opt-in: no wallet configured => the pay tool does not exist. Even then every payment needs
//    confirm:true, a per-call maxUsdg, stays under a hard per-payment cap and a per-process session budget,
//    and only ever settles on Robinhood Chain 4663 in the known USDG contract.
//  - The wallet key comes from the environment only. It is never an input and never appears in output.

import fs from 'node:fs'

export const CHAIN_ID = 4663
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
export const EXPLORER = 'https://robinhoodchain.blockscout.com'
const DECIMALS = 6
const SLUG = /^[a-z0-9-]{1,32}$/
const ADDR = /^0x[0-9a-fA-F]{40}$/
const TX = /^0x[0-9a-fA-F]{64}$/
const MIN_GAS = 100_000_000n // 0.1 gwei floor: Robinhood's fee estimate can be ~0 and public RPCs then reject the tx

const TYPES = {
  PaymentIntent: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }, { name: 'resource', type: 'string' },
  ],
}

export function loadConfig(env = process.env) {
  const gateway = String(env.COVENANT_GATEWAY || 'https://gateway.covenantx402.com').replace(/\/+$/, '')
  if (!/^https:\/\//.test(gateway) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(gateway)) {
    throw new Error('COVENANT_GATEWAY must be https (or http://localhost for local development)')
  }
  let walletKey = null
  if (env.COVENANT_WALLET_KEY_FILE) {
    const st = fs.statSync(env.COVENANT_WALLET_KEY_FILE)
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new Error('COVENANT_WALLET_KEY_FILE must not be readable by group/others (chmod 600)')
    walletKey = fs.readFileSync(env.COVENANT_WALLET_KEY_FILE, 'utf8').trim()
  } else if (env.COVENANT_WALLET_KEY) walletKey = String(env.COVENANT_WALLET_KEY).trim()
  if (walletKey && !/^0x[0-9a-fA-F]{64}$/.test(walletKey)) throw new Error('wallet key is not a 32-byte hex private key')
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }
  return {
    gateway,
    rpc: env.COVENANT_RPC_URL || 'https://robinhood-rpc.publicnode.com',
    walletKey,
    maxPaymentUsdg: num(env.COVENANT_MAX_PAYMENT_USDG, 0.05),   // hard per-payment ceiling
    sessionBudgetUsdg: num(env.COVENANT_SESSION_BUDGET_USDG, 0.10), // total this server process may ever spend
  }
}

export function createCore(cfg, { fetchImpl = fetch } = {}) {
  const UA = { 'user-agent': 'covenant-mcp/0.1', accept: 'application/json' }
  let spent = 0
  let busy = false
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function getJson(path, init) {
    const r = await fetchImpl(cfg.gateway + path, { ...init, headers: { ...UA, ...(init?.headers || {}) }, signal: AbortSignal.timeout(20000) })
    const text = await r.text()
    let body; try { body = JSON.parse(text) } catch { body = text }
    return { status: r.status, body, headers: r.headers }
  }

  const slugOf = (s) => {
    const v = String(s || '').trim().replace(/^\/?(x402\/)?(api\/)?/, '').replace(/^\//, '')
    if (!SLUG.test(v)) throw new Error('route must be a slug like "alerts" (letters, digits, dashes; max 32). URLs are not accepted.')
    return v
  }
  const usd = (atomic) => Number(BigInt(atomic)) / 10 ** DECIMALS

  // ------------------------------------------------------------------ read tools
  async function status() {
    const [h, c] = await Promise.all([getJson('/x402/health'), getJson('/chains')])
    return {
      gateway: cfg.gateway,
      ok: !!h.body?.ok,
      settlementsRecorded: h.body?.checks?.settlement?.settled ?? null,
      paidRoutes: h.body?.checks?.apis?.count ?? null,
      chains: (c.body?.chains || []).map((x) => ({ name: x.name, chainId: x.id, settlementReady: !!x.readiness?.settlementReady, note: x.readiness?.reason || null })),
      payingEnabled: !!cfg.walletKey,
    }
  }

  async function listApis() {
    const [a, m] = await Promise.all([getJson('/x402/apis'), getJson('/x402/marketplace')])
    return {
      network: 'eip155:4663 (Robinhood Chain), asset USDG',
      core: (a.body?.apis || []).map((x) => ({ route: x.slug, priceUsdg: x.price, description: x.description })),
      marketplace: (m.body?.apis || []).map((x) => ({ route: x.slug, priceUsdg: x.price, name: x.name, description: x.description, seller: x.seller })),
    }
  }

  async function inspectRoute(route) {
    const slug = slugOf(route)
    const r = await getJson(`/x402/api/${slug}`)
    if (r.status !== 402) return { route: slug, status: r.status, note: r.status === 404 ? 'unknown route' : 'route did not return a 402 challenge', body: typeof r.body === 'object' ? r.body : undefined }
    const exact = (r.body?.accepts || []).find((x) => x.scheme === 'exact') || r.body?.accepts?.[0]
    if (!exact) return { route: slug, status: 402, note: 'challenge had no accepted payment option' }
    return {
      route: slug, status: 402, payment: 'required (nothing has been paid)',
      priceUsdg: usd(exact.maxAmountRequired), network: exact.network, asset: exact.asset, payTo: exact.payTo,
      description: exact.description,
      safeToPayHere: exact.network === `eip155:${CHAIN_ID}` && String(exact.asset).toLowerCase() === USDG.toLowerCase(),
    }
  }

  async function receipts(limit = 10) {
    const r = await getJson('/x402/billing')
    const rows = (r.body?.rows || []).slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))
    return {
      total: r.body?.count ?? rows.length, totalUsdg: r.body?.totalUsdg ?? null,
      receipts: rows.map((x) => ({ route: String(x.api).replace(/^\/api/, ''), usdg: x.usdg, payer: x.payer, txHash: x.txHash, time: new Date(x.t).toISOString(), explorer: `${EXPLORER}/tx/${x.txHash}` })),
    }
  }

  async function reputation(address) {
    if (!ADDR.test(String(address || ''))) throw new Error('address must be a 0x… EVM address')
    const r = await getJson(`/reputation/${address}`)
    return r.body
  }

  function explorerLink(tx) {
    if (!TX.test(String(tx || ''))) throw new Error('tx must be a 0x… 32-byte hash')
    return `${EXPLORER}/tx/${tx}`
  }

  // ------------------------------------------------------------------ pay tool
  async function wallet() {
    const { ethers } = await import('ethers')
    const provider = new ethers.JsonRpcProvider(cfg.rpc)
    return { ethers, provider, signer: new ethers.Wallet(cfg.walletKey, provider) }
  }

  async function pay({ route, maxUsdg, confirm = false }) {
    if (!cfg.walletKey) throw new Error('paying is disabled: no wallet configured on this server')
    const slug = slugOf(route)
    const maxIn = Number(maxUsdg)
    if (!Number.isFinite(maxIn) || maxIn <= 0) throw new Error('maxUsdg is required and must be > 0')

    const ch = await getJson(`/x402/api/${slug}`)
    if (ch.status !== 402) throw new Error(`route "${slug}" did not return a payment challenge (HTTP ${ch.status})`)
    const req = (ch.body?.accepts || []).find((x) => x.scheme === 'exact')
    if (!req) throw new Error('no exact-scheme payment option offered')
    // A hostile or misconfigured gateway must not be able to redirect funds or switch asset/chain.
    if (req.network !== `eip155:${CHAIN_ID}`) throw new Error(`refusing: network ${req.network} is not Robinhood Chain ${CHAIN_ID}`)
    if (String(req.asset).toLowerCase() !== USDG.toLowerCase()) throw new Error('refusing: payment asset is not the known USDG contract')
    const spender = req.extra?.spender
    if (!spender || !ADDR.test(spender) || String(req.payTo).toLowerCase() !== String(spender).toLowerCase()) throw new Error('refusing: payTo does not match the facilitator spender')
    if (!String(req.resource || '').startsWith(cfg.gateway + '/x402/api/')) throw new Error('refusing: resource is outside the configured gateway')

    const price = usd(req.maxAmountRequired)
    if (price > maxIn) throw new Error(`price ${price} USDG exceeds your maxUsdg ${maxIn}`)
    if (price > cfg.maxPaymentUsdg) throw new Error(`price ${price} USDG exceeds the server's per-payment cap ${cfg.maxPaymentUsdg} (COVENANT_MAX_PAYMENT_USDG)`)
    if (spent + price > cfg.sessionBudgetUsdg + 1e-9) throw new Error(`session budget ${cfg.sessionBudgetUsdg} USDG would be exceeded (already spent ${spent.toFixed(6)})`)

    const { ethers, provider, signer } = await wallet()
    const usdg = new ethers.Contract(USDG, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], signer)
    const need = BigInt(req.maxAmountRequired)
    let balance = null, allowance = null, native = null
    try { [balance, allowance, native] = await Promise.all([usdg.balanceOf(signer.address), usdg.allowance(signer.address, spender), provider.getBalance(signer.address)]) } catch { /* plan can still be shown */ }

    const plan = {
      route: slug, priceUsdg: price, payTo: spender, network: req.network, wallet: signer.address,
      walletBalanceUsdg: balance == null ? 'unknown (rpc unavailable)' : Number(ethers.formatUnits(balance, DECIMALS)),
      needsApproval: allowance == null ? 'unknown' : allowance < need,
      sessionBudgetRemainingUsdg: Number((cfg.sessionBudgetUsdg - spent).toFixed(6)),
    }
    if (!confirm) return { executed: false, note: 'DRY RUN. Nothing was signed or sent. Call again with confirm:true to pay.', plan }
    if (balance != null && balance < need) throw new Error('wallet USDG balance is lower than the price')
    if (native != null && native === 0n) throw new Error('wallet has no native gas for the one-time approval')

    if (busy) throw new Error('another payment is already in progress')
    busy = true
    try {
      if (allowance == null || allowance < need) {
        const tx = await usdg.approve(spender, need, { maxFeePerGas: MIN_GAS * 2n, maxPriorityFeePerGas: MIN_GAS, gasLimit: 80000n })
        await tx.wait()
      }
      const now = Math.floor(Date.now() / 1000)
      const intent = { from: signer.address, to: req.payTo, value: req.maxAmountRequired, validAfter: String(now - 10), validBefore: String(now + 300), nonce: ethers.hexlify(ethers.randomBytes(32)), resource: req.resource }
      const signature = await signer.signTypedData({ name: 'COVENANT', version: '1', chainId: CHAIN_ID, verifyingContract: USDG }, TYPES, intent)

      // One signed intent settles at most once on the gateway, so re-sending the SAME intent is always safe.
      let settle
      for (let i = 1; i <= 5; i++) {
        const r = await getJson('/facilitator/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent, signature }) })
        settle = r.body
        if (settle?.success) break
        const retry = settle?.pending || /coalesce|RPC|busy|try again|retry/i.test(String(settle?.errorReason || ''))
        if (!retry || i === 5) break
        await sleep(6000)
      }
      if (!settle?.success) throw new Error(`settlement failed: ${settle?.errorReason || 'unknown'}${settle?.pending ? ` (pending tx ${settle.transaction}; re-run to resolve)` : ''}`)
      spent += price

      const paid = await getJson(`/x402/api/${slug}`, { headers: { 'x-payment': settle.payment } })
      return {
        executed: true, settled: true, transaction: settle.transaction, explorer: explorerLink(settle.transaction), paidUsdg: price,
        sessionSpentUsdg: Number(spent.toFixed(6)), delivery: { httpStatus: paid.status, data: paid.status === 200 ? paid.body : undefined, note: paid.status === 200 ? undefined : 'payment settled but delivery did not return 200' },
      }
    } finally { busy = false }
  }

  return { status, listApis, inspectRoute, receipts, reputation, explorerLink, pay, _state: () => ({ spent }) }
}
