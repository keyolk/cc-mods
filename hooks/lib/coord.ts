// Coordinator mode: one session (the one the person turned it on in) hands
// work to worker sessions, each a claude in a pane split off the
// coordinator's own (its own window only when that pane is too small), checks
// what they report, and asks the person before anything their decision rides
// on.
//
// The ledger is the one record of who is whose. It lives in
// ~/.claude/state/office/coord/<coordinator sid>.json, written by the
// coordinator's cc-mods and read by the office (office/coord.py), so the
// office draws the same relations the coordinator acts on.
//
// Relations, by session id:
//   owned     a worker this coordinator started (its pane, its worktree)
//   adopted   a session that was already running: every live session is
//             adopted while the mode is on (auto), unless the person turned
//             that off (/coord limits adopt off) or released it; or handed
//             over by the person (/coord adopt)
//   observed  every other live session: read, never instructed (released
//             ones, another coordinator and its owned workers)
//
// Workers are started by this mod, never by Claude's Bash: the tmux guard
// keeps Claude's commands in its own window, and a worker's pane (or, as a
// fallback, window) is made by code that checks the person's limits first.
// Pure: the mod does the I/O.

import type { Cap, CapValue, Policy } from './policy'
import { ONE_BROWSER } from './webpane'
import { grantRule } from './grant'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export type Relation = 'owned' | 'adopted'

// maxWorkers counts owned workers only: an adopted session was running
// before and costs nothing new. autoAdopt: every live session becomes an
// adopted worker while the mode is on.
export type Limits = { models: string[]; maxEffort: Effort; maxWorkers: number; autoAdopt: boolean }
// What a coordinator may hand out until the person says otherwise.
export const DEFAULT_LIMITS: Limits = { models: ['haiku', 'sonnet', 'opus'], maxEffort: 'high', maxWorkers: 4, autoAdopt: true }

export type Worker = {
  slug: string
  sid: string
  relation: Relation
  pane?: string
  window?: string
  // What coord_spawn made, as tmux answered it: the one pane (or fallback
  // window) coord_close may kill. pane/window above follow the session.
  made?: Made
  cwd: string
  worktree?: string // owned and made here: removed when the worker is closed
  repoDir?: string // the checkout the worktree came from
  repo?: string
  model?: string
  effort?: Effort
  brief?: string // the prompt file
  addDirs?: string[] // --add-dir: folders outside cwd its tools may reach
  code?: string // its code, when that is not its cwd (a repository Claude Code does not trust)
  at: number
  state?: string // the last @cc_pane_state seen
  attention?: string
  asks?: string // the tool call a permission ask waits on (@cc_pane_asks)
  asked?: string // what the coordinator was last woken for: the call, or the attention
  typedAt?: number // the person's last prompt in the worker's own pane
  // Adopted by autoAdopt, not handed over by the person. Until the
  // coordinator first instructs it (instructed), the person is the one
  // driving it: its turns and asks wake nobody (quiet).
  auto?: boolean
  instructed?: number
  endedAt?: number
  // Ticks in a row no pane named it and no live claude was found for it: one
  // such tick is not gone (MISSES_FOR_GONE).
  missed?: number
  // When observe took it for gone (endedAt then too). Seen in a pane again,
  // it was alive all along: observe takes it back as it was, owned or
  // adopted, and autoAdopt does not adopt its session anew.
  goneAt?: number
  // MCP servers its cc-mods reports down and past retrying alone
  // (state/office/mcp/<sid>.json `stuck`), by name: told to the coordinator
  // once each until they come back (mcpWakes).
  mcpDown?: string[]
}

export type LogEntry = { at: number; kind: 'order' | 'spawn' | 'adopt' | 'release' | 'close' | 'send' | 'event' | 'limits'; text: string }

export type Ledger = {
  on: boolean
  sid: string
  name: string // the coordinator's SendMessage name
  pane?: string
  limits: Limits
  workers: Worker[]
  log: LogEntry[]
  // Sessions handed back (coord_close or /coord release of an adopted one):
  // never adopted again by autoAdopt; /coord adopt takes one back.
  released: string[]
  at: number
  policyBefore?: Policy // this session's policy before /coord on, put back by /coord off
  mcpDown?: string[] // the coordinator's own, as Worker.mcpDown
}

export const LOG_MAX = 200
// The person's prompt in a worker's pane this recent is named in
// coord_send's result, as a note. It refuses nothing: an instruction is a
// peer message (or, failing that, an office inbox prompt), and the draft in
// their composer stays where it is.
export const TYPED_MS = 10 * 60_000
export const SPAWN_GRACE_MS = 60_000
// Live (2026-11-10 20:16): one tick found no pane and no live claude for all
// 22 workers at once, all alive; the owned ones came back as adopted. Gone
// takes two ticks in a row (10 s apart) that both miss it.
export const MISSES_FOR_GONE = 2
export const RELEASED_MAX = 200

export function emptyLedger(sid: string, name: string, now: number): Ledger {
  return { on: false, sid, name, limits: { ...DEFAULT_LIMITS }, workers: [], log: [], released: [], at: now }
}

export function parseLedger(json: string | undefined, sid: string, name: string, now: number): Ledger {
  let raw: any
  try {
    raw = json ? JSON.parse(json) : undefined
  } catch {
    raw = undefined
  }
  if (!raw || typeof raw !== 'object') return emptyLedger(sid, name, now)
  const lim = raw.limits ?? {}
  const models = Array.isArray(lim.models) ? lim.models.filter((m: unknown) => typeof m === 'string') : DEFAULT_LIMITS.models
  return {
    on: raw.on === true,
    sid,
    name: typeof raw.name === 'string' && raw.name ? raw.name : name,
    pane: typeof raw.pane === 'string' ? raw.pane : undefined,
    limits: {
      models: models.length ? models : DEFAULT_LIMITS.models,
      maxEffort: isEffort(lim.maxEffort) ? lim.maxEffort : DEFAULT_LIMITS.maxEffort,
      maxWorkers: Number.isInteger(lim.maxWorkers) && lim.maxWorkers > 0 ? lim.maxWorkers : DEFAULT_LIMITS.maxWorkers,
      // A ledger from before the setting adopts too: only an explicit off stays off.
      autoAdopt: lim.autoAdopt !== false,
    },
    workers: Array.isArray(raw.workers) ? raw.workers.filter((w: any) => w && typeof w.slug === 'string' && typeof w.sid === 'string') : [],
    log: Array.isArray(raw.log) ? raw.log.slice(-LOG_MAX) : [],
    released: Array.isArray(raw.released) ? raw.released.filter((x: unknown) => typeof x === 'string').slice(-RELEASED_MAX) : [],
    policyBefore: raw.policyBefore && typeof raw.policyBefore === 'object' ? raw.policyBefore : undefined,
    mcpDown: Array.isArray(raw.mcpDown) ? raw.mcpDown.filter((x: unknown) => typeof x === 'string') : undefined,
    at: Number(raw.at) || now,
  }
}

export function logged(l: Ledger, kind: LogEntry['kind'], text: string, now: number): Ledger {
  return { ...l, at: now, log: [...l.log, { at: now, kind, text }].slice(-LOG_MAX) }
}

export function isEffort(x: unknown): x is Effort {
  return typeof x === 'string' && (EFFORTS as readonly string[]).includes(x)
}

