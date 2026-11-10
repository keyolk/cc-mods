// coord_route: which session a task goes to, judged by one cheap model call
// over the live sessions (the rows coord_roster shows, with what each was
// last asked), so the person never picks a session by hand. The router only
// answers; the coordinator acts on the answer with coord_send / coord_spawn,
// so every action stays in its transcript. Pure: coord.ts does the I/O.

import { EFFORTS, active, isEffort, typedLately, modelAlias, type Ledger, type Limits, type PaneSeen } from './coord'
import type { Place } from './coordplace'

export type Candidate = {
  name: string // SendMessage name
  slug?: string // the ledger's name, for coord_send
  relation: 'owned' | 'adopted' | 'observed'
  auto?: boolean // adopted automatically: a session the person runs, not one handed over
  pane: string
  state: string
  attention: string
  typed: boolean // the person prompted it in the last 10 minutes: worth saying, not a bar
  cwd: string
  code?: string // a worker's code outside its cwd
  repo?: string // the main checkout of the git repository its cwd is in
  title?: string // @title, the pane label the person set
  prompts: string[] // the newest few prompts it was given, oldest first
}

export type SessionInfo = { titles: Map<string, string>; prompts: Map<string, string[]>; repos: Map<string, string> }

// Every live session but the coordinator itself, once each.
export function candidates(seen: PaneSeen[], l: Ledger, names: Map<string, string>, info: SessionInfo, now: number): Candidate[] {
  const mine = new Map(active(l).map((w) => [w.sid, w]))
  const out: Candidate[] = []
  const done = new Set<string>([l.sid])
  for (const s of seen) {
    if (done.has(s.sid)) continue
    done.add(s.sid)
    const w = mine.get(s.sid)
    const title = info.titles.get(s.sid)?.trim()
    out.push({
      name: names.get(s.sid) ?? s.sid.slice(0, 8),
      ...(w ? { slug: w.slug } : {}),
      relation: w?.relation ?? 'observed',
      ...(w?.auto ? { auto: true } : {}),
      pane: s.pane,
      state: s.state || '?',
      attention: s.attention || 'none',
      typed: !!w && typedLately(w, now),
      cwd: s.cwd,
      ...(w?.code ? { code: w.code } : {}),
      ...(info.repos.get(s.cwd) ? { repo: info.repos.get(s.cwd) } : {}),
      ...(title ? { title: title.slice(0, 80) } : {}),
      prompts: info.prompts.get(s.sid) ?? [],
    })
  }
  return out
}

// `sid<TAB>["sid","text"]` lines from the transcript scan (coord.ts
// recentPrompts): per session, the newest PROMPTS_PER prompts, clipped. Tags
// (<task-notification>, <command-name>) are the harness's, not a task.
export const PROMPTS_PER = 3
const PROMPT_CLIP = 200
export function parsePrompts(out: string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const line of out.split('\n')) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') continue
    const text = row[1].replace(/\s+/g, ' ').trim()
    if (!text || text.startsWith('<')) continue
    m.set(row[0], [...(m.get(row[0]) ?? []), text.length > PROMPT_CLIP ? text.slice(0, PROMPT_CLIP) + '…' : text])
  }
  for (const [k, v] of m) m.set(k, v.slice(-PROMPTS_PER))
  return m
}

export const ROUTER_MODEL = 'haiku'

