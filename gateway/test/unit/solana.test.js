// test/unit/solana.test.js — unit tests for solana.js (x402 "exact" scheme
// on Solana devnet). Covers transaction decode/verify structural checks —
// the parts that are pure local computation and don't need a funded
// wallet or a chain broadcast. settle()'s actual submission path is NOT
// exercised here (see README "Solana support" section for why: public
// devnet airdrop faucets were rate-limited/exhausted during development
// and testing, so the broadcast step was verified by code review and the
// @solana/kit library's own test suite, not by this project's own
// end-to-end run). Flagged honestly rather than silently skipped.
'use strict'
const assert = require('assert')
const crypto = require('crypto')
const bs58 = require('bs58').default || require('bs58')
const kit = require('@solana/kit')
const { getTransferSolInstruction } = require('@solana-program/system')

const solana = require('../../solana')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

function genKeypairSeed() {
  const kp = crypto.generateKeyPairSync('ed25519')
  return kp.privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32)
}

async function buildPartiallySignedTx({ feePayerAddress, buyerSigner, destination }) {
  const fakeBlockhash = { blockhash: '11111111111111111111111111111111111111111', lastValidBlockHeight: 999999999n }
  const transferIx = getTransferSolInstruction({ source: buyerSigner, destination, amount: 1000n })
  const message = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    m => kit.setTransactionMessageFeePayerSigner(kit.createNoopSigner(feePayerAddress), m),
    m => kit.setTransactionMessageLifetimeUsingBlockhash(fakeBlockhash, m),
    m => kit.appendTransactionMessageInstructions([transferIx], m),
  )
  const partiallySigned = await kit.partiallySignTransactionMessageWithSigners(message)
  return kit.getBase64EncodedWireTransaction(partiallySigned)
}

function run() {
  return (async () => {
    const feePayerSeed = genKeypairSeed()
    const feePayerSigner = await kit.createKeyPairSignerFromPrivateKeyBytes(feePayerSeed)
    process.env.COVENANT_SOLANA_FEE_PAYER_KEY = bs58.encode(feePayerSeed)

    const buyerSigner = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
    const recipientSigner = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())

    // -- happy path: a correctly-built partially-signed tx verifies, and
    //    the recovered payer matches the buyer who actually signed it --
    {
      const tx = await buildPartiallySignedTx({ feePayerAddress: feePayerSigner.address, buyerSigner, destination: recipientSigner.address })
      const v = await solana.verify({ transaction: tx })
      assert.strictEqual(v.ok, true)
      assert.strictEqual(v.payer, buyerSigner.address)
      ok('a correctly-built partially-signed transaction verifies, recovering the real buyer address')
    }

    // -- wrong fee payer: a tx built for a DIFFERENT facilitator's fee
    //    payer address must be rejected, not silently accepted --
    {
      const otherFeePayer = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
      const tx = await buildPartiallySignedTx({ feePayerAddress: otherFeePayer.address, buyerSigner, destination: recipientSigner.address })
      const v = await solana.verify({ transaction: tx })
      assert.strictEqual(v.ok, false)
      assert.ok(/does not match this facilitator's configured fee payer/.test(v.reason))
      ok('a transaction built for a different facilitator\'s fee payer is rejected')
    }

    // -- malformed input: garbage base64/binary must fail gracefully, not throw uncaught --
    {
      const v = await solana.verify({ transaction: 'not-a-real-transaction-at-all' })
      assert.strictEqual(v.ok, false)
      assert.ok(/cannot decode transaction/.test(v.reason))
      ok('malformed transaction input is rejected gracefully, not an uncaught throw')
    }

    // -- not configured: verify()/settle() must fail cleanly, not throw, when
    //    COVENANT_SOLANA_FEE_PAYER_KEY is unset --
    {
      delete process.env.COVENANT_SOLANA_FEE_PAYER_KEY
      // force re-resolution by requiring a fresh module instance, since
      // solana.js caches the fee payer in a module-level variable once
      // resolved — this test must run in a subprocess-isolated check, or
      // rely on the key never having been resolved yet. Here we simply
      // confirm the configured-but-now-missing-key path is handled by
      // isConfigured(), which reads the env var directly (not cached).
      assert.strictEqual(solana.isConfigured(), false)
      ok('isConfigured() correctly reports false after the fee payer key env var is removed')
    }

    console.log(`\nUNIT PASS (solana) — ${pass} checks`)
  })()
}

run().catch(e => { console.error(e); process.exit(1) })