// Short model names to the CLI's aliases; a full id passes through.
export function modelAlias(m: string): string {
  const s = m.trim().toLowerCase()
  for (const a of MODELS) if (s === a || s.startsWith('claude-' + a)) return a
  return s
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/

export function active(l: Ledger): Worker[] {
  return l.workers.filter((w) => !w.endedAt)
}

export type SpawnRequest = { slug: string; model: string; effort: string; cwd?: string; repoDir?: string; brief: string; addDirs?: unknown }

// Why the coordinator may not start this worker, or undefined when it may.
// The limits are the person's; the answer names the command that changes them.
export function spawnRefusal(l: Ledger, r: SpawnRequest): string | undefined {
  if (!l.on) return 'coordinator mode is off; the person turns it on with /coord on'
  if (!SLUG.test(r.slug)) return 'slug must be lowercase letters, digits and dashes (max 40), starting with a letter or digit'
  if (active(l).some((w) => w.slug === r.slug)) return 'a worker named ' + r.slug + ' is already in the ledger'
  if (active(l).filter((w) => w.relation === 'owned').length >= l.limits.maxWorkers)
    return 'already ' + l.limits.maxWorkers + ' workers running (the limit); close one, or ask the person to raise it with /coord limits workers <n>'
  const m = modelAlias(r.model)
  if (!l.limits.models.includes(m)) return 'model ' + m + ' is not allowed (allowed: ' + l.limits.models.join(', ') + '); ask the person, who can change it with /coord limits models <list>'
  if (!isEffort(r.effort)) return 'effort must be one of ' + EFFORTS.join(', ')
  if (EFFORTS.indexOf(r.effort) > EFFORTS.indexOf(l.limits.maxEffort))
    return 'effort ' + r.effort + ' is above the limit ' + l.limits.maxEffort + '; ask the person, who can change it with /coord limits effort <level>'
  if (!r.brief.trim()) return 'the brief is empty'
  if (!r.repoDir && !r.cwd) return 'give repo_dir (a worktree is made off origin) or cwd (the worker runs there as is)'
  if (r.addDirs !== undefined && (!Array.isArray(r.addDirs) || r.addDirs.some((d) => typeof d !== 'string' || !/^[~/]/.test(d.trim()))))
    return 'add_dirs: a list of absolute (or ~/) directory paths'
  return undefined
}

// ---- adoption ------------------------------------------------------------------
// While the mode is on every live session is an adopted worker, so the
// coordinator can hand any of them a task without asking the person to type
// /coord adopt first (live: an opinion meant for the ops-k8s session waited
// on that). Not adopted: the coordinator itself, another coordinator that is
// on and its owned workers (`foreign`), and a session handed back (released).

// A worker slug from the session's name: SLUG-shaped, and not one an active
// worker already has (the sid's start tells two of the same name apart).
export function adoptSlug(name: string | undefined, sid: string, taken: ReadonlySet<string>): string {
  const clean = (x: string) => x.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '')
  const base = clean(name ?? '').slice(0, 40).replace(/-+$/, '') || clean(sid).slice(0, 8)
  if (!taken.has(base)) return base
  const tag = clean(sid).slice(0, 4)
  for (let i = 0; ; i++) {
    const s = base.slice(0, 34).replace(/-+$/, '') + '-' + tag + (i ? String(i) : '')
    if (!taken.has(s)) return s
  }
}

// The sessions other coordinators keep: each one that is on, and its live
// owned workers. `ledgers`: the other ledger files, one JSON each.
export function foreign(ledgers: readonly string[], self: string): Set<string> {
  const out = new Set<string>()
  for (const json of ledgers) {
    let d: any
    try {
      d = JSON.parse(json)
    } catch {
      continue
    }
    if (!d || d.on !== true || typeof d.sid !== 'string' || d.sid === self) continue
    out.add(d.sid)
    for (const w of Array.isArray(d.workers) ? d.workers : []) if (w && typeof w.sid === 'string' && !w.endedAt && (w.relation ?? 'owned') === 'owned') out.add(w.sid)
  }
  return out
}

// A worker the person still drives: adopted by autoAdopt and never
// instructed by the coordinator. Its changes update the ledger but wake
// nobody: the person typing in their own session is not news.
export function quiet(w: Worker): boolean {
  return !!w.auto && !w.instructed
}

// The ledger with every live session adopted that is not yet a worker, and
// the ones adopted now. A quiet worker that has since become `foreign` (it
// turned coordinator) is dropped, and so is an ended quiet one: neither says
// anything the ledger needs, and the list would grow with every session that
// came and went.
export function autoAdopt(l: Ledger, seen: readonly PaneSeen[], names: ReadonlyMap<string, string>, skip: ReadonlySet<string>, now: number): { ledger: Ledger; adopted: Worker[] } {
  if (!l.on || !l.limits.autoAdopt) return { ledger: l, adopted: [] }
  // Taken for gone and seen again: observe takes that record back.
  const back = comesBack(l, seen)
  const revived = (w: Worker) => back.has(w)
  const kept = l.workers.filter((w) => !(quiet(w) && ((w.endedAt && !revived(w)) || skip.has(w.sid))))
  const mine = new Set(kept.filter((w) => !w.endedAt || revived(w)).map((w) => w.sid))
  const taken = new Set(kept.filter((w) => !w.endedAt || revived(w)).map((w) => w.slug))
  const handed = new Set(l.released)
  const adopted: Worker[] = []
  for (const s of seen) {
    if (s.sid === l.sid || mine.has(s.sid) || handed.has(s.sid) || skip.has(s.sid)) continue
    mine.add(s.sid)
    const slug = adoptSlug(names.get(s.sid), s.sid, taken)
    taken.add(slug)
    // typedAt: the person's last prompt there, from before its adoption too.
    adopted.push({ slug, sid: s.sid, relation: 'adopted', auto: true, pane: s.pane, window: s.window, cwd: s.cwd, at: now, state: s.state, attention: s.attention, asks: s.asks, typedAt: s.humanAt })
  }
  if (!adopted.length && kept.length === l.workers.length) return { ledger: l, adopted }
  const next = { ...l, at: now, workers: [...kept, ...adopted] }
  return { ledger: adopted.length ? logged(next, 'adopt', 'auto: ' + adopted.map((w) => w.slug + ' (' + w.pane + ')').join(', '), now) : next, adopted }
}

// Auto-adopt turned off: the quiet workers go back to observed (not
// released: turned on again, they are adopted again). One the coordinator
// has instructed stays until it is closed.
export function unadopt(l: Ledger, now: number): Ledger {
  const drop = active(l).filter(quiet)
  return drop.length ? logged({ ...l, workers: l.workers.filter((w) => !drop.includes(w)) }, 'adopt', 'auto off: ' + drop.map((w) => w.slug).join(', ') + ' observed again', now) : l
}

// An adopted worker handed back to the person: ended, and recorded so
// autoAdopt leaves it alone from now on.
export function released(l: Ledger, w: Worker, now: number): Ledger {
  const r = [...l.released.filter((x) => x !== w.sid), w.sid].slice(-RELEASED_MAX)
  return logged({ ...l, released: r, workers: l.workers.map((x) => (x.sid === w.sid && !x.endedAt ? { ...x, endedAt: now } : x)) }, 'release', w.slug, now)
}

