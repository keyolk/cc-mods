// coord_route's rules (hooks/lib/coordroute.ts): the candidates the router
// reads, and what of its answer is let through. No model is called.
import { expect, test } from 'claude-code/testing'

import { emptyLedger, type Ledger, type Limits, type PaneSeen, type Worker } from '../hooks/lib/coord'
import { candidates, checkRoute, parsePrompts, parseRoute, routeRequest, routeText, type Candidate } from '../hooks/lib/coordroute'

const NOW = 1_800_000_000_000
const LIMITS: Limits = { models: ['haiku', 'sonnet'], maxEffort: 'high', maxWorkers: 2, autoAdopt: true }
const ledger = (workers: Worker[] = []): Ledger => ({ ...emptyLedger('coord', 'cc-mods-d9', NOW), on: true, limits: LIMITS, workers })
const pane = (over: Partial<PaneSeen>): PaneSeen => ({ pane: '%1', window: '@1', sid: 's', state: 'done', attention: 'none', cwd: '/src/x', ...over })
const worker = (over: Partial<Worker>): Worker => ({ slug: 'w', sid: 'w1', relation: 'owned', cwd: '/w/x', at: NOW - 600_000, ...over })

test('coord_route: candidates are every live session but the coordinator, once each, with relation, repository and recent prompts', () => {
  const seen = [
    pane({ sid: 'coord', pane: '%0', cwd: '/src/cc-mods' }),
    pane({ sid: 'w1', pane: '%2', state: 'working', cwd: '/h/worktrees/cc-mods/fix' }),
    pane({ sid: 'w1', pane: '%2', state: 'working', cwd: '/h/worktrees/cc-mods/fix' }),
    pane({ sid: 'o1', pane: '%3', cwd: '/src/tmc' }),
    pane({ sid: 'h1', pane: '%4', cwd: '/src/briefs' }),
  ]
  const l = ledger([worker({ slug: 'fix', sid: 'w1', cwd: '/h/worktrees/cc-mods/fix' }), worker({ slug: 'held', sid: 'h1', relation: 'adopted', typedAt: NOW - 1000 }), worker({ slug: 'old', sid: 'o1', endedAt: NOW - 5000 })])
  const names = new Map([['w1', 'fix'], ['o1', 'tmc-main']])
  const info = { titles: new Map([['o1', ' layout work ']]), prompts: new Map([['o1', ['fix the layout']]]), repos: new Map([['/h/worktrees/cc-mods/fix', '/src/cc-mods']]) }
  const cs = candidates(seen, l, names, info, NOW)
  expect(cs.map((c) => c.name)).toEqual(['fix', 'tmc-main', 'h1'])
  expect(cs[0]).toMatchObject({ slug: 'fix', relation: 'owned', state: 'working', repo: '/src/cc-mods', typed: false, prompts: [] })
  // An ended worker is observed again; a person typing in a worker holds it.
  expect(cs[1]).toMatchObject({ relation: 'observed', title: 'layout work', prompts: ['fix the layout'] })
  expect(cs[1]!.slug).toBeUndefined()
  expect(cs[2]).toMatchObject({ slug: 'held', relation: 'adopted', typed: true })
  // The model is told the limits and how many workers already run.
  const r = routeRequest('fix X', cs, LIMITS, 1)
  expect(JSON.parse(r.prompt).limits).toEqual({ models: ['haiku', 'sonnet'], maxEffort: 'high', maxWorkers: 2, ownedWorkers: 1 })
  expect(r.system).toContain('Never "send" to an observed session')
})

test('coord_route: recent prompts from the transcript scan, the newest three, harness tags dropped', () => {
  const rows = ['a', 'b', 'c', 'd'].map((t) => JSON.stringify(['s1', t]))
  const out = [...rows, JSON.stringify(['s1', '<task-notification>x</task-notification>']), JSON.stringify(['s2', '  two\n lines ']), 'not json', JSON.stringify(['s3', 'x'.repeat(300)])].join('\n')
  const m = parsePrompts(out)
  expect(m.get('s1')).toEqual(['b', 'c', 'd'])
  expect(m.get('s2')).toEqual(['two lines'])
  expect(m.get('s3')![0]!.length).toBe(201)
})

