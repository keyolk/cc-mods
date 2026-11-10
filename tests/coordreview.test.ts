// The coordinator's review queue (hooks/lib/coordreview.ts): no engine, just functions.
import { expect, test } from 'claude-code/testing'

import { REVIEW_KEEP_MS, confirmed, countText, emptyReview, openItems, parseReview, pruned, reviewLine, reviewTable, upsert, type ReviewFile } from '../hooks/lib/coordreview'
import { coordSection, emptyLedger } from '../hooks/lib/coord'

const NOW = 1_800_000_000_000
const base = () => emptyReview('coord-sid', 'cc-mods-d9')
const add = (f: ReviewFile, input: Record<string, unknown>, now = NOW) => {
  const r = upsert(f, 'add', input, now)
  if (typeof r === 'string') throw new Error(r)
  return r
}

test('review: add makes an open item; the same id again is the same work, its fields overwritten and links piled up', () => {
  const a = add(base(), { id: 'cc-mods#85', title: '검토 대기열', changed: '지휘 view에 🔎 검토', verified: 'bun·pytest', check: 'j/k로 넘겨 보기', risk: '동시 쓰기', links: ['https://github.com/keyolk/cc-mods/pull/85'] })
  expect(a.fresh).toBe(true)
  expect(a.item).toMatchObject({ state: 'open', at: NOW, updatedAt: NOW })
  const b = add(a.file, { id: 'cc-mods#85', verified: 'bun·pytest·8899 live run', links: ['~/briefs/x.html', 'https://github.com/keyolk/cc-mods/pull/85'] }, NOW + 5)
  expect(b.fresh).toBe(false)
  expect(b.file.items).toHaveLength(1)
  expect(b.item).toMatchObject({ title: '검토 대기열', changed: '지휘 view에 🔎 검토', verified: 'bun·pytest·8899 live run', at: NOW, updatedAt: NOW + 5 })
  expect(b.item.links).toEqual(['https://github.com/keyolk/cc-mods/pull/85', '~/briefs/x.html'])
})

test('review: update needs an id already there; a new item needs a title and what changed or what to check', () => {
  expect(upsert(base(), 'update', { id: 'x', title: 't' }, NOW)).toContain('add it first')
  expect(upsert(base(), 'add', { id: 'bad id', title: 't', changed: 'c' }, NOW)).toContain('id:')
  expect(upsert(base(), 'add', { id: 'x', changed: 'c' }, NOW)).toContain('title')
  expect(upsert(base(), 'add', { id: 'x', title: 't' }, NOW)).toContain('what changed')
  // An empty string leaves the old field alone.
  const f = add(base(), { id: 'x', title: 't', check: 'k' }).file
  const r = upsert(f, 'update', { id: 'x', check: '  ' }, NOW + 1)
  expect(typeof r !== 'string' && r.item.check).toBe('k')
})

test('review: confirm takes it off the open list and keeps it as history; new information opens it again', () => {
  const f = add(add(base(), { id: 'a', title: 'A', changed: 'c' }).file, { id: 'b', title: 'B', check: 'k' }).file
  const c = confirmed(f, 'a', NOW + 10) as ReviewFile
  expect(openItems(c).map((i) => i.id)).toEqual(['b'])
  expect(c.items.find((i) => i.id === 'a')).toMatchObject({ state: 'confirmed', confirmedAt: NOW + 10 })
  expect(confirmed(c, 'a', NOW)).toContain('already')
  expect(confirmed(c, 'zz', NOW)).toContain('no review item')
  const again = add(c, { id: 'a', risk: '후속 PR에 회귀' }, NOW + 20)
  expect(again.item.state).toBe('open')
  expect(again.item.confirmedAt).toBeUndefined()
  expect(countText(again.file)).toBe('검토 대기 2건')
})

test('review: a confirmed item older than a week goes; an open one never does', () => {
  const f = add(add(base(), { id: 'a', title: 'A', changed: 'c' }).file, { id: 'b', title: 'B', changed: 'c' }).file
  const c = confirmed(f, 'a', NOW) as ReviewFile
  expect(pruned(c, NOW + REVIEW_KEEP_MS - 1).items).toHaveLength(2)
  expect(pruned(c, NOW + REVIEW_KEEP_MS + 1).items.map((i) => i.id)).toEqual(['b'])
  expect(pruned(c, NOW + 100 * REVIEW_KEEP_MS).items.map((i) => i.id)).toEqual(['b'])
})

test('review: the file the office wrote parses back (a confirm, an issue); garbage is an empty queue', () => {
  const f = add(base(), { id: 'tweb-240', title: 'T', changed: 'c' }).file
  const office = JSON.parse(JSON.stringify(f))
  office.items[0].issues = [{ text: 'reload 경우 미재현', at: NOW + 1 }]
  office.items.push({ id: 'no good', title: 'x' }, null)
  const back = parseReview(JSON.stringify(office), 'coord-sid', 'n')
  expect(back.items.map((i) => i.id)).toEqual(['tweb-240'])
  expect(back.items[0]!.issues).toEqual([{ text: 'reload 경우 미재현', at: NOW + 1 }])
  expect(parseReview('{"items": [', 's', 'n').items).toEqual([])
  expect(parseReview(undefined, 's', 'n')).toEqual(emptyReview('s', 'n'))
})

test('review: list is a table of the open items; the system prompt gets one line, none when empty', () => {
  const f = add(add(base(), { id: 'a', title: 'A | pipe', changed: 'c', check: '두 줄\n확인' }).file, { id: 'b', title: 'B', changed: 'c' }, NOW + 1).file
  const t = reviewTable(confirmed(f, 'b', NOW + 2) as ReviewFile)
  expect(t).toContain('검토 대기 1건')
  expect(t).toContain('| a | A \\| pipe | 두 줄 / 확인 |')
  expect(t).toContain('1 confirmed in the last 7 days')
  expect(reviewTable(base())).toBe('Review queue empty.')
  expect(reviewLine(f)).toBe('Review queue (coord_review): 2 open — a, b.')
  expect(reviewLine(base())).toBeUndefined()
  const l = { ...emptyLedger('sid', 'n', NOW), on: true }
  expect(coordSection(l, NOW, 'Korean', reviewLine(f))).toContain('Review queue (coord_review): 2 open')
  // The rules: finished work goes to the queue, chat gets one line, and the two answers back.
  const s = coordSection(l, NOW)
  expect(s).toContain('`coord_review` add')
  expect(s).toContain('`검토 대기 N건`')
  expect(s).toContain('`[review] confirmed <id>`')
  expect(s).toContain('`[review] issue <id>: <words>`')
  expect(s).not.toContain('Review queue (')
})
