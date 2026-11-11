// Coordinator mode, the I/O side (the rules are lib/coord.ts): the /coord
// command, the coord_* tools the coordinator's Claude calls, and the watch
// that tells it when a worker needs it. register.ts calls coordStart from
// session.start and adds coordSection to the system prompt (or, where
// cc-plugin-sec-default keeps that out of reach, to the conversation).
//
// Only the person turns the mode on (/coord on, a command Claude cannot run)
// and sets its limits. The tools refuse while it is off, so a session that
// never turned it on can start nothing.

import { briefGates, gateNote } from './lib/grant'
import { COORD_CAPS, PANES_FMT, WAKE_PREFIX, WORKER_CAPS, active, mcpWakes, adoptSlug, applyOps, autoAdopt, closeArgv, foreign, limitsText, released, unadopt, coordRules, coordRoster, current, logged, mergeRepos, observe, overlaps, parseLedger, parseLimits, parsePanes, policyArgvs, policyOf, recheck, spawnRefusal, statusTail, titleArgv, typedLately, typedNote, unseen, workerArgv, workerPrompt, type Change, type Ledger, type Made, type PaneSeen, type Worker } from './lib/coord'
import { canonicalOf, parseProjects, placement, trustTarget, trustedBy } from './lib/trust'
import { restoreArgvs } from './lib/rca'
import { repoFromRemote } from './lib/prs'
import { ROUTER_MODEL, candidates, checkRoute, parsePrompts, parseRoute, routeRequest, routeText, type Paths, type Raw } from './lib/coordroute'
import { BOX_FMT, busyOf, parseBoxes, pick, places, spots, type Fit, type PaneBox, type Work } from './lib/coordplace'
import type { Policy } from './lib/policy'
import { confirmed, countText, parseReview, pruned, reviewLine, reviewTable, upsert, type ReviewFile } from './lib/coordreview'
import { clip } from './lib/text'
import { STATUS_DIR, parseStatusFile, type Status } from './lib/status'
import { DEFER_DIR, DEFER_LIST, parseDeferred } from './lib/defer'
import { INLINE_MAX, parseInbox, spillDir, spilled } from './lib/inbox'
import { SUM_MODEL, applied, parseFirst, parseLast, parseSummaries, parseSums, personLines, plan, sumRequest, type SumIn, type Summaries } from './lib/coordsum'

// What register.ts lends: the session, and its policy. God mode keeps "the
// policy before" and puts it back when it ends, so while god is on the
// coordinator's policy goes there instead of being applied over god.
export type CoordPolicy = {
  now: () => Promise<Policy | null>
  run: (argv: string[], sessionId?: string) => Promise<boolean>
  godBefore: () => Policy | undefined
  setGodBefore: (p: Policy) => Promise<void>
  reload: () => Promise<void>
}
// busy: the coordinator's own turn is running (a prompt submitted then waits
// for its end).
type Ctx = { sid: () => string; home: () => string; pane: () => string | undefined; busy: () => boolean; policy: CoordPolicy }

const TOOLS = {
  roster: {
    name: 'coord_roster',
    description: 'Coordinator mode: every live Claude session in tmux with its relation to this coordinator (owned; adopted, every live session by default; observed: another coordinator, its owned workers, a session handed back), state, attention, directory and SendMessage name. Call before starting a worker.',
    inputSchema: { type: 'object', properties: {} },
  },
  route: {
    name: 'coord_route',
    description:
      'Coordinator mode: where a task goes. One cheap model call reads every live session (relation, state, directory, repository, its recent prompts) and your limits, and answers send (an owned or adopted worker: every live session is adopted by default), adopt (an observed session that fits; the person hands it over), spawn (a new worker: repo_dir or cwd, model, effort) or unsure, with a reason. It only answers: act on it with coord_send or coord_spawn. Call it first for every task.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: "the task, in the person's words" } }, required: ['task'] },
  },
  spawn: {
    name: 'coord_spawn',
    description:
      "Coordinator mode: start a worker claude in a pane split off yours in your tmux window (the person sees it there), in a window that already holds your workers, or in a new window: pass coord_route's window as `window`; without it, or when that place no longer has room, your window when it has room (at most 2 workers, 60 columns and 15 rows left on each side), else a new window. A window is used only when every session in it works on the same repository (or task folder) as the worker, your own window included; one holding other work is never split. With repo_dir, a worktree is made off origin's default branch at ~/worktrees/<repo>/<slug> on branch <slug>; with cwd, it runs there as is. The brief is saved to ~/research/<slug>/prompt.txt (always reachable) and reporting instructions are appended. In a repository (or cwd) Claude Code does not trust, the worker runs in ~/research/<slug> with the code as an add-dir, and its prompt says to use absolute paths and git -C. Refused above the person's limits, or when a live session already works in that directory unless overlap_ok (set it only after the person said to start another anyway).",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'short task name: lowercase, digits, dashes' },
        model: { type: 'string', description: 'haiku | sonnet | opus' },
        effort: { type: 'string', description: 'low | medium | high | xhigh | max' },
        brief: { type: 'string', description: "the worker's prompt: the person's words verbatim, evidence paths, scope, when to send READY" },
        repo_dir: { type: 'string', description: 'a local git checkout to branch a worktree from' },
        cwd: { type: 'string', description: 'run in this directory instead of a new worktree' },
        add_dirs: { type: 'array', items: { type: 'string' }, description: "existing folders outside its cwd the worker's tools may reach without a permission dialog (claude --add-dir); ~/research/<slug> is always added" },
        window: { type: 'string', description: 'where its pane goes, from coord_route: a window id it listed ("@N") or "new"' },
        overlap_ok: { type: 'boolean' },
      },
      required: ['slug', 'model', 'effort', 'brief'],
    },
  },
  send: {
    name: 'coord_send',
    description: 'Coordinator mode: send an instruction to an owned or adopted worker (every live session is adopted by default); it arrives in that session as a message starting with [coordinator]: a peer message, read mid-turn at its next tool call, or (when no peer message reaches it) its office inbox, read when its turn ends. No length limit: a very long text goes to a file and the message carries the path. Refused for observed sessions. The person typing in that pane is no bar (their draft is left alone); the result notes it when they typed there in the last 10 minutes.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, text: { type: 'string' } }, required: ['slug', 'text'] },
  },
  close: {
    name: 'coord_close',
    description: 'Coordinator mode: end a worker. Owned: kills the pane coord_spawn made for it (or its fallback window) and removes its worktree (refused when the worktree has uncommitted changes). Adopted: hands it back to the person (the session and its pane keep running) and it is not adopted again.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
  review: {
    name: 'coord_review',
    description:
      "Coordinator mode: the review queue, finished work the person should judge (the office's 지휘 view shows it under 🔎 검토; the person's 확인함 or 문제 있음 comes back as `[review] confirmed <id>` or `[review] issue <id>: <words>`). add: a new item, or the same id again for the same work's later step (fields given overwrite, links pile up, a confirmed item opens again). update: an id already there. confirm: the person said in chat they looked at it. list: the open items. Every result ends with the open count to say in chat as `검토 대기 N건`.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'confirm', 'list'] },
        id: { type: 'string', description: 'the work: the worker slug or the PR (cc-mods#85); letters, digits, . # _ -' },
        title: { type: 'string', description: 'one line the person recognises the work by' },
        changed: { type: 'string', description: 'what changed, in the words the person would use' },
        verified: { type: 'string', description: 'what you checked (tests, live run, CI on the sha) and what you did not' },
        check: { type: 'string', description: 'what the person should look at or try themselves' },
        risk: { type: 'string', description: 'what could go wrong, or is untested' },
        links: { type: 'array', items: { type: 'string' }, description: 'PR URLs, brief paths, files' },
      },
      required: ['action'],
    },
  },
}

