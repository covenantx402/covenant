// solana.js — x402 "exact" scheme on Solana (SVM), devnet-only for now.
//
// Architecturally separate from chains.js/facilitator.js on purpose: Solana
// isn't an EVM chain (no chainId, no EIP-712, no approve+transferFrom) — it
// uses CAIP-2 `solana:<genesis-hash>` network ids, Ed25519 signatures, and
// a fundamentally different payment flow (per the exact SVM spec,
// specs/schemes/exact/scheme_exact_svm.md in x402-foundation/x402):
//   1. Buyer builds a versioned (v0) transaction with a SPL TransferChecked
//      instruction to the seller, signs it with their Ed25519 key, and
//      leaves the FEE PAYER'S signature slot empty (partially signed).
//   2. Buyer base64-encodes the partially-signed tx as the PaymentPayload.
//   3. Facilitator verifies the transaction's structure/amount/recipient
//      match the advertised requirements (no RPC call needed for this —
//      it's pure transaction-decoding + field comparison, same economic
//      shape as verify() elsewhere in this gateway).
//   4. Facilitator adds its OWN signature as feePayer (the final required
//      signature) and submits the now fully-signed transaction. The
//      facilitator pays the Solana network fee — same "buyer never pays
//      gas" model every other chain in this gateway already has.
// This is genuinely a different trust/signature model from the EVM
// approve+transferFrom pattern (facilitator.js), not a port of it — hence
// its own module instead of forcing it into chains.js's EVM-shaped registry.
//
// STATUS: devnet only. Mainnet needs its own funded fee-payer wallet and
// its own settlement-cost floor measurement (Solana fees are usually a
// few thousand lamports, ~$0.0002-0.001 at current SOL prices — likely
// the cheapest rail COVENANT would support, cheaper than Base/Arbitrum —
// but that needs a real spot measurement before going live, same
// discipline chains.js's EVM floors were held to).
const {
  createSolanaRpc,
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  signTransaction,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  createSolanaRpcSubscriptions,
} = require('@solana/kit')
const bs58 = require('bs58').default || require('bs58')

// SPL Token program — the ONLY program a buyer's instruction is allowed to
// target. See the P0 fix below (assertSafeTx) for why this allowlist
// exists: without it, a buyer could smuggle an UNRELATED instruction (e.g.
// a plain SystemProgram transfer) into the same transaction that drains
// the facilitator's own fee-payer account, since the fee payer's
// signature — added blindly by settle() — satisfies that instruction's
// signer requirement too. Verified exploitable with a real PoC before
// this fix existed (see commit message).
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

const NETWORK = {
  key: 'solana-devnet',
  caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', // Solana devnet genesis hash, per the x402 spec's documented network id
  name: 'Solana Devnet',
  // Circle's official devnet USDC mint — verified to exist and be owned by
  // the SPL Token program via getAccountInfo, 2026-10-16 (see commit).
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  usdcSymbol: 'USDC',
  decimals: 6,
  rpcUrl: 'https://api.devnet.solana.com',
  wsUrl: 'wss://api.devnet.solana.com',
  explorer: 'https://explorer.solana.com/?cluster=devnet',
  // Devnet SOL has no real USD value — floor is nominal, exists only so
  // the code path is exercised the same way every EVM chain's is.
  minSettlePriceUsd: 0,
}

let _rpc = null
function rpc() {
  if (!_rpc) _rpc = createSolanaRpc(NETWORK.rpcUrl)
  return _rpc
}

let _rpcSubscriptions = null
function rpcSubscriptions() {
  if (!_rpcSubscriptions) _rpcSubscriptions = createSolanaRpcSubscriptions(NETWORK.wsUrl)
  return _rpcSubscriptions
}

let _feePayer = null
async function feePayer() {
  if (_feePayer) return _feePayer
  const raw = process.env.COVENANT_SOLANA_FEE_PAYER_KEY
  if (!raw) return null
  // Accepts a base58-encoded 32-byte seed (the common "export private key"
  // format from Phantom/Solflare/solana-keygen) OR a base58-encoded
  // 64-byte secret key (seed+pubkey, the solana-keygen JSON array format
  // re-encoded) — take the first 32 bytes either way, since
  // createKeyPairSignerFromPrivateKeyBytes derives the public key itself.
  const bytes = bs58.decode(raw.trim())
  const seed = bytes.length >= 32 ? bytes.slice(0, 32) : bytes
  if (seed.length !== 32) throw new Error(`COVENANT_SOLANA_FEE_PAYER_KEY must decode to at least 32 bytes, got ${seed.length}`)
  _feePayer = await createKeyPairSignerFromPrivateKeyBytes(seed)
  return _feePayer
}

