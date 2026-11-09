// Lets `bun test` run the pure-library tests while `claude plugin test` is
// unavailable (it refuses to run when the hooks-modules rollout switch is
// cached off). Only `claude-code/testing` is aliased, to bun's own runner,
// which has the same test/expect surface the library tests use.
import { plugin } from 'bun'
import * as bunTest from 'bun:test'

// An engine test takes the engine's `$` and `on` (tests/mod.test.ts); bun has
// no engine to hand it, so it is reported skipped instead of failing on `on`.
// It may carry engine options first: test(name, { options }, ($, on) => ...).
const engineAware = Object.assign((name: string, ...args: any[]) => {
  const fn = args.find((a) => typeof a === 'function')
  return fn && (fn.length > 0 || typeof args[0] !== 'function') ? bunTest.test.skip(name, fn) : (bunTest.test as any)(name, ...args)
}, bunTest.test)

plugin({
  name: 'claude-code-testing-shim',
  setup(build) {
    build.module('claude-code/testing', () => ({ exports: { ...bunTest, test: engineAware }, loader: 'object' }))
  },
})
