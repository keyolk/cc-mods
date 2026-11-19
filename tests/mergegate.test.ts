// lib/mergegate.ts: the coordinator merge rule as a pre-merge check.
import { expect, test } from 'claude-code/testing'

import { compareArgv, ghLogins, mergeDeny, mergeProblems, mergeQuery, parseMerge, parseMergeFacts, readMergeFacts, readOrder, validRepo, type MergeFacts } from '../hooks/lib/mergegate'

const M = 'gh pr ' + 'merge'
const HEAD = 'abc1234def5678900000000000000000000000ff'

const ok: MergeFacts = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', head: HEAD, base: 'main', unresolved: 0, checks: 'pass', failing: [], advisory: [], requiredOnly: false }

// A PR read whose rollup holds the given check runs.
const read = (nodes: object[], rollup = 'FAILURE') => JSON.stringify({ data: { repository: { pullRequest: {
  state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headRefOid: HEAD, baseRefName: 'main', reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: rollup, contexts: { nodes } } } }] },
} } } })
const run = (name: string, conclusion: string | null, isRequired: boolean, status = 'COMPLETED') => ({ name, status, conclusion, isRequired })

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
  expect(mergeProblems(call, { ...ok, checks: 'fail', failing: ['test'], requiredOnly: true }, 0)).toEqual(['a required check failed on the head: test'])
  expect(mergeProblems(call, { ...ok, checks: 'pending' }, 0)).toEqual(['CI is still running on the head'])
  expect(mergeProblems(call, { ...ok, unresolved: 2 }, 0)).toEqual(['2 unresolved review threads'])
  expect(mergeProblems(call, { ...ok, mergeable: 'CONFLICTING' }, 0)).toEqual(['the head conflicts with main'])
  expect(mergeProblems(call, ok, 3)[0]).toContain('lacks 3 commits of main')
  expect(mergeProblems(call, ok, undefined)[0]).toContain('compare failed')
  expect(mergeProblems(call, { ...ok, isDraft: true }, 0)).toEqual(['the PR is a draft'])
  expect(mergeProblems(call, { ...ok, state: 'MERGED' }, 0)).toEqual(['the PR is merged, not open'])
})

test('only required checks refuse a merge; a failing optional check is advisory', () => {
  const call = { repo: 'o/n', number: 1, matchHead: 'abc1234', admin: false }
  // sendbird/context: Gordon fails repo-wide and is not required.
  const optional = parseMergeFacts(read([run('test', 'SUCCESS', true), run('Gordon', 'FAILURE', false)]))!
  expect(optional.checks).toBe('pass')
  expect(optional.advisory).toEqual(['Gordon'])
  expect(mergeProblems(call, optional, 0)).toEqual([])
  // A required check that failed refuses, naming only it.
  const failed = parseMergeFacts(read([run('test', 'FAILURE', true), run('SOC2', 'FAILURE', false)]))!
  expect(mergeProblems(call, failed, 0)).toEqual(['a required check failed on the head: test'])
  expect(mergeDeny(call, mergeProblems(call, failed, 0), failed.advisory)).toContain('Not required, so not a reason (failed): SOC2')
  // A required check still running refuses.
  const running = parseMergeFacts(read([run('test', null, true, 'IN_PROGRESS'), run('lint', 'SUCCESS', false)], 'PENDING'))!
  expect(mergeProblems(call, running, 0)).toEqual(['a required check is still running on the head'])
})

test('a repo that requires no check: a failure is advisory, a running check still holds the merge', () => {
  const call = { repo: 'o/n', number: 1, matchHead: 'abc1234', admin: false }
  // sendbird/context#31: nothing required, Gordon failed, the rest passed.
  const f = parseMergeFacts(read([run('check', 'SUCCESS', false), run('Gordon', 'FAILURE', false)]))!
  expect(f.checks).toBe('pass')
  expect(f.advisory).toEqual(['Gordon'])
  expect(mergeProblems(call, f, 0)).toEqual([])
  const running = parseMergeFacts(read([run('check', null, false, 'IN_PROGRESS'), run('Gordon', 'FAILURE', false)], 'PENDING'))!
  expect(mergeProblems(call, running, 0)).toEqual(['CI is still running on the head'])
  // Only the rollup is known (no contexts): its FAILURE still refuses.
  expect(parseMergeFacts(read([], 'FAILURE'))!.checks).toBe('fail')
  // keyolk/cc-mods: no checks at all.
  expect(parseMergeFacts(read([], ''))!.checks).toBe('none')
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
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: true }] } } } }] },
  } } } })
  expect(parseMergeFacts(json)).toEqual({ ...ok, unresolved: 1, checks: 'fail', failing: ['test'], requiredOnly: true })
  expect(mergeQuery({ repo: 'o/n', number: 5 })).toContain('isRequired(pullRequestNumber: 5)')
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

test('validRepo refuses an unexpanded shell variable', () => {
  expect(validRepo('sendbird/soda-k8s')).toBe(true)
  expect(validRepo('$R')).toBe(false)
  expect(validRepo('$OWNER/$NAME')).toBe(false)
  expect(validRepo('')).toBe(false)
})

test('ghLogins lists every login gh status shows, once', () => {
  const st = 'github.com\n  ✓ Logged in to github.com account keyolk (keyring)\n  - Active account: true\n\n  ✓ Logged in to github.com account gavin-jeong (keyring)\n  - Active account: false\n'
  expect(ghLogins(st)).toEqual(['keyolk', 'gavin-jeong'])
  expect(ghLogins('You are not logged in')).toEqual([])
})

test('readOrder puts the mapped login first and drops repeats and blanks', () => {
  expect(readOrder([undefined, 'gavin-jeong'], ['keyolk', 'gavin-jeong'])).toEqual(['gavin-jeong', 'keyolk'])
  expect(readOrder([undefined, undefined], [])).toEqual([])
})

test('readMergeFacts falls through to the login that can read the repo', async () => {
  // The active login (keyolk) cannot see sendbird/soda-k8s: GitHub answers
  // "Could not resolve to a Repository", as live. The other login reads it.
  const seen: (string | undefined)[] = []
  const fake = async (account: string | undefined) => {
    seen.push(account)
    return account === 'gavin-jeong'
      ? { exitCode: 0, stdout: read([run('test', 'SUCCESS', true)], 'SUCCESS'), stderr: '' }
      : { exitCode: 1, stdout: '', stderr: "gh: Could not resolve to a Repository with the name 'sendbird/soda-k8s'." }
  }
  const r = await readMergeFacts(fake, { repo: 'sendbird/soda-k8s', number: 12999 }, ['keyolk', 'gavin-jeong'])
  expect(r.account).toBe('gavin-jeong')
  expect(r.facts?.head).toBe(HEAD)
  expect(seen).toEqual(['keyolk', 'gavin-jeong'])
  expect(r.errors).toHaveLength(1)
  expect(r.errors[0]).toContain('Could not resolve')
})

test('readMergeFacts names every login that failed, and reads once as the active login when none is known', async () => {
  const fail = async () => ({ exitCode: 1, stdout: '', stderr: 'nope' })
  const r = await readMergeFacts(fail, { repo: 'o/n', number: 1 }, ['a', 'b'])
  expect(r.facts).toBeUndefined()
  expect(r.errors.map((e) => e.split(':')[0])).toEqual(['a', 'b'])
  const calls: (string | undefined)[] = []
  await readMergeFacts(async (a) => (calls.push(a), { exitCode: 1, stdout: '', stderr: '' }), { repo: 'o/n', number: 1 }, [])
  expect(calls).toEqual([undefined])
})