let ledger: Ledger | undefined
let toolNames: Record<string, keyof typeof TOOLS> = {}
let watch: { cancel: () => void } | undefined
let ctx: Ctx | undefined
// A reload (a merge on main) starts this module over while the engine keeps
// the coord_* tools registered: a call in the next moment met no ledger and
// no tool names, and went unanswered (live, three times: "no tool.call hook
// answered this call"). Calls wait for coordStart.
let started!: () => void
const ready = new Promise<void>((r) => (started = r))
const READY_WAIT_MS = 20_000

// The tool by its name, whether or not this module has registered it yet.
function kindOf(tool: string): keyof typeof TOOLS | undefined {
  if (toolNames[tool]) return toolNames[tool]
  const m = /^mcp__cc-mods__coord_(roster|route|spawn|send|close|review)$/.exec(tool)
  return m ? (m[1] as keyof typeof TOOLS) : undefined
}

const dir = () => ctx!.home() + '/.claude/state/office/coord'
const file = () => dir() + '/' + ctx!.sid() + '.json'
// Not dir()/*.json: that glob is the ledgers (lib/coordreview.ts).
const reviewFile = () => dir() + '/review/' + ctx!.sid() + '.json'
// What the office asks of this coordinator (office/crew.py): taken once.
const opsFile = () => dir() + '/ops/' + ctx!.sid() + '.json'
// The queue as last read: coordSection's line. The office writes confirms
// into the file, so it is read again each tick and before every change.
let review: ReviewFile | undefined

async function sh($: any, argv: string[], opts: Record<string, unknown> = {}) {
  try {
    const r = await $.process.run(argv, { timeoutMs: 15_000, ...opts })
    return { ok: r.exitCode === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() }
  } catch (e) {
    return { ok: false, out: '', err: String(e) }
  }
}

async function readText($: any, path: string): Promise<string | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    const r = await $.fs.read(path)
    return typeof r === 'string' ? r : r?.text
  } catch {
    return undefined
  }
}

async function save($: any, l: Ledger) {
  ledger = l
  await sh($, ['mkdir', '-p', dir()])
  await $.fs.write(file(), JSON.stringify(l, null, 1)).catch(() => undefined)
}

// Session id → SendMessage name, from Claude Code's session registry.
async function names($: any): Promise<Map<string, string>> {
  const r = await sh($, ['sh', '-c', 'jq -c "{s: .sessionId, n: .name}" "$0"/.claude/sessions/*.json 2>/dev/null', ctx!.home()])
  const m = new Map<string, string>()
  for (const line of r.out.split('\n')) {
    try {
      const d = JSON.parse(line)
      if (d.s) m.set(d.s, d.n || String(d.s).slice(0, 8))
    } catch {}
  }
  return m
}

async function panes($: any): Promise<PaneSeen[]> {
  return (await panesRead($)) ?? []
}

// The panes, or undefined when tmux did not answer: a module reload kills
// the reads it was running, and a timeout or a killed read is not every
// session gone (live, 2026-11-10 20:16: 22 workers called gone in one tick,
// all alive). A list where no pane names a session is no answer either: this
// coordinator's own pane names its session while it runs.
async function panesRead($: any): Promise<PaneSeen[] | undefined> {
  const r = await sh($, ['tmux', 'list-panes', '-a', '-F', PANES_FMT], { timeoutMs: 3000 })
  const seen = r.ok ? parsePanes(r.out) : []
  return seen.length ? seen : undefined
}

// Of these session ids, the ones still alive: a claude process the session
// registry names (checked to be claude, so a reused pid is not it; a worker
// started through ccproxy is still a claude child, its pane's command
// ccproxy), or a transcript written in the last 3 minutes. The last line
// says the loop ran to its end.
export const ALIVE_DONE = '--alive-done--'
const ALIVE_SH =
  'h=$0; for s in "$@"; do p=$(jq -r --arg s "$s" \'select(.sessionId == $s) | .pid\' "$h"/.claude/sessions/*.json 2>/dev/null | head -1); ' +
  'if [ -n "$p" ] && ps -o comm= -p "$p" 2>/dev/null | grep -q claude; then echo "$s"; continue; fi; ' +
  'f=$(ls "$h"/.claude/projects/*/"$s".jsonl 2>/dev/null | head -1); [ -n "$f" ] && [ -n "$(find "$f" -mmin -3 2>/dev/null)" ] && echo "$s"; done; echo ' +
  ALIVE_DONE

// A read that did not finish (timed out, killed by a reload) found nobody
// dead: every session asked about counts alive.
async function alive($: any, sids: string[]): Promise<Set<string>> {
  if (!sids.length) return new Set()
  const r = await sh($, ['sh', '-c', ALIVE_SH, ctx!.home(), ...sids], { timeoutMs: 5000 })
  const lines = r.out.split('\n')
  if (!lines.includes(ALIVE_DONE)) return new Set(sids)
  return new Set(lines.filter((x) => sids.includes(x)))
}

export function coordLedger(): Ledger | undefined {
  return ledger
}

// coordSection in its two halves: one text in the system prompt, two
// conversation rows where that is out of reach (register.ts contextNotes),
// the rules sent once and the roster when it changed.
export function coordParts(now: number): { rules: string; roster: string } | undefined {
  return ledger?.on ? { rules: coordRules(ledger, 'Korean'), roster: coordRoster(ledger, now, reviewLine(review)) } : undefined
}

async function readOps($: any) {
  const raw = await readText($, opsFile())
  if (raw === undefined) return
  await sh($, ['rm', '-f', opsFile()])
  const { ledger: l, done } = applyOps(ledger!, raw, Date.now())
  if (done.length) await save($, l)
}

async function readReview($: any): Promise<ReviewFile> {
  review = parseReview(await readText($, reviewFile()), ctx!.sid(), ledger?.name ?? ctx!.sid().slice(0, 8))
  return review
}

// register.ts, when a `[review] …` prompt from the office arrives: the
// person's confirm is in the file already, so the turn's line counts it.
export async function coordReviewRefresh($: any) {
  if (ledger?.on && ctx) await readReview($)
}

export async function coordStart($: any, c: Ctx) {
  ctx = c
  try {
    const n = await names($)
    ledger = parseLedger(await readText($, file()), c.sid(), n.get(c.sid()) ?? c.sid().slice(0, 8), Date.now())
    if (ledger.on) await turnOn($, false)
  } finally {
    started()
  }
}

async function registerTools($: any) {
  toolNames = {}
  for (const [k, spec] of Object.entries(TOOLS)) {
    try {
      const r = await $.tool.register({ ...spec, isDeferred: false })
      toolNames[r?.tool ?? spec.name] = k as keyof typeof TOOLS
    } catch (err) {
      $.ui.log('coord: could not register ' + spec.name + ': ' + String(err))
    }
  }
}

async function turnOn($: any, fresh: boolean) {
  const l = ledger!
  const n = await names($)
  let next: Ledger = { ...l, on: true, pane: ctx!.pane(), name: n.get(l.sid) ?? l.name }
  if (fresh && !l.on) {
    // What /coord off puts back: god's "before" while god is on, else now.
    const before = ctx!.policy.godBefore() ?? (await ctx!.policy.now())
    if (before) next = { ...next, policyBefore: before }
    await save($, logged(next, 'order', 'coordinator mode on', Date.now()))
    await coordPolicy($)
  } else await save($, next)
  await registerTools($)
  watch?.cancel()
  watch = $.clock.every(10_000, () => void tick($))
}

