// lib/mergegate.ts: the coordinator merge rule as a pre-merge check.
import { expect, test } from 'claude-code/testing'

import { compareArgv, mergeDeny, mergeProblems, mergeQuery, parseMerge, parseMergeFacts, type MergeFacts } from '../hooks/lib/mergegate'

const M = 'gh pr ' + 'merge'
const HEAD = 'abc1234def5678900000000000000000000000ff'

const ok: MergeFacts = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', head: HEAD, base: 'main', unresolved: 0, checks: 'pass', failing: [] }

test('parseMerge reads the PR, repo, READY sha and --admin', () => {
  expect(parseMerge(M + ' 149 -R keyolk/cc-mods --squash --match-head-commit abc1234', undefined)).toEqual({ repo: 'keyolk/cc-mods', number: 149, matchHead: 'abc1234', admin: false })
  expect(parseMerge(M + ' https://github.com/acme/infra-k8s/pull/7 --match-head-commit=abc1234 --admin', 'x/y')).toEqual({ repo: 'acme/infra-k8s', number: 7, matchHead: 'abc1234', admin: true })
  expect(parseMerge('GH_TOKEN="$(gh auth token --user keyolk)" ' + M + ' 12 --squash', 'keyolk/cc-mods')).toEqual({ repo: 'keyolk/cc-mods', number: 12, matchHead: undefined, admin: false })
  expect(parseMerge('cd /tmp && ' + M + ' 3 --repo=o/n --match-head-commit "abc1234"', undefined)?.matchHead).toBe('abc1234')
  // The current branch's PR: no number, so the caller asks for it.
  expect(parseMerge(M + ' --squash', 'o/n')?.number).toBe(0)
})

test('parseMerge ignores text that only mentions a merge', () => {
  expect(parseMerge('grep -n "' + M + ' 12" notes.md', 'o/n')).toBeUndefined()
  expect(parseMerge('gh pr view 12 --json mergeable', 'o/n')).toBeUndefined()
  expect(parseMerge("git commit -m 'run " + M + " 3 later'", 'o/n')).toBeUndefined()
})

test('a clean PR at the READY sha passes', () => {
  expect(mergeProblems({ repo: 'o/n', number: 1, matchHead: 'abc1234', admin: false }, ok, 0)).toEqual([])
})

test('each clause of the rule refuses on its own', () => {
  const call = { repo: 'o/n', number: 1, matchHead: 'abc1234', admin: false }
  expect(mergeProblems({ ...call, matchHead: undefined }, ok, 0)[0]).toContain('no --match-head-commit')
  expect(mergeProblems({ ...call, matchHead: 'fff9999' }, ok, 0)[0]).toContain('is not the head')
  expect(mergeProblems({ ...call, matchHead: 'abc' }, ok, 0)[0]).toContain('is not the head') // too short to name a commit
  expect(mergeProblems(call, { ...ok, checks: 'fail', failing: ['test'] }, 0)).toEqual(['CI failed on the head: test'])
  expect(mergeProblems(call, { ...ok, checks: 'pending' }, 0)).toEqual(['CI is still running on the head'])
  expect(mergeProblems(call, { ...ok, unresolved: 2 }, 0)).toEqual(['2 unresolved review threads'])
  expect(mergeProblems(call, { ...ok, mergeable: 'CONFLICTING' }, 0)).toEqual(['the head conflicts with main'])
  expect(mergeProblems(call, ok, 3)[0]).toContain('lacks 3 commits of main')
  expect(mergeProblems(call, ok, undefined)[0]).toContain('compare failed')
  expect(mergeProblems(call, { ...ok, isDraft: true }, 0)).toEqual(['the PR is a draft'])
  expect(mergeProblems(call, { ...ok, state: 'MERGED' }, 0)).toEqual(['the PR is merged, not open'])
})

test('--admin skips CI, threads and up-to-date but not the head match', () => {
  const admin = { repo: 'o/n', number: 1, matchHead: 'abc1234', admin: true }
  expect(mergeProblems(admin, { ...ok, checks: 'fail', unresolved: 4 }, undefined)).toEqual([])
  expect(mergeProblems({ ...admin, matchHead: undefined }, ok, undefined)[0]).toContain('no --match-head-commit')
})

test('the PR read parses into facts, with the check verdict from prs.ts', () => {
  const json = JSON.stringify({ data: { repository: { pullRequest: {
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD, baseRefName: 'main',
    reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] } } } }] },
  } } } })
  expect(parseMergeFacts(json)).toEqual({ ...ok, unresolved: 1, checks: 'fail', failing: ['test'] })
  expect(parseMergeFacts('{"data":{"repository":{"pullRequest":null}}}')).toBeUndefined()
  expect(parseMergeFacts('not json')).toBeUndefined()
})

test('the query, compare argv and deny text name the PR', () => {
  expect(mergeQuery({ repo: 'o/n', number: 5 })).toContain('pullRequest(number: 5)')
  expect(compareArgv('o/n', 'main', HEAD)).toEqual(['api', 'repos/o/n/compare/main...' + HEAD, '--jq', '.behind_by'])
  const d = mergeDeny({ repo: 'o/n', number: 5, admin: false }, ['CI is still running on the head'])
  expect(d).toContain('o/n#5')
  expect(d).toContain('  - CI is still running on the head')
})