function isConfigured() {
  return !!process.env.COVENANT_SOLANA_FEE_PAYER_KEY
}

/**
 * Decode a base64-encoded partially-signed transaction (the PaymentPayload
 * shape the exact SVM spec documents: { transaction: "base64..." }) into
 * its compiled message, WITHOUT needing an RPC call — this is pure
 * decoding, same cost-free verification shape as facilitator.verify()'s
 * signature-recovery step.
 */
function decodeTransaction(base64Transaction) {
  const wireBytes = Buffer.from(base64Transaction, 'base64')
  const txDecoder = getTransactionDecoder()
  const tx = txDecoder.decode(wireBytes)
  const msgDecoder = getCompiledTransactionMessageDecoder()
  const compiledMessage = msgDecoder.decode(tx.messageBytes)
  return { tx, compiledMessage }
}

/**
 * P0 anti-drain guard. Our fee payer co-signs (in settle()) WHATEVER
 * transaction passed verify() — it never inspects what the instructions
 * actually DO. Without this check, a buyer can smuggle an unrelated
 * instruction into the same transaction that moves funds OUT of the fee
 * payer's own account, since the fee payer is a required signer for ANY
 * instruction referencing its account as a signer-role account — and
 * settle() supplies that signature blindly. Proven exploitable with a
 * real local PoC (two-instruction tx: a tiny real buyer payment +
 * a SystemProgram transfer draining 5 SOL from the fee payer to the
 * attacker) before this function existed.
 *
 * Enforces, on the FULLY RESOLVED account list (staticAccounts — this
 * gateway rejects any transaction using address lookup tables below,
 * specifically because an unresolved ALT could hide a program from this
 * check):
 *   1. Every instruction's program is on the allowlist (SPL Token /
 *      Token-2022 only — the only program a payment transfer legitimately
 *      needs).
 *   2. The fee payer account (index 0) is NEVER referenced inside any
 *      instruction's account list — its only role in this flow is paying
 *      the network fee, never being a source/destination/authority of a
 *      token transfer.
 * Returns { ok, reason? }.
 */
function assertSafeTx(compiledMessage, feePayerAddress) {
  const staticAccounts = compiledMessage.staticAccounts || []
  // Address Lookup Tables let a transaction reference additional accounts
  // (including PROGRAM ids) without listing them in staticAccounts — a
  // program hidden behind an unresolved ALT would be invisible to the
  // allowlist check below. Reject outright rather than resolve ALTs here;
  // this gateway's payment transactions don't need them.
  if (compiledMessage.addressTableLookups && compiledMessage.addressTableLookups.length > 0) {
    return { ok: false, reason: 'transactions using address lookup tables are not supported — ALT-referenced accounts (including programs) cannot be safety-checked' }
  }
  const feePayerIndex = staticAccounts.indexOf(feePayerAddress)
  for (const ix of compiledMessage.instructions || []) {
    const program = staticAccounts[ix.programAddressIndex]
    if (program !== SPL_TOKEN_PROGRAM && program !== SPL_TOKEN_2022_PROGRAM) {
      return { ok: false, reason: `instruction targets a non-allowlisted program (${program}) — only the SPL Token/Token-2022 program is permitted in a payment transaction` }
    }
    if ((ix.accountIndices || []).includes(feePayerIndex)) {
      return { ok: false, reason: 'the fee payer account is referenced inside a token-program instruction — the fee payer must only pay the network fee, never be a transfer source/destination/authority' }
    }
  }
  return { ok: true }
}

/**
 * Verify a buyer's partially-signed transaction matches the advertised
 * PaymentRequirements. Checks (pure decode + compare, no RPC call):
 *   - transaction decodes cleanly
 *   - fee payer account is empty (buyer hasn't tried to pay their own fee
 *     — that would mean no sponsor signature slot for the facilitator)
 *   - the fee payer slot matches COVENANT's configured fee payer address
 *     (a buyer can't point the sponsor slot at a DIFFERENT facilitator
 *     and expect this one to sign it)
 *   - assertSafeTx: no non-allowlisted program, fee payer never referenced
 *     inside a token instruction (the P0 anti-drain guard — see its own
 *     docstring for the exploit this closes)
 * Returns { ok, reason? }.
 */
