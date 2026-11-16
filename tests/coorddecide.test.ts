// The decision briefs a coordinator asked, as its roster carries them every
// turn (hooks/lib/coorddecide.ts). No engine: the sidecars as text.
import { expect, test } from 'claude-code/testing'

import { UNRELAYED_MAX_MS, briefQuestions, briefState, briefTime, briefsNamed, decisionLines, stampRelayed, withLogged } from '../hooks/lib/coorddecide'
import { coordRoster, coordRules, emptyLedger, parseLedger, type Ledger, type Worker } from '../hooks/lib/coord'

const C = '8aa8ea53-8bfd-4484-b94d-d9f9a7803da6'
const NOW = Date.parse('2026-11-16T00:45:00Z')
const q = (over: Record<string, unknown> = {}) => ({ id: 'q1', question: 'cepext ap2 ALB는 언제 지울까?', options: [{ label: '11-16 함께' }, { label: '11-18로 미룸' }], coordinator: C, worker: '2026-10-13-common-gw-0e', asked: '2026-11-12T14:33Z', ...over })
const side = (qs: object[], extra: Record<string, unknown> = {}) => JSON.stringify({ sessions: [], decisions: qs, decision: qs[0], ...extra })
const ans = (choice: string, at: string) => ({ answer: { choice, note: '', by: 'office', at } })

// The two briefs of the evidence (2026-11-16): cepext answered 11-12 15:55Z
// and never relayed; tweb-daemon answered, no worker, done since.
const files = new Map([
  ['2026-11-12-common-gw-cepext-ap2', side([q(ans('11-16 함께', '2026-11-12T15:55Z'))])],
  ['2026-11-12-tweb-daemon-restart', side([q({ question: '공유 twebd를 지금 재시작할까?', worker: null, asked: '2026-11-12T08:41Z', ...ans('지금 재시작', '2026-11-12T08:43Z') })], { done: { at: '2026-11-15T23:50Z', result: '재시작함' } })],
  ['2026-11-16-other-open', side([q({ worker: 'another-worker', asked: '2026-11-16T00:30Z' })])],
  ['2026-11-16-other-coordinator', side([q({ coordinator: 'someone-else' })])],
  ['broken', '{'],
])
const live = new Set(['2026-10-13-common-gw-0e'])

test('coorddecide: a sidecar\'s questions this coordinator asked, in either shape', () => {
  expect(briefQuestions('b', side([q(), q({ id: 'q2', coordinator: 'x' })]), C).qs.map((x) => x.id)).toEqual(['q1'])
  // From before `decisions`: one question in `decision`, read as q1.
  const legacy = JSON.stringify({ decision: { question: 'go?', coordinator: C, answer: { choice: 'yes', at: '2026-11-12T08:43Z' } } })
  expect(briefQuestions('b', legacy, C).qs).toEqual([{ brief: 'b', id: 'q1', question: 'go?', worker: undefined, asked: undefined, answer: { choice: 'yes', note: undefined, at: '2026-11-12T08:43Z', by: undefined } }])
  expect(briefQuestions('b', '{', C)).toEqual({ qs: [], done: false })
  // A done with no result is not done (as office/command.py _done).
  expect(briefQuestions('b', side([q()], { done: { at: 'x' } }), C).done).toBe(false)
  expect(briefTime('2026-11-12T15:55Z')).toBe(Date.parse('2026-11-12T15:55:00Z'))
  expect(briefTime(undefined)).toBe(0)
})

test('coorddecide: open questions, and answers not relayed, not done, to a live worker, in the last week', () => {
  const s = briefState(files, C, {}, live, NOW)
  expect(s.open.map((x) => x.brief)).toEqual(['2026-11-16-other-open'])
  expect(s.unrelayed.map((x) => x.brief)).toEqual(['2026-11-12-common-gw-cepext-ap2'])
  const text = decisionLines(s)
  expect(text).toContain('결정 대기 1 (the person has not answered; they are in the office, do not ask again): 2026-11-16-other-open.')
  expect(text).toContain('확인 필요: 답 받았으나 전달 기록 없음 — 2026-11-12-common-gw-cepext-ap2 → 2026-10-13-common-gw-0e: "11-16 함께" (answered 2026-11-12T15:55Z).')
  expect(text).not.toContain('relay it')
  // Relayed after its answer: gone; relayed before (an earlier send about it): still there.
  expect(briefState(files, C, { '2026-11-12-common-gw-cepext-ap2': NOW - 60_000 }, live, NOW).unrelayed).toEqual([])
  expect(briefState(files, C, { '2026-11-12-common-gw-cepext-ap2': Date.parse('2026-11-12T14:40Z') }, live, NOW).unrelayed.length).toBe(1)
  // Its worker gone (closed), or the answer over a week old: history, not listed.
  expect(briefState(files, C, {}, new Set(), NOW).unrelayed).toEqual([])
  expect(briefState(files, C, {}, live, Date.parse('2026-11-12T15:55Z') + UNRELAYED_MAX_MS + 1).unrelayed).toEqual([])
  // Recorded by the coordinator itself (the person picked in the worker's
  // pane, 2026-11-13 webhook-sync-reserve-configmap): nothing to relay.
  const byCoord = new Map([['2026-11-13-webhook-sync-reserve-configmap', side([q({ answer: { choice: '함께 예약', by: 'coordinator', at: '2026-11-13T07:07Z' } })])]])
  expect(briefState(byCoord, C, {}, live, NOW).unrelayed).toEqual([])
  // No worker named and not done: the coordinator's own to carry out.
  const own = new Map([['b', side([q({ worker: null, ...ans('지금', '2026-11-16T00:40Z') })])]])
  expect(decisionLines(briefState(own, C, {}, live, NOW))).toContain('확인 필요: 답 받았으나 전달 기록 없음 — b → (no worker): "지금"')
  // Nothing at all: the line still says 0, so a remembered count cannot stand.
  expect(decisionLines(briefState(new Map(), C, {}, live, NOW))).toBe('결정 대기 0: no decision brief of yours waits on the person.')
})

