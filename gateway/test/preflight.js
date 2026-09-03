// Cek kesehatan operasional gateway SEBELUM demo/rekaman.
// Termasuk gas facilitator — kalau ini habis, settlement GAGAL padahal
// USDG-nya masih ada. Ini failure mode yang paling gampang kena.
const { ethers } = require('ethers')
const fs = require('fs')

for (const l of fs.readFileSync('/root/tribute/proxy/.env', 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const RPC = 'https://robinhood-rpc.publicnode.com'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const GW = process.env.GW || 'http://127.0.0.1:8792'
const SETTLE_GAS = 70000n   // estimasi gas per settlement

const ok = (b) => b ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m'
const warn = (b) => b ? '\x1b[33mWARN\x1b[0m' : '\x1b[32mOK  \x1b[0m'

async function getJson(path, headers) {
  const r = await fetch(GW + path, { headers })
  let j = null
  try { j = await r.json() } catch { /* ignore */ }
  return { status: r.status, json: j }
}

;(async () => {
  const p = new ethers.JsonRpcProvider(RPC)
  const gp = (await p.getFeeData()).gasPrice

  let fac = null
  if (process.env.TRIBUTE_SETTLE_KEY) {
    fac = new ethers.Wallet(process.env.TRIBUTE_SETTLE_KEY, p)
  }

  console.log('')
  console.log('  TRIBUTE gateway health')
  console.log('  ' + '─'.repeat(58))

  // 1. RPC
  let block = null
  try {
    block = await p.getBlockNumber()
    console.log(`  ${ok(true)} RPC          block ${block}`)
  } catch (e) {
    console.log(`  ${ok(false)} RPC          ${String(e.shortMessage || e.message).slice(0, 40)}`)
  }

  // 2. facilitator gas — INI YANG PALING KRITIS
  if (fac) {
    const bal = await p.getBalance(fac.address)
    const canSettle = Number(bal / (SETTLE_GAS * gp))
    console.log(`  ${warn(canSettle < 5)} facilitator gas   ${ethers.formatEther(bal)} ETH → ~${canSettle} settlements left`)
    if (canSettle < 5) {
      console.log(`         \x1b[33m⚠ top up ${fac.address} sebelum demo — kalau gas habis, PAY gagal\x1b[0m`)
    }
    // USDG facilitator (penerima)
    const tokRO = new ethers.Contract(USDG, ['function balanceOf(address) view returns (uint256)'], p)
    const u = await tokRO.balanceOf(fac.address)
    console.log(`  ${ok(true)} facilitator USDG  ${ethers.formatUnits(u, 6)}`)
  }

  // 3. endpoint publik
  const st = await getJson('/x402/stats')
  const apis = await getJson('/x402/apis')
  console.log(`  ${ok(st.status === 200)} /x402/stats    HTTP ${st.status}`)
  console.log(`  ${ok(apis.status === 200)} /x402/apis     HTTP ${apis.status}`)

  const d = st.json || {}
  console.log('  ' + '─'.repeat(58))
  console.log('  data yang tampil di console:')
  for (const [k, v] of [
    ['Events 24h', d.activity24h],
    ['Gate hits', d.hits402],
    ['Paid APIs', d.apis],
    ['Settled on-chain', d.onchain?.settled],
    ['Vault entries', d.vault?.entries],
    ['Brokered', d.vault?.brokered],
    ['Wallets', d.wallets],
    ['Known agents', d.reputation?.knownAgents],
    ['Top routes', (d.topPaths || []).length],
  ]) {
    const flag = (v === 0 || v === undefined) ? ' \x1b[33m← kosong\x1b[0m' : ''
    console.log(`    ${String(k).padEnd(18)}: ${v}${flag}`)
  }

  // 4. agent key (kalau ada)
  const keyPath = '/root/tribute/proxy/.demo_key'
  if (fs.existsSync(keyPath)) {
    const secret = fs.readFileSync(keyPath, 'utf8').trim()
    const an = await getJson('/analytics/keys', { Authorization: 'Bearer ' + secret })
    const ve = await getJson('/vault/entries', { Authorization: 'Bearer ' + secret })
    console.log('  ' + '─'.repeat(58))
    console.log(`  ${ok(an.status === 200)} agent key     analytics HTTP ${an.status}`)
    console.log(`  ${ok(ve.status === 200)} agent key     vault     HTTP ${ve.status}`)
  }

  // 5. wallet demo (kalau ada)
  const wPath = '/root/tribute/proxy/.demo_wallet'
  if (fs.existsSync(wPath)) {
    const txt = fs.readFileSync(wPath, 'utf8')
    const addr = (txt.match(/DEMO_WALLET_ADDRESS=(\S+)/) || [])[1]
    if (addr) {
      const tokRO = new ethers.Contract(USDG, ['function balanceOf(address) view returns (uint256)'], p)
      const u = await tokRO.balanceOf(addr)
      const g = await p.getBalance(addr)
      console.log(`  ${warn(u === 0n)} demo wallet   ${ethers.formatUnits(u, 6)} USDG | ${ethers.formatEther(g)} ETH`)
      if (u === 0n) console.log('         \x1b[33m⚠ wallet demo kosong — PAY bakal gagal preflight\x1b[0m')
    }
  }

  console.log('  ' + '─'.repeat(58))
  console.log('')
})().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1) })
