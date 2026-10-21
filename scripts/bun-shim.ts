// Lets `bun test` run the pure-library tests while `claude plugin test` is
// unavailable (it refuses to run when the hooks-modules rollout switch is
// cached off). Only `claude-code/testing` is aliased, to bun's own runner,
// which has the same test/expect surface the library tests use.
import { plugin } from 'bun'
import * as bunTest from 'bun:test'

plugin({
  name: 'claude-code-testing-shim',
  setup(build) {
    build.module('claude-code/testing', () => ({ exports: { ...bunTest }, loader: 'object' }))
  },
})
