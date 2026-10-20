// test/unit/solana.test.js — unit tests for solana.js (x402 "exact" scheme
// on Solana devnet). Covers transaction decode/verify structural checks —
// the parts that are pure local computation and don't need a funded
// wallet or a chain broadcast. settle()'s actual submission path is NOT
// exercised here (see README "Solana support" section for why: public
// devnet airdrop faucets were rate-limited/exhausted during development
// and testing, so the broadcast step was verified by code review and the
// @solana/kit library's own test suite, not by this project's own
// end-to-end run). Flagged honestly rather than silently skipped.
//
// Note: a chunk of this file is dedicated to assertSafeTx — a real
// anti-drain vulnerability was found and fixed in this module (see
// solana.js's assertSafeTx docstring and the commit message for the full
// writeup). A buyer with a perfectly legitimate signature could smuggle a
// second instruction into the same transaction that drains the
// facilitator's own fee-payer wallet, because settle() co-signs whatever
// verify() approves without inspecting what the instructions actually DO.
// These tests are the permanent regression guard for that fix — if any of
// the "rejected" assertions below ever start passing (ok: true), that is
// the vulnerability coming back.
'use strict'
const assert = require('assert')
const crypto = require('crypto')
const bs58 = require('bs58').default || require('bs58')
const kit = require('@solana/kit')
const { getTransferSolInstruction } = require('@solana-program/system')
const { getTransferCheckedInstruction } = require('@solana-program/token')

const solana = require('../../solana')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

function genKeypairSeed() {
  const kp = crypto.generateKeyPairSync('ed25519')
  return kp.privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32)
}

const FAKE_BLOCKHASH = { blockhash: '11111111111111111111111111111111111111111', lastValidBlockHeight: 999999999n }

