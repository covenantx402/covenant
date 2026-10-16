#!/usr/bin/env node
// test/unit/run-all.js — runs every *.test.js file in this directory as a
// separate child process (isolated DB/env per file, same pattern as
// test/smoke.js) and fails loud on the first failure.
'use strict'
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const dir = __dirname
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort()

if (files.length === 0) {
  console.error('no *.test.js files found in test/unit/')
  process.exit(1)
}

console.log(`\n== running ${files.length} unit test file(s) ==`)
let failed = false
for (const f of files) {
  console.log(`\n-- ${f} --`)
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' })
  } catch (_e) {
    failed = true
    console.error(`\nFAILED: ${f}`)
  }
}

if (failed) {
  console.error('\nUNIT TESTS FAILED')
  process.exit(1)
}
console.log('\nALL UNIT TESTS PASSED')
