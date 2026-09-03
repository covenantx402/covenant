// article-extract.js — deterministic in-app article extraction.
// Input: raw text from r.jina.ai ("Title: ...\nMarkdown Content: ...").
// Output: { title, published, body } with only real prose paragraphs.
'use strict'

const BAD_START = /^(_Magazine:|Magazine:|!\[|\[!|Get more of|Add Cointelegraph|Subscribe|Copy link|Copied to|Written by|Reviewed by|Related|More reading|Go to top|©|All rights reserved|Editorial Policy|Financial Risk|Ads Disclosure|Latest News|Published |#|\*|>|_)/
const TICKER_RUN = /^(?:[A-Z]{2,7}\$[0-9][0-9,.]*\s*[0-9.]+%?\s*){1,}$/

function extractArticle(raw) {
  const title = (raw.match(/^Title:\s*(.+)$/m) || [])[1]?.trim() || null
  const published = (raw.match(/^Published Time:\s*(.+)$/m) || [])[1]?.trim() || null
  let md = raw.split('Markdown Content:')[1] || raw
  const h1 = md.search(/^#\s+/m)
  if (h1 > -1) md = md.slice(h1)
  const out = []
  for (let block of md.split(/\n\s*\n/)) {
    block = block
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (!block) continue
    if (/^Cointelegraph is committed/i.test(block)) break
    if (BAD_START.test(block)) continue
    if (TICKER_RUN.test(block)) continue
    if (block.length < 60) continue
    out.push(block)
  }
  return { title, published, body: out.join('\n\n').slice(0, 12000) }
}

module.exports = { extractArticle }