// Requests the office left for this coordinator (office/crew.py writes
// coord/ops/<sid>.json): `release` takes a worker off the view for good, as
// /coord release does. The ledger is this process's to write, so the office
// asks rather than edits it. An op for a session that is no worker (any
// more) is dropped; `done` names the workers released.
export function applyOps(l: Ledger, raw: string | undefined, now: number): { ledger: Ledger; done: string[] } {
  let ops: unknown[] = []
  try {
    const d = JSON.parse(raw ?? '{}')
    if (Array.isArray(d?.ops)) ops = d.ops
  } catch {}
  let out = l
  const done: string[] = []
  for (const o of ops) {
    if (!o || typeof o !== 'object' || (o as { op?: unknown }).op !== 'release') continue
    const w = active(out).find((x) => x.sid === (o as { sid?: unknown }).sid)
    if (!w) continue
    out = released(out, w, now)
    done.push(w.slug)
  }
  return { ledger: out, done }
}

// The cost cap on a decision brief, the same for the coordinator and its
// workers. The person asked that asking them never burn many tokens; the
// office already lists the question and each option's detail from the
// sidecar, so the page only has to explain, briefly. `brief ask --new`
// (keyolk/briefs#2) writes that page itself, about 1 KB, from the arguments.
export const DECISION_BRIEF =
  'A decision brief is made by `brief ask --new <slug> --context "<background, at most 5 lines>" --question Q --option "label: detail" ... --recommend N`: ' +
  'a minimal page (about 1 KB) and its sidecar, with no HTML written by hand and not the full doc:visual-brief workflow. ' +
  'At most 4 options; each detail carries the option\'s cost in under 100 characters (the office shows it as is). ' +
  'Write the page yourself only when a figure is truly needed: one short page with at most one small inline SVG, under 8 KB; no tabs, no second figure, no re-telling of the research (link the research brief instead), no external CSS or scripts; then `brief ask <brief>` on it.'

// A worker whose MCP tool fails on the connection. cc-mods reconnects only
// between turns ($.command.run waits for the session to be idle), so a
// worker that waits inside its turn waits for nothing: it ends the turn, and
// cc-mods prompts it to go on once the server is back (register.ts
// MCP_RESUME). Before this a worker sent BLOCKED and nobody reconnected.
export const MCP_WAIT =
  '- When an MCP tool fails on its connection (ECONNRESET, "not connected", "connection closed", or ToolSearch says the server failed to connect), do not send BLOCKED for it: do the rest of the work that does not need that server, then end your turn with one line naming the server you wait on. cc-mods reconnects it between turns and prompts you to go on once it is back; when it cannot, it tells the coordinator itself.'

// What every worker is told about reporting, after the coordinator's brief.
// `fallback`: the command that queues a report in the coordinator's office
// inbox (bin/coord-report <sid>). SendMessage finds the coordinator by its
// socket in /tmp/cc-socks, and a coordinator whose socket file is gone still
// runs but cannot be messaged: the inbox reaches it all the same.
// `where`: what its tools reach (lib/trust.ts placement). A read outside
// those stops at "Read outside the working directories" even under auto
// mode (sandbox off, managed read paths), a dialog nobody watches.
// `coordSid`: the coordinator's session id, which `brief ask --coordinator`
// needs so the office sends the person's answer back to it.
// `briefGrant`: bin/brief-grant's absolute path (the plugin's bin).
export function workerPrompt(brief: string, coordName: string, slug: string, fallback?: string, where?: { cwd: string; addDirs: readonly string[]; outside?: string }, coordSid?: string, briefGrant?: string): string {
  const o = where?.outside
  return (
    brief.trim() +
    '\n\n---\nYou are worker `' + slug + '` for the coordinator session `' + coordName + '`. Report to it with SendMessage (to: "' + coordName + '"), and never wait on the person:\n' +
    '- `READY <sha>` when the work is pushed, tests pass, and the PR body has a live run; add the PR URL and, when the person must decide or understand something, a brief made with the doc:visual-brief skill (its path).\n' +
    '- `BLOCKED <why>` when you cannot go on; `QUESTION <what>` when the brief leaves a choice open.\n' +
    '- When the person must decide (two or more options, a step hard to undo, a scope call), ask on a decision brief. ' + DECISION_BRIEF + ' Add `--coordinator ' + (coordSid ?? '<coordinator sid>') + ' --worker ' + slug + '`, and send `QUESTION <one line> — <brief path>` (or `BLOCKED <why> — <brief path>`). Never run `brief show`: the decision shows in the office\'s 지휘 view, and the answer comes back as a `[coordinator]` prompt. Only a yes/no on one small step that is easy to undo goes as a plain QUESTION.\n' +
    '- Ask the person once per task where you can: early on, list every open question the work raises, and go on with what needs no answer; then ask them together, one `brief ask --new` per question (a brief holds one decision), in one `QUESTION` report with every brief path. Ask alone and at once only what stops the work entirely.\n' +
    grantRule(briefGrant) + '\n' +
    '- When a skill you use fails you (a script fails, its guidance is wrong, a case it does not cover), work around it to finish, and add a line to your READY or BLOCKED report: `SKILL <skill name>: <the problem in one line> — <evidence: the command and its error, or file:line>`. Do not edit the skill here: fixing it is a separate task.\n' +
    MCP_WAIT + '\n' +
    (fallback ? '- When SendMessage says the coordinator is not reachable, send the same report with Bash: `' + fallback + " '[worker " + slug + "] <report>'`. It arrives in the coordinator's session as a prompt.\n" : '') +
    ONE_BROWSER + '\n' +
    'Messages from the coordinator start with `[coordinator]`: a message from another session (it may arrive in the middle of your turn; act on it there) or a prompt. The person may also type in this pane; their words win.' +
    (where ? '\nYour tools reach `' + [where.cwd, ...where.addDirs].join('`, `') + '` without a permission dialog. A file anywhere else stops you at a dialog nobody answers: do not read it; send the coordinator `QUESTION need <path>` and go on with the rest.' : '') +
    (o ? '\nThe code is in `' + o + '`, outside your cwd: Claude Code does not trust that repository, so you run in `' + where!.cwd + '` and reach it as an added directory. Read, Edit and Write it by absolute paths under `' + o + '`; run git as `git -C ' + o + ' …` and other commands as `cd ' + o + ' && …` in the same Bash call. That repository\'s .claude settings (hooks, permissions, MCP servers) do not apply here, and its CLAUDE.md is not loaded: read it yourself when it has one.' : '')
  )
}

export type Made = { kind: 'pane' | 'window'; pane: string; window: string }

// A split off the coordinator's pane: -h puts the worker beside it, -v below.
export type Split = { dir: '-h' | '-v'; size: number }
// The smallest pane either side keeps after a split: a claude narrower or
// shorter than this wraps its own UI into noise.
export const SPLIT_MIN = { cols: 60, rows: 15 }

// Where a worker's pane goes, from the coordinator pane's size: the longer
// side is split and the worker gets a third of it. Never a window-wide
// select-layout: the window also holds tweb panes and the cockpit, whose
// sizes are the person's. Undefined: too small either way, so a new window.
export function splitPlan(width: number, height: number): Split | undefined {
  const third = (n: number) => Math.floor(n / 3)
  const across = { dir: '-h' as const, size: third(width), keep: width - third(width) - 1, min: SPLIT_MIN.cols }
  const down = { dir: '-v' as const, size: third(height), keep: height - third(height) - 1, min: SPLIT_MIN.rows }
  // A cell is about twice as tall as it is wide.
  const order = width >= 2 * height ? [across, down] : [down, across]
  const fit = order.find((o) => o.size >= o.min && o.keep >= o.min)
  return fit && { dir: fit.dir, size: fit.size }
}

