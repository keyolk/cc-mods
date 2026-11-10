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
//   adopted   a session that was already running, handed over by the person
//   observed  every other live session: read, never instructed
//
// Workers are started by this mod, never by Claude's Bash: the tmux guard
// keeps Claude's commands in its own window, and a worker's pane (or, as a
// fallback, window) is made by code that checks the person's limits first.
// Pure: the mod does the I/O.

import type { Cap, CapValue, Policy } from './policy'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]
export const MODELS = ['haiku', 'sonnet', 'opus'] as const
export type Relation = 'owned' | 'adopted'

export type Limits = { models: string[]; maxEffort: Effort; maxWorkers: number }
// What a coordinator may hand out until the person says otherwise.
export const DEFAULT_LIMITS: Limits = { models: ['haiku', 'sonnet', 'opus'], maxEffort: 'high', maxWorkers: 4 }

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
  heldAt?: number // the person typed in the worker's own pane
  endedAt?: number
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
  at: number
  policyBefore?: Policy // this session's policy before /coord on, put back by /coord off
}

export const LOG_MAX = 200
// The person typing in a worker's pane holds it this long after the last
// prompt: the coordinator sends it nothing meanwhile.
export const HOLD_MS = 10 * 60_000
export const SPAWN_GRACE_MS = 60_000

