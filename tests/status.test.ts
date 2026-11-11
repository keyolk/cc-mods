// A worker's declared status (hooks/lib/status.ts): what the tool accepts,
// when the turn's end asks for it, which sessions are workers, and how the
// coordinator sees it (observe's wake, the roster, the prompts). No engine.
import { expect, test } from 'claude-code/testing'

import { ASKS, KINDS, SELF_CHECK_MAX, STATES, STATUS_TOOL, parseStatus, parseStatusFile, sameStatus, selfCheckDue, statusLine, workerOf, type Status } from '../hooks/lib/status'
import { STATUS_OLD_MS, STATUS_RULE, coordRoster, coordRules, emptyLedger, observe, parsePanes, statusTail, workerPrompt, type Ledger, type Worker } from '../hooks/lib/coord'

const NOW = 1_800_000_000_000

test('status: the tool takes Rex\'s states and kinds, refuses what it does not know, and caps the text', () => {
  expect(STATUS_TOOL.inputSchema.properties.state.enum).toEqual([...STATES])
  expect(STATUS_TOOL.inputSchema.properties.kind.enum).toEqual([...KINDS])
  const s = parseStatus({ state: 'blocked', kind: 'question', step: '  brief\n대기 ', needs: '~/briefs/x.html', progress: '59.6', extra: 1 }, NOW) as Status
  expect(s).toEqual({ state: 'blocked', kind: 'question', step: 'brief 대기', needs: '~/briefs/x.html', progress: 60, at: NOW })
  // An unknown state is refused, not stored as something else (Rex: never read a new state as idle).
  expect(parseStatus({ state: 'paused' }, NOW)).toContain('state must be')
  expect(parseStatus({}, NOW)).toContain('state must be')
  expect(parseStatus({ state: 'blocked' }, NOW)).toContain('blocked needs a kind')
  expect(parseStatus({ state: 'working', kind: 'wait' }, NOW)).toContain('only with state blocked')
  expect(parseStatus({ state: 'blocked', kind: 'nap' }, NOW)).toContain('kind must be')
  expect(parseStatus({ state: 'working', progress: 140 }, NOW)).toContain('0 to 100')
  const long = parseStatus({ state: 'working', step: 'x'.repeat(200) }, NOW) as Status
  expect(long.step!.length).toBe(60)
  expect(long.step!.endsWith('…')).toBe(true)
  // Empty fields are left out, not stored empty.
  expect(parseStatus({ state: 'done', msg: '  ', kind: '' }, NOW)).toEqual({ state: 'done', at: NOW })
})

test('status: a login wait names its pane, what it asks and the element, and only with blocked:auth', () => {
  expect(STATUS_TOOL.inputSchema.properties.ask.enum).toEqual([...ASKS])
  const otp = parseStatus({ state: 'blocked', kind: 'auth', needs: 'GitHub 2FA', pane: '%601', ask: 'otp', target: '#app_totp', submit: 'button[type=submit]' }, NOW) as Status
  expect(otp).toEqual({ state: 'blocked', kind: 'auth', needs: 'GitHub 2FA', pane: '%601', ask: 'otp', target: '#app_totp', submit: 'button[type=submit]', at: NOW })
  expect(statusLine(otp)).toContain('relay otp %601')
  // submit means something only for a code; device has no element.
  expect(parseStatus({ state: 'blocked', kind: 'auth', pane: '%1', ask: 'click', target: '#go', submit: '#x' }, NOW)).toEqual({ state: 'blocked', kind: 'auth', pane: '%1', ask: 'click', target: '#go', at: NOW })
  expect(parseStatus({ state: 'blocked', kind: 'auth', pane: '%1', ask: 'device', target: '#x' }, NOW)).toEqual({ state: 'blocked', kind: 'auth', pane: '%1', ask: 'device', at: NOW })
  expect(parseStatus({ state: 'blocked', kind: 'question', pane: '%1', ask: 'otp', target: '#x' }, NOW)).toContain('only with state blocked, kind auth')
  expect(parseStatus({ state: 'working', pane: '%1' }, NOW)).toContain('only with state blocked, kind auth')
  expect(parseStatus({ state: 'blocked', kind: 'auth', pane: '601', ask: 'otp', target: '#x' }, NOW)).toContain('tmux pane id')
  expect(parseStatus({ state: 'blocked', kind: 'auth', pane: '%1', ask: 'sms', target: '#x' }, NOW)).toContain('ask must be')
  expect(parseStatus({ state: 'blocked', kind: 'auth', pane: '%1', ask: 'otp' }, NOW)).toContain('needs target')
  // A login wait without them is as before: the office only shows its needs.
  expect(parseStatus({ state: 'blocked', kind: 'auth', needs: 'aws sso login' }, NOW)).toEqual({ state: 'blocked', kind: 'auth', needs: 'aws sso login', at: NOW })
  expect(parseStatusFile(JSON.stringify(otp))).toEqual(otp)
  // The worker is told to declare it and never to ask for the code in a message.
  expect(STATUS_RULE).toContain('ask (otp|click|device)')
  expect(STATUS_RULE).toContain('never ask for the code in a message')
})

