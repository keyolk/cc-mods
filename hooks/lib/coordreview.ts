// The coordinator's review queue: finished work the person should look at.
//
// A worker's READY that the coordinator verified and merged is not done for
// the person: they still have to judge it. One brief a turn could not carry
// that (written once, never updated, nothing taken off when looked at), so
// each coordinator keeps a list in
// ~/.claude/state/office/coord/review/<coordinator sid>.json. The coordinator
// adds or updates an item with coord_review (the same id again is the same
// work's later step); the office's 지휘 view shows the open ones under 🔎 검토
// and writes the person's "확인함" (confirmed) or "문제 있음" (an issue) back
// here, telling the coordinator `[review] confirmed <id>` or
// `[review] issue <id>: <words>` (office/review.py). A confirmed item leaves
// the list and stays in the file as history for REVIEW_KEEP_MS.
//
// The folder is under coord/ but not coord/*.json: the office and the
// coordinators glob that for ledgers.
// Pure: coord.ts does the I/O.

export type ReviewIssue = { text: string; at: number }

export type ReviewItem = {
  id: string
  title: string
  changed: string // what changed, for the person
  verified: string // what the coordinator checked, and what it did not
  check: string // what the person should look at themselves
  risk: string
  links: string[]
  state: 'open' | 'confirmed'
  at: number
  updatedAt: number
  confirmedAt?: number
  issues?: ReviewIssue[] // what the person said was wrong, newest last
}

export type ReviewFile = { sid: string; name: string; items: ReviewItem[] }

export const REVIEW_KEEP_MS = 7 * 24 * 3600_000
export const REVIEW_ID = /^[\w.#-]{1,60}$/
const TEXT_MAX = 2000
const LINKS_MAX = 12
const FIELDS = ['title', 'changed', 'verified', 'check', 'risk'] as const

export function emptyReview(sid: string, name: string): ReviewFile {
  return { sid, name, items: [] }
}

const str = (x: unknown, max = TEXT_MAX) => (typeof x === 'string' ? x.trim().slice(0, max) : '')

function links(x: unknown): string[] {
  const all = Array.isArray(x) ? x : typeof x === 'string' && x.trim() ? x.split(/[\n,]\s*/) : []
  return [...new Set(all.map((l) => str(l, 500)).filter(Boolean))].slice(0, LINKS_MAX)
}

export function parseReview(json: string | undefined, sid: string, name: string): ReviewFile {
  let raw: any
  try {
    raw = json ? JSON.parse(json) : undefined
  } catch {
    raw = undefined
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return emptyReview(sid, name)
  const items: ReviewItem[] = []
  for (const it of raw.items) {
    if (!it || typeof it.id !== 'string' || !REVIEW_ID.test(it.id)) continue
    items.push({
      id: it.id,
      title: str(it.title, 200) || it.id,
      changed: str(it.changed),
      verified: str(it.verified),
      check: str(it.check),
      risk: str(it.risk),
      links: links(it.links),
      state: it.state === 'confirmed' ? 'confirmed' : 'open',
      at: Number(it.at) || 0,
      updatedAt: Number(it.updatedAt) || Number(it.at) || 0,
      ...(Number(it.confirmedAt) ? { confirmedAt: Number(it.confirmedAt) } : {}),
      ...(Array.isArray(it.issues) ? { issues: it.issues.filter((i: any) => i && typeof i.text === 'string').map((i: any) => ({ text: i.text, at: Number(i.at) || 0 })) } : {}),
    })
  }
  return { sid, name: typeof raw.name === 'string' && raw.name ? raw.name : name, items }
}

// Confirmed items older than REVIEW_KEEP_MS are dropped; open ones never are.
export function pruned(f: ReviewFile, now: number): ReviewFile {
  const items = f.items.filter((i) => i.state === 'open' || now - (i.confirmedAt ?? i.updatedAt) < REVIEW_KEEP_MS)
  return items.length === f.items.length ? f : { ...f, items }
}

export function openItems(f: ReviewFile): ReviewItem[] {
  return f.items.filter((i) => i.state === 'open')
}

// add: a new item, or the same id again (the same work's later step: its
// fields are overwritten). update: only an id already there. Either way the
// fields given replace the old ones, the ones left out stay, links pile up,
// and a confirmed item opens again: there is something new to look at.
export function upsert(f: ReviewFile, action: 'add' | 'update', input: Record<string, unknown>, now: number): { file: ReviewFile; item: ReviewItem; fresh: boolean } | string {
  const id = str(input.id, 80)
  if (!REVIEW_ID.test(id)) return 'id: letters, digits, . # _ - (max 60), e.g. the worker slug or cc-mods#85'
  const old = f.items.find((i) => i.id === id)
  if (action === 'update' && !old) return 'no review item ' + id + ' (add it first)'
  const given: Partial<ReviewItem> = {}
  for (const k of FIELDS) if (typeof input[k] === 'string' && str(input[k])) given[k] = str(input[k], k === 'title' ? 200 : TEXT_MAX)
  if (!old && !given.title) return 'a new item needs a title'
  if (!old && !given.changed && !given.check) return 'a new item needs what changed or what the person should check'
  const base: ReviewItem = old ?? { id, title: '', changed: '', verified: '', check: '', risk: '', links: [], state: 'open', at: now, updatedAt: now }
  const { confirmedAt: _drop, ...rest } = base
  const item: ReviewItem = { ...rest, ...given, links: links([...base.links, ...links(input.links)]), state: 'open', updatedAt: now }
  const items = old ? f.items.map((i) => (i.id === id ? item : i)) : [...f.items, item]
  return { file: pruned({ ...f, items }, now), item, fresh: !old }
}

// The person looked at it (in chat; the office writes its own confirms).
export function confirmed(f: ReviewFile, id: string, now: number): ReviewFile | string {
  const it = f.items.find((i) => i.id === id)
  if (!it) return 'no review item ' + id
  if (it.state === 'confirmed') return id + ' is already confirmed'
  return pruned({ ...f, items: f.items.map((i) => (i.id === id ? { ...i, state: 'confirmed' as const, confirmedAt: now, updatedAt: now } : i)) }, now)
}

export const countText = (f: ReviewFile) => '검토 대기 ' + openItems(f).length + '건'

const cell = (s: string) => s.replace(/\s*\n\s*/g, ' / ').replace(/\|/g, '\\|')

// coord_review list: the open items, oldest first, then how many were
// confirmed lately.
export function reviewTable(f: ReviewFile): string {
  const open = openItems(f).sort((a, b) => a.at - b.at)
  const done = f.items.filter((i) => i.state === 'confirmed').length
  const tail = done ? '\n' + done + ' confirmed in the last 7 days (kept as history).' : ''
  if (!open.length) return 'Review queue empty.' + tail
  const rows = open.map((i) => '| ' + i.id + ' | ' + cell(i.title) + ' | ' + cell(i.check || '-') + ' | ' + cell(i.risk || '-') + ' | ' + cell(i.issues?.at(-1)?.text ?? '-') + ' |')
  return countText(f) + '\n| id | title | check | risk | last issue |\n|---|---|---|---|---|\n' + rows.join('\n') + tail
}

// The line coordSection carries every turn, undefined with nothing open.
export function reviewLine(f: ReviewFile | undefined): string | undefined {
  const open = f ? openItems(f) : []
  if (!open.length) return undefined
  return 'Review queue (coord_review): ' + open.length + ' open — ' + open.map((i) => i.id + (i.issues?.length ? ' (issue)' : '')).join(', ') + '.'
}