async function buildTx({ feePayerAddress, instructions }) {
  const message = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    m => kit.setTransactionMessageFeePayerSigner(kit.createNoopSigner(feePayerAddress), m),
    m => kit.setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
    m => kit.appendTransactionMessageInstructions(instructions, m),
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
    const buyerTokenAccount = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
    const merchantTokenAccount = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
    const mint = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
    process.env.COVENANT_SOLANA_MINT = mint.address
    process.env.COVENANT_SOLANA_PAYTO = merchantTokenAccount.address

    function legitTransferCheckedIx() {
      return getTransferCheckedInstruction({ source: buyerTokenAccount.address, mint: mint.address, destination: merchantTokenAccount.address, authority: buyerSigner, amount: 1000n, decimals: 6 })
    }

    // -- payment binding: verify() must check mint / recipient / amount --
    {
      const other = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
      const bad = (over) => getTransferCheckedInstruction({ source: buyerTokenAccount.address, mint: mint.address, destination: merchantTokenAccount.address, authority: buyerSigner, amount: 1000n, decimals: 6, ...over })
      const run = async (ix, extra = {}) => solana.verify({ transaction: await buildTx({ feePayerAddress: feePayerSigner.address, instructions: [ix] }), ...extra })
      assert.strictEqual((await run(bad({ destination: other.address }))).ok, false, 'wrong recipient must be rejected')
      assert.strictEqual((await run(bad({ mint: other.address }))).ok, false, 'wrong mint must be rejected')
      assert.strictEqual((await run(bad(), { amount: '999' })).ok, false, 'amount mismatch vs requested must be rejected')
      assert.strictEqual((await run(bad(), { payTo: other.address })).ok, false, 'caller cannot widen/redirect payTo')
      assert.strictEqual((await run(bad(), { amount: '1000', payTo: merchantTokenAccount.address, asset: mint.address })).ok, true, 'matching requirements verify')
      const two = await buildTx({ feePayerAddress: feePayerSigner.address, instructions: [bad(), bad()] })
      assert.strictEqual((await solana.verify({ transaction: two })).ok, false, 'extra instructions must be rejected')
      delete process.env.COVENANT_SOLANA_PAYTO
      assert.strictEqual((await run(bad())).ok, false, 'unconfigured recipient must fail closed')
      process.env.COVENANT_SOLANA_PAYTO = merchantTokenAccount.address
      ok('Solana verify binds mint/recipient/amount, single-instruction only, fails closed when unconfigured')
    }

    // -- happy path: a real SPL TransferChecked payment verifies, and the
    //    recovered payer matches the buyer who actually signed it --
    {
      const tx = await buildTx({ feePayerAddress: feePayerSigner.address, instructions: [legitTransferCheckedIx()] })
      const v = await solana.verify({ transaction: tx })
      assert.strictEqual(v.ok, true, v.reason)
      assert.strictEqual(v.payer, buyerSigner.address)
      ok('a real SPL TransferChecked payment verifies, recovering the real buyer address')
    }

    // -- wrong fee payer: a tx built for a DIFFERENT facilitator's fee
    //    payer address must be rejected, not silently accepted --
    {
      const otherFeePayer = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
      const tx = await buildTx({ feePayerAddress: otherFeePayer.address, instructions: [legitTransferCheckedIx()] })
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

    // ============ ANTI-DRAIN TESTS ============
    // See solana.js's assertSafeTx docstring. These PoCs were confirmed
    // exploitable (verify() returned ok:true) before the fix existed.

    // -- smuggled SystemProgram instruction alongside a legit payment:
    //    drains the FEE PAYER's own SOL to the attacker. The legit
    //    instruction's real buyer signature must NOT be enough to accept
    //    the whole transaction when a second instruction targets a
    //    non-allowlisted program. --
    {
      const attackerSigner = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
      const legitIx = getTransferSolInstruction({ source: buyerSigner, destination: merchantTokenAccount.address, amount: 1n })
      const drainIx = getTransferSolInstruction({ source: kit.createNoopSigner(feePayerSigner.address), destination: attackerSigner.address, amount: 5_000_000_000n })
      const tx = await buildTx({ feePayerAddress: feePayerSigner.address, instructions: [legitIx, drainIx] })
      const v = await solana.verify({ transaction: tx })
      assert.strictEqual(v.ok, false, 'this transaction drains the fee payer\'s own SOL via a smuggled SystemProgram instruction and must never verify as ok')
      assert.ok(/non-allowlisted program/.test(v.reason))
      ok('a smuggled SystemProgram instruction that drains the fee payer\'s SOL is rejected, even alongside a real buyer signature')
    }

    // -- fee payer made the AUTHORITY of a TransferChecked instruction:
    //    drains the fee payer's own SPL TOKEN balance (not SOL) — a
    //    second variant of the same exploit using the allowlisted
    //    program itself, so the program-allowlist check alone would NOT
    //    catch this; it needs the separate "fee payer never referenced
    //    inside a token instruction" check. --
    {
      const attackerTokenAccount = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
      const feePayerTokenAccount = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
      const drainIx = getTransferCheckedInstruction({ source: feePayerTokenAccount.address, mint: mint.address, destination: attackerTokenAccount.address, authority: kit.createNoopSigner(feePayerSigner.address), amount: 999_999_999n, decimals: 6 })
      const tx = await buildTx({ feePayerAddress: feePayerSigner.address, instructions: [drainIx] })
      const v = await solana.verify({ transaction: tx })
      assert.strictEqual(v.ok, false, 'this transaction drains the fee payer\'s own SPL token balance by making it the transfer authority and must never verify as ok')
      assert.ok(/fee payer account is referenced inside a token-program instruction/.test(v.reason))
      ok('making the fee payer the AUTHORITY of a token transfer (draining its own token balance) is rejected')
    }

    // -- non-allowlisted program used alone (no smuggling needed) --
    {
      const recipientSigner = await kit.createKeyPairSignerFromPrivateKeyBytes(genKeypairSeed())
      const ix = getTransferSolInstruction({ source: buyerSigner, destination: recipientSigner.address, amount: 1000n })
      const tx = await buildTx({ feePayerAddress: feePayerSigner.address, instructions: [ix] })
      const v = await solana.verify({ transaction: tx })
      assert.strictEqual(v.ok, false)
      assert.ok(/non-allowlisted program/.test(v.reason))
      ok('a plain SystemProgram SOL transfer (not a token payment) is rejected — only SPL Token/Token-2022 instructions are allowed')
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
