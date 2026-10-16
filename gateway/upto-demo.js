// upto-demo.js — a tiny resource that genuinely has variable cost, built to
// exercise the x402 "upto" scheme end to end (not just plumbing with no
// caller). COVENANT's other paid routes are all flat-price ("exact"); this
// is deliberately the one place price depends on the request.
//
// Honest framing (see README): a real "upto" use case is something whose
// true cost can't be known BEFORE the work runs — LLM token usage,
// compute-time billing. This demo's cost (price per word of input text) IS
// knowable upfront from the query string, so it doesn't literally need
// "settle less than I thought" semantics the way a metered LLM call would.
// It proves the exact same mechanism though: the challenge advertises a
// CEILING sized for the worst case (WORDS_CAP words), the buyer signs
// that ceiling once, and settlement only ever pulls the real per-request
// cost — which is provably less than the ceiling for any input shorter
// than the cap. A metered resource would compute actualValue AFTER doing
// the work instead of from the query string, but the settle() call shape
// is identical either way.
const chains = require('./chains')

const PRICE_PER_WORD_USD = 0.0001
const WORDS_CAP = 500 // hard cap — bounds both the advertised ceiling and the real charge
const MIN_WORDS_BILLED = 1 // a 0-word (empty) request still bills 1 word's worth — nothing settles for free, and settle() rejects a $0 actualValue outright

function wordCount(text) {
  const t = String(text || '').trim()
  if (!t) return 0
  return t.split(/\s+/).length
}

// Ceiling: what the buyer signs once, sized for the worst case (WORDS_CAP
// words) regardless of how long their actual text turns out to be.
function ceilingPriceUsd() {
  return PRICE_PER_WORD_USD * WORDS_CAP
}

// Actual: the real per-request cost, capped at WORDS_CAP words so a
// pathological input can't exceed the signed ceiling, and floored at
// MIN_WORDS_BILLED so an empty/whitespace-only request doesn't produce a
// $0 charge (which settle() would reject outright as an invalid actualValue).
function actualPriceUsd(text) {
  const n = Math.max(Math.min(wordCount(text), WORDS_CAP), MIN_WORDS_BILLED)
  return PRICE_PER_WORD_USD * n
}

function toAtomic(priceUsd, chainId) {
  const c = chains.getChain(chainId)
  return String(BigInt(Math.round(priceUsd * 10 ** c.decimals)))
}

module.exports = { PRICE_PER_WORD_USD, WORDS_CAP, wordCount, ceilingPriceUsd, actualPriceUsd, toAtomic }
