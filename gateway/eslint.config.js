// gateway/eslint.config.js — flat config (ESLint 9+).
//
// Scope: catch real bugs (unused vars, undefined refs, unreachable code),
// NOT impose a style rewrite on ~4000 lines of working, tested code. No
// "format everything" ruleset — that's a separate, much bigger PR with its
// own review, not something to sneak in under "add a linter".
const js = require('@eslint/js')

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortSignal: 'readonly',
        Promise: 'readonly',
      },
    },
    rules: {
      // Catch real mistakes, don't fight the existing style.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-fallthrough': 'error',
      'no-dupe-keys': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // `let x = null` immediately before a try/catch that may reassign it
      // is a deliberate "declare the shape, fill it in below" pattern used
      // throughout this codebase (payload/fetchErr/latencyMs triples) — not
      // a bug. Downgraded to warn so it's visible without blocking CI.
      'no-useless-assignment': 'warn',
      // This codebase intentionally uses var-free, semicolon-free style in
      // most files — don't force either on. Only block things that are
      // actual correctness hazards.
      'no-var': 'off',
      'no-console': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'data/', '*.db', '*.db-*'],
  },
]
