// Minimal flat config so the editor-side lint hook has something to run.
// Type checking is `tsc -p .`; this only parses TS and flags obvious mistakes.
import tsParser from '@typescript-eslint/parser'

export default [
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    rules: {},
  },
]