const SYSTEM = [
  'You route one task for a coordinator of Claude Code sessions. Pick where the task goes. Answer with one JSON object and nothing else.',
  'Actions:',
  '- "send": give it to an owned or adopted session already working in the right repository or directory. target: its slug. Every live session is adopted by default; one with "auto": true is a session the person runs themselves, adopted automatically: send to it only when its directory and recent prompts are on the same work.',
  '- "adopt": an observed session (one handed back, or with automatic adoption off) fits (same repository or directory, its recent prompts are on the same work). target: its name. The person hands it over, then it gets the task.',
  '- "spawn": start a new worker. Give repo_dir (a git checkout from the candidates\' repo or cwd values, or a path the task names) to work on a fresh worktree, or cwd to run in a directory as is; and model and effort, the smallest that fits the task, within the limits.',
  '- "unsure": the task does not say where it belongs and no candidate makes it clear. Say in reason what you would need to know.',
  'Rules:',
  '- Prefer a session already working in the right repository or directory, on related work.',
  '- Choose spawn only when no live session fits, or the one that fits is working (busy).',
  '- Never "send" to an observed session; for those the action is "adopt". "typed": true (the person prompted it lately) does not stop a send.',
  '- spawn is not possible when the owned workers are at maxWorkers: then pick a fitting session, or "unsure". Adopted sessions never count toward maxWorkers.',
  '- With spawn, also pick "window" from places: a window whose workers (by slug) work on the same repository or task; else the coordinator\'s window; "new" when no listed window fits or the work is unrelated to all of them.',
  'Shape: {"action":"send"|"adopt"|"spawn"|"unsure","target":"<slug or name>","repo_dir":"<path>","cwd":"<path>","model":"haiku|sonnet|opus","effort":"low|medium|high|xhigh|max","window":"<a places window id>|new","reason":"<one sentence>"}. Leave out keys that do not apply.',
].join('\n')

export function routeRequest(task: string, cands: Candidate[], limits: Limits, owned: number, places: Place[] = [{ window: 'new', kind: 'new' }]): { system: string; prompt: string } {
  const sessions = cands.map((c) => ({ ...c, prompts: c.prompts.length ? c.prompts : undefined }))
  return {
    system: SYSTEM,
    prompt: JSON.stringify({ task, limits: { models: limits.models, maxEffort: limits.maxEffort, maxWorkers: limits.maxWorkers, ownedWorkers: owned }, sessions, places }, null, 1),
  }
}

export type Raw = { action?: unknown; target?: unknown; repo_dir?: unknown; cwd?: unknown; model?: unknown; effort?: unknown; window?: unknown; reason?: unknown }

// The model's reply as an object: a fenced block or prose around it is cut
// away; anything that is not one JSON object is an error, never a guess.
export function parseRoute(text: string): Raw | { error: string } {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b < a) return { error: 'the router did not answer with JSON: ' + JSON.stringify(text.slice(0, 200)) }
  try {
    const o = JSON.parse(t.slice(a, b + 1))
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'the router answered JSON that is not an object' }
    return o as Raw
  } catch (e) {
    return { error: 'the router answered bad JSON (' + String(e) + '): ' + JSON.stringify(text.slice(0, 200)) }
  }
}

export type Decision =
  | { action: 'send'; target: Candidate; reason: string }
  | { action: 'adopt'; target: Candidate; reason: string }
  | { action: 'spawn'; repoDir?: string; cwd?: string; model: string; effort: string; window?: string; placeNote?: string; reason: string }
  | { action: 'unsure'; reason: string }

// What coord.ts found on disk for the paths the router named: repoTop the
// checkout's toplevel (null: not a git checkout), cwdOk whether it is a
// directory.
export type Paths = { repoTop?: string | null; cwdOk?: boolean }

const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')

