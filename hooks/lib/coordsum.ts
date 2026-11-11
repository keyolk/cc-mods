// What each live session is doing, in one line: the office's 지휘 view and
// coord_roster / coord_route show it beside the session's name, so an
// adopted session (`gavin-jeong-63` in ~) says what it is without a visit to
// its pane. Cheapest source first: a name or pane label the person gave it
// (not one cut from its first prompt); its only prompt when that is short;
// else one model call for every session that needs one, fed its declared
// status (step → next) first and its newest prompts before its first, cached
// per session until its last prompt or its status changes. Pure:
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
  // What it declared with its status tool (lib/status.ts): the phase it is
  // in and its next action, the best word on what it does now.
  status?: { step?: string; next?: string; msg?: string }
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
// label the coordinator set is `w:<slug>`. Anything else the person typed,
// except a label cut from the first prompt (`first`): ~/.claude/hooks/
// tmux_pane_title.py writes the first prompt's head into @title, and as a
// "given name" it froze a worker as `사람의 말(원문): "slx를 좀 개선할수…`
// for its whole life (2026-11-12).
export function given(name: string | undefined, slug?: string, first?: string): string | undefined {
  const n = (name ?? '').trim()
  if (!n || n === slug || n.startsWith('w:') || /^[\w.-]+-[0-9a-f]{2}$/.test(n) || /^[0-9a-f]{8}$/.test(n)) return undefined
  if (RELAY.test(n)) return undefined
  const head = n.replace(/…$/, '').replace(/\s+/g, ' ').trim()
  const f = (first ?? '').replace(/\s+/g, ' ').trim()
  if (f && head.length >= 8 && f.startsWith(head) && f.length > head.length) return undefined
  return n
}

// The head a coordinator puts on what it hands on: the person's words
// quoted, a worker's report quoted, its own instruction. A label made of it
// names the hand-off, not the work.
const RELAY = /^(?:사람의 말\s*\(|worker 보고\s*\(|\[coordinator\]|\[coord\]|\[office→coord\])/

// A prompt with the relay head taken off: `사람의 말(원문): "slx를 …"` → `slx를 …`.
export function unrelay(text: string): string {
  const t = text.replace(/^\s*\[(?:coordinator|coord|office→coord)\]\s*/, '')
  const q = /^\s*(?:사람의 말|worker 보고)\s*\([^)]*\)\s*:\s*"?/.exec(t)
  if (!q) return t.trim()
  // The quote the head opened closes at the first `"`; what follows is the coordinator's.
  const rest = t.slice(q[0].length)
  return (q[0].endsWith('"') ? rest.split('"')[0]! : rest).trim()
}

// The status as one line for the key and the model: what changes when the
// worker moves to a new phase.
const statusText = (st: SumIn['status']) => [st?.step, st?.next].filter(Boolean).join(' → ')

export function clip(s: string, n = SUM_CHARS): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// The cache key: a summary stands until the session is renamed, prompted
// again, or declares a new phase (its status step/next).
const keyOf = (r: SumIn) => [r.title ?? '', r.name, r.last ?? String(r.prompts.length), statusText(r.status)].join('|')

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
    const name = given(r.title, r.slug, r.first) ?? given(r.name, r.slug, r.first)
    if (name) {
      next[r.sid] = { text: clip(name), src: 'name', key, at: now }
      continue
    }
    const first = r.first ?? r.prompts[0]
    // A status with no prompt to read is still worth a label.
    if (!first && !statusText(r.status)) continue
    if (!first) {
      next[r.sid] = { text: old?.text || clip(r.status!.step || r.status!.next || ''), src: 'first', key, at: now }
      if (ask.length < SUM_BATCH) ask.push(r)
      continue
    }
    const only = r.prompts.length <= 1 && (!r.prompts[0] || r.prompts[0] === first)
    if (only && !statusText(r.status) && !RELAY.test(first) && first.replace(/\s+/g, ' ').trim().length <= SUM_CHARS) {
      next[r.sid] = { text: clip(first), src: 'prompt', key, at: now }
      continue
    }
    // Shown until the call answers, and kept if it fails: the label it had
    // (a step alone, "구현" or "PR #5 READY", names no subject), else its
    // first prompt without the relay head.
    next[r.sid] = { text: old?.text || clip(unrelay(first)), src: 'first', key, at: now }
    if (ask.length < SUM_BATCH) ask.push(r)
  }
  return { next, ask }
}

const SYSTEM = [
  'You label Claude Code sessions for a dashboard. For each session, write what it is working on NOW, in Korean, as a noun phrase of about 20 characters (at most 40), like "warren credential broker 설계", "slx Jev 판정" or "office 지휘 view 정리".',
  '`status` is what the session itself declared about its current phase (step → next): when given, name that work. Otherwise read its newest prompts before its first one: the work moves on, and the first prompt is often only how the task was handed over.',
  'Name the subject and the work, never the request: not "세션 다시 로드", "상태 보고", "질문", "원인 조사 요청", and never quote the person.',
  'Answer with one JSON object and nothing else: {"<id>": "<label>", ...}, one key per session id given.',
].join('\n')

export function sumRequest(rows: SumIn[]): { system: string; prompt: string } {
  const sessions = rows.map((r) => ({
    id: r.sid,
    cwd: r.cwd,
    status: statusText(r.status) ? clip([statusText(r.status), r.status?.msg].filter(Boolean).join(' · '), 300) : undefined,
    recent: r.prompts.length ? r.prompts.map((p) => clip(unrelay(p), 200)) : undefined,
    first: r.first ? clip(unrelay(r.first), 400) : undefined,
  }))
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

// A coordinator's own prompts are mostly not the person's: worker reports
// (`[worker x] READY …`), brief answers, review verdicts, the plugin's
// notices, other sessions' messages. Its summary was made of those, and its
// key (the newest prompt's time) moved on each one; it also skipped itself,
// so cc-mods-d9 kept "대화 스크롤 키 바인딩 변경 및 PR 막힘 처리" from
// 2026-11-10 in the person's 내 차례. Only the person's words are kept, so
// the label says what they asked of it and changes when they speak again.
// What the office's task box sends (office/command.py say) is the person's,
// with its tag taken off.
export function fromPerson(text: string): string | undefined {
  const t = text.trim()
  const office = /^\[office→coord\]\s*(?:\(re: [^)]*\)\s*)?([\s\S]+)/.exec(t)
  if (office) return office[1]!.trim()
  if (!t || /^(?:\[|<|The cc-mods plugin sent|Another Claude session|(?:READY|DONE|NOTE|QUESTION|BLOCKED)\b)/.test(t)) return undefined
  return t
}

// `["sid","text","time"]` lines (coord.ts PROMPTS_SH, FIRST_SH) with only
// the person's words left.
export function personLines(out: string): string {
  const keep: string[] = []
  for (const line of out.split('\n')) {
    try {
      const r = JSON.parse(line)
      const t = Array.isArray(r) && typeof r[1] === 'string' ? fromPerson(r[1]) : undefined
      if (t) keep.push(JSON.stringify([r[0], t, ...r.slice(2)]))
    } catch {}
  }
  return keep.join('\n')
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
