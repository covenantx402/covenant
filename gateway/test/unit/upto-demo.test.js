// test/unit/upto-demo.test.js — pure-function unit tests for upto-demo.js
// (the x402 "upto" scheme demo's word-count pricing logic).
'use strict'
const assert = require('assert')
const uptoDemo = require('../../upto-demo')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

// -- wordCount: basic, empty, whitespace-only --
{
  assert.strictEqual(uptoDemo.wordCount('hello world'), 2)
  assert.strictEqual(uptoDemo.wordCount(''), 0)
  assert.strictEqual(uptoDemo.wordCount('   '), 0, 'whitespace-only counts as 0 words, not 1')
  assert.strictEqual(uptoDemo.wordCount(null), 0, 'null input does not throw')
  assert.strictEqual(uptoDemo.wordCount('one  two   three'), 3, 'multiple spaces between words collapse correctly')
  ok('wordCount handles basic/empty/whitespace/null input correctly')
}

// -- ceilingPriceUsd: fixed worst-case, independent of any input --
{
  const expected = uptoDemo.PRICE_PER_WORD_USD * uptoDemo.WORDS_CAP
  assert.strictEqual(uptoDemo.ceilingPriceUsd(), expected)
  ok('ceilingPriceUsd is exactly PRICE_PER_WORD_USD * WORDS_CAP')
}

// -- actualPriceUsd: scales with word count, capped at WORDS_CAP --
{
  const oneWord = uptoDemo.actualPriceUsd('hello')
  const twoWords = uptoDemo.actualPriceUsd('hello world')
  assert.ok(twoWords > oneWord, 'more words costs more')
  assert.strictEqual(twoWords, uptoDemo.PRICE_PER_WORD_USD * 2)
  ok('actualPriceUsd scales linearly with word count')
}

// -- actualPriceUsd never exceeds ceilingPriceUsd, even for huge input --
{
  const hugeText = Array(10000).fill('word').join(' ') // 10,000 words, way over WORDS_CAP
  const actual = uptoDemo.actualPriceUsd(hugeText)
  assert.ok(actual <= uptoDemo.ceilingPriceUsd(), `actual (${actual}) must never exceed ceiling (${uptoDemo.ceilingPriceUsd()}) — this is the entire safety property upto depends on`)
  assert.strictEqual(actual, uptoDemo.ceilingPriceUsd(), 'a text at/above WORDS_CAP words costs exactly the ceiling, not more')
  ok('actualPriceUsd is capped at WORDS_CAP words — can never exceed the signed ceiling')
}

// -- actualPriceUsd never produces a $0 charge (empty input still bills >0) --
{
  assert.ok(uptoDemo.actualPriceUsd('') > 0, 'empty text must still produce a positive charge — settle() rejects actualValue <= 0')
  assert.ok(uptoDemo.actualPriceUsd('   ') > 0, 'whitespace-only text must still produce a positive charge')
  ok('actualPriceUsd never returns $0, even for empty/whitespace-only input')
}

// -- toAtomic: correct scaling for a 6-decimal chain --
{
  const atomic = uptoDemo.toAtomic(0.05, 4663) // Robinhood, 6 decimals
  assert.strictEqual(atomic, '50000')
  ok('toAtomic converts a USD-equivalent decimal price to the chain\'s atomic units correctly')
}

console.log(`\nUNIT PASS (upto-demo) — ${pass} checks`)