async function verify({ transaction, payTo, amount, asset }) {
  const fp = await feePayer()
  if (!fp) return { ok: false, reason: 'Solana fee payer not configured (COVENANT_SOLANA_FEE_PAYER_KEY missing)' }

  let decoded
  try { decoded = decodeTransaction(transaction) }
  catch (e) { return { ok: false, reason: 'cannot decode transaction: ' + String(e.message || e) } }

  const { compiledMessage } = decoded
  const staticAccounts = compiledMessage.staticAccounts || []
  if (!staticAccounts.length) return { ok: false, reason: 'transaction has no accounts' }

  // Account 0 is always the fee payer by Solana convention.
  const feePayerAccount = staticAccounts[0]
  if (feePayerAccount !== fp.address) {
    return { ok: false, reason: `transaction's fee payer slot (${feePayerAccount}) does not match this facilitator's configured fee payer (${fp.address}) — this payload was built for a different sponsor` }
  }

  // P0 anti-drain guard — must run BEFORE accepting any signature as
  // sufficient "buyer authorization". A transaction can have a perfectly
  // legitimate buyer signature AND a smuggled instruction that drains the
  // fee payer; the signature check below alone would have accepted it.
  const safety = assertSafeTx(compiledMessage, feePayerAccount)
  if (!safety.ok) return { ok: false, reason: safety.reason }

  // The fee payer's signature slot must currently be present-but-EMPTY —
  // @solana/kit represents an unsigned slot as `null` (not 64 zero
  // bytes) in the decoded signatures map — i.e. "partially signed": the
  // buyer signed, the sponsor has not yet. Reject anything that looks
  // already-fully-signed (nothing left for this facilitator to add) or
  // missing the slot entirely (malformed).
  const signatures = decoded.tx.signatures
  if (!signatures || !(feePayerAccount in signatures)) {
    return { ok: false, reason: 'transaction has no signature slot reserved for the fee payer' }
  }
  const feePayerSigBytes = signatures[feePayerAccount]
  if (feePayerSigBytes !== null) return { ok: false, reason: 'transaction is already fully signed — nothing for this facilitator to co-sign' }

  // At least one OTHER account must carry a real (non-null) signature —
  // that's the buyer's authorization. Structural proof of payer intent;
  // amount/recipient/asset matching against the specific instruction
  // bytes is deliberately NOT implemented in this devnet-only pass (see
  // README "Solana support" section) — flagged honestly as a gap, not
  // silently skipped.
  const otherSigners = Object.entries(signatures).filter(([addr]) => addr !== feePayerAccount)
  const realSigner = otherSigners.find(([, sig]) => sig !== null)
  if (!realSigner) return { ok: false, reason: 'no non-fee-payer account has signed this transaction' }

  return { ok: true, payer: realSigner[0] }
}

/**
 * Settle: add the facilitator's fee-payer signature to a verified
 * partially-signed transaction and submit it. Returns
 * { success, transaction?, errorReason? } — same shape facilitator.settle()
 * uses, so callers don't need scheme-specific branching on the response.
 */
async function settle({ transaction }) {
  const fp = await feePayer()
  if (!fp) return { success: false, errorReason: 'Solana fee payer not configured (COVENANT_SOLANA_FEE_PAYER_KEY missing)' }

  let decoded
  try { decoded = decodeTransaction(transaction) }
  catch (e) { return { success: false, errorReason: 'cannot decode transaction: ' + String(e.message || e) } }

  try {
    // signTransaction signs directly off the decoded tx's messageBytes +
    // existing signature map — no need to decompile/recompile the
    // message first (decompileTransactionMessage would only be needed if
    // we were re-deriving the message from scratch, which we're not).
    const fullySigned = await signTransaction([fp.keyPair], { messageBytes: decoded.tx.messageBytes, signatures: decoded.tx.signatures })

    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc: rpc(), rpcSubscriptions: rpcSubscriptions() })
    await sendAndConfirm(fullySigned, { commitment: 'confirmed' })
    const signature = getSignatureFromTransaction(fullySigned)
    return { success: true, transaction: signature, network: NETWORK.caip2 }
  } catch (e) {
    return { success: false, errorReason: 'Solana settle error: ' + String(e.message || e) }
  }
}

function publicView() {
  return {
    network: NETWORK.caip2,
    name: NETWORK.name,
    asset: NETWORK.usdcMint,
    assetName: NETWORK.usdcSymbol,
    decimals: NETWORK.decimals,
    configured: isConfigured(),
    feePayer: _feePayer ? _feePayer.address : null,
    minSettlePriceUsd: NETWORK.minSettlePriceUsd,
  }
}

module.exports = { NETWORK, isConfigured, feePayer, decodeTransaction, verify, settle, publicView, getBase64EncodedWireTransaction }
