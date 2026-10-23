// demo-wallet.js — the wallet behind the public "Run a live payment" button.
//
// It is a SEPARATE key from the facilitator's settlement key, loaded from a
// mode-600 file (never from env, never logged). When the file is absent the
// whole demo feature is simply off.
//
// Everything this wallet pays is labelled `self-test-demo` in the public
// settlement ledger, so a demo click can never inflate the "external payers"
// number. This module is deliberately tiny and dependency-free so
// facilitator.js (audit classification) and proofkit.js (the payment flow)
// can both require it without a require cycle.
'use strict'
const fs = require('fs')
const { ethers } = require('ethers')

const KEY_FILE = process.env.COVENANT_DEMO_KEY_FILE || '/root/.covenant-demo-key'
let cached // undefined = not loaded yet, null = unavailable, { key, address } = ready

function load() {
  if (cached !== undefined) return cached
  try {
    const k = fs.readFileSync(KEY_FILE, 'utf8').trim()
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('not a 32-byte hex key')
    cached = { key: k, address: new ethers.Wallet(k).address }
  } catch { cached = null }
  return cached
}

/** lowercase address, or null when the demo wallet is not configured */
const address = () => (load() ? load().address.toLowerCase() : null)
const checksumAddress = () => (load() ? load().address : null)
/** the private key never leaves this module except to the one signer that needs it */
const privateKey = () => (load() ? load().key : null)
/** test hook */
function _reset(next) { cached = next }

module.exports = { address, checksumAddress, privateKey, _reset, KEY_FILE }
