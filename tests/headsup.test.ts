// What a worker's screen and last answer say that the coordinator would not
// hear otherwise (hooks/lib/headsup.ts), and the wakes made of them
// (hooks/lib/coord.ts headsUpWakes, personAskWakes).
import { expect, test } from 'claude-code/testing'
import { askedProperly, endsAsking, parseAskFile, parseHeadsUp, HEADSUP_MAX } from '../hooks/lib/headsup'
import { coordRules, current, emptyLedger, headsUpWakes, parseLedger, personAskWakes, recheck, wakeWorker, workerPrompt, type Ledger, type Worker } from '../hooks/lib/coord'

const NOW = 1_800_000_000_000
const on = (over: Partial<Ledger> = {}): Ledger => ({ ...emptyLedger('coord-sid', 'cc-mods-d9', NOW), on: true, ...over })
const worker = (over: Partial<Worker> = {}): Worker => ({ slug: 'relay-2fa', sid: 'w1', relation: 'owned', cwd: '/w/relay', at: NOW - 120_000, state: 'working', attention: 'none', ...over })

// The band as tmux capture-pane gives it: the star, the tag, the sentence
// wrapped under the star, the choice row, then the prompt box.
const BAND = [
  '⏺ I wired the relay: the office fills the code into the input it names.',
  '',
  '✦ Heads up · 2FA 중계가 입력칸 selector만 확인하고 어느 사이트인지는',
  '  확인하지 않습니다. 다른 탭에 코드가 들어갈 수 있습니다.',
  '  1 Learn more  2 Knew this already  3 What is this  0 Dismiss',
  '',
  '────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────',
  '  ⏵⏵ auto mode on',
].join('\n')

test('headsup: the band on a screen is its sentence, joined over its wrapped rows', () => {
  expect(parseHeadsUp(BAND)).toBe('2FA 중계가 입력칸 selector만 확인하고 어느 사이트인지는 확인하지 않습니다. 다른 탭에 코드가 들어갈 수 있습니다.')
})

test('headsup: "Heads up ·" quoted in the scrollback is not a band', () => {
  // A session talking about another session's band: no star, no choice row.
  expect(parseHeadsUp(['> Here is a note offered by a side agent: > Heads up · 곧 켤 자동 갱신은 Sendbird만 고칩니다', '', '❯ '].join('\n'))).toBeUndefined()
  // The star and tag but no choice row under it (an answer that quoted it).
  expect(parseHeadsUp(['✦ Heads up · pt2677 brief 답이 비어 있습니다', '', '⏺ Done.', '', '❯ '].join('\n'))).toBeUndefined()
  // The other tag explains a concept; it is not about the work.
  expect(parseHeadsUp(BAND.replace('Heads up', 'You should know'))).toBeUndefined()
  expect(parseHeadsUp('')).toBeUndefined()
})

test('headsup: a side panel beside the chat is cut off the rows', () => {
  const panel = BAND.split('\n').map((l) => l.padEnd(70) + '   │ reqs 12 ▁▂▃').join('\n')
  expect(parseHeadsUp(panel)).toBe(parseHeadsUp(BAND))
})

test('headsup: on a narrow pane the choice row wraps and the band still counts', () => {
  const narrow = BAND.replace('  1 Learn more  2 Knew this already  3 What is this  0 Dismiss', '  1 Learn more  2 Knew this already\n  3 What is this  0 Dismiss')
  expect(parseHeadsUp(narrow)).toBe(parseHeadsUp(BAND))
})

test('headsup: a screen padded with blank rows below still shows its band', () => {
  expect(parseHeadsUp(BAND + '\n'.repeat(60))).toBe(parseHeadsUp(BAND))
})

test('headsup: a long sentence is clipped', () => {
  const long = BAND.replace('다른 탭에', 'x'.repeat(400) + ' 다른 탭에')
  const t = parseHeadsUp(long)!
  expect(t.length).toBe(HEADSUP_MAX)
  expect(t.endsWith('…')).toBe(true)
})

