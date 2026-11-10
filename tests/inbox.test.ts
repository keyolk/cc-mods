// The office inbox's messages (hooks/lib/inbox.ts): what is read, what goes
// in, what counts as gone in, what goes back after a failed submit, the wake
// a coordinator gets, and where a long instruction goes. No engine.
import { expect, test } from 'claude-code/testing'

import { INBOX_KEEP_S, INLINE_MAX, failWake, inboxPrompt, landed, parseInbox, putBack, resumed, spillDir, spilled } from '../hooks/lib/inbox'

const NOW = 1_800_000_000

test('inbox: a file is read with its marks; an empty, broken or textless one is nothing', () => {
  expect(parseInbox(JSON.stringify({ text: ' hi ', at: NOW, keep: true, tries: 2, from: 'c1', slug: 'w' }))).toEqual({ text: 'hi', at: NOW, keep: true, tries: 2, from: 'c1', slug: 'w' })
  expect(parseInbox(JSON.stringify({ text: 'hi', at: NOW }))).toEqual({ text: 'hi', at: NOW })
  for (const raw of [undefined, '', '{', 'null', '{"text":"  "}', '{"at":1}']) expect(parseInbox(raw)).toBeUndefined()
})

test('inbox: an unmarked message lasts two minutes, a kept one a day, saying how late', () => {
  expect(inboxPrompt({ text: 'a', at: NOW - 10 }, NOW)).toBe('a')
  expect(inboxPrompt({ text: 'a', at: NOW - 600 }, NOW)).toBeUndefined()
  expect(inboxPrompt({ text: 'a', at: NOW - 600, keep: true }, NOW)).toBe('(10분 전 office inbox에 들어온 메시지)\na')
  expect(inboxPrompt({ text: 'a', at: NOW - INBOX_KEEP_S - 1, keep: true }, NOW)).toBeUndefined()
})

test('inbox: a submit went in only when not dropped and the prompt that entered still carries the text', () => {
  expect(landed({ text: '[coordinator] do it' }, '[coordinator] do it')).toBe(true)
  // A hook that adds around it is fine.
  expect(landed({ text: 'note\n[coordinator] do it\nmore' }, '[coordinator] do it')).toBe(true)
  expect(landed({ drop: 'policy' }, '[coordinator] do it')).toBe('dropped: policy')
  expect(landed(undefined, 'x')).toBe('no prompt entered')
  expect(landed({ text: 'something else' }, '[coordinator] do it')).toBe('the prompt that entered no longer carries it')
})

test('inbox: a message put back keeps its age and sender, goes first, and counts a try', () => {
  const m = { text: 'one', at: NOW - 60, keep: true, from: 'c1', slug: 'w' }
  expect(putBack(m, undefined)).toEqual({ ...m, tries: 1 })
  expect(putBack({ ...m, tries: 1 }, { text: 'two', at: NOW })).toEqual({ ...m, text: 'one\n\ntwo', tries: 2 })
  expect(putBack({ text: 'reply', at: NOW }, { text: 'two', at: NOW, keep: true })).toMatchObject({ keep: true })
  // One left aside by a reload says it may be a repeat, and is not a failed try.
  expect(resumed(m, { text: 'two', at: NOW })).toEqual({ ...m, text: '(전달 확인 전에 다시 보냄: 이미 받았다면 무시)\none\n\ntwo', tries: 0 })
})

test('inbox: the wake names the worker, why, the tries and the head of what was lost', () => {
  const w = failWake({ text: '[coordinator] ' + 'a'.repeat(300), at: NOW, tries: 5, slug: 'office-say-first' }, 'dropped: x')
  expect(w.startsWith('[coord] office-say-first: 지시 전달 실패 (dropped: x, 5회 시도): "[coordinator] aaa')).toBe(true)
  expect(w).toContain('…" — 다시 보내거나 파일로 넘겨라')
  expect(w.length).toBeLessThan(260)
  // With what the worker was doing known, it leads and the slug follows.
  expect(failWake({ text: 'x', at: NOW, tries: 5, slug: 'ops-k8s-4a', summary: 'ALB 정리' }, 'y').startsWith('[coord] ALB 정리 (ops-k8s-4a): 지시 전달 실패')).toBe(true)
  // It rides through a put-back.
  expect(putBack({ text: 'a', at: NOW, slug: 's', summary: 'S' }, { text: 'b', at: NOW }).summary).toBe('S')
  expect(parseInbox(JSON.stringify({ text: 'a', at: 1, slug: 's', summary: 'S' }))?.summary).toBe('S')
})

test('inbox: a long instruction keeps its head and names the file; the file goes where the worker reaches', () => {
  const text = 'x'.repeat(INLINE_MAX + 5)
  const s = spilled(text, '/h/research/w/coord-1.md')
  expect(s.startsWith('x'.repeat(2_000) + '\n\n(본문 ' + text.length + '자가 길어 파일로 넘겼다. 전문: /h/research/w/coord-1.md')).toBe(true)
  expect(spillDir(['/h/briefs', '/h/research/w'], 'w', '/h')).toBe('/h/research/w')
  expect(spillDir(['/h/briefs', '/h/research/other'], 'w', '/h')).toBe('/h/research/other')
  expect(spillDir(['/h/briefs'], 'w', '/h')).toBe('/h/briefs')
  expect(spillDir(undefined, 'w', '/h')).toBe('/h/.claude/state/office/inbox/long')
})