export function workerArgv(o: { target: string; split?: Split; slug: string; cwd: string; model: string; effort: string; sid: string; promptFile: string; addDirs?: readonly string[] }): string[] {
  // The prompt is read from its file by the shell in the new pane, so a
  // long brief never rides on tmux's command line. The add-dirs come after
  // it as `--add-dir=<dir>`, put first on claude's line: --add-dir takes
  // several values, and in its spaced form the prompt after it would be read
  // as one more directory.
  // Through ccproxy when it is installed, as the person's own `claude` (a
  // fish function) is: a bare `exec claude` from sh skipped it, so every
  // worker ran on the person's account directly and hit its session limit
  // (2026-11-10). Without ccproxy, claude itself. crossSessionInbound
  // accept: the coordinator runs in another permission mode, and a peer
  // message from a session of another mode class is held for the person's
  // approval in the worker's pane (seen 2026-11-10), so coord_send stalled.
  const cmd = 'm=$1 e=$2 s=$3 n=$4 p=$5; shift 5; if command -v ccproxy >/dev/null 2>&1; then set -- ccproxy claude --intercept=mitm -- "$@"; else set -- claude "$@"; fi; exec "$@" --settings "{\\"crossSessionInbound\\":\\"accept\\"}" --model "$m" --effort "$e" --permission-mode auto --disallowedTools AskUserQuestion --session-id "$s" -n "$n" "$(cat "$p")"'
  const dirs = (o.addDirs ?? []).map((d) => '--add-dir=' + d)
  const run = ['-c', o.cwd, 'sh', '-c', cmd, 'worker', modelAlias(o.model), o.effort, o.sid, o.slug, o.promptFile, ...dirs]
  // -d: the person's keyboard stays where it is. `target` is the
  // coordinator's pane for a split, its tmux session for a window.
  if (o.split) return ['split-window', '-d', o.split.dir, '-l', String(o.split.size), '-P', '-F', '#{window_id} #{pane_id}', '-t', o.target, ...run]
  return ['new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', o.target, '-n', 'w:' + o.slug, ...run]
}

// The worker's pane label. @title, not pane_title: Claude Code rewrites
// pane_title over OSC (register.ts /title).
export function titleArgv(pane: string, slug: string): string[] {
  return ['set', '-p', '-t', pane, '@title', 'w:' + slug]
}

// What coord_close kills: the pane (or fallback window) coord_spawn made,
// never the coordinator's own pane or window. A worker from before `made`
// was recorded had its own window. A fallback window another live worker
// was split into since (`others`), or any other Claude session's pane is in
// now (`seen`: a session the person moved or split there), loses only this
// worker's pane. Undefined: nothing of the worker's to kill.
export function closeArgv(w: Worker, coord: { pane?: string; window?: string }, others: readonly Worker[] = [], seen: readonly Pick<PaneSeen, 'window' | 'sid'>[] = []): string[] | undefined {
  const m: Made | undefined = w.made ?? (w.relation === 'owned' && w.window ? { kind: 'window', pane: w.pane ?? '', window: w.window } : undefined)
  if (!m) return undefined
  const pane = () => (m.pane && m.pane !== coord.pane ? ['kill-pane', '-t', m.pane] : undefined)
  if (m.kind === 'pane') return pane()
  if (m.window === coord.window || (m.pane && m.pane === coord.pane)) return undefined
  if (others.some((o) => o.sid !== w.sid && (o.made?.window ?? o.window) === m.window)) return pane()
  if (seen.some((s) => s.window === m.window && s.sid && s.sid !== w.sid)) return pane()
  return ['kill-window', '-t', m.window]
}

// A pane seen in tmux, as the coordinator's watch reads it.
export type PaneSeen = { pane: string; window: string; sid: string; state: string; attention: string; cwd: string; humanAt?: number; asks?: string }

export function parsePanes(out: string): PaneSeen[] {
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 6 && p[2])
    .map(([pane, window, sid, state, attention, cwd, human, asks]) => ({ pane: pane!, window: window!, sid: sid!, state: state ?? '', attention: attention ?? '', cwd: cwd ?? '', humanAt: Number(human) ? Number(human) * 1000 : undefined, asks: asks?.trim() || undefined }))
}
// Attention from the pane's own copy, else the window's (a session from
// before the pane copy publishes only @cc_attention). @cc_pane_asks: the
// call a permission ask waits on (lib/asks.ts).
export const PANES_FMT = '#{pane_id}\t#{window_id}\t#{@cc_pane_session}\t#{@cc_pane_state}\t#{?@cc_pane_attention,#{@cc_pane_attention},#{@cc_attention}}\t#{pane_current_path}\t#{@cc_human_at}\t#{@cc_pane_asks}'

export type Change = { slug: string; sid: string; kind: 'ask' | 'turn' | 'gone' | 'back' | 'mcp'; text: string; wake: boolean; server?: string }
const GONE = 'its session is gone'
const BACK = 'its session is back (taken for gone, it was alive)'

// Workers no pane names past their first minute: the ones observe would call
// gone, so the mod looks whether they are still alive first.
export function unseen(l: Ledger, seen: PaneSeen[], now: number): Worker[] {
  const sids = new Set(seen.map((s) => s.sid))
  return active(l).filter((w) => !sids.has(w.sid) && now - w.at >= SPAWN_GRACE_MS)
}

// The records taken for gone whose session a pane names again: the newest
// such record per session, when no live record holds that session or its
// slug (the coordinator may have spawned a new worker under the same name;
// two live workers with one slug would let coord_close pick the old one and
// remove the new one's worktree). A session left out is adopted anew.
export function comesBack(l: Ledger, seen: readonly PaneSeen[]): Set<Worker> {
  const shown = new Set(seen.map((s) => s.sid))
  const live = active(l)
  const sids = new Set(live.map((w) => w.sid))
  const slugs = new Set(live.map((w) => w.slug))
  const last = new Map<string, Worker>()
  for (const w of l.workers) if (w.endedAt && w.goneAt && shown.has(w.sid) && !sids.has(w.sid)) last.set(w.sid, w)
  return new Set([...last.values()].filter((w) => !slugs.has(w.slug)))
}