test('headsUpWakes: a new band wakes the coordinator once, in the [coord] line form', () => {
  const l = on({ workers: [worker()] })
  const sums = new Map([['w1', '2FA 중계']])
  const r = headsUpWakes(l, new Map([['w1', BAND]]), NOW, sums)
  expect(r.changes.map((c) => c.text)).toEqual(['2FA 중계 (relay-2fa): heads-up: 2FA 중계가 입력칸 selector만 확인하고 어느 사이트인지는 확인하지 않습니다. 다른 탭에 코드가 들어갈 수 있습니다.'])
  expect(r.changes[0]!.wake).toBe(true)
  expect(r.ledger.workers[0]!.headsUp?.text).toContain('2FA 중계가')
  // The line names its worker the way the other [coord] lines do.
  expect(wakeWorker(r.changes[0]!.text, r.ledger)?.slug).toBe('relay-2fa')
  // Held through the coordinator's turn: still news, even after 0 (dismissed).
  expect(current(r.changes[0]!, r.ledger, NOW)).toBe(true)
  expect(recheck('[coord] ' + r.changes[0]!.text, r.ledger, NOW, new Map())).toBe('[coord] ' + r.changes[0]!.text)
  // The same band again: nothing told, the ledger unchanged.
  const again = headsUpWakes(r.ledger, new Map([['w1', BAND]]), NOW + 45_000, sums)
  expect(again.changes).toEqual([])
  expect(again.ledger).toBe(r.ledger)
  // A pane not read this tick keeps what it had.
  expect(headsUpWakes(r.ledger, new Map(), NOW).ledger).toBe(r.ledger)
  // Dismissed: the row's band clears, nothing is told.
  const gone = headsUpWakes(r.ledger, new Map([['w1', '❯ ']]), NOW + 90_000)
  expect(gone.changes).toEqual([])
  expect(gone.ledger.workers[0]!.headsUp).toBeUndefined()
  // A different sentence is told; the first one coming back is not.
  const b2 = BAND.replace('2FA 중계가 입력칸 selector만 확인하고 어느 사이트인지는', 'tmux 멈춤을 미루고 screenshot 버그를 먼저 고치고')
  const second = headsUpWakes(gone.ledger, new Map([['w1', b2]]), NOW + 100_000)
  expect(second.changes).toHaveLength(1)
  expect(second.changes[0]!.text).toContain('heads-up: tmux 멈춤을')
  expect(headsUpWakes(second.ledger, new Map([['w1', BAND]]), NOW + 200_000).changes).toEqual([])
})

test('headsUpWakes: a quiet worker is recorded, not told; an ended one is not read', () => {
  const q = headsUpWakes(on({ workers: [worker({ auto: true, relation: 'adopted' })] }), new Map([['w1', BAND]]), NOW)
  expect(q.changes.map((c) => c.wake)).toEqual([false])
  const ended = on({ workers: [worker({ endedAt: NOW - 1 })] })
  expect(headsUpWakes(ended, new Map([['w1', BAND]]), NOW).ledger).toBe(ended)
})

test('headsUpWakes: what was told survives a reload of the ledger', () => {
  const r = headsUpWakes(on({ workers: [worker()] }), new Map([['w1', BAND]]), NOW)
  const back = parseLedger(JSON.stringify(r.ledger), 'coord-sid', 'cc-mods-d9', NOW)
  expect(headsUpWakes(back, new Map([['w1', BAND]]), NOW + 60_000).changes).toEqual([])
})

test('endsAsking: a last paragraph that asks the person is its question', () => {
  // The live case (2026-11-12, luther-dp-onboarding).
  expect(endsAsking('DP 쪽 확인을 마쳤습니다.\n\n남은 결정은 하나입니다. Luther 스레드에 공유할 메시지 초안을 쓸지 정해 주세요.')).toBe('Luther 스레드에 공유할 메시지 초안을 쓸지 정해 주세요.')
  expect(endsAsking('PR을 열었습니다.\n\n리뷰 요청도 보낼까요?')).toBe('리뷰 요청도 보낼까요?')
  expect(endsAsking('Tests pass.\n\nShall I open the PR now?')).toBe('Shall I open the PR now?')
  expect(endsAsking('결과:\n\n- A안: 빠름\n- B안: 안전\n\n어느 쪽으로 갈지 알려 주세요.')).toBe('어느 쪽으로 갈지 알려 주세요.')
})

