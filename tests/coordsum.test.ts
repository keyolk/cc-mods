// The one-line summaries (hooks/lib/coordsum.ts): which source each session's
// line comes from, when the cached one stands, and what of the model's
// answer is kept. No model is called.
import { expect, test } from 'claude-code/testing'

import { SUM_BATCH, SUM_RETRY_MS, applied, clip, fromPerson, given, parseFirst, parseLast, parseSummaries, parseSums, personLines, plan, sumRequest, unrelay, type SumIn } from '../hooks/lib/coordsum'
import { parsePrompts } from '../hooks/lib/coordroute'

const NOW = 1_800_000_000_000
const row = (over: Partial<SumIn>): SumIn => ({ sid: 's1', name: 'gavin-jeong-63', cwd: '/Users/me', prompts: [], ...over })

test('coordsum: a name the person gave is the summary; Claude Code\'s, the slug and the coordinator\'s label are not', () => {
  expect(given('O11y agent 소실 RCA')).toBe('O11y agent 소실 RCA')
  expect(given('layout work')).toBe('layout work')
  for (const n of ['gavin-jeong-63', 'cc-mods-d9', '2026-10-13-common-gw-0e', 'w:fix', '8aa8ea53', '', undefined]) expect(given(n)).toBeUndefined()
  expect(given('office-say-first', 'office-say-first')).toBeUndefined()
})

test('coordsum: the cheapest source first, the model only for what is left, in one batch', () => {
  const rows = [
    row({ sid: 'a', title: 'Twingate relay 조사' }),
    row({ sid: 'b', prompts: ['ccx 빌드 고쳐줘'], first: 'ccx 빌드 고쳐줘' }),
    row({ sid: 'c', first: 'office 지휘 view 정리: 사람이 세션을 골라 시키는 화면이 아니라 말하면 알아서', prompts: ['[coordinator] 보충'] }),
    row({ sid: 'd' }),
  ]
  const { next, ask } = plan(rows, {}, NOW)
  expect(next.a).toMatchObject({ text: 'Twingate relay 조사', src: 'name' })
  expect(next.b).toMatchObject({ text: 'ccx 빌드 고쳐줘', src: 'prompt' })
  // Until the call answers (and if it fails), the first prompt, clipped.
  expect(next.c).toMatchObject({ src: 'first' })
  expect(next.c!.text.length).toBeLessThanOrEqual(40)
  expect(next.c!.text.endsWith('…')).toBe(true)
  // Nothing to say about a session with no prompt yet.
  expect(next.d).toBeUndefined()
  expect(ask.map((r) => r.sid)).toEqual(['c'])
  const q = sumRequest(ask)
  // The relay head is taken off: the model reads the work, not the hand-off.
  expect(JSON.parse(q.prompt).sessions[0]).toMatchObject({ id: 'c', recent: ['보충'] })
  expect(q.system).toContain('JSON')
  const many = Array.from({ length: SUM_BATCH + 5 }, (_, i) => row({ sid: 'x' + i, first: 'y'.repeat(60), prompts: ['a', 'b'] }))
  expect(plan(many, {}, NOW).ask.length).toBe(SUM_BATCH)
})

test('coordsum: a summary stands until the session is prompted again or renamed; a fallback is retried later, not every tick', () => {
  const r = row({ sid: 'c', first: 'z'.repeat(80), prompts: ['p1', 'p2'], last: '2026-11-10T07:00:00Z' })
  const first = plan([r], {}, NOW)
  const done = applied(first.next, new Map([['c', 'office 지휘 view 정리']]), NOW)
  expect(done.c).toMatchObject({ text: 'office 지휘 view 정리', src: 'model' })
  expect(plan([r], done, NOW + 3_600_000)).toEqual({ next: done, ask: [] })
  expect(plan([{ ...r, last: '2026-11-10T08:00:00Z' }], done, NOW).ask.length).toBe(1)
  expect(plan([{ ...r, name: 'renamed by hand' }], done, NOW).next.c).toMatchObject({ src: 'name', text: 'renamed by hand' })
  // The call failed: the first prompt is kept and asked again only after SUM_RETRY_MS.
  expect(plan([r], first.next, NOW + 60_000).ask).toEqual([])
  expect(plan([r], first.next, NOW + SUM_RETRY_MS + 1).ask.length).toBe(1)
})

test('coordsum: the model\'s answer keeps only labels for the sessions asked, clipped; anything else is nothing', () => {
  const ask = [row({ sid: 'a' }), row({ sid: 'b' })]
  const got = parseSums('```json\n{"a": "Twingate relay 실패율 조사", "b": "' + 'x'.repeat(80) + '", "zz": "not asked"}\n```', ask)
  expect(got.get('a')).toBe('Twingate relay 실패율 조사')
  expect(got.get('b')!.length).toBe(40)
  expect(got.has('zz')).toBe(false)
  expect(parseSums('no json here', ask).size).toBe(0)
  expect(parseSums('[1,2]', ask).size).toBe(0)
  expect(clip('  a\n b  ')).toBe('a b')
})

test('coordsum: the cache file, and the transcript rows: first prompts skip harness tags, the last prompt\'s time is the third column', () => {
  expect(parseSummaries(undefined)).toEqual({})
  expect(parseSummaries('{bad')).toEqual({})
  expect(parseSummaries('{"a":{"text":"t","src":"model","key":"k","at":1},"b":{"text":1}}')).toEqual({ a: { text: 't', src: 'model', key: 'k', at: 1 } })
  const first = [JSON.stringify(['s1', '<command-name>/coord</command-name>', 't0']), JSON.stringify(['s1', ' fix\n the  build ', 't1']), JSON.stringify(['s1', 'later', 't2']), 'junk'].join('\n')
  expect(parseFirst(first).get('s1')).toBe('fix the build')
  const tail = [JSON.stringify(['s1', 'a', '2026-11-10T07:00:00Z']), JSON.stringify(['s1', 'b', '2026-11-10T07:05:00Z']), JSON.stringify(['s2', 'old row without time'])].join('\n')
  expect(parseLast(tail)).toEqual(new Map([['s1', '2026-11-10T07:05:00Z']]))
  // The prompts the router reads are unchanged by the extra column.
  expect(parsePrompts(tail).get('s1')).toEqual(['a', 'b'])
})