// What changed for the ledger's workers since the last look, and the ledger
// with the new states. `wake`: worth a message to the coordinator now (a
// worker waiting on input, gone, or taken over by the person); the rest only
// updates what the office draws. `alive`: session ids whose claude still runs
// or whose transcript still grows: a worker among them is not gone though no
// pane names it (a session that took its pane's name over it, such as a
// `claude -p` from an older cc-mods). `sums`: what each session was doing
// (lib/coordsum.ts), so a wake names the worker as the person knows it.
// The caller passes what it read: a tmux or alive read that failed is no
// news, so it does not call this at all, or counts every worker it asked
// about alive. A worker taken for gone whose session a pane names again is
// taken back (`back`), with its relation, worktree and spawn record as they
// were.
export function observe(l: Ledger, seen: PaneSeen[], now: number, alive: ReadonlySet<string> = new Set(), sums: ReadonlyMap<string, string> = new Map()): { ledger: Ledger; changes: Change[] } {
  const bySid = new Map(seen.map((s) => [s.sid, s]))
  const changes: Change[] = []
  const back = comesBack(l, seen)
  const workers = l.workers.map((w0) => {
    let w = w0
    if (w.endedAt) {
      if (!back.has(w)) return w
      w = { ...w, endedAt: undefined, goneAt: undefined, missed: undefined }
      changes.push({ slug: w.slug, sid: w.sid, kind: 'back', text: who(w.slug, sums.get(w.sid)) + ': ' + BACK, wake: !quiet(w) })
    }
    const s = bySid.get(w.sid)
    if (!s) {
      // Not yet published: a worker just started has no @cc_pane_session for
      // its first seconds.
      if (now - w.at < SPAWN_GRACE_MS) return w
      if (alive.has(w.sid)) return w.missed ? { ...w, missed: undefined } : w
      const missed = (w.missed ?? 0) + 1
      if (missed < MISSES_FOR_GONE) return { ...w, missed }
      changes.push({ slug: w.slug, sid: w.sid, kind: 'gone', text: who(w.slug, sums.get(w.sid)) + ': ' + GONE + ' (pane closed or claude exited)', wake: !quiet(w) })
      return { ...w, missed: undefined, endedAt: now, goneAt: now }
    }
    const next: Worker = { ...w, missed: undefined, pane: s.pane, window: s.window, state: s.state, attention: s.attention, asks: s.asks }
    // The brief itself arrives as an owned worker's first composer prompt
    // (it is claude's command-line argument), so a mark from the spawn's
    // first minute is that, not the person. An adopted one was given no
    // brief: any mark after its adoption is the person.
    // Recorded, not told: the person typing there stops nothing.
    const grace = w.relation === 'owned' ? SPAWN_GRACE_MS : 0
    const human = s.humanAt && s.humanAt > w.at + grace ? s.humanAt : undefined
    if (human && (!w.typedAt || human > w.typedAt)) next.typedAt = human
    const wake = !quiet(w)
    // waiting with ask or action is not a turn's end: ask is a question its
    // turn ended on or a permission dialog drawn, action a tool call put to
    // the permission mode. Under --permission-mode auto the classifier
    // settles most of those in seconds with no dialog, so an action wakes the
    // coordinator only when a second tick still sees it; an ask at once. The
    // call (`asks`) is what is woken for, so its dialog after its action is
    // not news twice. The second tick must see the same call: every Bash
    // under auto mode spends its first ~3 s in action (measured), so two
    // calls 10 s apart each caught there read as one stuck ask (live: a cp to
    // the worker's scratchpad after a python run, told as a dialog nobody saw).
    const asks = s.attention === 'ask' || s.attention === 'action'
    const open = s.attention === 'ask' || (s.attention === 'action' && w.attention === 'action' && w.asks === s.asks)
    const about = s.asks ?? s.attention
    if (!asks) next.asked = undefined
    if (open && w.asked !== about) {
      next.asked = about
      changes.push({ slug: w.slug, sid: w.sid, kind: 'ask', text: askText(w.slug, s, sums.get(w.sid)), wake })
    }
    // cc-mods publishes done (attention none) at a turn's end, and waiting
    // with none only when the session has idled 30 min after that done. A
    // watch tick can miss the done, and the working too when the whole turn
    // fits between two ticks: so done, or that idle waiting, after anything
    // else is a finished turn.
    // A quiet worker's turns are the person's: not even logged.
    else if (wake && !asks && idle(s.state) && !rested(w) && (w.state === 'working' || w.state === 'waiting' || now - w.at > SPAWN_GRACE_MS)) changes.push({ slug: w.slug, sid: w.sid, kind: 'turn', text: who(w.slug, sums.get(w.sid)) + ': finished its turn', wake: true })
    return next
  })
  return { ledger: { ...l, workers }, changes }
}

// The person must answer the worker: the text says which pane and window,
// and the call when it is a permission ask. The office's 지휘 view draws the
// dialog's options on the worker's row (office.py asking/dialog, kind key),
// so the person answers there, not in the pane.
export function askText(slug: string, s: Pick<PaneSeen, 'pane' | 'window' | 'attention' | 'asks'>, summary?: string): string {
  const where = (summary ? summary + ' (' + slug + ', ' : slug + ' (') + 'pane ' + s.pane + ', window ' + s.window + ')'
  if (s.asks) return where + ': asks: ' + s.asks + (s.attention === 'ask' ? ' (a permission dialog: the person answers it on its row in the office 지휘 view)' : ' (a permission ask still unsettled; if a dialog stays, the person answers it in the office 지휘 view)')
  return where + ': waiting on ' + (s.attention === 'ask' ? 'an answer' : 'an approval') + ' in its pane'
}

// A worker as a wake names it: what it was doing, the slug after it in
// parentheses (`office 지휘 정리 (fix)`); the slug alone while no summary is
// known. The person reads these lines too, and `ops-k8s-4a` said nothing.
// recheck finds the slug at either spot.
export function who(slug: string, summary?: string): string {
  const s = (summary ?? '').replace(/\s+/g, ' ').trim()
  return s && s !== slug ? s + ' (' + slug + ')' : slug
}

// A session's MCP state as its cc-mods writes it (register.ts mcpExport):
// the servers it is missing, each with its tries and whether it is stuck.
export type McpDown = { server: string; tries: number; last?: string; text?: string; stuck?: boolean; atStart?: boolean }
export function parseMcpState(json: string | undefined): McpDown[] {
  try {
    const d = JSON.parse(json ?? '')
    return (Array.isArray(d?.dropped) ? d.dropped : [])
      .filter((x: any) => x && typeof x.server === 'string' && x.server)
      .map((x: any) => ({ server: x.server, tries: Number(x.tries) || 0, last: typeof x.last === 'string' ? x.last : undefined, text: typeof x.text === 'string' ? x.text : undefined, stuck: x.stuck === true, atStart: x.atStart === true }))
  } catch {
    return []
  }
}

// The line a stuck server makes: `<who>: MCP <server> 끊김 (<why>)`. The
// session retries on its own (1, 2, 4 … 30 minutes apart); the line is for
// when that has not worked, so the coordinator tells the person or presses
// 다시 연결 for it.
export function mcpText(who: string, d: McpDown): string {
  const why = d.last === 'unknown'
    ? '/mcp가 이 이름을 모름: 이름 매핑 실패, 자동 재연결 멈춤'
    : (d.atStart ? '세션 시작 때 연결 실패, ' : '') + '자동 재연결 ' + d.tries + '회 실패' + (d.text ? ': ' + d.text.replace(/\s+/g, ' ').slice(0, 120) : '')
  return who + ': MCP ' + d.server + ' 끊김 (' + why + ')'
}

// The coordinator's and its workers' stuck MCP servers, read from each
// session's state file (`files`: sid → its JSON). A server is told once,
// when it turns stuck, and again only after it came back and fell again;
// the ledger keeps what is down (mcpDown) so current() can drop a held line
// that came back meanwhile. A quiet worker (the person's own session) is
// recorded, not told, as its asks are.
export function mcpWakes(l: Ledger, files: ReadonlyMap<string, string | undefined>, sums: ReadonlyMap<string, string> = new Map()): { ledger: Ledger; changes: Change[] } {
  const changes: Change[] = []
  const step = (sid: string, slug: string, before: readonly string[] | undefined, wake: boolean): string[] | undefined => {
    const down = parseMcpState(files.get(sid)).filter((d) => d.stuck)
    for (const d of down) if (!before?.includes(d.server)) changes.push({ slug, sid, kind: 'mcp', server: d.server, text: mcpText(who(slug, sums.get(sid)), d), wake })
    return down.length ? down.map((d) => d.server) : undefined
  }
  const same = (a?: readonly string[], b?: readonly string[]) => (a ?? []).join('\n') === (b ?? []).join('\n')
  const self = step(l.sid, 'coordinator', l.mcpDown, true)
  const workers = l.workers.map((w) => {
    if (w.endedAt) return w
    const down = step(w.sid, w.slug, w.mcpDown, !quiet(w))
    return same(down, w.mcpDown) ? w : { ...w, mcpDown: down }
  })
  if (same(self, l.mcpDown) && workers.every((w, i) => w === l.workers[i])) return { ledger: l, changes }
  return { ledger: { ...l, mcpDown: self, workers }, changes }
}

