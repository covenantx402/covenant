// kit/eslint.config.js — flat config (ESLint 9+) for the TypeScript kit.
// tsc already catches type errors; this layer is for lint-only correctness
// (unused vars, floating promises, etc.), not a style rewrite.
const js = require('@eslint/js')
const tseslint = require('typescript-eslint')

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // tsc's noUnusedParameters/noUnusedLocals already cover unused vars
      // with more context (and respect intentional `_name` conventions) —
      // don't duplicate that check with a less-informed lint rule.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    ignores: ['dist/', 'node_modules/'],
  },
)
