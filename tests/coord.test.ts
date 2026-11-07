// Coordinator mode's rules (hooks/lib/coord.ts): no engine, just functions.
import { expect, test } from 'claude-code/testing'

import { COORD_CAPS, HOLD_MS, WORKER_CAPS, coordSection, mergeRepos, policyArgvs, policyOf, emptyLedger, held, observe, overlaps, parseLedger, parseLimits, parsePanes, spawnRefusal, workerArgv, workerPrompt, type Ledger, type Worker } from '../hooks/lib/coord'

const NOW = 1_800_000_000_000
const on = (over: Partial<Ledger> = {}): Ledger => ({ ...emptyLedger('coord-sid', 'cc-mods-d9', NOW), on: true, ...over })
const worker = (over: Partial<Worker> = {}): Worker => ({ slug: 'tmc-layout', sid: 'w1', relation: 'owned', cwd: '/w/tmc-layout', at: NOW - 120_000, state: 'working', attention: 'none', ...over })
const req = { slug: 'tmc-layout', model: 'sonnet', effort: 'medium', brief: 'do it', repoDir: '/src/tmc' }

test('coord: nothing starts while the mode is off, or beyond the limits', () => {
  expect(spawnRefusal(emptyLedger('s', 'n', NOW), req)).toContain('/coord on')
  expect(spawnRefusal(on(), req)).toBeUndefined()
  expect(spawnRefusal(on(), { ...req, slug: 'Bad Slug' })).toContain('slug')
  expect(spawnRefusal(on(), { ...req, effort: 'max' })).toContain('above the limit high')
  expect(spawnRefusal(on({ limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 4 } }), { ...req, model: 'opus' })).toContain('not allowed')
  // A full model id counts as its alias.
  expect(spawnRefusal(on(), { ...req, model: 'claude-opus-5-5' })).toBeUndefined()
  const full = on({ limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 1 }, workers: [worker({ slug: 'other' })] })
  expect(spawnRefusal(full, req)).toContain('already 1 workers')
  // An adopted session does not take a worker slot; an ended one frees it.
  expect(spawnRefusal({ ...full, workers: [worker({ slug: 'other', relation: 'adopted' })] }, req)).toBeUndefined()
  expect(spawnRefusal({ ...full, workers: [worker({ slug: 'other', endedAt: NOW })] }, req)).toBeUndefined()
  expect(spawnRefusal(on({ workers: [worker()] }), req)).toContain('already in the ledger')
  expect(spawnRefusal(on(), { ...req, repoDir: undefined })).toContain('repo_dir')
})

test('coord: the worker runs claude with its model, effort and session id, the brief read from its file', () => {
  const argv = workerArgv({ target: 'main:', slug: 'tmc-layout', cwd: '/w/tmc-layout', model: 'claude-sonnet-5-5', effort: 'medium', sid: 'u-1', promptFile: '/r/prompt.txt' })
  expect(argv.slice(0, 12)).toEqual(['new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', 'main:', '-n', 'w:tmc-layout', '-c', '/w/tmc-layout', 'sh'])
  expect(argv[13]).toContain('--disallowedTools AskUserQuestion')
  expect(argv[13]).toContain('--session-id "$3"')
  expect(argv.slice(14)).toEqual(['worker', 'sonnet', 'medium', 'u-1', 'tmc-layout', '/r/prompt.txt'])
  const p = workerPrompt('  fix it  ', 'cc-mods-d9', 'tmc-layout')
  expect(p.startsWith('fix it\n')).toBe(true)
  expect(p).toContain('SendMessage (to: "cc-mods-d9")')
  expect(p).toContain('READY <sha>')
})

test('coord: the watch wakes the coordinator for a question, an exit and the person taking over', () => {
  const l = on({ workers: [worker(), worker({ slug: 'b', sid: 'w2' }), worker({ slug: 'c', sid: 'w3' }), worker({ slug: 'fresh', sid: 'w4', at: NOW - 5_000 })] })
  const seen = parsePanes(['%1\t@1\tw1\tworking\task\t/w/tmc-layout\t', '%2\t@2\tw2\tdone\tnone\t/w/b\t' + Math.floor((NOW - 1000) / 1000), ''].join('\n'))
  const { ledger, changes } = observe(l, seen, NOW)
  expect(changes.map((c) => c.slug)).toEqual(['tmc-layout', 'b', 'b', 'c'])
  expect(changes[0]!.text).toContain('waiting on an answer')
  expect(changes[1]!.text).toContain('the person is typing')
  expect(changes[2]!.text).toContain('finished its turn')
  expect(changes[3]!.text).toContain('gone')
  // Just started and not yet published: not counted gone.
  expect(ledger.workers.find((w) => w.slug === 'fresh')!.endedAt).toBeUndefined()
  expect(ledger.workers.find((w) => w.slug === 'c')!.endedAt).toBe(NOW)
  const b = ledger.workers.find((w) => w.slug === 'b')!
  expect(held(b, NOW)).toBe(true)
  expect(held(b, NOW + HOLD_MS)).toBe(false)
  // Seen again unchanged: nothing new to say.
  expect(observe(ledger, seen, NOW + 10_000).changes).toEqual([])
})