// Worker states, every 10 s while the mode is on. What needs the coordinator
// (a worker asking, gone, or taken over by the person) is sent to it as one
// framed prompt; the rest only updates the ledger the office draws.
let ticking = false
async function tick($: any) {
  if (ledger?.on && !ticking) await readReview($)
  if (ledger?.on && !ticking) await readOps($)
  if (ticking || !ledger?.on || (!active(ledger).length && !ledger.limits.autoAdopt)) return
  ticking = true
  try {
    // Panes first: a coord tool (close, spawn) may save the ledger while
    // tmux answers, and observing the ledger from before that would undo it.
    const seen = await panesRead($)
    // tmux did not answer: nothing is known about any worker this tick.
    if (!seen) return
    // A session that appeared since the last tick becomes an adopted worker.
    await adoptLive($, seen, false)
    // A worker no pane names is gone only when its session is: another
    // session can take its pane's name (a `claude -p` it ran, from a cc-mods
    // before register.ts kept those off the pane).
    const live = await alive($, unseen(ledger, seen, Date.now()).map((w) => w.sid))
    // Each worker's declared status (register.ts statusTool writes
    // state/office/status/<sid>.json), read before observe so a turn's wake
    // carries the one declared in that turn.
    const statuses = await statusFiles($, ledger)
    const o = observe(ledger, seen, Date.now(), live, sums, statuses)
    // MCP servers the coordinator's and its workers' cc-mods could not get
    // back (register.ts mcpExport writes state/office/mcp/<sid>.json).
    const files = await mcpFiles($, o.ledger)
    const m = files ? mcpWakes(o.ledger, files, sums) : { ledger: o.ledger, changes: [] }
    const l = m.ledger
    // A worker the person set aside (office ⏰ 나중에, lib/defer.ts) is
    // recorded, not woken for, as a quiet worker is: its turns, asks and
    // MCP drops wait for its time, or for the office to bring it back on a
    // new question (the file then stops naming it).
    const asleep = await deferredSids($)
    const changes = [...o.changes, ...m.changes].map((c) => (c.wake && asleep.has(c.sid) ? { ...c, wake: false } : c))
    let out = l
    // A quiet worker's asks are the person's own work: kept in its
    // row, not in the log the office shows.
    for (const c of changes) if (c.wake || c.kind === 'gone' || c.kind === 'back') out = logged(out, 'event', c.text, Date.now())
    if (changes.length || l.mcpDown !== ledger.mcpDown || JSON.stringify(l.workers) !== JSON.stringify(ledger.workers)) await save($, out)
    // A worker coord_close is closing: its pane went first, its endedAt
    // comes when the close saves. Not news to the coordinator that closed it.
    pending.push(...changes.filter((c) => c.wake && !closing.has(c.sid)))
    await flush($)
    // The office's one-line summaries, at most once a minute: a session the
    // person prompts again is labelled anew by the next one.
    if (Date.now() - summedAt > SUM_EVERY_MS) {
      summedAt = Date.now()
      sums = await summarize($, seen, await names($), await sessionInfo($, seen))
    }
  } finally {
    ticking = false
  }
}

// `<sid>\t<file on one line>` for each sid whose <dir>/<sid>.json exists.
const READ_EACH = 'd=$0; for s; do [ -f "$d/$s.json" ] && printf "%s\\t%s\\n" "$s" "$(tr -d "\\n" < "$d/$s.json")"; done; true'

// The active workers' status files, by session id. One read for all; a
// failed read or a missing file is no news (the ledger keeps what it had).
async function statusFiles($: any, l: Ledger): Promise<Map<string, Status>> {
  const m = new Map<string, Status>()
  const sids = active(l).map((w) => w.sid)
  if (!sids.length) return m
  const r = await sh($, ['sh', '-c', READ_EACH, ctx!.home() + STATUS_DIR, ...sids], { timeoutMs: 3000 })
  if (!r.ok) return m
  for (const line of r.out.split('\n')) {
    const i = line.indexOf('\t')
    const st = i > 0 ? parseStatusFile(line.slice(i + 1)) : undefined
    if (st) m.set(line.slice(0, i), st)
  }
  return m
}

// The sessions set aside now (a failed read: none).
async function deferredSids($: any): Promise<Map<string, number>> {
  const r = await sh($, ['sh', '-c', DEFER_LIST, ctx!.home() + DEFER_DIR], { timeoutMs: 3000 })
  return r.ok ? parseDeferred(r.out, Date.now()) : new Map()
}
// Each live session's MCP state file, by session id: the coordinator's and
// its active workers'. One read for all (a missing file reads as nothing).
async function mcpFiles($: any, l: Ledger): Promise<Map<string, string | undefined> | undefined> {
  const sids = [l.sid, ...active(l).map((w) => w.sid)]
  const d = ctx!.home() + '/.claude/state/office/mcp'
  const r = await sh($, ['sh', '-c', READ_EACH, d, ...sids], { timeoutMs: 3000 })
  // A read that failed is no news (as a failed tmux read is for observe):
  // undefined, and the tick keeps what the ledger had.
  if (!r.ok) return undefined
  const m = new Map<string, string | undefined>()
  for (const line of r.out.split('\n')) {
    const i = line.indexOf('\t')
    if (i > 0) m.set(line.slice(0, i), line.slice(i + 1))
  }
  return m
}
let summedAt = 0
const SUM_EVERY_MS = 60_000
// The summaries the last one wrote: a wake and an inbox message name a
// worker by what it was doing (lib/coord.ts who), not by its slug alone.
let sums: Map<string, string> = new Map()

// The ledger with every live session adopted (lib/coord.ts autoAdopt). The
// other ledgers and the names are read only when a session is new (`full`:
// always, for roster and route), so a quiet tick costs no more than before.
// The ledger is taken again after the reads: a coord tool may have saved it
// meanwhile.
async function adoptLive($: any, seen: PaneSeen[], full: boolean) {
  const l = ledger!
  if (!l.on || !l.limits.autoAdopt) return
  if (!full) {
    const known = new Set([l.sid, ...l.released, ...active(l).map((w) => w.sid)])
    if (seen.every((s) => known.has(s.sid))) return
  }
  const [n, others] = await Promise.all([names($), sh($, ['sh', '-c', 'for f in "$0"/*.json; do [ "$f" = "$1" ] || jq -c . "$f" 2>/dev/null; done', dir(), file()], { timeoutMs: 3000 })])
  const r = autoAdopt(ledger!, seen, n, foreign(others.out.split('\n').filter(Boolean), ledger!.sid), Date.now())
  if (r.ledger !== ledger) await save($, r.ledger)
}

// Wakes not yet delivered. A prompt submitted while the coordinator's turn
// runs waits for that turn's end, by when the coordinator has often found
// out itself (a worker gone two minutes before it heard). So they wait
// here: a coord tool's result carries them, and at the turn's end the ones
// still true go as one prompt.
let pending: Change[] = []
const closing = new Set<string>()
// What each submitted line was for: the prompt waits in the engine's queue
// until the session is idle, and coordRecheck looks at it again then.
const sent = new Map<string, Change>()

async function flush($: any) {
  if (!pending.length || !ctx || ctx.busy()) return
  const now = Date.now()
  const due = pending.filter((c) => ledger && current(c, ledger, now))
  pending = []
  if (!due.length) return
  for (const c of due) sent.set(c.text, c)
  while (sent.size > 50) sent.delete(sent.keys().next().value!)
  await $.prompt.submit({ text: WAKE_PREFIX + due.map((c) => c.text).join('\n' + WAKE_PREFIX) }).catch(() => undefined)
}

// register.ts, at a plugin prompt's prompt.submit: the [coord] text with the
// lines no longer true taken out, undefined when none is left (dropped).
export function coordRecheck(text: string): string | undefined {
  return ledger && text.startsWith(WAKE_PREFIX) ? recheck(text, ledger, Date.now(), sent) : text
}