// The worker a [coord] line is about: its slug at the start (`fix: …`,
// `fix (pane …`) or in the parentheses after a summary (`… (fix): …`,
// `… (fix, pane …`). The newest worker of that slug.
export function wakeWorker(body: string, l: Ledger): Worker | undefined {
  const hit = (slug: string) => body.startsWith(slug + ':') || body.startsWith(slug + ' (') || body.includes(' (' + slug + '):') || body.includes(' (' + slug + ', pane ')
  return l.workers.filter((x) => hit(x.slug)).sort((a, b) => b.at - a.at || b.slug.length - a.slug.length)[0]
}

const idle = (state: string | undefined) => state === 'done' || state === 'waiting'
// Idle as last seen: a waiting that asked something was mid-turn or put a
// question, so a done after it is a turn's end.
const rested = (w: Worker) => idle(w.state) && w.attention !== 'ask' && w.attention !== 'action'

export function typedLately(w: Worker, now: number): boolean {
  return !!w.typedAt && now - w.typedAt < TYPED_MS
}

// coord_send's note on a worker the person prompted lately, else ''.
export function typedNote(w: Worker, now: number): string {
  if (!typedLately(w, now)) return ''
  return ' Note: the person typed in this pane lately (' + new Date(w.typedAt!).toTimeString().slice(0, 5) + ', ' + Math.max(1, Math.round((now - w.typedAt!) / 60_000)) + ' min ago); their draft is not touched.'
}

// Whether a wake held while the coordinator's turn ran still says something
// true now that it can be delivered: the worker still asks, is still idle
// after its turn. A gone worker stays news unless its session was seen again
// (taken back); a worker back stays news while it is not gone again.
export function current(c: Change, l: Ledger, now: number): boolean {
  if (c.kind === 'mcp' && c.sid === l.sid) return !!l.mcpDown?.includes(c.server ?? '')
  const ws = l.workers.filter((x) => x.sid === c.sid)
  const w = ws.find((x) => !x.endedAt) ?? ws[0]
  if (!w) return false
  if (c.kind === 'mcp') return !w.endedAt && !!w.mcpDown?.includes(c.server ?? '')
  if (c.kind === 'gone') return !!w.endedAt
  if (w.endedAt) return false
  if (c.kind === 'back') return true
  if (c.kind === 'ask') return w.attention === 'ask' || w.attention === 'action'
  return rested(w)
}

export const WAKE_PREFIX = '[coord] '

// The coordinator's [coord] prompt as the session takes it up. A plugin's
// prompt waits until the session is idle, and a module reloaded mid-turn
// (a merge on main) does not know a turn runs, so a wake can still sit in
// the queue when its worker is closed (live: brief-decision-4's ask arrived
// a minute after coord_close). Each line is checked again: by the change it
// was sent for (`sent`), else, sent before a reload, by its worker's slug,
// dropped once that worker has ended. Undefined: no line is left.
export function recheck(text: string, l: Ledger, now: number, sent: ReadonlyMap<string, Change>): string | undefined {
  const lines = text.split('\n')
  if (!lines.every((x) => x.startsWith(WAKE_PREFIX))) return text
  const kept = lines.filter((line) => {
    const body = line.slice(WAKE_PREFIX.length)
    const c = sent.get(body)
    if (c) return current(c, l, now)
    const w = wakeWorker(body, l)
    return body.includes(GONE) ? !w || !!w.endedAt : !w?.endedAt
  })
  return kept.length ? kept.join('\n') : undefined
}

// Live sessions that already work in the repository a new worker would:
// under its directory, or in the same git repository (its main checkout or
// any worktree, which share one common git dir). A session in a parent
// directory (~, ~/src) is not working in it. `git` maps a session's cwd to
// its common git dir, the target's under `common`.
export function overlaps(seen: PaneSeen[], l: Ledger, dir: string, git?: { common?: string; of: Map<string, string> }): PaneSeen[] {
  const norm = (p: string) => p.replace(/\/+$/, '')
  const d = norm(dir)
  const same = (cwd: string) => !!git?.common && git.of.get(cwd) === git.common
  return seen.filter((s) => s.sid !== l.sid && s.cwd && (norm(s.cwd) === d || norm(s.cwd).startsWith(d + '/') || same(s.cwd)))
}

// What the coordinator reads every turn: its role, its limits, its workers,
// and the review queue's line (lib/coordreview.ts reviewLine) when it has any.
export function coordSection(l: Ledger, now: number, language = 'Korean', review?: string): string {
  return coordRules(l, language) + '\n' + coordRoster(l, now, review)
}