export function emptyLedger(sid: string, name: string, now: number): Ledger {
  return { on: false, sid, name, limits: { ...DEFAULT_LIMITS }, workers: [], log: [], at: now }
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
    },
    workers: Array.isArray(raw.workers) ? raw.workers.filter((w: any) => w && typeof w.slug === 'string' && typeof w.sid === 'string') : [],
    log: Array.isArray(raw.log) ? raw.log.slice(-LOG_MAX) : [],
    policyBefore: raw.policyBefore && typeof raw.policyBefore === 'object' ? raw.policyBefore : undefined,
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
export function workerPrompt(brief: string, coordName: string, slug: string, fallback?: string, where?: { cwd: string; addDirs: readonly string[]; outside?: string }, coordSid?: string): string {
  const o = where?.outside
  return (
    brief.trim() +
    '\n\n---\nYou are worker `' + slug + '` for the coordinator session `' + coordName + '`. Report to it with SendMessage (to: "' + coordName + '"), and never wait on the person:\n' +
    '- `READY <sha>` when the work is pushed, tests pass, and the PR body has a live run; add the PR URL and, when the person must decide or understand something, a brief made with the doc:visual-brief skill (its path).\n' +
    '- `BLOCKED <why>` when you cannot go on; `QUESTION <what>` when the brief leaves a choice open.\n' +
    '- When the person must decide (two or more options, a step hard to undo, a scope call), ask on a decision brief. ' + DECISION_BRIEF + ' Add `--coordinator ' + (coordSid ?? '<coordinator sid>') + ' --worker ' + slug + '`, and send `QUESTION <one line> — <brief path>` (or `BLOCKED <why> — <brief path>`). Never run `brief show`: the decision shows in the office\'s 지휘 view, and the answer comes back as a `[coordinator]` prompt. Only a yes/no on one small step that is easy to undo goes as a plain QUESTION.\n' +
    '- Ask the person once per task where you can: early on, list every open question the work raises, and go on with what needs no answer; then ask them together, one `brief ask --new` per question (a brief holds one decision), in one `QUESTION` report with every brief path. Ask alone and at once only what stops the work entirely.\n' +
    '- When a skill you use fails you (a script fails, its guidance is wrong, a case it does not cover), work around it to finish, and add a line to your READY or BLOCKED report: `SKILL <skill name>: <the problem in one line> — <evidence: the command and its error, or file:line>`. Do not edit the skill here: fixing it is a separate task.\n' +
    (fallback ? '- When SendMessage says the coordinator is not reachable, send the same report with Bash: `' + fallback + " '[worker " + slug + "] <report>'`. It arrives in the coordinator's session as a prompt.\n" : '') +
    'Messages from the coordinator arrive as prompts starting with `[coordinator]`. The person may also type in this pane; their words win.' +
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
  const cmd = 'm=$1 e=$2 s=$3 n=$4 p=$5; shift 5; exec claude "$@" --model "$m" --effort "$e" --permission-mode auto --disallowedTools AskUserQuestion --session-id "$s" -n "$n" "$(cat "$p")"'
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
// was split into since (`others`) loses only this worker's pane. Undefined:
// nothing of the worker's to kill.
export function closeArgv(w: Worker, coord: { pane?: string; window?: string }, others: readonly Worker[] = []): string[] | undefined {
  const m: Made | undefined = w.made ?? (w.relation === 'owned' && w.window ? { kind: 'window', pane: w.pane ?? '', window: w.window } : undefined)
  if (!m) return undefined
  const pane = () => (m.pane && m.pane !== coord.pane ? ['kill-pane', '-t', m.pane] : undefined)
  if (m.kind === 'pane') return pane()
  if (m.window === coord.window || (m.pane && m.pane === coord.pane)) return undefined
  if (others.some((o) => o.sid !== w.sid && (o.made?.window ?? o.window) === m.window)) return pane()
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

export type Change = { slug: string; sid: string; kind: 'ask' | 'held' | 'turn' | 'gone'; text: string; wake: boolean }
const GONE = 'its session is gone'

// Workers no pane names past their first minute: the ones observe would call
// gone, so the mod looks whether they are still alive first.
export function unseen(l: Ledger, seen: PaneSeen[], now: number): Worker[] {
  const sids = new Set(seen.map((s) => s.sid))
  return active(l).filter((w) => !sids.has(w.sid) && now - w.at >= SPAWN_GRACE_MS)
}

// What changed for the ledger's workers since the last look, and the ledger
// with the new states. `wake`: worth a message to the coordinator now (a
// worker waiting on input, gone, or taken over by the person); the rest only
// updates what the office draws. `alive`: session ids whose claude still runs
// or whose transcript still grows: a worker among them is not gone though no
// pane names it (a session that took its pane's name over it, such as a
// `claude -p` from an older cc-mods).
export function observe(l: Ledger, seen: PaneSeen[], now: number, alive: ReadonlySet<string> = new Set()): { ledger: Ledger; changes: Change[] } {
  const bySid = new Map(seen.map((s) => [s.sid, s]))
  const changes: Change[] = []
  const workers = l.workers.map((w) => {
    if (w.endedAt) return w
    const s = bySid.get(w.sid)
    if (!s) {
      // Not yet published: a worker just started has no @cc_pane_session for
      // its first seconds.
      if (now - w.at < SPAWN_GRACE_MS || alive.has(w.sid)) return w
      changes.push({ slug: w.slug, sid: w.sid, kind: 'gone', text: w.slug + ': ' + GONE + ' (pane closed or claude exited)', wake: true })
      return { ...w, endedAt: now }
    }
    const next: Worker = { ...w, pane: s.pane, window: s.window, state: s.state, attention: s.attention, asks: s.asks }
    // The brief itself arrives as the worker's first composer prompt (it is
    // claude's command-line argument), so a mark from the spawn's first
    // minute is that, not the person.
    const human = s.humanAt && s.humanAt > w.at + SPAWN_GRACE_MS ? s.humanAt : undefined
    const held = human && (!w.heldAt || human > w.heldAt) ? human : undefined
    if (held) {
      next.heldAt = held
      changes.push({ slug: w.slug, sid: w.sid, kind: 'held', text: w.slug + ': the person is typing in it; send it nothing until ' + new Date(held + HOLD_MS).toTimeString().slice(0, 5), wake: true })
    }
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
      changes.push({ slug: w.slug, sid: w.sid, kind: 'ask', text: askText(w.slug, s), wake: true })
    }
    // cc-mods publishes done (attention none) at a turn's end, and waiting
    // with none only when the session has idled 30 min after that done. A
    // watch tick can miss the done, and the working too when the whole turn
    // fits between two ticks: so done, or that idle waiting, after anything
    // else is a finished turn.
    else if (!asks && idle(s.state) && !rested(w) && (w.state === 'working' || w.state === 'waiting' || now - w.at > SPAWN_GRACE_MS)) changes.push({ slug: w.slug, sid: w.sid, kind: 'turn', text: w.slug + ': finished its turn', wake: true })
    return next
  })
  return { ledger: { ...l, workers }, changes }
}

// The person must act in the worker's pane: the text says which pane and
// window (`tmux select-pane -t %12`), and the call when it is a permission
// ask.
export function askText(slug: string, s: Pick<PaneSeen, 'pane' | 'window' | 'attention' | 'asks'>): string {
  const where = slug + ' (pane ' + s.pane + ', window ' + s.window + ')'
  if (s.asks) return where + ': asks: ' + s.asks + (s.attention === 'ask' ? ' (a permission dialog only the person can answer in that pane)' : ' (a permission ask still unsettled; a dialog there only the person can answer)')
  return where + ': waiting on ' + (s.attention === 'ask' ? 'an answer' : 'an approval') + ' in its pane'
}

const idle = (state: string | undefined) => state === 'done' || state === 'waiting'
// Idle as last seen: a waiting that asked something was mid-turn or put a
// question, so a done after it is a turn's end.
const rested = (w: Worker) => idle(w.state) && w.attention !== 'ask' && w.attention !== 'action'

export function held(w: Worker, now: number): boolean {
  return !!w.heldAt && now - w.heldAt < HOLD_MS
}

// Whether a wake held while the coordinator's turn ran still says something
// true now that it can be delivered: the worker still asks, is still held,
// is still idle after its turn. A gone worker stays gone.
export function current(c: Change, l: Ledger, now: number): boolean {
  const w = l.workers.find((x) => x.sid === c.sid)
  if (!w) return false
  if (c.kind === 'gone') return true
  if (w.endedAt) return false
  if (c.kind === 'ask') return w.attention === 'ask' || w.attention === 'action'
  if (c.kind === 'held') return held(w, now)
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
    const slug = /^([a-z0-9][a-z0-9-]*)[ :]/.exec(body)?.[1]
    const w = l.workers.filter((x) => x.slug === slug).sort((a, b) => b.at - a.at)[0]
    return !w?.endedAt || body.includes(GONE)
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

// What the coordinator reads every turn: its role, its limits, its workers.
export function coordSection(l: Ledger, now: number, language = 'Korean'): string {
  const rows = active(l).map((w) => '| ' + w.slug + ' | ' + w.relation + ' | ' + (w.model ?? '-') + '/' + (w.effort ?? '-') + ' | ' + (w.state ?? '?') + (w.attention && w.attention !== 'none' ? ' (' + w.attention + ')' : '') + (held(w, now) ? ' HELD by person' : '') + ' | ' + w.cwd + (w.code ? ' (code ' + w.code + ')' : '') + ' |')
  return [
    '# Coordinator mode (cc-mods)',
    'You are `' + l.name + '`, the coordinator. You orchestrate, verify, merge, clean up and report; you do not do the work yourself.',
    "- Every task goes to another Claude session, however small: a one-line fix, a config change, a lookup across files, a brief. Do not edit files, write code, run the task's builds or tests, or open PRs yourself. Route each task with `coord_route` first (task: the person's words): it reads every live session and answers send, adopt, spawn or unsure with a reason. Act on that answer: send → `coord_send`; adopt → ask the person to `/coord adopt <pane>`, then `coord_send`; spawn → `coord_spawn` with its repo_dir or cwd, model, effort and window. Ask the person where a task goes only when the router answers unsure; when the call fails, call it once more, then route by `coord_roster` yourself. Your own tools are for routing and checking: `coord_roster`, reading a worker's diff, report or CI to verify it, merging, and answering the person about status.",
    '- Only when the person says so in this turn ("직접 해", "do it yourself") do the work here; a coordinator that cannot spawn (limits reached) says so and asks, it does not fall back to doing the work.',
    '- Start workers only with the `coord_spawn` tool (never tmux or claude from Bash). Each gets a worktree off origin and a pane where the person sees it: `coord_route` lists the places (your window, a window that already holds your workers, or new: at most 2 workers a window, 60 columns and 15 rows left on each side of a split) and picks one with the session; pass its window to `coord_spawn` as `window`. A place that no longer has room falls back to your window, else a new window; the result says which. `coord_route` already looked for a live session working there; `coord_spawn` still refuses one in the very directory, and then the person decides whether to adopt it.',
    "- A brief has the person's words verbatim, the evidence paths, the scope, and when to send READY.",
    '- Send instructions only with `coord_send`, and only to owned or adopted workers. Observed sessions are read-only: summarise them, never instruct them. A worker HELD by the person gets nothing until the hold ends.',
    '- Before relaying a report, re-check the claims the decision rides on (file:line, counts, "already merged") and label the rest unverified.',
    '- Merge only when the head equals the READY sha (--match-head-commit), CI passed on that sha, no unresolved threads, the bot review is clean, and the head contains origin/main. Admin merge only on the person\'s typed order.',
    '- After a merge, close the worker with `coord_close` (it kills the pane it made, or its fallback window, and removes the worktree).',
    "- When the person must decide (two or more options, a step hard to undo, a scope call), the default is a decision brief, not a question in chat alone. " + DECISION_BRIEF + " Add `--coordinator " + l.sid + "`, and `--worker <slug>` when it is about a worker. The office's 지휘 view lists every waiting decision: while the office is up (`curl -sf http://localhost:8796/` answers), never run `brief show`, which covers the office's pane and its controls; only without the office does `brief show <brief>` put it in a tweb pane. In chat write one line and the brief path; you may also ask with AskUserQuestion, the recommended option first.",
    '- Only a yes/no on one small step that is easy to undo goes to the person in chat alone, without a brief.',
    "- A worker's `QUESTION … — <brief path>` already asks the person on that brief: do not ask it again; it is in the office's 지휘 view.",
    "- Gather the person's questions: say once in chat `결정 N건 대기` with the brief paths, not a message per question, and ask them on one occasion, not as each arrives. Ask alone and at once only what stops a worker entirely.",
    "- A report line `SKILL <name>: <problem> — <evidence>` is a skill that failed a worker. Give fixing it to a worker as its own task (route it like any task), with the line and its evidence verbatim, and tell that worker to use the meta:self-enhancer or meta:skill-creator skill. The worker that hit it does not edit the skill. Tell the person in one line.",
    "- A worker's tools reach only its cwd and add_dirs (its ~/research/<slug> always): never tell it to read a path outside them, which stops it at a dialog nobody answers; put a folder it needs in add_dirs at spawn. A worker that needs one sends `QUESTION need <path>`: answer with what it needs, or close and respawn it with add_dirs.",
    "- A repository Claude Code does not trust is not refused: the worker runs in ~/research/<slug> with the worktree as an add-dir (the spawn result says so). Brief it with absolute paths under the worktree and `git -C <worktree>`; that repository's .claude settings (hooks, permissions, MCP) do not apply there. Never write trust (~/.claude.json) for the person.",
    "- `[coord] <slug> (pane %N, window @N): asks: <tool> <target>` is a permission dialog in that worker's pane: coord_send cannot answer it. Tell the person the pane and window and what it asks (or, when a folder outside its cwd is the cause, close and respawn it with add_dirs).",
    '- A prompt `[brief answer] <brief>: <label> — <note>` is the person\'s pick from the office: instruct the worker with it (`coord_send`). `[office→coord] <slug>: <text>` is the person\'s instruction for that worker: relay it with `coord_send`. `[office→coord] <text>` with no worker slug is the person\'s instruction to you, typed in the office without picking a session: call `coord_route` with the text and act on its answer; never ask the person which session to use.',
    '- Report to the person in ' + language + ', briefly, with tables.',
    'Limits (the person sets them with /coord limits): models ' + l.limits.models.join(', ') + '; effort up to ' + l.limits.maxEffort + '; ' + l.limits.maxWorkers + ' workers.',
    rows.length ? '| worker | relation | model/effort | state | cwd |\n|---|---|---|---|---|\n' + rows.join('\n') : 'No workers yet.',
  ].join('\n')
}

// `/coord limits models opus,sonnet | effort high | workers 4`
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
  return 'limits: models <list> | effort <level> | workers <n>'
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
