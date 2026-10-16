// test/unit/article-extract.test.js — pure-function unit tests for
// article-extract.js (no DB, no network, no server). Run standalone:
//   node test/unit/article-extract.test.js
// or via `npm run test:unit` (runs every file in test/unit/).
'use strict'
const assert = require('assert')
const { extractArticle } = require('../../article-extract')

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

// -- title / published extraction --
{
  const raw = 'Title: Some Headline Here\nPublished Time: 2026-01-01T00:00:00Z\nMarkdown Content:\n# Some Headline Here\n\nThis is the first real paragraph of the article and it is definitely long enough to pass the 60-character minimum length filter.'
  const { title, published } = extractArticle(raw)
  assert.strictEqual(title, 'Some Headline Here')
  assert.strictEqual(published, '2026-01-01T00:00:00Z')
  ok('extracts title and published time from header lines')
}

// -- missing title/published → null, not throw --
{
  const raw = 'Markdown Content:\n# Untitled\n\nA paragraph long enough to survive the length filter, just to check null-safe title/published extraction works.'
  const { title, published } = extractArticle(raw)
  assert.strictEqual(title, null)
  assert.strictEqual(published, null)
  ok('missing Title:/Published Time: lines -> null, no throw')
}

// -- strips markdown formatting (bold, italic, links, images) --
{
  const raw = 'Markdown Content:\n# H\n\nThis has **bold text** and *italic text* and a [link](https://example.com) and this whole paragraph needs to clear sixty characters minimum.'
  const { body } = extractArticle(raw)
  assert.ok(body.includes('bold text'), 'bold markers stripped, text kept')
  assert.ok(!body.includes('**'), 'no leftover ** markers')
  assert.ok(body.includes('italic text'), 'italic markers stripped, text kept')
  assert.ok(body.includes('link'), 'link text kept')
  assert.ok(!body.includes('https://example.com'), 'link URL dropped, only anchor text kept')
  ok('strips bold/italic/link markdown, keeps the text')
}

// -- images dropped entirely (alt text is noise, not article content) --
{
  const raw = 'Markdown Content:\n# H\n\n![alt text goes here](https://example.com/img.png)\n\nThis is the real paragraph and it needs to be long enough to pass the sixty-character filter on its own.'
  const { body } = extractArticle(raw)
  assert.ok(!body.includes('alt text goes here'), 'image alt text is dropped entirely, not kept as prose')
  assert.ok(body.includes('real paragraph'), 'the actual article paragraph survives')
  ok('image markdown dropped entirely (not kept as alt-text prose)')
}

// -- short paragraphs (<60 chars) filtered out as noise --
{
  const raw = 'Markdown Content:\n# H\n\nToo short.\n\nThis paragraph on the other hand is long enough to clear the sixty character minimum length filter easily.'
  const { body } = extractArticle(raw)
  assert.ok(!body.includes('Too short.'), 'sub-60-char paragraph dropped')
  assert.ok(body.includes('long enough to clear'), 'long paragraph kept')
  ok('paragraphs under 60 chars are filtered as noise')
}

// -- boilerplate patterns filtered (BAD_START regex) --
{
  const raw = 'Markdown Content:\n# H\n\nSubscribe to our newsletter for more updates on crypto news and markets every single day of the week.\n\nThis is an actual real paragraph of substantial article content that should be kept in the output.'
  const { body } = extractArticle(raw)
  assert.ok(!body.includes('Subscribe to our newsletter'), 'boilerplate "Subscribe..." paragraph dropped')
  assert.ok(body.includes('actual real paragraph'), 'real content paragraph kept')
  ok('known boilerplate lead-ins (Subscribe/Related/etc.) are filtered')
}

// -- stops entirely at the Cointelegraph disclaimer boilerplate --
{
  const raw = 'Markdown Content:\n# H\n\nThis is the real article body and it is definitely long enough to pass the sixty character filter here.\n\nCointelegraph is committed to high journalistic standards and legal disclaimers follow this line in production text.\n\nThis paragraph comes after the disclaimer and must never appear in output because extraction stops at the marker above.'
  const { body } = extractArticle(raw)
  assert.ok(body.includes('real article body'), 'content before the disclaimer marker is kept')
  assert.ok(!body.includes('comes after the disclaimer'), 'content after the disclaimer marker is dropped entirely')
  ok('extraction stops at "Cointelegraph is committed..." boilerplate, drops everything after')
}

// -- output capped at 12000 chars (prevents unbounded payload size) --
{
  const bigParagraph = 'This is one long sentence that keeps repeating itself over and over to pad out the length. '.repeat(200)
  const raw = `Markdown Content:\n# H\n\n${bigParagraph}`
  const { body } = extractArticle(raw)
  assert.ok(body.length <= 12000, `body should be capped at 12000 chars, got ${body.length}`)
  ok('output body capped at 12000 chars')
}

// -- ticker-spam runs filtered (e.g. "BTC$95000 2.3% ETH$3200 1.1%") --
{
  const raw = 'Markdown Content:\n# H\n\nBTC$95000 2.3% ETH$3200 1.1% SOL$180 5.0%\n\nThis is a genuine prose paragraph about the market that should clearly survive the content filter.'
  const { body } = extractArticle(raw)
  assert.ok(!body.includes('BTC$95000'), 'ticker-spam run filtered out')
  assert.ok(body.includes('genuine prose paragraph'), 'real prose paragraph kept')
  ok('ticker-spam runs (TICKER_RUN regex) are filtered')
}

console.log(`\nUNIT PASS (article-extract) — ${pass} checks`)