test('coord_route: the reply must be one JSON object; a fence or prose around it is cut away', () => {
  expect(parseRoute('```json\n{"action":"unsure","reason":"r"}\n```')).toEqual({ action: 'unsure', reason: 'r' })
  expect(parseRoute('Here: {"action":"spawn"} done')).toEqual({ action: 'spawn' })
  expect(parseRoute('send it to fix')).toHaveProperty('error')
  expect(parseRoute('{"action": oops}')).toHaveProperty('error')
  expect(parseRoute('{"a":1} or {"b":2}')).toHaveProperty('error')
})

const C = (over: Partial<Candidate>): Candidate => ({ name: 'n', relation: 'observed', pane: '%9', state: 'done', attention: 'none', typed: false, cwd: '/src/x', prompts: [], ...over })
const CANDS = [C({ name: 'fix', slug: 'fix', relation: 'owned', pane: '%2', state: 'working' }), C({ name: 'tmc-main', pane: '%3' }), C({ name: 'h', slug: 'held', relation: 'adopted', typed: true })]

test('coord_route: send and adopt name a live session of the right relation; one the person typed in lately is still sent to', () => {
  const ok = checkRoute({ action: 'send', target: 'fix', reason: 'same repo' }, CANDS, LIMITS, 1, {})
  expect(ok).toMatchObject({ action: 'send', reason: 'same repo' })
  const text = routeText(ok as any)
  expect(text).toContain('coord_send slug=fix')
  expect(text).toContain('mid-turn')
  expect((checkRoute({ action: 'send', target: 'tmc-main', reason: 'r' }, CANDS, LIMITS, 1, {}) as any).error).toContain('observed')
  expect(routeText(checkRoute({ action: 'adopt', target: '%3', reason: 'r' }, CANDS, LIMITS, 1, {}) as any)).toContain('/coord adopt %3')
  expect((checkRoute({ action: 'adopt', target: 'fix', reason: 'r' }, CANDS, LIMITS, 1, {}) as any).error).toContain('already owned')
  expect(checkRoute({ action: 'send', target: 'held', reason: 'r' }, CANDS, LIMITS, 1, {})).toMatchObject({ action: 'send', target: { slug: 'held' } })
  expect(routeRequest('x', CANDS, LIMITS, 1).system).toContain('"typed": true (the person prompted it lately) does not stop a send')
  expect((checkRoute({ action: 'send', target: 'ghost', reason: 'r' }, CANDS, LIMITS, 1, {}) as any).error).toContain('no live session')
  expect((checkRoute({ action: 'send', target: 'fix' }, CANDS, LIMITS, 1, {}) as any).error).toContain('no reason')
  expect((checkRoute({ action: 'delegate', reason: 'r' }, CANDS, LIMITS, 1, {}) as any).error).toContain('expected send')
})