test('status: a file is read back as written, and a broken one is none', () => {
  const s = parseStatus({ state: 'done', link: 'https://github.com/keyolk/cc-mods/pull/121', msg: 'merged' }, NOW) as Status
  expect(parseStatusFile(JSON.stringify(s))).toEqual(s)
  expect(parseStatusFile('{')).toBeUndefined()
  expect(parseStatusFile(undefined)).toBeUndefined()
  expect(parseStatusFile('{"state":"paused","at":1}')).toBeUndefined()
})

test('status: one line for the coordinator, with no table pipes in it', () => {
  const s = parseStatus({ state: 'blocked', kind: 'question', step: 'design', progress: 40, needs: 'a|b', next: 'implement' }, NOW) as Status
  expect(statusLine(s)).toBe('blocked:question · design · 40% · needs a/b · next implement')
  expect(sameStatus(s, { ...s })).toBe(true)
  expect(sameStatus(s, { ...s, at: NOW + 1 })).toBe(false)
  expect(sameStatus(undefined, undefined)).toBe(true)
  expect(sameStatus(s, undefined)).toBe(false)
})

test('status: a session is a worker when an on coordinator gave it work; the person\'s own adopted session is not', () => {
  const led = (o: object) => JSON.stringify({ on: true, sid: 'c1', workers: [], ...o })
  expect(workerOf([led({ workers: [{ slug: 'fix', sid: 'w1', relation: 'owned' }] })], 'w1')).toEqual({ coord: 'c1', slug: 'fix' })
  expect(workerOf([led({ workers: [{ slug: 'g', sid: 'w1', relation: 'adopted', auto: true, instructed: NOW }] })], 'w1')).toEqual({ coord: 'c1', slug: 'g' })
  // Adopted but never instructed: the person drives it.
  expect(workerOf([led({ workers: [{ slug: 'g', sid: 'w1', relation: 'adopted', auto: true }] })], 'w1')).toBeUndefined()
  // Ended, a coordinator that is off, the coordinator itself, a broken file.
  expect(workerOf([led({ workers: [{ slug: 'fix', sid: 'w1', relation: 'owned', endedAt: NOW }] })], 'w1')).toBeUndefined()
  expect(workerOf([led({ on: false, workers: [{ slug: 'fix', sid: 'w1', relation: 'owned' }] })], 'w1')).toBeUndefined()
  expect(workerOf([led({ sid: 'w1', workers: [{ slug: 'x', sid: 'w1', relation: 'owned' }] })], 'w1')).toBeUndefined()
  expect(workerOf(['{', led({ workers: [{ slug: 'fix', sid: 'w1', relation: 'owned' }] })], 'w1')?.slug).toBe('fix')
})