// register.ts: the coordinator's turn ended.
export async function coordIdle($: any) {
  if (ledger?.on) await flush($)
}

function withPending(r: { result: string } | { deny: string }): { result: string } | { deny: string } {
  if (!pending.length || !('result' in r)) return r
  const now = Date.now()
  const due = pending.filter((c) => ledger && current(c, ledger, now))
  pending = []
  return due.length ? { result: r.result + '\n\nMeanwhile:\n' + WAKE_PREFIX + due.map((c) => c.text).join('\n' + WAKE_PREFIX) } : r
}

// ---- the person's command ---------------------------------------------------

export async function coordCommand($: any, args: string): Promise<string> {
  if (!ledger || !ctx) return 'coordinator mode is not ready yet (no session)'
  const [verb = 'status', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ')
  const now = Date.now()
  if (verb === 'on') {
    await turnOn($, true)
    return 'Coordinator mode on as `' + ledger.name + '`, with its own policy: merge only in its workers\' repositories, auto-continue, no prod write, Slack or other windows' + (ctx.policy.godBefore() ? ' (applied when god mode ends)' : '') + '. Limits: ' + limitsText(ledger.limits) + ' (/coord limits to change)' + (ledger.limits.autoAdopt ? ' Every live session becomes an adopted worker within 10 s; /coord release <slug> hands one back for good.' : '') + ' The coord_* tools are there from the next prompt.'
  }
  if (verb === 'off') {
    watch?.cancel()
    watch = undefined
    const before = ledger.policyBefore
    await save($, logged({ ...ledger, on: false, policyBefore: undefined }, 'order', 'coordinator mode off', now))
    if (before) {
      if (ctx.policy.godBefore()) await ctx.policy.setGodBefore(before)
      else for (const argv of restoreArgvs(before)) await ctx.policy.run(argv)
      await ctx.policy.reload()
    }
    return 'Coordinator mode off; this session\'s policy is back to what it was. Workers keep running in their panes; the ledger stays for the next /coord on.'
  }
  if (verb === 'limits') {
    if (!arg) return 'Limits: ' + limitsText(ledger.limits)
    const lim = parseLimits(arg, ledger.limits)
    if (typeof lim === 'string') return lim
    const next = logged({ ...ledger, limits: lim }, 'limits', arg, now)
    await save($, lim.autoAdopt ? next : unadopt(next, now))
    return 'Limits now: ' + limitsText(lim)
  }
  if (verb === 'adopt') {
    // By pane id (%12), session name, or the start of a session id.
    const seen = await panes($)
    const n = await names($)
    const hit = seen.find((s) => s.pane === arg || n.get(s.sid) === arg || (arg.length >= 6 && s.sid.startsWith(arg)))
    if (!hit) return 'No live session matches ' + JSON.stringify(arg) + '; give its pane id, name or session id.'
    if (hit.sid === ledger.sid) return 'That is this session.'
    const had = active(ledger).find((w) => w.sid === hit.sid)
    // Adopted by autoAdopt: the person handing it over makes it theirs no
    // longer, so its turns wake the coordinator from now on.
    if (had?.auto) {
      await save($, logged({ ...ledger, workers: ledger.workers.map((x) => (x === had ? { ...x, auto: undefined } : x)) }, 'adopt', had.slug + ' (' + hit.pane + ') handed over', now))
      return 'Adopted ' + had.slug + ' (' + hit.pane + '), handed over: its turns wake the coordinator now.'
    }
    if (had) return 'Already in the ledger.'
    const slug = adoptSlug(n.get(hit.sid), hit.sid, new Set(active(ledger).map((x) => x.slug)))
    const w: Worker = { slug, sid: hit.sid, relation: 'adopted', pane: hit.pane, window: hit.window, cwd: hit.cwd, at: now, state: hit.state, attention: hit.attention }
    // A session handed back before is the coordinator's again.
    await save($, logged({ ...ledger, released: ledger.released.filter((x) => x !== hit.sid), workers: [...ledger.workers, w] }, 'adopt', slug + ' (' + hit.pane + ')', now))
    return 'Adopted ' + slug + ' (' + hit.pane + '). The coordinator may instruct it now.'
  }
  if (verb === 'release') {
    const w = active(ledger).find((x) => x.slug === arg)
    if (!w) return 'No worker ' + arg
    await save($, released(ledger, w, now))
    return 'Released ' + arg + '; it keeps running, now observed only, and is not adopted again (/coord adopt takes it back).'
  }
  const rows = active(ledger).map((w) => '- ' + w.slug + ' · ' + w.relation + (w.auto ? ' (auto)' : '') + ' · ' + (w.model ?? '-') + '/' + (w.effort ?? '-') + ' · ' + (w.state ?? '?') + (typedLately(w, now) ? ' · you typed lately' : '') + ' · ' + (w.pane ?? ''))
  return 'Coordinator mode ' + (ledger.on ? 'on' : 'off') + ' as `' + ledger.name + '`.\n' + (rows.length ? rows.join('\n') : 'No workers.') + '\n/coord on|off|adopt <pane|name>|release <slug>|limits [models <list>|effort <level>|workers <n>|adopt on|off]'
}

// ---- the tools --------------------------------------------------------------

export function isCoordTool(tool: string): boolean {
  return kindOf(tool) !== undefined
}

export async function coordTool($: any, tool: string, input: any): Promise<{ result: string } | { deny: string }> {
  const kind = kindOf(tool)
  if (!ledger || !ctx) {
    let timer: { cancel: () => void } | undefined
    await Promise.race([ready, new Promise<void>((r) => (timer = $.clock.after(READY_WAIT_MS, r)))])
    timer?.cancel()
  }
  if (!ledger || !ctx) return { deny: 'coordinator mode is not ready (cc-mods is still loading); call again in a few seconds' }
  if (!ledger.on) return { deny: 'coordinator mode is off; only the person turns it on (/coord on)' }
  if (kind === 'roster') return withPending({ result: await roster($) })
  if (kind === 'route') return withPending(await route($, input ?? {}))
  if (kind === 'spawn') return withPending(await spawn($, input ?? {}))
  if (kind === 'send') return withPending(await send($, input ?? {}))
  if (kind === 'close') return withPending(await close($, input ?? {}))
  if (kind === 'review') return withPending(await reviewTool($, input ?? {}))
  return { deny: 'unknown coordinator tool' }
}

async function roster($: any): Promise<string> {
  const seen = await panes($)
  await adoptLive($, seen, true)
  const n = await names($)
  const doing = await summarize($, seen, n, await sessionInfo($, seen))
  const mine = new Map(active(ledger!).map((w) => [w.sid, w]))
  const now = Date.now()
  const rows = seen
    .filter((s, i) => seen.findIndex((x) => x.sid === s.sid) === i)
    .map((s) => {
      const w = mine.get(s.sid)
      const rel = s.sid === ledger!.sid ? 'self' : (w?.relation ?? 'observed') + (w?.auto ? ' (auto)' : '')
      return '| ' + (n.get(s.sid) ?? s.sid.slice(0, 8)) + ' | ' + rel + (w ? ' ' + w.slug : '') + ' | ' + s.pane + ' | ' + (s.state || '?') + (s.attention && s.attention !== 'none' ? ' (' + s.attention + ')' : '') + (w && typedLately(w, now) ? ' person typed ' + new Date(w.typedAt!).toTimeString().slice(0, 5) : '') + ' | ' + (w?.status ? statusTail(w.status, now).slice(' — status '.length) : '-') + ' | ' + s.cwd + ' | ' + (doing.get(s.sid) ?? '').replace(/\|/g, '/') + ' |'
    })
  return '| name | relation | pane | state | status | cwd | doing |\n|---|---|---|---|---|---|---|\n' + rows.join('\n')
}

// The newest prompts of each session, off the tail of its transcript (the
// office reads the same files): one shell for all of them, a JSON row per
// prompt, parsed in lib/coordroute.ts.
// The third column is the prompt's timestamp: a session's summary stands
// until its newest prompt changes (lib/coordsum.ts).
const PROMPT_JQ = '\'fromjson? | select(.type == "user" and (.isMeta | not)) | (.timestamp // "") as $t | .message.content | (if type == "string" then . else ([.[]? | select(.type == "text") | .text] | join(" ")) end) | select(length > 0) | [$s, ., $t]\''
const PROMPTS_SH =
  'h=$0; for s in "$@"; do f=$(ls "$h"/.claude/projects/*/"$s".jsonl 2>/dev/null | head -1); [ -n "$f" ] || continue; ' +
  'tail -c 300000 "$f" | tail -n +2 | jq -Rc --arg s "$s" ' + PROMPT_JQ + ' 2>/dev/null | tail -n 12; done'
// The coordinator's own prompts, further back: the person's words are a few
// among many worker reports (coordsum personLines keeps them).
const OWN_SH =
  'h=$0; s=$1; f=$(ls "$h"/.claude/projects/*/"$s".jsonl 2>/dev/null | head -1); [ -n "$f" ] || exit 0; ' +
  'tail -c 3000000 "$f" | tail -n +2 | jq -Rc --arg s "$s" ' + PROMPT_JQ + ' 2>/dev/null | tail -n 400'
// The first prompts, off the head: what the session was started for.
const FIRST_SH =
  'h=$0; for s in "$@"; do f=$(ls "$h"/.claude/projects/*/"$s".jsonl 2>/dev/null | head -1); [ -n "$f" ] || continue; ' +
  'head -c 200000 "$f" | jq -Rc --arg s "$s" ' + PROMPT_JQ + ' 2>/dev/null | head -n 4; done'

type Info = { titles: Map<string, string>; prompts: Map<string, string[]>; first: Map<string, string>; last: Map<string, string>; own?: { prompts: string[]; first?: string; last?: string } }

// Pane labels and prompts of every live session; this one's own (`own`,
// the person's words only) when it is among them.
async function sessionInfo($: any, seen: PaneSeen[]): Promise<Info> {
  const me = ledger!.sid
  const sids = [...new Set(seen.filter((s) => s.sid !== me).map((s) => s.sid))]
  const self = seen.some((s) => s.sid === me)
  const [titles, tail, head, own, ownHead] = await Promise.all([
    sh($, ['tmux', 'list-panes', '-a', '-F', '#{@cc_pane_session}\t#{@title}'], { timeoutMs: 3000 }).then((r) => new Map(r.out.split('\n').map((x) => x.split('\t') as [string, string]).filter(([s, t]) => s && t))),
    sids.length ? sh($, ['sh', '-c', PROMPTS_SH, ctx!.home(), ...sids], { timeoutMs: 10_000 }) : Promise.resolve({ out: '' }),
    sids.length ? sh($, ['sh', '-c', FIRST_SH, ctx!.home(), ...sids], { timeoutMs: 10_000 }) : Promise.resolve({ out: '' }),
    self ? sh($, ['sh', '-c', OWN_SH, ctx!.home(), me], { timeoutMs: 10_000 }) : Promise.resolve({ out: '' }),
    self ? sh($, ['sh', '-c', FIRST_SH, ctx!.home(), me], { timeoutMs: 10_000 }) : Promise.resolve({ out: '' }),
  ])
  const mine = personLines(own.out)
  return {
    titles,
    prompts: parsePrompts(tail.out),
    first: parseFirst(head.out),
    last: parseLast(tail.out),
    ...(self ? { own: { prompts: parsePrompts(mine).get(me) ?? [], first: parseFirst(personLines(ownHead.out)).get(me), last: parseLast(mine).get(me) } } : {}),
  }
}

// What each live session was doing (lib/coordsum.ts), kept in the office's
// state where the 지휘 view reads it. The plan is written at once (a given
// name or the first prompt), the model's labels when its one call answers;
// a call already out is not started again.
const sumFile = () => ctx!.home() + '/.claude/state/office/summary.json'
let summing = false
async function summarize($: any, seen: PaneSeen[], n: Map<string, string>, info: Info): Promise<Map<string, string>> {
  const mine = new Map(active(ledger!).map((w) => [w.sid, w]))
  const rows: SumIn[] = []
  for (const s of seen) {
    if (rows.some((r) => r.sid === s.sid)) continue
    if (s.sid === ledger!.sid) {
      // Itself: what the person asked of it, never its workers' reports.
      const o = info.own
      if (o && (o.first || o.prompts.length)) rows.push({ sid: s.sid, name: n.get(s.sid) ?? ledger!.name, ...(info.titles.get(s.sid) ? { title: info.titles.get(s.sid) } : {}), cwd: s.cwd, ...(o.first ? { first: o.first } : {}), prompts: o.prompts, ...(o.last ? { last: o.last } : {}) })
      continue
    }
    const w = mine.get(s.sid)
    rows.push({ sid: s.sid, name: n.get(s.sid) ?? s.sid.slice(0, 8), ...(w ? { slug: w.slug } : {}), ...(info.titles.get(s.sid) ? { title: info.titles.get(s.sid) } : {}), cwd: s.cwd, ...(info.first.get(s.sid) ? { first: info.first.get(s.sid) } : {}), prompts: info.prompts.get(s.sid) ?? [], ...(info.last.get(s.sid) ? { last: info.last.get(s.sid) } : {}) })
  }
  const cache = parseSummaries(await readText($, sumFile()))
  const now = Date.now()
  const { next, ask } = plan(rows, cache, now)
  // Another coordinator's sessions stay in the file: merged, not replaced.
  const write = async (sums: Summaries) => {
    const all = { ...parseSummaries(await readText($, sumFile())), ...sums }
    await $.fs.write(sumFile(), JSON.stringify(all)).catch(() => undefined)
  }
  if (JSON.stringify(rows.map((r) => cache[r.sid])) !== JSON.stringify(rows.map((r) => next[r.sid]))) await write(next)
  if (ask.length && !summing) {
    summing = true
    void (async () => {
      try {
        const q = sumRequest(ask)
        const r = await $.model.complete({ model: SUM_MODEL, system: q.system, prompt: q.prompt, maxTokens: 1200, effort: 'low', timeoutMs: 45_000 })
        if (r?.isAnswered) await write(applied(next, parseSums(String(r.text ?? ''), ask), Date.now()))
      } catch {
        // The first prompt stands; plan() asks again after SUM_RETRY_MS.
      } finally {
        summing = false
      }
    })()
  }
  return new Map(Object.entries(next).map(([k, v]) => [k, v.text]))
}

async function route($: any, i: any): Promise<{ result: string } | { deny: string }> {
  const task = String(i.task ?? '').trim()
  if (!task) return { deny: 'coord_route: the task is empty' }
  const seen = await panes($)
  await adoptLive($, seen, true)
  const l = ledger!
  const others = seen.filter((s) => s.sid !== l.sid)
  const [n, info, repos] = await Promise.all([names($), sessionInfo($, others), commonDirs($, seen).then((m) => new Map([...m].map(([cwd, common]) => [cwd, canonicalOf(common) ?? common])))])
  const doing = await summarize($, others, n, info)
  const cands = candidates(seen, l, n, { titles: info.titles, prompts: info.prompts, repos, doing }, Date.now())
  const owned = active(l).filter((w) => w.relation === 'owned').length
  const all = await boxes($)
  const box = coordBox(all)
  // Each place is shown with the work of the sessions in it; which of them
  // fit is known once the router has chosen the repository, below.
  const fit = await fitOf($, seen, box.window)
  const room = places(spots(l, box, all, fit))
  const ask = routeRequest(task, cands, l.limits, owned, room)
  let r: any
  try {
    r = await $.model.complete({ model: ROUTER_MODEL, system: ask.system, prompt: ask.prompt, maxTokens: 600, effort: 'low', timeoutMs: 45_000 })
  } catch (e) {
    return { deny: 'coord_route: the router call was refused (' + String(e) + '); nothing was decided' }
  }
  if (!r?.isAnswered) return { deny: 'coord_route: the router model gave no answer (' + (r?.reason ?? 'unknown') + (r?.status ? ' ' + r.status : '') + (r?.error ? ' ' + r.error : '') + '); nothing was decided, call it again' }
  const raw = parseRoute(r.text)
  if ('error' in raw) return { deny: 'coord_route: ' + raw.error }
  const paths = await routePaths($, raw)
  // A window holding other work than the chosen repository or folder is
  // dropped here, by rule, whatever the router picked.
  const want = raw.action === 'spawn' ? await wantOf($, raw, paths) : undefined
  const fitted = want ? spots(l, box, all, { ...fit, want: [want] }) : undefined
  const d = checkRoute(raw, cands, l.limits, owned, paths, fitted ? places(fitted) : room, fitted?.away)
  if ('error' in d) return { deny: 'coord_route: ' + d.error + '; nothing was decided, call it again or route with coord_roster' }
  return { result: routeText(d) }
}

// Every pane's window and size, for where a worker's pane goes.
async function boxes($: any): Promise<PaneBox[]> {
  return parseBoxes((await sh($, ['tmux', 'list-panes', '-a', '-F', BOX_FMT], { timeoutMs: 3000 })).out)
}

// The coordinator's pane, its window and size.
function coordBox(all: PaneBox[]): { pane: string; window: string; width: number; height: number } {
  const me = ctx!.pane() ?? ''
  const b = all.find((x) => x.pane === me)
  return { pane: me, window: b?.window ?? '', width: b?.width ?? 0, height: b?.height ?? 0 }
}

// What a directory works on (lib/coordplace.ts Work): the main checkout of
// its git repository and that repository's GitHub owner/name.
async function workOf($: any, d: string): Promise<Work> {
  const common = await commonDir($, d)
  if (!common) return { dir: d }
  const origin = await sh($, ['git', '-C', d, 'remote', 'get-url', 'origin'], { timeoutMs: 3000 })
  const repo = origin.ok ? repoFromRemote(origin.out) : undefined
  return { dir: d, common: canonicalOf(common) ?? common, ...(repo ? { repo } : {}) }
}

// The sessions in the windows a worker may be split into (the
// coordinator's, and the ones it made for its workers), with their work.
async function fitOf($: any, seen: PaneSeen[], coordWindow: string, want?: Work[]): Promise<Fit> {
  const mine = active(ledger!)
  const wins = new Set([coordWindow, ...mine.filter((w) => w.relation === 'owned' && w.made?.kind === 'window').map((w) => w.made!.window)])
  const here = seen.filter((s) => wins.has(s.window))
  const code = new Map(mine.map((w) => [w.sid, w.code]))
  const dirs = [...new Set(here.flatMap((s) => [s.cwd, code.get(s.sid) ?? '']).filter(Boolean))]
  const [n, works] = await Promise.all([names($), Promise.all(dirs.map(async (d) => [d, await workOf($, d)] as const)).then((xs) => new Map(xs))])
  return { sessions: busyOf(here, ledger!, n, works), home: ctx!.home(), ...(want ? { want } : {}) }
}

// The work of the worker the router chose to spawn: its repo_dir's checkout,
// or its cwd.
async function wantOf($: any, raw: Raw, paths: Paths): Promise<Work | undefined> {
  if (paths.repoTop) return workOf($, paths.repoTop)
  if (typeof raw.cwd === 'string' && raw.cwd.trim() && paths.cwdOk) return workOf($, raw.cwd.trim().replace(/^~(?=\/|$)/, ctx!.home()))
  return undefined
}

// The paths the router named, looked at: a repo_dir's toplevel, a cwd's
// existence.
async function routePaths($: any, raw: Raw): Promise<Paths> {
  const home = ctx!.home()
  const expand = (p: string) => p.trim().replace(/^~(?=\/|$)/, home)
  const out: Paths = {}
  if (typeof raw.repo_dir === 'string' && raw.repo_dir.trim()) {
    const top = await sh($, ['git', '-C', expand(raw.repo_dir), 'rev-parse', '--show-toplevel'], { timeoutMs: 3000 })
    out.repoTop = top.ok && top.out ? top.out : null
  }
  if (typeof raw.cwd === 'string' && raw.cwd.trim()) out.cwdOk = (await sh($, ['test', '-d', expand(raw.cwd)], { timeoutMs: 3000 })).ok
  return out
}

async function spawn($: any, i: any): Promise<{ result: string } | { deny: string }> {
  const req = { slug: String(i.slug ?? ''), model: String(i.model ?? ''), effort: String(i.effort ?? ''), brief: String(i.brief ?? ''), repoDir: i.repo_dir ? String(i.repo_dir) : undefined, cwd: i.cwd ? String(i.cwd) : undefined, addDirs: i.add_dirs }
  const why = spawnRefusal(ledger!, req)
  if (why) return { deny: why }
  const home = ctx!.home()
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, home)
  // A worker reaching outside its cwd stops at a permission dialog nobody is
  // watching; --add-dir lets its tools in. Only folders that exist: claude
  // would refuse to start on one that does not.
  const addDirs = [...new Set(((req.addDirs as string[] | undefined) ?? []).map((d) => expand(d.trim()).replace(/(.)\/+$/, '$1')))]
  for (const d of addDirs) {
    if (!(await sh($, ['test', '-d', d], { timeoutMs: 3000 })).ok) return { deny: 'add_dirs: ' + d + ' is not an existing directory; nothing was started' }
  }
  // A worker asks the person on a decision brief, which the office finds
  // only in ~/briefs (brief.py ROOT): writing one there must not stop it at
  // a dialog.
  if ((await sh($, ['test', '-d', home + '/briefs'], { timeoutMs: 3000 })).ok && !addDirs.includes(home + '/briefs')) addDirs.push(home + '/briefs')
  let cwd = req.cwd ? expand(req.cwd) : ''
  let worktree: string | undefined
  let repoName: string | undefined
  let repoTop = ''
  let ghRepo: string | undefined
  const seen = await panes($)
  if (req.repoDir) {
    const top = await sh($, ['git', '-C', expand(req.repoDir), 'rev-parse', '--show-toplevel'])
    if (!top.ok) return { deny: 'repo_dir is not a git checkout: ' + top.err }
    repoTop = top.out
    repoName = top.out.split('/').pop()!
    const origin = await sh($, ['git', '-C', repoTop, 'remote', 'get-url', 'origin'])
    ghRepo = origin.ok ? repoFromRemote(origin.out) : undefined
    worktree = home + '/worktrees/' + repoName + '/' + req.slug
    cwd = worktree
  }
  // Claude Code stops a new session in an untrusted folder at its safety
  // dialog, and its default answer exits. Trust is per repository (a trusted
  // ~ does not cover one under it), so most repositories here would stop
  // there: the worker runs in its research folder instead and reaches the
  // code as an add-dir (lib/trust.ts placement). Decided before any worktree
  // is made.
  const code = cwd
  const research = home + '/research/' + req.slug
  const common = await commonDir($, repoTop || cwd)
  const place = req.repoDir ? { dir: cwd, top: worktree, canonical: canonicalOf(common) ?? repoTop } : await placeOf($, cwd, common)
  const projects = parseProjects(await readText($, home + '/.claude.json'))
  const codeTrusted = !!trustedBy(projects, place)
  const researchTrusted = codeTrusted || !!trustedBy(projects, await placeOf($, research, await commonDir($, research)))
  const at = placement({ code, research, addDirs, codeTrusted, researchTrusted })
  if (!at)
    return { deny: trustTarget(place) + ' is not trusted, and neither is ' + research + ': Claude Code would stop the worker at its "Is this a project you trust?" dialog. The person must open claude in one of them (or a parent of ' + research + ') once and choose "Yes, I trust this folder"; nothing was started.' }
  // A session in the very directory is refused until the person decides; one
  // elsewhere in the same repository (its checkout or another worktree) is
  // only named, so the coordinator knows who else is in there.
  const n = await names($)
  const who = (ss: PaneSeen[]) => ss.map((s) => (n.get(s.sid) ?? s.sid.slice(0, 8)) + ' (' + s.pane + ', ' + s.cwd + ')').join('; ')
  const busy = seen.filter((s) => s.sid !== ledger!.sid && s.cwd.replace(/\/+$/, '') === code.replace(/\/+$/, ''))
  if (busy.length && !i.overlap_ok)
    return { deny: 'live sessions already work in ' + code + ': ' + who(busy) + '. Ask the person whether to adopt one (/coord adopt <pane>) or start another anyway (overlap_ok).' }
  const near = req.repoDir ? overlaps(seen, ledger!, repoTop, { common, of: await commonDirs($, seen) }).filter((s) => !busy.includes(s)) : []
  if (req.repoDir) {
    const top = repoTop
    await sh($, ['git', '-C', top, 'fetch', '-q', 'origin'], { timeoutMs: 60_000 })
    const head = await sh($, ['git', '-C', top, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
    const base = head.ok && head.out ? head.out : 'origin/main'
    const add = await sh($, ['git', '-C', top, 'worktree', 'add', '-q', '-b', req.slug, worktree!, base], { timeoutMs: 60_000 })
    if (!add.ok) return { deny: 'git worktree add failed: ' + add.err }
  }
  await sh($, ['mkdir', '-p', research])
  const promptFile = research + '/prompt.txt'
  await $.fs.write(promptFile, workerPrompt(req.brief, ledger!.name, req.slug, 'python3 ' + $.plugin.root + '/bin/coord-report ' + ledger!.sid, at, ledger!.sid, 'python3 ' + $.plugin.root + '/bin/brief-grant'))
  const uuid = (await sh($, ['uuidgen'])).out.toLowerCase()
  const me = ctx!.pane() ?? ''
  const sess = await sh($, ['tmux', 'display-message', '-p', '-t', me, '#{session_name}\t#{pane_width}\t#{pane_height}'], { timeoutMs: 3000 })
  if (!uuid || !sess.ok || !me) return { deny: 'could not find this tmux pane or make a session id' }
  const [session = '', w0, h0] = sess.out.split('\t')
  const width = Number(w0) || 0
  const height = Number(h0) || 0
  // Beside the coordinator, where the person sees it, or beside its workers
  // in a window it made, as coord_route chose; checked again against tmux
  // now (lib/coordplace.ts).
  const all = await boxes($)
  const myWindow = all.find((b) => b.pane === me)?.window ?? ''
  // Only beside sessions on the same work: the repository (or folder) the
  // worker's code is in.
  const fit = await fitOf($, seen, myWindow, [await workOf($, repoTop || code)])
  const room = spots(ledger!, { pane: me, window: myWindow, width, height }, all, fit)
  const placed = pick(i.window === undefined ? undefined : String(i.window), room)
  const split = placed.spot?.split
  // The worker's policy is written under its session id before it starts,
  // so its first tool call already runs under it.
  for (const argv of policyArgvs(WORKER_CAPS)) {
    if (!(await ctx!.policy.run(argv, uuid))) return { deny: 'could not write the worker policy (' + argv.join(' ') + '); nothing was started' }
  }
  const r = await sh($, ['tmux', ...workerArgv({ target: placed.spot ? placed.spot.target : session + ':', split, slug: req.slug, cwd: at.cwd, model: req.model, effort: req.effort, sid: uuid, promptFile, addDirs: at.addDirs })], { timeoutMs: 5000 })
  if (!r.ok) return { deny: 'tmux ' + (split ? 'split-window' : 'new-window') + ' failed: ' + r.err }
  const [window = '', pane = ''] = r.out.split(' ')
  const made: Made = { kind: split ? 'pane' : 'window', pane, window }
  if (pane) await sh($, ['tmux', ...titleArgv(pane, req.slug)], { timeoutMs: 3000 })
  const now = Date.now()
  const w: Worker = { slug: req.slug, sid: uuid, relation: 'owned', pane, window, made, cwd: at.cwd, code: at.outside, worktree, repoDir: repoTop || undefined, repo: ghRepo, model: req.model, effort: req.effort as Worker['effort'], brief: promptFile, addDirs: at.addDirs.length ? at.addDirs : undefined, at: now }
  await save($, logged({ ...ledger!, workers: [...ledger!.workers, w] }, 'spawn', req.slug + ' ' + req.model + '/' + req.effort + ' in ' + at.cwd + (at.addDirs.length ? ' +' + at.addDirs.join(' +') : ''), now))
  if (ghRepo) await coordPolicy($)
  const o = at.outside
  const untrusted = o ? ' ' + trustTarget(place) + ' is not trusted by Claude Code, so the worker runs in ' + at.cwd + ' and reaches the code in ' + o + ' as an add-dir: brief it with absolute paths under ' + o + ' and `git -C ' + o + '`; that repository\'s .claude settings (hooks, permissions, MCP) do not apply there (its prompt says so).' : ''
  const sp = placed.spot
  const where = sp
    ? 'in pane ' + pane + ', split ' + (sp.split.dir === '-h' ? 'beside' : 'below') + (sp.kind === 'coordinator' ? ' yours' : ' ' + sp.target + ', next to ' + sp.workers.join(', ')) + ' (' + sp.split.size + (sp.split.dir === '-h' ? ' columns' : ' rows') + ') in window ' + window
    : 'in a new window ' + window + ' (pane ' + pane + ')' + (String(i.window ?? '') === 'new' ? ', as routed' : room.skipped.length ? ': ' + room.skipped.join('; ') : '')
  const note = placed.note ? ' (' + placed.note + ')' : ''
  return { result: 'Started worker ' + req.slug + ' ' + where + note + ', session ' + uuid + ', ' + req.model + '/' + req.effort + ', cwd ' + at.cwd + (at.addDirs.length ? ', add-dirs ' + at.addDirs.join(', ') : '') + '. Brief: ' + promptFile + '. It reports to you with SendMessage.' + untrusted + (near.length ? ' Other live sessions in this repository: ' + who(near) + '.' : '') + gateNote(briefGates(req.brief)) }
}

// The absolute common git dir of a checkout or worktree, undefined outside git.
async function commonDir($: any, d: string): Promise<string | undefined> {
  if (!d) return undefined
  const r = await sh($, ['git', '-C', d, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 3000 })
  return r.ok && r.out ? r.out.replace(/\/+$/, '') : undefined
}

async function commonDirs($: any, seen: PaneSeen[]): Promise<Map<string, string>> {
  const cwds = [...new Set(seen.filter((s) => s.sid !== ledger!.sid && s.cwd).map((s) => s.cwd))]
  const m = new Map<string, string>()
  await Promise.all(cwds.map(async (c) => {
    const d = await commonDir($, c)
    if (d) m.set(c, d)
  }))
  return m
}

async function placeOf($: any, dir: string, common: string | undefined) {
  if (!common) return { dir }
  const top = await sh($, ['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 3000 })
  return { dir, top: top.ok && top.out ? top.out : undefined, canonical: canonicalOf(common) }
}

async function send($: any, i: any): Promise<{ result: string } | { deny: string }> {
  const w = active(ledger!).find((x) => x.slug === String(i.slug ?? ''))
  const text = String(i.text ?? '').trim()
  if (!w) return { deny: 'no owned or adopted worker ' + i.slug + '; observed sessions (another coordinator, its workers, one handed back) are not instructed: the person adopts one with /coord adopt <pane>' }
  if (!text) return { deny: 'empty instruction' }
  const now = Date.now()
  const home = ctx!.home()
  // Too long to send whole: the rest goes to a file the worker can read.
  let body = text
  if (body.length > INLINE_MAX) {
    const d = spillDir(w.addDirs, w.slug, home)
    const path = d + '/coord-' + new Date(now).toISOString().replace(/[:.]/g, '-') + '.md'
    await sh($, ['mkdir', '-p', d])
    await $.fs.write(path, body)
    body = spilled(body, path)
  }
  const msg = '[coordinator] ' + body
  // A peer message (the SendMessage tool's own delivery) reaches a worker in
  // the middle of its turn, at its next tool call. A plugin prompt through
  // the office inbox waits for the turn to end: 25 minutes, once, while the
  // worker went on without it. The inbox is for a worker no peer message
  // reaches (its socket in /tmp/cc-socks gone).
  const peer = await $.session.send({ to: { sessionId: w.sid }, text: msg }).catch((e: unknown) => ({ isDelivered: false, reason: String(e) }))
  let via: string
  if (peer?.isDelivered) via = 'delivered into its session (mid-turn: at its next tool call)'
  else {
    // The office inbox (office.py inbox_put): the worker's cc-mods submits it
    // there as a prompt once it is idle; from and slug let it tell this
    // coordinator when it never went in.
    const inbox = home + '/.claude/state/office/inbox/' + w.sid + '.json'
    await sh($, ['mkdir', '-p', home + '/.claude/state/office/inbox'])
    const old = parseInbox(await readText($, inbox))
    // keep: an instruction reaches a worker in the middle of a long turn, which
    // may outlast the 2-minute stale limit of an unmarked inbox file.
    try {
      await $.fs.write(inbox, JSON.stringify({ text: old ? old.text + '\n\n' + msg : msg, at: old?.at ?? now / 1000, keep: true, from: ctx!.sid(), slug: w.slug, ...(sums.get(w.sid) ? { summary: sums.get(w.sid) } : {}) }))
    } catch (e) {
      return { deny: 'coord_send: not delivered to ' + w.slug + ': no peer message (' + (peer?.reason ?? 'refused') + ') and the office inbox could not be written (' + String(e) + ')' }
    }
    via = 'left in its office inbox (no peer message: ' + clip(String(peer?.reason ?? 'refused'), 120) + '); it goes in when its turn ends, and a [coord] wake tells you if it never does'
  }
  // The first instruction ends a quiet worker's quiet: its reply is news.
  const l = w.instructed ? ledger! : { ...ledger!, workers: ledger!.workers.map((x) => (x.sid === w.sid && !x.endedAt ? { ...x, instructed: now } : x)) }
  await save($, logged(l, 'send', w.slug + ': ' + text.slice(0, 200), now))
  return { result: 'Sent to ' + w.slug + ' (' + (w.pane ?? '') + '): ' + via + '.' + (body !== text ? ' Its ' + text.length + ' characters went to a file; the message carries the head and the path.' : '') + typedNote(w, now) }
}

async function reviewTool($: any, i: any): Promise<{ result: string } | { deny: string }> {
  const action = String(i.action ?? 'list')
  const now = Date.now()
  const f = await readReview($)
  if (action === 'list') return { result: reviewTable(f) }
  let next: ReviewFile | string
  let said: string
  if (action === 'confirm') {
    next = confirmed(f, String(i.id ?? ''), now)
    said = 'Confirmed ' + i.id + '; it left the queue.'
  } else if (action === 'add' || action === 'update') {
    const r = upsert(f, action, i, now)
    next = typeof r === 'string' ? r : r.file
    said = typeof r === 'string' ? '' : (r.fresh ? 'Added ' : 'Updated ') + r.item.id + '.'
  } else return { deny: 'coord_review: action is add, update, confirm or list' }
  if (typeof next === 'string') return { deny: 'coord_review: ' + next }
  await sh($, ['mkdir', '-p', dir() + '/review'])
  const out = pruned(next, now)
  try {
    await $.fs.write(reviewFile(), JSON.stringify(out, null, 1))
  } catch (e) {
    return { deny: 'coord_review: could not write ' + reviewFile() + ': ' + String(e) }
  }
  review = out
  return { result: said + ' ' + countText(out) + ' (say only this in chat; the office shows the items).' }
}

async function close($: any, i: any): Promise<{ result: string } | { deny: string }> {
  const w = active(ledger!).find((x) => x.slug === String(i.slug ?? ''))
  if (!w) return { deny: 'no worker ' + i.slug }
  const now = Date.now()
  if (w.relation === 'adopted') {
    await save($, released(ledger!, w, now))
    return { result: 'Handed ' + w.slug + ' back to the person; it keeps running in its pane and is not adopted again.' }
  }
  if (w.worktree) {
    const dirty = await sh($, ['git', '-C', w.worktree, 'status', '--porcelain'])
    if (dirty.ok && dirty.out) return { deny: w.worktree + ' has uncommitted changes; nothing was closed:\n' + dirty.out.split('\n').slice(0, 10).join('\n') }
  }
  closing.add(w.sid)
  // Only what coord_spawn made, and never this session's own pane or window.
  const me = ctx!.pane()
  const myWindow = me ? (await sh($, ['tmux', 'display-message', '-p', '-t', me, '#{window_id}'], { timeoutMs: 3000 })).out : ''
  const kill = closeArgv(w, { pane: me, window: myWindow || undefined }, active(ledger!).filter((x) => x.relation === 'owned'), await panes($))
  if (kill) await sh($, ['tmux', ...kill], { timeoutMs: 3000 })
  let note = ''
  if (w.worktree) {
    // From the main checkout: git will not remove the worktree it runs in.
    const rm = await sh($, ['git', '-C', w.repoDir ?? w.worktree, 'worktree', 'remove', w.worktree])
    note = rm.ok ? ' and removed ' + w.worktree : '; the worktree stays (' + rm.err + ')'
  }
  await save($, logged({ ...ledger!, workers: ledger!.workers.map((x) => (x.sid === w.sid ? { ...x, endedAt: x.endedAt ?? now } : x)) }, 'close', w.slug, now))
  closing.delete(w.sid)
  return { result: kill ? 'Closed ' + w.slug + "'s " + (kill[0] === 'kill-pane' ? 'pane ' : 'window ') + kill[2] + note + '.' : 'Ended ' + w.slug + ' in the ledger; it had no pane or window of its own to close' + note + '.' }
}

// The coordinator's own policy: COORD_CAPS plus a merge scope for each
// repository its live workers are in. Under god mode, it becomes what god
// puts back.
async function coordPolicy($: any) {
  const l = ledger!
  const repos = mergeRepos(l)
  const god = ctx!.policy.godBefore()
  if (god) await ctx!.policy.setGodBefore(policyOf(COORD_CAPS, repos, god))
  else for (const argv of policyArgvs(COORD_CAPS, repos)) await ctx!.policy.run(argv)
  await ctx!.policy.reload()
}
