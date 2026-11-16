// The decision briefs a coordinator asked (`brief ask --coordinator <sid>`),
// as its workers context carries them every turn: the ones the person has
// not answered, and the ones answered but not yet passed to their worker.
//
// Before this the coordinator knew a brief was answered only from the
// `[brief answer]` prompt the office sends once. A prompt lost to a reload or
// to compaction left it with nothing: live 2026-11-12..16 it kept saying
// "결정 2건 대기" for three days while the office showed none pending, and
// the cepext answer ("11-16 함께") never reached its worker. The sidecars
// (~/briefs/<name>.brief.json) are the record; this reads them.
//
// Relayed: a `coord_send` to the brief's worker that names the brief file
// after its answer (hooks/coord.ts stamps Ledger.relayed). Done (`brief
// done`) is handled too. Pure: hooks/coord.ts reads the files.

export type BriefQ = {
  brief: string // the file's name without .brief.json
  id: string
  question: string
  worker?: string
  asked?: string
  answer?: { choice: string; note?: string; at: string; by?: string }
}

// A brief's questions this coordinator asked, as its sidecar holds them: in
// `decisions`, or a sidecar from before that holds one in `decision` (q1),
// as office/command.py _decisions reads it. A broken file: none.
export function briefQuestions(brief: string, json: string, coordSid: string): { qs: BriefQ[]; done: boolean } {
  let d: any
  try {
    d = JSON.parse(json)
  } catch {
    return { qs: [], done: false }
  }
  if (!d || typeof d !== 'object') return { qs: [], done: false }
  const raw: unknown[] = Array.isArray(d.decisions) ? d.decisions : d.decision && typeof d.decision === 'object' ? [d.decision] : []
  const qs: BriefQ[] = []
  raw.forEach((q: any, i) => {
    if (!q || typeof q !== 'object' || q.coordinator !== coordSid || typeof q.question !== 'string') return
    const a = q.answer && typeof q.answer === 'object' && q.answer.choice != null ? { choice: String(q.answer.choice), note: q.answer.note ? String(q.answer.note) : undefined, at: String(q.answer.at ?? ''), by: q.answer.by ? String(q.answer.by) : undefined } : undefined
    qs.push({ brief, id: String(q.id ?? 'q' + (i + 1)), question: q.question, worker: typeof q.worker === 'string' && q.worker ? q.worker : undefined, asked: typeof q.asked === 'string' ? q.asked : undefined, answer: a })
  })
  const done = !!(d.done && typeof d.done === 'object' && String(d.done.result ?? '').trim())
  return { qs, done }
}

// The brief CLI writes minutes only (2026-11-12T15:55Z).
export function briefTime(s: string | undefined): number {
  const t = Date.parse(/T\d\d:\d\dZ$/.test(s ?? '') ? s!.slice(0, -1) + ':00Z' : (s ?? ''))
  return Number.isFinite(t) ? t : 0
}

// An answer older than this that was never relayed is history, not a drift:
// the briefs folder holds every coordinator's past weeks.
export const UNRELAYED_MAX_MS = 7 * 24 * 3600_000
export const LIST_MAX = 5

export type BriefState = {
  open: BriefQ[]
  unrelayed: BriefQ[]
}

