// Agent wallets on Robinhood 4663. Private key shown once, then vaulted AES-256-GCM. Persisted to disk.
const { Wallet } = require('ethers')
const fs = require('fs')
const path = require('path')
const vault = require('./agent-vault')

const STORE_PATH = process.env.TRIBUTE_WALLETS_STORE ||
  path.join(__dirname, 'data', 'wallets.json')

const wallets = []

function load() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
    if (fs.existsSync(STORE_PATH)) wallets.push(...JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')))
  } catch (e) {
    console.error('wallets load failed:', e.message)
  }
}

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
  const tmp = STORE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(wallets))
  fs.renameSync(tmp, STORE_PATH)
}

load()

function slug(s) {
  return String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent'
}

function create({ label } = {}) {
  const w = Wallet.createRandom()
  const tag = slug(label)
  const name = `wallet_${tag}_${Date.now().toString(36)}`.slice(0, 64)
  vault.put(name, w.privateKey)
  vault.audit('wallet', name)
  const rec = {
    label: String(label || 'agent').slice(0, 40),
    address: w.address,
    vault: name,
    chainId: 4663,
    createdAt: Date.now()
  }
  wallets.push(rec)
  save()
  return {
    ...rec,
    privateKey: w.privateKey,
    mnemonic: w.mnemonic?.phrase || null,
    note: 'private key + mnemonic shown once. copy now. vault holds the encrypted key under rec.vault'
  }
}

function list() {
  return wallets.map(({ label, address, vault: v, chainId, createdAt }) => ({ label, address, vault: v, chainId, createdAt }))
}

function count() { return wallets.length }

module.exports = { create, list, count }
