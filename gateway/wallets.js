// wallets.js — agent wallets on Robinhood 4663 (SQLite-backed).
// Private key shown once, then vaulted AES-256-GCM (see agent-vault.js).
const { Wallet } = require('ethers')
const db = require('./db')
const vault = require('./agent-vault')

const stmts = {
  insert: db.prepare('INSERT INTO wallets (address, owner, label, vault_ref, chain_id, created_at) VALUES (?,?,?,?,?,?)'),
  list: db.prepare('SELECT * FROM wallets WHERE owner = ? ORDER BY created_at DESC'),
  count: db.prepare('SELECT COUNT(*) AS n FROM wallets'),
}

function slug(s) {
  return String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent'
}

function create(owner, { label } = {}) {
  const w = Wallet.createRandom()
  const tag = slug(label)
  const name = `wallet_${tag}_${Date.now().toString(36)}`.slice(0, 64)
  vault.put(owner, name, w.privateKey)
  vault.audit('wallet', name)
  const rec = {
    label: String(label || 'agent').slice(0, 40),
    address: w.address,
    vault: name,
    chainId: 4663,
    createdAt: Date.now(),
  }
  stmts.insert.run(rec.address, owner, rec.label, rec.vault, rec.chainId, rec.createdAt)
  return {
    ...rec,
    privateKey: w.privateKey,
    mnemonic: w.mnemonic?.phrase || null,
    note: 'private key + mnemonic shown once. copy now. vault holds the encrypted key under rec.vault',
  }
}

function list(owner) {
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('wallet owner is required')
  return stmts.list.all(owner).map(r => ({ label: r.label, address: r.address, vault: r.vault_ref, chainId: r.chain_id, createdAt: r.created_at }))
}

function count() { return stmts.count.get().n }

module.exports = { create, list, count }