test('endsAsking: a question inside the work, or a report, is not an ask', () => {
  // The question is in an earlier paragraph; the answer ends on a report.
  expect(endsAsking('왜 실패했을까요? 로그를 봤습니다.\n\n원인은 timeout이었고 고쳤습니다.')).toBeUndefined()
  // Inside a code block.
  expect(endsAsking('고쳤습니다.\n\n```\nif ok? then\n```')).toBeUndefined()
  // A table closes it.
  expect(endsAsking('정리:\n\n| a | b? |\n|---|---|')).toBeUndefined()
  expect(endsAsking('READY를 보냈습니다.')).toBeUndefined()
  expect(endsAsking('')).toBeUndefined()
})

test('askedProperly: a brief ask, a blocked:question status or a QUESTION report is asking the right way', () => {
  expect(askedProperly([{ name: 'Bash', input: { command: 'brief ask --new luther-msg --question "쓸까?"' } }])).toBe(true)
  expect(askedProperly([{ name: 'mcp__cc-mods__status', input: { state: 'blocked', kind: 'question', needs: 'brief' } }])).toBe(true)
  expect(askedProperly([{ name: 'SendMessage', input: { to: 'cc-mods-d9', message: 'QUESTION scope? — /b/x.html' } }])).toBe(true)
  // A working status, a brief show, a READY: not an ask.
  expect(askedProperly([{ name: 'mcp__cc-mods__status', input: { state: 'working' } }])).toBe(false)
  expect(askedProperly([{ name: 'Bash', input: { command: 'brief done x --result ok' } }])).toBe(false)
  expect(askedProperly([{ name: 'SendMessage', input: { message: 'READY abc' } }])).toBe(false)
  expect(askedProperly([])).toBe(false)
})

test('personAskWakes: a question asked in words only is told once per turn', () => {
  const l = on({ workers: [worker({ slug: 'luther-dp-onboarding', state: 'done' })] })
  const sums = new Map([['w1', 'Luther DP 온보딩']])
  const file = parseAskFile(JSON.stringify({ text: '메시지 초안을 쓸지 정해 주세요.', at: NOW, turnId: 't1' }))
  const r = personAskWakes(l, new Map([['w1', file]]), sums)
  expect(r.changes.map((c) => c.text)).toEqual(['Luther DP 온보딩 (luther-dp-onboarding): 사람에게 물음: "메시지 초안을 쓸지 정해 주세요."'])
  expect(wakeWorker(r.changes[0]!.text, r.ledger)?.slug).toBe('luther-dp-onboarding')
  expect(current(r.changes[0]!, r.ledger, NOW)).toBe(true)
  // The same file again: not told twice.
  expect(personAskWakes(r.ledger, new Map([['w1', file]])).changes).toEqual([])
  // The worker went on (a new turn runs): the held line is stale.
  expect(current(r.changes[0]!, { ...r.ledger, workers: [{ ...r.ledger.workers[0]!, state: 'working' }] }, NOW)).toBe(false)
  // The next turn's ask is told.
  expect(personAskWakes(r.ledger, new Map([['w1', { text: '보낼까요?', at: NOW + 60_000 }]])).changes).toHaveLength(1)
  // A file from before the worker was taken on: old.
  expect(personAskWakes(l, new Map([['w1', { text: 'x?', at: NOW - 600_000 }]])).changes).toEqual([])
  // No file, or a broken one: nothing.
  expect(personAskWakes(l, new Map([['w1', parseAskFile('nope')]])).changes).toEqual([])
})

test('rules: the coordinator acts on heads-up and words-only asks; a worker asks on a brief', () => {
  const rules = coordRules(on())
  expect(rules).toContain('heads-up: <sentence>')
  expect(rules).toContain('It is not a notice to clear by pressing 0')
  expect(rules).toContain('When it does not apply, tell the person in one line why')
  expect(rules).toContain('사람에게 물음')
  expect(rules).toContain('answer it yourself with `coord_send`')
  const wp = workerPrompt('do it', 'cc-mods-d9', 'x')
  expect(wp).toContain('do not ask in your answer')
  expect(wp).toContain('declare `status` blocked with kind question')
})