test('coord: sessions already in a directory or the repository around it are found', () => {
  const seen = parsePanes(['%1\t@1\ts1\tdone\tnone\t/src/tmc', '%2\t@2\ts2\tdone\tnone\t/src/tmc/crates', '%3\t@3\ts3\tdone\tnone\t/src/tmcx', '%4\t@4\tcoord-sid\tdone\tnone\t/src/tmc'].join('\n'))
  expect(overlaps(seen, on(), '/src/tmc/').map((s) => s.sid)).toEqual(['s1', 's2'])
})

test('coord: a ledger from disk keeps sane limits; the prompt names the workers', () => {
  const l = parseLedger(JSON.stringify({ on: true, limits: { models: [], maxEffort: 'turbo', maxWorkers: -1 }, workers: [{ slug: 'a', sid: 'x', relation: 'owned', cwd: '/a', at: 1 }, { nope: 1 }] }), 'sid', 'n', NOW)
  expect(l.limits).toEqual({ models: ['haiku', 'sonnet', 'opus'], maxEffort: 'high', maxWorkers: 4 })
  expect(l.workers.length).toBe(1)
  expect(parseLedger('{oops', 'sid', 'n', NOW).on).toBe(false)
  const text = coordSection(l, NOW)
  expect(text).toContain('`n`, the coordinator')
  expect(text).toContain('| a | owned |')
})

test('coord: /coord limits', () => {
  const cur = on().limits
  expect(parseLimits('models opus,claude-sonnet-5-5', cur)).toEqual({ ...cur, models: ['opus', 'sonnet'] })
  expect(parseLimits('models gpt', cur)).toContain('comma list')
  expect(parseLimits('effort xhigh', cur)).toEqual({ ...cur, maxEffort: 'xhigh' })
  expect(parseLimits('workers 99', cur)).toContain('1 to 12')
  expect(parseLimits('', cur)).toContain('limits:')
})

test('coord: the brief, the worker\'s first prompt, does not count as the person typing', () => {
  const l = on({ workers: [worker({ at: NOW - 30_000 })] })
  const seen = parsePanes('%1\t@1\tw1\tworking\tnone\t/w/tmc-layout\t' + Math.floor((NOW - 29_000) / 1000))
  expect(observe(l, seen, NOW).changes).toEqual([])
  const later = parsePanes('%1\t@1\tw1\tworking\tnone\t/w/tmc-layout\t' + Math.floor((NOW + 60_000) / 1000))
  expect(observe(l, later, NOW + 61_000).changes.map((c) => c.text)[0]).toContain('the person is typing')
})

test('coord: a turn that ended between two ticks still wakes the coordinator', () => {
  // Live: the ledger went from no state straight to waiting; the worker had
  // already sent READY.
  const l = on({ workers: [worker({ state: undefined, at: NOW - 300_000 })] })
  const seen = parsePanes('%1\t@1\tw1\twaiting\tnone\t/w/tmc-layout\t')
  expect(observe(l, seen, NOW).changes.map((c) => c.text)).toEqual(['tmc-layout: finished its turn'])
  // Just started, not yet working: nothing.
  expect(observe(on({ workers: [worker({ state: undefined, at: NOW - 5_000 })] }), seen, NOW).changes).toEqual([])
  // Already idle last time: nothing new.
  expect(observe(on({ workers: [worker({ state: 'done' })] }), seen, NOW).changes).toEqual([])
})

test('coord: the coordinator merges only in its workers\' repositories; a worker does nothing outward', () => {
  expect(policyArgvs(COORD_CAPS, ['keyolk/tmc'])).toEqual([['mode', 'default'], ['block', 'gh_merge'], ['block', 'prod_eks_write'], ['block', 'slack_send'], ['block', 'tmux_window_escape'], ['allow', 'auto_continue'], ['allow', 'gh_merge', '--repo', 'keyolk/tmc']])
  expect(WORKER_CAPS).toMatchObject({ gh_merge: 'block', slack_send: 'block', auto_model: 'block', auto_effort: 'block', auto_continue: 'allow' })
  const l = on({ workers: [worker({ repo: 'keyolk/tmc' }), worker({ slug: 'b', repo: 'keyolk/tmc' }), worker({ slug: 'c', repo: undefined }), worker({ slug: 'd', repo: 'keyolk/tweb', endedAt: NOW })] })
  expect(mergeRepos(l)).toEqual(['keyolk/tmc'])
  const base = { mode: 'custom', caps: { gh_merge: 'allow', prod_eks_access: 'allow', prod_eks_write: 'allow', slack_send: 'allow', tmux_window_escape: 'allow', auto_continue: 'inherit', auto_effort: 'inherit', auto_model: 'inherit' }, explicit: {}, scopes: {} } as any
  const p = policyOf(COORD_CAPS, ['keyolk/tmc'], base)
  expect(p.caps.gh_merge).toBe('block')
  expect(p.caps.prod_eks_access).toBe('allow')
  expect(p.scopes).toEqual({ gh_merge: ['keyolk/tmc'] })
})