test('coordsum: a coordinator is labelled by the person\'s words, never by its workers\' reports', () => {
  expect(fromPerson('[worker warren-9c] READY 92e04f0 https://x')).toBeUndefined()
  expect(fromPerson('READY https://github.com/sendbird/ops-k8s/pull/10341')).toBeUndefined()
  expect(fromPerson('The cc-mods plugin sent a message:\n[coord] warren …')).toBeUndefined()
  expect(fromPerson('[brief answer] 2026-11-12-x.html: q1 A')).toBeUndefined()
  expect(fromPerson('<task-notification>…')).toBeUndefined()
  expect(fromPerson('[office→coord] (re: 2026-11-12-a.html, worker w) daily check in upload')).toBe('daily check in upload')
  expect(fromPerson('slx를 좀 개선할수 있을거 같아')).toBe('slx를 좀 개선할수 있을거 같아')
  const out = [
    JSON.stringify(['c', '[worker a] READY 1', '2026-11-12T00:40:00Z']),
    JSON.stringify(['c', 'office 보내기가 안 사라져', '2026-11-12T00:41:00Z']),
    JSON.stringify(['c', '[review] confirmed a', '2026-11-12T00:42:00Z']),
    'not json',
  ].join('\n')
  const kept = personLines(out)
  expect(parsePrompts(kept).get('c')).toEqual(['office 보내기가 안 사라져'])
  // The key moves with the person's newest words, not with each report.
  expect(parseLast(kept).get('c')).toBe('2026-11-12T00:41:00Z')
})

test('coordsum: a pane label cut from the first prompt, or a relay head, is not a name the person gave', () => {
  const first = '사람의 말(원문): "slx를 좀 개선할수 있을거 같아 무조건 다 올리는게 아니라 jev활용해서"'
  expect(given('사람의 말(원문): "slx를 좀 개선할수…', 'slx-ask-judge', first)).toBeUndefined()
  expect(given('worker 보고(원문): "SKILL tsc(workt…')).toBeUndefined()
  expect(given('tweb이 coder/warren 같은 리모트 환경', undefined, 'tweb이 coder/warren 같은 리모트 환경에서도 잘돌수 있을까?')).toBeUndefined()
  // A label the person typed stays, even beside a first prompt.
  expect(given('Twingate relay 조사', undefined, 'relay가 자꾸 끊겨')).toBe('Twingate relay 조사')
  expect(unrelay(first)).toBe('slx를 좀 개선할수 있을거 같아 무조건 다 올리는게 아니라 jev활용해서')
  expect(unrelay('[coordinator] 사람의 말(원문): "warren 작업하던 세션 다시 로드해줘" 이어서 credential broker 메모')).toBe('warren 작업하던 세션 다시 로드해줘')
  expect(unrelay('[coordinator] #130 rebase')).toBe('#130 rebase')
  expect(unrelay('그냥 "말"')).toBe('그냥 "말"')
})

test('coordsum: a session is named by what it declared it is doing now; a new phase relabels it', () => {
  const r = row({ sid: 'w', slug: 'warren-9c', title: '사람의 말(원문): "warren 작업하던…', first: '사람의 말(원문): "warren 작업하던 세션 다시 로드해줘"', prompts: ['[coordinator] broker 메모 마무리'], last: '2026-11-12T00:40:00Z', status: { step: 'credential broker 설계 메모', next: 'PR 열기' } })
  const a = plan([r], {}, NOW)
  // Until the model answers: the first prompt without the hand-off head.
  expect(a.next.w).toMatchObject({ text: 'warren 작업하던 세션 다시 로드해줘', src: 'first' })
  expect(a.ask.map((x) => x.sid)).toEqual(['w'])
  const q = JSON.parse(sumRequest(a.ask).prompt).sessions[0]
  expect(q.status).toBe('credential broker 설계 메모 → PR 열기')
  expect(q.first).toBe('warren 작업하던 세션 다시 로드해줘')
  expect(q.recent).toEqual(['broker 메모 마무리'])
  expect(sumRequest(a.ask).system).toContain('NOW')
  const done = applied(a.next, new Map([['w', 'warren credential broker 설계']]), NOW)
  // The same phase: kept, no call. A new step: asked again.
  expect(plan([r], done, NOW + 3_600_000)).toEqual({ next: done, ask: [] })
  const moved = plan([{ ...r, status: { step: 'PR 리뷰 대응', next: 'merge 대기' } }], done, NOW)
  expect(moved.ask.length).toBe(1)
  // While that call is out, the label it had stays.
  expect(moved.next.w!.text).toBe('warren credential broker 설계')
  // A lone short prompt that is a relay is no label either.
  const relay = plan([row({ sid: 'x', first: '[coordinator] 확인', prompts: ['[coordinator] 확인'] })], {}, NOW)
  expect(relay.next.x).toMatchObject({ src: 'first', text: '확인' })
  // A status with no prompt read yet still names it.
  expect(plan([row({ sid: 'y', status: { step: 'slx Jev 판정' } })], {}, NOW).next.y).toMatchObject({ text: 'slx Jev 판정' })
})
