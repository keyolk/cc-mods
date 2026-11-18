// Type checking is `tsc -p .`; eslint adds the checks tsc does not make.
// Each rule here had no violation when it was turned on (or each one was fixed
// in the same change), so a new error is always new code. An agent copies what
// the code base already does, so a pattern let in once spreads.
// - no-empty: an empty `catch {}` swallows an error with no word on why. A
//   best-effort catch is fine; it says so in a comment inside the block.
// - eqeqeq: `==` coerces; `x == null` (null or undefined) stays allowed.
// - the rest catch slips that type checking lets through.
import tsParser from '@typescript-eslint/parser'

export default [
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-empty': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-fallthrough': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-dupe-else-if': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-cond-assign': 'error',
    },
  },
]