// From every brief file read (name → text): the questions still open, and
// the answered ones not relayed, not done, not recorded by the coordinator
// itself, answered in the last week, whose
// worker is one this ledger has live (or none named: the coordinator's own)
// and was asked nothing newer since (a newer brief to it supersedes).
// `relayed`: brief → when a coord_send last named it. `live`: the slugs of
// the active workers.
export function briefState(files: ReadonlyMap<string, string>, coordSid: string, relayed: Readonly<Record<string, number>>, live: ReadonlySet<string>, now: number): BriefState {
  const open: BriefQ[] = []
  const unrelayed: BriefQ[] = []
  const all = [...files].map(([brief, json]) => ({ brief, ...briefQuestions(brief, json, coordSid) })).filter((b) => b.qs.length)
  // The newest ask per worker: an older brief to the same worker was
  // superseded by it (live 2026-11-16: cepext-ap2's "11-16 함께" was
  // narrowed by the 11-16 cepext-recent-hits brief; pushing the old answer
  // into a session doing prod deletes would undo that).
  const asked = (qs: BriefQ[]) => Math.max(0, ...qs.map((q) => briefTime(q.asked)))
  const newest = new Map<string, number>()
  for (const b of all) for (const q of b.qs) if (q.worker) newest.set(q.worker, Math.max(newest.get(q.worker) ?? 0, briefTime(q.asked)))
  for (const { brief, qs, done } of all) {
    const waiting = qs.filter((q) => !q.answer)
    if (waiting.length) {
      open.push(...waiting)
      continue
    }
    // Recorded by the coordinator itself (`brief answer --by coordinator`:
    // the person picked in the worker's pane, live 2026-11-13): it knows.
    if (done || qs.every((q) => q.answer!.by === 'coordinator')) continue
    const at = Math.max(...qs.map((q) => briefTime(q.answer!.at)))
    if (!at || now - at > UNRELAYED_MAX_MS) continue
    if ((relayed[brief] ?? 0) >= at) continue
    const w = qs.find((q) => q.worker)?.worker
    if (w && !live.has(w)) continue
    if (w && (newest.get(w) ?? 0) > asked(qs)) continue
    unrelayed.push(...qs)
  }
  const byAsked = (a: BriefQ, b: BriefQ) => briefTime(a.asked) - briefTime(b.asked) || a.brief.localeCompare(b.brief)
  return { open: open.sort(byAsked), unrelayed: unrelayed.sort((a, b) => briefTime(a.answer?.at) - briefTime(b.answer?.at) || a.brief.localeCompare(b.brief)) }
}

// The roster's lines: `결정 대기 N: <brief>, …` and one per brief answered
// with no relay on record. A record, not an order: the coordinator checks
// whether the worker already has it (a relay before this record was kept, a
// later instruction) and decides.
export function decisionLines(s: BriefState): string {
  const out: string[] = []
  const briefs = [...new Set(s.open.map((q) => q.brief))]
  if (briefs.length) out.push('결정 대기 ' + briefs.length + ' (the person has not answered; they are in the office, do not ask again): ' + briefs.slice(0, LIST_MAX).join(', ') + (briefs.length > LIST_MAX ? ' 외 ' + (briefs.length - LIST_MAX) : '') + '.')
  else out.push('결정 대기 0: no decision brief of yours waits on the person.')
  const by = new Map<string, BriefQ[]>()
  for (const q of s.unrelayed) by.set(q.brief, [...(by.get(q.brief) ?? []), q])
  for (const [brief, qs] of [...by].slice(0, LIST_MAX)) {
    const w = qs.find((q) => q.worker)?.worker
    const said = qs.map((q) => (qs.length > 1 ? q.id + ' ' : '') + '"' + q.answer!.choice + '"' + (q.answer!.note ? ' — ' + q.answer!.note : '')).join(', ')
    out.push('확인 필요: 답 받았으나 전달 기록 없음 — ' + brief + ' → ' + (w ?? '(no worker)') + ': ' + said + ' (answered ' + qs[0]!.answer!.at + ').')
  }
  if (by.size > LIST_MAX) out.push('확인 필요: 답 받았으나 전달 기록 없음 외 ' + (by.size - LIST_MAX) + '건.')
  return out.join('\n')
}

// The briefs a coord_send text names: `<name>.html` (with or without the
// ~/briefs/ path before it).
export function briefsNamed(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|[\s/(`"'])(\d{4}-\d\d-\d\d-[A-Za-z0-9._-]+?)\.(?:html|brief\.json)\b/g)].map((m) => m[1]!))]
}

// The relayed map with the ledger's send log folded in: a send logged
// before Ledger.relayed was kept (the log holds its first 200 characters,
// where a `[brief answer] <path>` relay names the brief) counts too.
export function withLogged(relayed: Readonly<Record<string, number>> | undefined, log: readonly { at: number; kind: string; text: string }[]): Record<string, number> {
  const out = { ...(relayed ?? {}) }
  for (const e of log) if (e.kind === 'send') for (const b of briefsNamed(e.text)) out[b] = Math.max(out[b] ?? 0, e.at)
  return out
}

export const RELAYED_MAX = 200

// The ledger's relayed map with the briefs `text` names stamped `now`,
// capped to the newest RELAYED_MAX.
export function stampRelayed(relayed: Readonly<Record<string, number>> | undefined, text: string, now: number): Record<string, number> | undefined {
  const named = briefsNamed(text)
  if (!named.length) return undefined
  const next = { ...(relayed ?? {}) }
  for (const b of named) next[b] = now
  const keep = Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, RELAYED_MAX)
  return Object.fromEntries(keep)
}
