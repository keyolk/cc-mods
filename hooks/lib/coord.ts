// Coordinator mode: one session (the one the person turned it on in) hands
// work to worker sessions, each a claude in its own tmux window, checks what
// they report, and asks the person before anything their decision rides on.
//
// The ledger is the one record of who is whose. It lives in
// ~/.claude/state/office/coord/<coordinator sid>.json, written by the
// coordinator's cc-mods and read by the office (office/coord.py), so the
// office draws the same relations the coordinator acts on.
//
// Relations, by session id:
//   owned     a worker this coordinator started (its window, its worktree)
//   adopted   a session that was already running, handed over by the person
//   observed  every other live session: read, never instructed
//
// Workers are started by this mod, never by Claude's Bash: the tmux guard
// keeps Claude's commands in its own window, and a worker window is the one
// exception, so it goes through code that checks the person's limits first.
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
  cwd: string
  worktree?: string // owned and made here: removed when the worker is closed
  repoDir?: string // the checkout the worktree came from
  repo?: string
  model?: string
  effort?: Effort
  brief?: string // the prompt file
  at: number
  state?: string // the last @cc_pane_state seen
  attention?: string
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

export type SpawnRequest = { slug: string; model: string; effort: string; cwd?: string; repoDir?: string; brief: string }

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
  return undefined
}

// What every worker is told about reporting, after the coordinator's brief.
export function workerPrompt(brief: string, coordName: string, slug: string): string {
  return (
    brief.trim() +
    '\n\n---\nYou are worker `' + slug + '` for the coordinator session `' + coordName + '`. Report to it with SendMessage (to: "' + coordName + '"), and never wait on the person:\n' +
    '- `READY <sha>` when the work is pushed, tests pass, and the PR body has a live run; add the PR URL and, when the person must decide or understand something, a brief made with the doc:visual-brief skill (its path).\n' +
    '- `BLOCKED <why>` when you cannot go on; `QUESTION <what>` when the brief leaves a choice open.\n' +
    'Messages from the coordinator arrive as prompts starting with `[coordinator]`. The person may also type in this pane; their words win.'
  )
}

export function workerArgv(o: { target: string; slug: string; cwd: string; model: string; effort: string; sid: string; promptFile: string }): string[] {
  // The prompt is read from its file by the shell in the new window, so a
  // long brief never rides on tmux's command line.
  const cmd = 'exec claude --model "$1" --effort "$2" --permission-mode auto --disallowedTools AskUserQuestion --session-id "$3" -n "$4" "$(cat "$5")"'
  return ['new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', o.target, '-n', 'w:' + o.slug, '-c', o.cwd, 'sh', '-c', cmd, 'worker', modelAlias(o.model), o.effort, o.sid, o.slug, o.promptFile]
}

// A pane seen in tmux, as the coordinator's watch reads it.
export type PaneSeen = { pane: string; window: string; sid: string; state: string; attention: string; cwd: string; humanAt?: number }

export function parsePanes(out: string): PaneSeen[] {
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 6 && p[2])
    .map(([pane, window, sid, state, attention, cwd, human]) => ({ pane: pane!, window: window!, sid: sid!, state: state ?? '', attention: attention ?? '', cwd: cwd ?? '', humanAt: Number(human) ? Number(human) * 1000 : undefined }))
}
export const PANES_FMT = '#{pane_id}\t#{window_id}\t#{@cc_pane_session}\t#{@cc_pane_state}\t#{@cc_pane_attention}\t#{pane_current_path}\t#{@cc_human_at}'

export type Change = { slug: string; text: string; wake: boolean }