test('coorddecide: the live case (2026-11-16): ap2 relayed at 08:50, and superseded by the 11-16 brief, is not listed', () => {
  const real = new Map([
    ['2026-11-12-common-gw-cepext-ap2', side([q(ans('11-16 함께', '2026-11-12T15:55Z'))])],
    ['2026-11-13-webhook-sync-reserve-configmap', side([q({ asked: '2026-11-13T06:50Z', answer: { choice: '함께 예약', by: 'coordinator', at: '2026-11-13T07:07Z' } })])],
    ['2026-11-16-common-gw-cepext-recent-hits', side([q({ asked: '2026-11-16T00:30Z' }), q({ id: 'q2', asked: '2026-11-16T00:30Z' })])],
  ])
  // The coordinator's 08:50 KST send, as its ledger log holds it.
  const log = [{ at: Date.parse('2026-11-15T23:50:55Z'), kind: 'send', text: '2026-10-13-common-gw-0e: [brief answer] /Users/gavin.jeong/briefs/2026-11-12-common-gw-cepext-ap2.html: "11-16 함께" (answered 11-12 15:55Z by the person in office).' }]
  const s = briefState(real, C, withLogged(undefined, log), live, NOW)
  expect(s.unrelayed).toEqual([])
  expect([...new Set(s.open.map((x) => x.brief))]).toEqual(['2026-11-16-common-gw-cepext-recent-hits'])
  // Superseded alone, with no relay on record: still not listed.
  expect(briefState(real, C, {}, live, NOW).unrelayed).toEqual([])
  // Relay recorded alone, no newer brief: not listed.
  const ap2 = new Map([...real].filter(([k]) => k === '2026-11-12-common-gw-cepext-ap2'))
  expect(briefState(ap2, C, withLogged(undefined, log), live, NOW).unrelayed).toEqual([])
  // Neither: it is the one line to check.
  expect(briefState(ap2, C, {}, live, NOW).unrelayed.map((x) => x.brief)).toEqual(['2026-11-12-common-gw-cepext-ap2'])
})

test('coorddecide: a coord_send naming a brief stamps it relayed', () => {
  expect(briefsNamed('[brief answer] /Users/x/briefs/2026-11-12-common-gw-cepext-ap2.html: "11-16 함께"')).toEqual(['2026-11-12-common-gw-cepext-ap2'])
  expect(briefsNamed('see 2026-11-12-a.html and (2026-11-13-b.brief.json) and 2026-11-12-a.html')).toEqual(['2026-11-12-a', '2026-11-13-b'])
  expect(briefsNamed('no brief here.html')).toEqual([])
  expect(stampRelayed(undefined, 'plain text', NOW)).toBeUndefined()
  expect(stampRelayed({ old: 1 }, 'go: 2026-11-12-a.html', NOW)).toEqual({ '2026-11-12-a': NOW, old: 1 })
  // A relay logged before the map was kept (the live 08:50 send) counts too.
  const log = [{ at: NOW - 5, kind: 'send', text: '2026-10-13-common-gw-0e: [brief answer] /Users/x/briefs/2026-11-12-common-gw-cepext-ap2.html: "11-16 함께"' }, { at: NOW, kind: 'event', text: '2026-11-12-b.html' }]
  expect(withLogged({ a: 1 }, log)).toEqual({ a: 1, '2026-11-12-common-gw-cepext-ap2': NOW - 5 })
  expect(briefState(files, C, withLogged(undefined, log), live, NOW).unrelayed).toEqual([])
})

test('coorddecide: the roster carries the lines and the ledger keeps the relayed map', () => {
  const l: Ledger = { ...emptyLedger(C, 'cc-mods-8f', NOW), on: true }
  const w: Worker = { slug: '2026-10-13-common-gw-0e', sid: 'w1', relation: 'adopted', cwd: '/x', at: NOW, instructed: NOW }
  const roster = coordRoster({ ...l, workers: [w] }, NOW, undefined, decisionLines(briefState(files, C, {}, live, NOW)))
  expect(roster).toContain('결정 대기 1')
  expect(roster).toContain('확인 필요: 답 받았으나 전달 기록 없음 — 2026-11-12-common-gw-cepext-ap2')
  expect(coordRules(l)).toContain('확인 필요: 답 받았으나 전달 기록 없음')
  expect(coordRules(l)).toContain('never push an old answer into a worker by reflex')
  const back = parseLedger(JSON.stringify({ ...l, relayed: { a: 5, bad: 'x' } }), C, 'n', NOW)
  expect(back.relayed).toEqual({ a: 5 })
  expect(parseLedger(JSON.stringify({ ...l, relayed: [1] }), C, 'n', NOW).relayed).toBeUndefined()
})