// The two halves of coordSection. The rules change only with the limits or
// the name; the roster changes with every worker's state. Where the section
// cannot ride in the system prompt (cc-plugin-sec-default, see register.ts
// contextNotes) each half is a conversation row of its own, re-sent only
// when it changed: the rules, several KB, then go once, not every turn.
export function coordRules(l: Ledger, language = 'Korean'): string {
  return [
    '# Coordinator mode (cc-mods)',
    'You are `' + l.name + '`, the coordinator. You orchestrate, verify, merge, clean up and report; you do not do the work yourself.',
    "- Every task goes to another Claude session, however small: a one-line fix, a config change, a lookup across files, a brief. Do not edit files, write code, run the task's builds or tests, or open PRs yourself. Route each task with `coord_route` first (task: the person's words): it reads every live session and answers send, adopt, spawn or unsure with a reason. Act on that answer: send → `coord_send`; adopt (an observed session) → ask the person to `/coord adopt <pane>`, then `coord_send`; spawn → `coord_spawn` with its repo_dir or cwd, model, effort and window. Never ask the person where a task goes: when the router answers unsure, `coord_spawn` in the most plausible repository and tell the person in one line where it went and why; when the call fails, call it once more, then route by `coord_roster` yourself. Your own tools are for routing and checking: `coord_roster`, reading a worker's diff, report or CI to verify it, merging, and answering the person about status.",
    '- Only when the person says so in this turn ("직접 해", "do it yourself") do the work here; a coordinator that cannot spawn (limits reached) says so and asks, it does not fall back to doing the work.',
    '- Start workers only with the `coord_spawn` tool (never tmux or claude from Bash). Each gets a worktree off origin and a pane where the person sees it: `coord_route` lists the places (your window, a window that already holds your workers, or new: at most 2 workers a window, 60 columns and 15 rows left on each side of a split) and picks one with the session; pass its window to `coord_spawn` as `window`. One window holds one work: a worker goes beside sessions on the same repository or task folder only, never into a window (yours included) holding other work, which gets a new window; both tools drop such a window by rule. A place that no longer has room falls back to your window, else a new window; the result says which. `coord_route` already looked for a live session working there; `coord_spawn` still refuses one in the very directory, and then the person decides whether to adopt it.',
    "- A brief has the person's words verbatim, the evidence paths, the scope, and when to send READY.",
    (l.limits.autoAdopt
      ? '- Every live session is your adopted worker while the mode is on (relation `adopted (auto)`), except another coordinator, its owned workers, and a session handed back: you may `coord_send` it a task that fits its directory and recent work. The ones listed as the person\'s are sessions the person drives that you have not instructed yet; their turns do not wake you. Adopted sessions do not count toward the worker limit. `coord_close` on an adopted one hands it back to the person (the pane stays) and it is not adopted again.'
      : '- Live sessions are not adopted automatically (/coord limits adopt off): only the ones the person handed over with /coord adopt are adopted.'),
    '- Send instructions only with `coord_send`, and only to owned or adopted workers. Observed sessions are read-only: summarise them, never instruct them. The person may type in any worker\'s pane while you send to it: that is fine (their draft stays); `person typed HH:MM` and the note in coord_send\'s result are for your report, not a reason to hold back.',
    '- Before relaying a report, re-check the claims the decision rides on (file:line, counts, "already merged") and label the rest unverified.',
    '- Merge only when the head equals the READY sha (--match-head-commit), CI passed on that sha, no unresolved threads, the bot review is clean, and the head contains origin/main. Admin merge only on the person\'s typed order.',
    '- After a merge, close the worker with `coord_close` (it kills the pane it made, or its fallback window, and removes the worktree).',
    "- When the person must decide (two or more options, a step hard to undo, a scope call), the default is a decision brief, not a question in chat alone. " + DECISION_BRIEF + " Add `--coordinator " + l.sid + "`, and `--worker <slug>` when it is about a worker. The office's 지휘 view lists every waiting decision: while the office is up (`curl -sf http://localhost:8796/` answers), never run `brief show`, which covers the office's pane and its controls; only without the office does `brief show <brief>` put it in a tweb pane. In chat write one line and the brief path; you may also ask with AskUserQuestion, the recommended option first.",
    '- Only a yes/no on one small step that is easy to undo goes to the person in chat alone, without a brief.',
    "- A worker's `QUESTION … — <brief path>` already asks the person on that brief: do not ask it again; it is in the office's 지휘 view.",
    "- The person gives intent and judgment; what it takes to carry them out is yours to arrange. coord_spawn's result names the gates a brief will meet (a Slack send, a merge, a prod write): the worker asks every approval it needs on its first decision brief, together, and an approval the person already gave (a brief answered, or their words in this conversation) is not asked again. A worker's Slack send the person approved on a brief (`[granted: …]` on the answer) goes through on its own: never tell the person to change a policy for it.",
    "- Gather the person's questions: say once in chat `결정 N건 대기` with the brief paths, not a message per question, and ask them on one occasion, not as each arrives. Ask alone and at once only what stops a worker entirely.",
    "- Finished work goes to the person's review queue, not only to chat: when you have verified and merged a worker's READY (or a worker finished something the person must judge), call `coord_review` add with id = the worker slug or the PR (cc-mods#85), title, changed (what changed, in the person's terms), verified (what you checked: tests, live run, CI on the sha; and what you did not), check (what the person should look at or try), risk, links (PR, brief, files). A later step of the same work (a follow-up PR, a fix after an issue) is `coord_review` update on the same id, not a new item. In chat say only the one line the tool returns, `검토 대기 N건`, never the items: the office's 지휘 view shows them under 🔎 검토. Do not write a one-off brief for finished work.",
    "- `[review] confirmed <id>` is the person having looked at that work: it has left the queue, nothing to do. `[review] issue <id>: <words>` is a problem the person found in it, in their words: it is a task; send it to the worker that did it when it is still there, else route it with `coord_route`, and update the item when the fix is verified (it stays open until the person confirms it). When the person says in chat they checked an item, `coord_review` confirm it.",
    "- A report line `SKILL <name>: <problem> — <evidence>` is a skill that failed a worker. Give fixing it to a worker as its own task (route it like any task), with the line and its evidence verbatim, and tell that worker to use the meta:self-enhancer or meta:skill-creator skill. The worker that hit it does not edit the skill. Tell the person in one line.",
    "- PR follow-ups are your chores, not the person's: a worker's or the person's own session's PR that waits on review (REVIEW_REQUIRED, a new commit after CHANGES_REQUESTED, an approval voided by a new head), a re-review ping, a reviewer to re-request, an approved PR that is not merged. Do not wait for the person to say \"리뷰 요청해\". Sweep the open PRs (`gh pr list`/`gh pr view`) when a worker reports READY or DONE and when the person talks about a PR; write each review-request text yourself (PR link, what changed, what was verified) and collect them. Ask the person only what you cannot decide (send or not, which channel, close or keep) on one decision brief for the whole sweep. A send the person approved goes out from you; a worker's Slack send follows the granted-press rule above.",
    "- When a decision brief's answer is carried out and its result verified (the worker's READY, the merge, the deploy, a live check), mark it done: `brief done <brief> --result \"<one line>\" --link <PR or URL> --revert \"<command that undoes it>\"`. The office lists it under ✅ 최근 완료; a brief only answered stays out of it. Do not mark one done before the result is checked.",
    "- A worker's job ends at merge (and deploy or install), not at READY: a session with an open PR finishes it (review fixes, CI, conflicts, review requests; `sb:pr-followup`). Send each live session that is idle with an open PR an instruction to finish it; when its session is gone, give the PR to one triage worker. Never let a PR sit at \"opened\".",
    "- Once the person states an intent (\"upload the check-in\"), you own every step to done. At the start foresee each gate the path will meet (session policy such as slack_send=block, permission dialogs, approvals) and ask for all of them together on the first brief; do not report them one by one as they block, and do not ask again for what the person approved. Never hand the person logistics (a limit to raise, a pane to click): free a worker slot by closing a finished worker yourself and say what you did.",
    "- A rule the person teaches you in feedback about how you run things is not left in project memory alone. Save the memory, and in the same turn give a worker the task of putting the rule into this coordinator prompt (hooks/lib/coord.ts) or the skill it belongs to, so every coordinator session has it. Tell the person in one line.",
    "- A worker's tools reach only its cwd and add_dirs (its ~/research/<slug> always): never tell it to read a path outside them, which stops it at a dialog nobody answers; put a folder it needs in add_dirs at spawn. A worker that needs one sends `QUESTION need <path>`: answer with what it needs, or close and respawn it with add_dirs.",
    "- A repository Claude Code does not trust is not refused: the worker runs in ~/research/<slug> with the worktree as an add-dir (the spawn result says so). Brief it with absolute paths under the worktree and `git -C <worktree>`; that repository's .claude settings (hooks, permissions, MCP) do not apply there. Never write trust (~/.claude.json) for the person.",
    "- A `[coord]` line names a worker as `<summary> (<slug>)`, or by its slug alone while no summary is known; when you tell the person about it, name it the same way. `[coord] <summary> (<slug>, pane %N, window @N): asks: <tool> <target>` is a permission dialog in that worker's pane: coord_send cannot answer it, and the office's 지휘 view already shows it on that worker's row with its options to press. Do not tell the person to go to the pane, and do not repeat it: say once in chat `권한 확인 N건 대기 (지휘)` with what each asks. Only while the office is down (`curl -sf -o /dev/null http://localhost:8796/` fails) name the pane and window instead. When a folder outside its cwd is the cause, close and respawn it with add_dirs instead.",
    "- `[coord] <summary> (<slug>): 지시 전달 실패 (<why>, N회 시도): \"<head>\"` is an instruction of yours that never went into that worker: send it again with `coord_send`; when it fails again, tell the person the worker's pane.",
    "- `[coord] <summary> (<slug>): MCP <server> 끊김 (<why>)` (`coordinator: MCP …` for your own session) is an MCP server that session's cc-mods could not reconnect on its own: it keeps retrying (1, 2, 4 … 30 minutes apart), and the office shows 🔌 on that session's row with a 다시 연결 button. Tell the person once in chat `MCP 끊김: <server> (<who>)` with the why. When the why says 이름 매핑 실패, that is a cc-mods bug: route a fix with its text. Do not tell the worker to reconnect it, and do not run /mcp for it.",
    '- A prompt `[brief answer] <brief>: <label> — <note>` is the person\'s pick from the office: instruct the worker with it (`coord_send`). `[office→coord] <slug>: <text>` is the person\'s instruction for that worker: relay it with `coord_send`. `[office→coord] <text>` with no worker slug is a task the person typed in the office\'s 지휘 box: hand it out at once with `coord_route` (task: the text) and act on its answer; never ask the person where it goes; when the router is unsure, spawn in the most plausible repository and report the reason in one line. The office shows the person where it went from your next `coord_send` or `coord_spawn`, so make that call before anything else for this task. `[office→coord] (re: <brief file>, worker <slug>) <text>` or `[office→coord] (re: review <id>) <text>` is about what the person has open in the office: pass it to that brief\'s or review item\'s worker with `coord_send`; when it names no worker or that worker is gone, `coord_route` it.',
    ONE_BROWSER + ' Tell workers the same when a brief needs a browser.',
    '- Report to the person in ' + language + ', briefly, with tables.',
    'Limits (the person sets them with /coord limits): ' + limitsText(l.limits),
  ].join('\n')
}