test('coord_route: spawn needs a real checkout or directory, and a model and effort within the limits', () => {
  const spawn = { action: 'spawn', repo_dir: '~/src/tmc', model: 'claude-haiku-4-5', effort: 'low', reason: 'nobody there' }
  const ok = checkRoute(spawn, CANDS, LIMITS, 1, { repoTop: '/h/src/tmc' })
  expect(ok).toEqual({ action: 'spawn', repoDir: '/h/src/tmc', model: 'haiku', effort: 'low', reason: 'nobody there' })
  expect(routeText(ok as any)).toContain('coord_spawn repo_dir=/h/src/tmc model=haiku effort=low')
  expect((checkRoute(spawn, CANDS, LIMITS, 1, { repoTop: null }) as any).error).toContain('not a git checkout')
  expect((checkRoute({ ...spawn, repo_dir: undefined, cwd: '/nope' }, CANDS, LIMITS, 1, { cwdOk: false }) as any).error).toContain('not a directory')
  expect(checkRoute({ ...spawn, repo_dir: undefined, cwd: '/tmp/x' }, CANDS, LIMITS, 1, { cwdOk: true })).toMatchObject({ cwd: '/tmp/x' })
  expect((checkRoute({ ...spawn, repo_dir: undefined }, CANDS, LIMITS, 1, {}) as any).error).toContain('without repo_dir or cwd')
  expect((checkRoute({ ...spawn, model: 'opus' }, CANDS, LIMITS, 1, { repoTop: '/t' }) as any).error).toContain('allowed: haiku, sonnet')
  expect((checkRoute({ ...spawn, model: undefined }, CANDS, LIMITS, 1, { repoTop: '/t' }) as any).error).toContain('model')
  expect((checkRoute({ ...spawn, effort: 'max' }, CANDS, LIMITS, 1, { repoTop: '/t' }) as any).error).toContain('above the limit high')
  expect((checkRoute({ ...spawn, effort: 'turbo' }, CANDS, LIMITS, 1, { repoTop: '/t' }) as any).error).toContain('one of')
  expect((checkRoute(spawn, CANDS, LIMITS, 2, { repoTop: '/t' }) as any).error).toContain('the limit 2')
})

test('coord_route: unsure is an answer, telling the coordinator to spawn in the likeliest repository, never to ask the person', () => {
  const d = checkRoute({ action: 'unsure', reason: 'which repo?' }, CANDS, LIMITS, 0, {})
  const t = routeText(d as any)
  expect(t).toContain('do not ask the person')
  expect(t).toContain('coord_spawn in the most plausible repository')
  expect(t).toContain('in one line where it went and why')
  expect(routeRequest('x', CANDS, LIMITS, 0).system).toContain('name in it the most plausible repository')
})

test('coord_route: an auto-adopted session is a send target, marked auto; the owned count leaves adopted ones out', () => {
  const l = ledger([worker({ slug: 'ops-k8s', sid: 'ops', relation: 'adopted', auto: true }), worker({ slug: 'a', sid: 'a1' }), worker({ slug: 'b', sid: 'b1', relation: 'adopted' })])
  const seen = [pane({ sid: 'ops', pane: '%9', cwd: '/src/ops-k8s' }), pane({ sid: 'a1', pane: '%2' }), pane({ sid: 'b1', pane: '%3' })]
  const cs = candidates(seen, l, new Map([['ops', 'ops-k8s']]), { titles: new Map(), prompts: new Map(), repos: new Map() }, NOW)
  expect(cs[0]).toMatchObject({ slug: 'ops-k8s', relation: 'adopted', auto: true })
  expect(cs[2]!.auto).toBeUndefined()
  const d = checkRoute({ action: 'send', target: 'ops-k8s', reason: 'it works in ops-k8s' }, cs, LIMITS, 1, {})
  expect(d).toMatchObject({ action: 'send', target: { slug: 'ops-k8s' } })
  expect(checkRoute({ action: 'adopt', target: 'ops-k8s', reason: 'r' }, cs, LIMITS, 1, {})).toEqual({ error: expect.stringContaining('already adopted') })
  // Two adopted plus one owned under maxWorkers 2: spawn is still open.
  expect(checkRoute({ action: 'spawn', cwd: '/src/x', model: 'haiku', effort: 'low', reason: 'r' }, cs, LIMITS, 1, { cwdOk: true })).toMatchObject({ action: 'spawn' })
  const ask = routeRequest('fix the ops alert', cs, LIMITS, 1)
  expect(ask.system).toContain('"auto": true is a session the person runs themselves')
  expect(ask.system).toContain('Adopted sessions never count toward maxWorkers')
  expect(JSON.parse(ask.prompt).sessions[0].auto).toBe(true)
})