// What changed for the ledger's workers since the last look, and the ledger
// with the new states. `wake`: worth a message to the coordinator now (a
// worker waiting on input, gone, or taken over by the person); the rest only
// updates what the office draws.
export function observe(l: Ledger, seen: PaneSeen[], now: number): { ledger: Ledger; changes: Change[] } {
  const bySid = new Map(seen.map((s) => [s.sid, s]))
  const changes: Change[] = []
  const workers = l.workers.map((w) => {
    if (w.endedAt) return w
    const s = bySid.get(w.sid)
    if (!s) {
      // Not yet published: a worker just started has no @cc_pane_session for
      // its first seconds.
      if (now - w.at < 60_000) return w
      changes.push({ slug: w.slug, text: w.slug + ': its session is gone (window closed or claude exited)', wake: true })
      return { ...w, endedAt: now }
    }
    const next: Worker = { ...w, pane: s.pane, window: s.window, state: s.state, attention: s.attention }
    // The brief itself arrives as the worker's first composer prompt (it is
    // claude's command-line argument), so a mark from the spawn's first
    // minute is that, not the person.
    const human = s.humanAt && s.humanAt > w.at + SPAWN_GRACE_MS ? s.humanAt : undefined
    const held = human && (!w.heldAt || human > w.heldAt) ? human : undefined
    if (held) {
      next.heldAt = held
      changes.push({ slug: w.slug, text: w.slug + ': the person is typing in it; send it nothing until ' + new Date(held + HOLD_MS).toTimeString().slice(0, 5), wake: true })
    }
    const asks = s.attention === 'ask' || s.attention === 'action'
    if (asks && w.attention !== s.attention) changes.push({ slug: w.slug, text: w.slug + ': waiting on ' + (s.attention === 'ask' ? 'an answer' : 'an approval') + ' in its pane', wake: true })
    // cc-mods publishes done at a turn's end and waiting (attention none)
    // when the session idles after it; a watch tick can miss the done, and
    // can miss the working too when the whole turn fits between two ticks.
    // So any move into an idle state from a non-idle one is a finished turn.
    else if (!asks && idle(s.state) && !idle(w.state) && (w.state === 'working' || now - w.at > SPAWN_GRACE_MS)) changes.push({ slug: w.slug, text: w.slug + ': finished its turn', wake: true })
    return next
  })
  return { ledger: { ...l, workers }, changes }
}

const idle = (state: string | undefined) => state === 'done' || state === 'waiting'

export function held(w: Worker, now: number): boolean {
  return !!w.heldAt && now - w.heldAt < HOLD_MS
}

// Live sessions that already work where a new worker would: same directory,
// or the same repository checkout. Asked about before starting another.
export function overlaps(seen: PaneSeen[], l: Ledger, dir: string): PaneSeen[] {
  const norm = (p: string) => p.replace(/\/+$/, '')
  const d = norm(dir)
  return seen.filter((s) => s.sid !== l.sid && s.cwd && (norm(s.cwd) === d || norm(s.cwd).startsWith(d + '/') || d.startsWith(norm(s.cwd) + '/')))
}

// What the coordinator reads every turn: its role, its limits, its workers.
export function coordSection(l: Ledger, now: number, language = 'Korean'): string {
  const rows = active(l).map((w) => '| ' + w.slug + ' | ' + w.relation + ' | ' + (w.model ?? '-') + '/' + (w.effort ?? '-') + ' | ' + (w.state ?? '?') + (w.attention && w.attention !== 'none' ? ' (' + w.attention + ')' : '') + (held(w, now) ? ' HELD by person' : '') + ' | ' + w.cwd + ' |')
  return [
    '# Coordinator mode (cc-mods)',
    'You are `' + l.name + '`, the coordinator. You orchestrate, verify, merge, clean up and report; you do not do the work yourself.',
    '- Start workers only with the `coord_spawn` tool (never tmux or claude from Bash). Each gets a worktree off origin and its own tmux window. Before starting one, call `coord_roster` and check that no live session already works there; if one does, ask the person whether to adopt it instead.',
    "- A brief has the person's words verbatim, the evidence paths, the scope, and when to send READY.",
    '- Send instructions only with `coord_send`, and only to owned or adopted workers. Observed sessions are read-only: summarise them, never instruct them. A worker HELD by the person gets nothing until the hold ends.',
    '- Before relaying a report, re-check the claims the decision rides on (file:line, counts, "already merged") and label the rest unverified.',
    '- Merge only when the head equals the READY sha (--match-head-commit), CI passed on that sha, no unresolved threads, the bot review is clean, and the head contains origin/main. Admin merge only on the person\'s typed order.',
    '- After a merge, close the worker with `coord_close` (it removes the worktree and the window).',
    '- When the person must decide, show the worker\'s visual brief and ask with AskUserQuestion, the recommended option first. The person may also answer or instruct from the office; those arrive here as prompts.',
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