// A window that is not one of `places` is dropped, not an error: the rest of
// the answer stands and coord_spawn places the worker by its default.
export function checkRoute(raw: Raw, cands: Candidate[], limits: Limits, owned: number, paths: Paths, places: Place[] = [{ window: 'new', kind: 'new' }]): Decision | { error: string } {
  const action = str(raw.action)
  const reason = str(raw.reason)
  if (!reason) return { error: 'the router gave no reason' }
  if (action === 'unsure') return { action, reason }
  if (action === 'send' || action === 'adopt') {
    const t = str(raw.target)
    const c = cands.find((x) => x.slug === t) ?? cands.find((x) => x.name === t || x.pane === t)
    if (!c) return { error: 'the router named ' + JSON.stringify(t) + ', which is no live session (' + cands.map((x) => x.slug ?? x.name).join(', ') + ')' }
    if (action === 'send' && c.relation === 'observed') return { error: 'the router chose send for ' + c.name + ', an observed session; observed sessions are adopted first, never instructed' }
    if (action === 'adopt' && c.relation !== 'observed') return { error: 'the router chose adopt for ' + c.name + ', already ' + c.relation }
    return { action, target: c, reason }
  }
  if (action !== 'spawn') return { error: 'the router answered action ' + JSON.stringify(raw.action) + '; expected send, adopt, spawn or unsure' }
  if (owned >= limits.maxWorkers) return { error: 'the router chose spawn, but ' + owned + ' workers already run (the limit ' + limits.maxWorkers + ')' }
  const repoDir = str(raw.repo_dir)
  const cwd = str(raw.cwd)
  if (!repoDir && !cwd) return { error: 'the router chose spawn without repo_dir or cwd' }
  if (repoDir && !paths.repoTop) return { error: 'the router chose repo_dir ' + repoDir + ', which is not a git checkout' }
  if (!repoDir && !paths.cwdOk) return { error: 'the router chose cwd ' + cwd + ', which is not a directory' }
  const model = modelAlias(str(raw.model))
  if (!limits.models.includes(model)) return { error: 'the router chose model ' + JSON.stringify(raw.model) + '; allowed: ' + limits.models.join(', ') }
  const effort = str(raw.effort)
  if (!isEffort(effort)) return { error: 'the router chose effort ' + JSON.stringify(raw.effort) + '; one of ' + EFFORTS.join(', ') }
  if (EFFORTS.indexOf(effort) > EFFORTS.indexOf(limits.maxEffort)) return { error: 'the router chose effort ' + effort + ', above the limit ' + limits.maxEffort }
  const win = str(raw.window)
  const place = win && places.some((p) => p.window === win) ? { window: win } : win ? { placeNote: 'the router chose window ' + JSON.stringify(win) + ', not one of ' + places.map((p) => p.window).join(', ') + '; coord_spawn places it by default' } : {}
  return repoDir ? { action, repoDir: paths.repoTop!, model, effort, ...place, reason } : { action, cwd, model, effort, ...place, reason }
}

// The tool's answer: the decision, its reason, and the call that acts on it.
export function routeText(d: Decision): string {
  const who = (c: Candidate) => (c.slug ?? c.name) + ' (pane ' + c.pane + ', ' + c.state + (c.attention !== 'none' ? '/' + c.attention : '') + ', ' + c.cwd + ')'
  if (d.action === 'send') return 'Route: send to ' + who(d.target) + '.\nReason: ' + d.reason + '\nNext: coord_send slug=' + d.target.slug + ' with the task' + (d.target.state === 'working' ? ' (it is mid-turn: the instruction waits for its turn to end)' : '') + '.'
  if (d.action === 'adopt') return 'Route: adopt ' + who(d.target) + '.\nReason: ' + d.reason + '\nNext: it is observed (handed back, or auto-adopt is off), so only the person can hand it over: ask them to run `/coord adopt ' + d.target.pane + '`, then coord_send it the task. If they say no, coord_spawn instead.'
  if (d.action === 'spawn') return 'Route: spawn a new worker ' + (d.repoDir ? 'on a worktree of ' + d.repoDir : 'in ' + d.cwd) + ', ' + d.model + '/' + d.effort + (d.window ? ', ' + (d.window === 'new' ? 'in a new window' : 'in window ' + d.window) : '') + '.\nReason: ' + d.reason + (d.placeNote ? '\nPlace: ' + d.placeNote + '.' : '') + '\nNext: coord_spawn ' + (d.repoDir ? 'repo_dir=' + d.repoDir : 'cwd=' + d.cwd) + ' model=' + d.model + ' effort=' + d.effort + (d.window ? ' window=' + d.window : '') + ', a slug for the task, and a brief with the person\'s words verbatim.'
  return 'Route: the router cannot tell.\nReason: ' + d.reason + '\nNext: ask the person where this goes (the recommended guess first).'
}