test('status: a worker\'s turn without a status call is asked once; the asking turn and a run of them are not', () => {
  const base = { worker: true, toolAt: NOW - 60_000, turnAt: NOW, statusAt: undefined as number | undefined, selfTurn: false, aborted: false, streak: 0 }
  expect(selfCheckDue(base)).toBe(true)
  // Declared in this turn: nothing to ask.
  expect(selfCheckDue({ ...base, statusAt: NOW + 5_000 })).toBe(false)
  // Declared only in an earlier turn: asked.
  expect(selfCheckDue({ ...base, statusAt: NOW - 5_000 })).toBe(true)
  // The self-check's own turn never asks again, nor past the cap.
  expect(selfCheckDue({ ...base, selfTurn: true })).toBe(false)
  expect(selfCheckDue({ ...base, streak: SELF_CHECK_MAX })).toBe(false)
  // Not a worker, aborted by the person, or the tool came only during this turn.
  expect(selfCheckDue({ ...base, worker: false })).toBe(false)
  expect(selfCheckDue({ ...base, aborted: true })).toBe(false)
  expect(selfCheckDue({ ...base, toolAt: undefined })).toBe(false)
  expect(selfCheckDue({ ...base, toolAt: NOW + 1 })).toBe(false)
})

const worker = (over: Partial<Worker> = {}): Worker => ({ slug: 'tmc-layout', sid: 'w1', relation: 'owned', pane: '%1', window: '@1', cwd: '/w/tmc-layout', at: NOW - 600_000, state: 'working', attention: 'none', ...over })
const on = (over: Partial<Ledger> = {}): Ledger => ({ ...emptyLedger('c1', 'cc-mods-d9', NOW - 3_600_000), on: true, ...over })

test('status: a turn\'s wake carries the status the worker declared, and its age when old', () => {
  const l = on({ workers: [worker()] })
  const st = parseStatus({ state: 'blocked', kind: 'question', step: 'design', needs: '~/briefs/x.html' }, NOW + 5_000) as Status
  const done = observe(l, parsePanes('%1\t@1\tw1\tdone\tnone\t/w/tmc-layout\t'), NOW + 10_000, new Set(), new Map(), new Map([['w1', st]]))
  expect(done.changes.map((c) => c.text)).toEqual(['tmc-layout: finished its turn — status blocked:question · design · needs ~/briefs/x.html'])
  expect(done.ledger.workers[0]!.status).toEqual(st)
  // No status this tick: the one it had stays, and is called old when it is.
  const later = observe({ ...done.ledger, workers: [{ ...done.ledger.workers[0]!, state: 'working' }] }, parsePanes('%1\t@1\tw1\tdone\tnone\t/w/tmc-layout\t'), NOW + 5_000 + STATUS_OLD_MS + 60_000)
  expect(later.ledger.workers[0]!.status).toEqual(st)
  expect(later.changes[0]!.text).toContain('(declared 11 min ago)')
  // None ever declared: the wake is as before.
  expect(observe(l, parsePanes('%1\t@1\tw1\tdone\tnone\t/w/tmc-layout\t'), NOW + 10_000).changes.map((c) => c.text)).toEqual(['tmc-layout: finished its turn'])
  expect(statusTail(undefined, NOW)).toBe('')
})

test('status: the roster has a status column, and the prompts tell both sides about it', () => {
  const st = parseStatus({ state: 'working', step: 'tests', progress: 80 }, NOW) as Status
  const roster = coordRoster(on({ workers: [worker({ status: st, instructed: NOW }), worker({ slug: 'other', sid: 'w2', instructed: NOW })] }), NOW)
  expect(roster).toContain('| worker | relation | model/effort | state | status | cwd |')
  expect(roster).toContain('| working | working · tests · 80% | /w/tmc-layout |')
  expect(roster).toContain('| working | - | /w/tmc-layout |')
  expect(coordRules(on())).toContain('`status` tool')
  expect(workerPrompt('do it', 'cc-mods-d9', 'fix')).toContain(STATUS_RULE)
})