export function coordRoster(l: Ledger, now: number, review?: string): string {
  // The quiet ones (every session the person runs, often twenty or more) go
  // on one line, so the table that rides on every turn stays the workers'.
  const mute = active(l).filter(quiet)
  const rows = active(l).filter((w) => !quiet(w)).map((w) => '| ' + w.slug + ' | ' + w.relation + (w.auto ? ' (auto)' : '') + ' | ' + (w.model ?? '-') + '/' + (w.effort ?? '-') + ' | ' + (w.state ?? '?') + (w.attention && w.attention !== 'none' ? ' (' + w.attention + ')' : '') + (typedLately(w, now) ? ' (person typed ' + new Date(w.typedAt!).toTimeString().slice(0, 5) + ')' : '') + ' | ' + w.cwd + (w.code ? ' (code ' + w.code + ')' : '') + ' |')
  return [
    rows.length ? '| worker | relation | model/effort | state | cwd |\n|---|---|---|---|---|\n' + rows.join('\n') : 'No workers yet.',
    ...(mute.length ? ['Adopted, the person\'s (not instructed yet; coord_roster has their state): ' + mute.map((w) => w.slug + ' ' + w.cwd).join(', ') + '.'] : []),
    ...(review ? [review] : []),
  ].join('\n')
}

export function limitsText(lim: Limits): string {
  return 'models ' + lim.models.join(', ') + '; effort up to ' + lim.maxEffort + '; ' + lim.maxWorkers + ' owned workers; auto-adopt ' + (lim.autoAdopt ? 'on' : 'off') + '.'
}

// `/coord limits models opus,sonnet | effort high | workers 4 | adopt on|off`
export function parseLimits(args: string, cur: Limits): Limits | string {
  const [what, value] = args.trim().split(/\s+/, 2)
  if (what === 'models') {
    const ms = String(value ?? '').split(',').map(modelAlias).filter(Boolean)
    const bad = ms.filter((m) => !(MODELS as readonly string[]).includes(m))
    if (!ms.length || bad.length) return 'models: a comma list of ' + MODELS.join(', ')
    return { ...cur, models: ms }
  }
  if (what === 'effort') return isEffort(value) ? { ...cur, maxEffort: value } : 'effort: one of ' + EFFORTS.join(', ')
  if (what === 'workers') {
    const n = Number(value)
    return Number.isInteger(n) && n > 0 && n <= 12 ? { ...cur, maxWorkers: n } : 'workers: 1 to 12'
  }
  if (what === 'adopt') return value === 'on' || value === 'off' ? { ...cur, autoAdopt: value === 'on' } : 'adopt: on or off'
  return 'limits: models <list> | effort <level> | workers <n> | adopt on|off'
}

// ---- policy -------------------------------------------------------------------
// The coordinator and its workers each get their own session policy
// (~/.claude/hooks/session_policy.py, keyed by session id). The coordinator
// merges and keeps going but touches no prod, Slack or other windows (it
// reads workers through coord tools); a repository it starts a worker in is
// added to its merge scopes. A worker keeps going on its brief and does
// nothing outward: no merge, no prod write, no Slack, no other windows, and
// the model and effort the coordinator chose stay put (no routing).

export const COORD_CAPS: Partial<Record<Cap, CapValue>> = {
  gh_merge: 'block',
  prod_eks_write: 'block',
  slack_send: 'block',
  tmux_window_escape: 'block',
  auto_continue: 'allow',
}
export const WORKER_CAPS: Partial<Record<Cap, CapValue>> = {
  gh_merge: 'block',
  prod_eks_write: 'block',
  slack_send: 'block',
  tmux_window_escape: 'block',
  auto_continue: 'allow',
  auto_effort: 'block',
  auto_model: 'block',
}

// session_policy.py argvs: `mode default` first (it clears scopes), then each
// capability, then the merge scopes.
export function policyArgvs(caps: Partial<Record<Cap, CapValue>>, mergeRepos: readonly string[] = []): string[][] {
  return [['mode', 'default'], ...Object.entries(caps).map(([c, v]) => [v as string, c]), ...mergeRepos.map((r) => ['allow', 'gh_merge', '--repo', r])]
}

// The same, as a Policy value: what god mode puts back when it ends while the
// coordinator is on (god keeps "the policy before" and restores that).
export function policyOf(caps: Partial<Record<Cap, CapValue>>, mergeRepos: readonly string[], base: Policy): Policy {
  const explicit = { ...caps }
  return { mode: 'custom', caps: { ...base.caps, ...caps }, explicit, scopes: mergeRepos.length ? { gh_merge: [...mergeRepos] } : {} }
}

export function mergeRepos(l: Ledger): string[] {
  return [...new Set(active(l).map((w) => w.repo).filter((r): r is string => !!r && r.includes('/')))]
}

// A decision a brief waits on (office/command.py pending), for the cockpit's
// Coord tab. The sidecar schema is the brief CLI's; anything off is dropped.
export type Decision = {
  file: string
  title: string
  question: string
  options: { label: string; detail: string }[]
  recommended: number | null
  coordinator?: string
  worker?: string
  asked?: string
}

export function parsePending(json: string): Decision[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Decision[] = []
  for (const it of raw as any[]) {
    const d = it?.decision
    if (!it || typeof it.file !== 'string' || !d || typeof d.question !== 'string') continue
    const options = (Array.isArray(d.options) ? d.options : []).filter((o: any) => o && typeof o.label === 'string').map((o: any) => ({ label: o.label, detail: typeof o.detail === 'string' ? o.detail : '' }))
    const rec = Number.isInteger(d.recommended) && d.recommended >= 0 && d.recommended < options.length ? d.recommended : null
    out.push({ file: it.file, title: typeof it.title === 'string' ? it.title : it.file, question: d.question, options, recommended: rec, coordinator: it.coordinatorName ?? undefined, worker: d.worker ?? undefined, asked: d.asked ?? undefined })
  }
  return out
}
