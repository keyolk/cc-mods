// What each live session was doing, in one line: the office's 지휘 view and
// coord_roster / coord_route show it beside the session's name, so an
// adopted session (`gavin-jeong-63` in ~) says what it is without a visit to
// its pane. Cheapest source first: a name or pane label the person gave it;
// its only prompt when that is short; else one model call for every session
// that needs one, cached per session until its last prompt changes. Pure:
// coord.ts reads the transcripts, calls the model and writes the cache
// (~/.claude/state/office/summary.json), which the office reads.

export type Summary = { text: string; src: 'name' | 'prompt' | 'model' | 'first'; key: string; at: number }
export type Summaries = Record<string, Summary>

export type SumIn = {
  sid: string
  name: string // SendMessage name
  slug?: string // the coordinator's slug for it
  title?: string // @title, the pane label
  cwd: string
  first?: string // the first prompt it was given
  prompts: string[] // the newest few, oldest first
  last?: string // when its newest prompt was given (the transcript's timestamp)
}

export const SUM_MODEL = 'haiku'
export const SUM_CHARS = 40
// A summary that fell back to the first prompt (the call failed) is asked
// again after this, not on every tick.
export const SUM_RETRY_MS = 10 * 60_000
// One call holds at most this many sessions; the rest wait for the next.
export const SUM_BATCH = 20

// Claude Code's own names are a word and two hex digits (gavin-jeong-63,
// cc-mods-d9, 2026-10-13-common-gw-0e); coord_spawn's are the slug; a pane
// label the coordinator set is `w:<slug>`. Anything else the person typed.
export function given(name: string | undefined, slug?: string): string | undefined {
  const n = (name ?? '').trim()
  if (!n || n === slug || n.startsWith('w:') || /^[\w.-]+-[0-9a-f]{2}$/.test(n) || /^[0-9a-f]{8}$/.test(n)) return undefined
  return n
}

export function clip(s: string, n = SUM_CHARS): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// The cache key: a summary stands until the session is renamed or prompted again.
const keyOf = (r: SumIn) => [r.title ?? '', r.name, r.last ?? String(r.prompts.length)].join('|')

// The summaries that stand without a model (kept, a given name, a lone short
// prompt, or the first prompt while the call is out) and the sessions the
// call should be asked about.
export function plan(rows: SumIn[], cache: Summaries, now: number): { next: Summaries; ask: SumIn[] } {
  const next: Summaries = {}
  const ask: SumIn[] = []
  for (const r of rows) {
    const key = keyOf(r)
    const old = cache[r.sid]
    if (old && old.key === key && (old.src !== 'first' || now - old.at < SUM_RETRY_MS)) {
      next[r.sid] = old
      continue
    }
    const name = given(r.title, r.slug) ?? given(r.name, r.slug)
    if (name) {
      next[r.sid] = { text: clip(name), src: 'name', key, at: now }
      continue
    }
    const first = r.first ?? r.prompts[0]
    if (!first) continue
    const only = r.prompts.length <= 1 && (!r.prompts[0] || r.prompts[0] === first)
    if (only && first.replace(/\s+/g, ' ').trim().length <= SUM_CHARS) {
      next[r.sid] = { text: clip(first), src: 'prompt', key, at: now }
      continue
    }
    // Shown until the call answers, and kept if it fails.
    next[r.sid] = { text: clip(first), src: 'first', key, at: now }
    if (ask.length < SUM_BATCH) ask.push(r)
  }
  return { next, ask }
}

const SYSTEM = [
  'You label Claude Code sessions for a dashboard. For each session, write what it was working on, in Korean, as a noun phrase of about 20 characters (at most 40), like "Twingate relay 실패율 조사" or "office 지휘 view 정리".',
  'Read its first prompt and its newest prompts; name the work, not the tool. Prompts starting with [coordinator] are instructions from a coordinator session.',
  'Answer with one JSON object and nothing else: {"<id>": "<label>", ...}, one key per session id given.',
].join('\n')

export function sumRequest(rows: SumIn[]): { system: string; prompt: string } {
  const sessions = rows.map((r) => ({ id: r.sid, cwd: r.cwd, first: r.first ? clip(r.first, 400) : undefined, recent: r.prompts.length ? r.prompts.map((p) => clip(p, 200)) : undefined }))
  return { system: SYSTEM, prompt: JSON.stringify({ sessions }, null, 1) }
}

// The model's labels for the sessions asked about; anything else is dropped.
export function parseSums(text: string, rows: SumIn[]): Map<string, string> {
  const out = new Map<string, string>()
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b < a) return out
  let o: unknown
  try {
    o = JSON.parse(t.slice(a, b + 1))
  } catch {
    return out
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out
  for (const r of rows) {
    const v = (o as Record<string, unknown>)[r.sid]
    if (typeof v === 'string' && v.trim()) out.set(r.sid, clip(v))
  }
  return out
}

// The plan with the model's labels in; the sessions it skipped keep the first prompt.
export function applied(next: Summaries, labels: Map<string, string>, now: number): Summaries {
  const out = { ...next }
  for (const [sid, text] of labels) if (out[sid]) out[sid] = { ...out[sid]!, text, src: 'model', at: now }
  return out
}

export function parseSummaries(raw: string | undefined): Summaries {
  if (!raw) return {}
  try {
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: Summaries = {}
    for (const [k, v] of Object.entries(o as Record<string, any>)) if (v && typeof v.text === 'string' && typeof v.key === 'string') out[k] = v as Summary
    return out
  } catch {
    return {}
  }
}

// The first prompt of each session: `["sid","text"]` lines (coord.ts FIRST_SH),
// harness tags skipped as parsePrompts skips them.
export function parseFirst(out: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of out.split('\n')) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string' || m.has(row[0])) continue
    const text = row[1].replace(/\s+/g, ' ').trim()
    if (text && !text.startsWith('<')) m.set(row[0], text.slice(0, 400))
  }
  return m
}

// When each session's newest prompt was given: the third column of the
// PROMPTS_SH rows (its transcript timestamp).
export function parseLast(out: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of out.split('\n')) {
    try {
      const row = JSON.parse(line)
      if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[2] === 'string') m.set(row[0], row[2])
    } catch {}
  }
  return m
}
