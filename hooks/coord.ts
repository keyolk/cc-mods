// Coordinator mode, the I/O side (the rules are lib/coord.ts): the /coord
// command, the coord_* tools the coordinator's Claude calls, and the watch
// that tells it when a worker needs it. register.ts calls coordStart from
// session.start and adds coordSection to the system prompt.
//
// Only the person turns the mode on (/coord on, a command Claude cannot run)
// and sets its limits. The tools refuse while it is off, so a session that
// never turned it on can start nothing.

import { COORD_CAPS, PANES_FMT, WAKE_PREFIX, WORKER_CAPS, active, adoptSlug, autoAdopt, closeArgv, foreign, limitsText, released, unadopt, coordSection, current, logged, mergeRepos, observe, overlaps, parseLedger, parseLimits, parsePanes, policyArgvs, policyOf, recheck, spawnRefusal, titleArgv, typedLately, typedNote, unseen, workerArgv, workerPrompt, type Change, type Ledger, type Made, type PaneSeen, type Worker } from './lib/coord'
import { canonicalOf, parseProjects, placement, trustTarget, trustedBy } from './lib/trust'
import { restoreArgvs } from './lib/rca'
import { repoFromRemote } from './lib/prs'
import { ROUTER_MODEL, candidates, checkRoute, parsePrompts, parseRoute, routeRequest, routeText, type Paths, type Raw } from './lib/coordroute'
import { BOX_FMT, parseBoxes, pick, places, spots, type PaneBox } from './lib/coordplace'
import type { Policy } from './lib/policy'

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
      "Coordinator mode: start a worker claude in a pane split off yours in your tmux window (the person sees it there), in a window that already holds your workers, or in a new window: pass coord_route's window as `window`; without it, or when that place no longer has room, your window when it has room (at most 2 workers, 60 columns and 15 rows left on each side), else a new window. With repo_dir, a worktree is made off origin's default branch at ~/worktrees/<repo>/<slug> on branch <slug>; with cwd, it runs there as is. The brief is saved to ~/research/<slug>/prompt.txt (always reachable) and reporting instructions are appended. In a repository (or cwd) Claude Code does not trust, the worker runs in ~/research/<slug> with the code as an add-dir, and its prompt says to use absolute paths and git -C. Refused above the person's limits, or when a live session already works in that directory unless overlap_ok (set it only after the person said to start another anyway).",
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
    description: 'Coordinator mode: send an instruction to an owned or adopted worker (every live session is adopted by default); it arrives in that session as a prompt starting with [coordinator]. Refused for observed sessions. The person typing in that pane is no bar (the instruction is queued behind their turn and leaves their draft alone); the result notes it when they typed there in the last 10 minutes.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, text: { type: 'string' } }, required: ['slug', 'text'] },
  },
  close: {
    name: 'coord_close',
    description: 'Coordinator mode: end a worker. Owned: kills the pane coord_spawn made for it (or its fallback window) and removes its worktree (refused when the worktree has uncommitted changes). Adopted: hands it back to the person (the session and its pane keep running) and it is not adopted again.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
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
  const m = /^mcp__cc-mods__coord_(roster|route|spawn|send|close)$/.exec(tool)
  return m ? (m[1] as keyof typeof TOOLS) : undefined
}

const dir = () => ctx!.home() + '/.claude/state/office/coord'
const file = () => dir() + '/' + ctx!.sid() + '.json'

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
  const r = await sh($, ['tmux', 'list-panes', '-a', '-F', PANES_FMT], { timeoutMs: 3000 })
  return r.ok ? parsePanes(r.out) : []
}

// Of these session ids, the ones still alive: a claude process the session
// registry names (checked to be claude, so a reused pid is not it), or a
// transcript written in the last 3 minutes.
const ALIVE_SH =
  'h=$0; for s in "$@"; do p=$(jq -r --arg s "$s" \'select(.sessionId == $s) | .pid\' "$h"/.claude/sessions/*.json 2>/dev/null | head -1); ' +
  'if [ -n "$p" ] && ps -o comm= -p "$p" 2>/dev/null | grep -q claude; then echo "$s"; continue; fi; ' +
  'f=$(ls "$h"/.claude/projects/*/"$s".jsonl 2>/dev/null | head -1); [ -n "$f" ] && [ -n "$(find "$f" -mmin -3 2>/dev/null)" ] && echo "$s"; done'

async function alive($: any, sids: string[]): Promise<Set<string>> {
  if (!sids.length) return new Set()
  const r = await sh($, ['sh', '-c', ALIVE_SH, ctx!.home(), ...sids], { timeoutMs: 5000 })
  return new Set(r.out.split('\n').filter((x) => sids.includes(x)))
}

export function coordLedger(): Ledger | undefined {
  return ledger
}

export function coordPrompt(now: number): string | undefined {
  return ledger?.on ? coordSection(ledger, now) : undefined
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
  if (ticking || !ledger?.on || (!active(ledger).length && !ledger.limits.autoAdopt)) return
  ticking = true
  try {
    // Panes first: a coord tool (close, spawn) may save the ledger while
    // tmux answers, and observing the ledger from before that would undo it.
    const seen = await panes($)
    // A session that appeared since the last tick becomes an adopted worker.
    await adoptLive($, seen, false)
    // A worker no pane names is gone only when its session is: another
    // session can take its pane's name (a `claude -p` it ran, from a cc-mods
    // before register.ts kept those off the pane).
    const live = await alive($, unseen(ledger, seen, Date.now()).map((w) => w.sid))
    const { ledger: l, changes } = observe(ledger, seen, Date.now(), live)
    let out = l
    // A quiet worker's asks are the person's own work: kept in its
    // row, not in the log the office shows.
    for (const c of changes) if (c.wake || c.kind === 'gone') out = logged(out, 'event', c.text, Date.now())
    if (changes.length || JSON.stringify(l.workers) !== JSON.stringify(ledger.workers)) await save($, out)
    // A worker coord_close is closing: its pane went first, its endedAt
    // comes when the close saves. Not news to the coordinator that closed it.
    pending.push(...changes.filter((c) => c.wake && !closing.has(c.sid)))
    await flush($)
  } finally {
    ticking = false
  }
}

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
  return { deny: 'unknown coordinator tool' }
}

async function roster($: any): Promise<string> {
  const seen = await panes($)
  await adoptLive($, seen, true)
  const n = await names($)
  const mine = new Map(active(ledger!).map((w) => [w.sid, w]))
  const now = Date.now()
  const rows = seen
    .filter((s, i) => seen.findIndex((x) => x.sid === s.sid) === i)
    .map((s) => {
      const w = mine.get(s.sid)
      const rel = s.sid === ledger!.sid ? 'self' : (w?.relation ?? 'observed') + (w?.auto ? ' (auto)' : '')
      return '| ' + (n.get(s.sid) ?? s.sid.slice(0, 8)) + ' | ' + rel + (w ? ' ' + w.slug : '') + ' | ' + s.pane + ' | ' + (s.state || '?') + (s.attention && s.attention !== 'none' ? ' (' + s.attention + ')' : '') + (w && typedLately(w, now) ? ' person typed ' + new Date(w.typedAt!).toTimeString().slice(0, 5) : '') + ' | ' + s.cwd + ' |'
    })
  return '| name | relation | pane | state | cwd |\n|---|---|---|---|---|\n' + rows.join('\n')
}

// The newest prompts of each session, off the tail of its transcript (the
// office reads the same files): one shell for all of them, a JSON row per
// prompt, parsed in lib/coordroute.ts.
const PROMPTS_SH =
  'h=$0; for s in "$@"; do f=$(ls "$h"/.claude/projects/*/"$s".jsonl 2>/dev/null | head -1); [ -n "$f" ] || continue; ' +
  'tail -c 300000 "$f" | tail -n +2 | jq -Rc --arg s "$s" \'fromjson? | select(.type == "user" and (.isMeta | not)) | .message.content | (if type == "string" then . else ([.[]? | select(.type == "text") | .text] | join(" ")) end) | select(length > 0) | [$s, .]\' 2>/dev/null | tail -n 12; done'

async function route($: any, i: any): Promise<{ result: string } | { deny: string }> {
  const task = String(i.task ?? '').trim()
  if (!task) return { deny: 'coord_route: the task is empty' }
  const seen = await panes($)
  await adoptLive($, seen, true)
  const l = ledger!
  const others = seen.filter((s) => s.sid !== l.sid)
  const [n, titles, prompts, repos] = await Promise.all([
    names($),
    sh($, ['tmux', 'list-panes', '-a', '-F', '#{@cc_pane_session}\t#{@title}'], { timeoutMs: 3000 }).then((r) => new Map(r.out.split('\n').map((x) => x.split('\t') as [string, string]).filter(([s, t]) => s && t))),
    sh($, ['sh', '-c', PROMPTS_SH, ctx!.home(), ...new Set(others.map((s) => s.sid))], { timeoutMs: 10_000 }).then((r) => parsePrompts(r.out)),
    commonDirs($, seen).then((m) => new Map([...m].map(([cwd, common]) => [cwd, canonicalOf(common) ?? common]))),
  ])
  const cands = candidates(seen, l, n, { titles, prompts, repos }, Date.now())
  const owned = active(l).filter((w) => w.relation === 'owned').length
  const room = places(spots(l, await coordBox($), await boxes($)))
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
  const d = checkRoute(raw, cands, l.limits, owned, await routePaths($, raw), room)
  if ('error' in d) return { deny: 'coord_route: ' + d.error + '; nothing was decided, call it again or route with coord_roster' }
  return { result: routeText(d) }
}

// Every pane's window and size, for where a worker's pane goes.
async function boxes($: any): Promise<PaneBox[]> {
  return parseBoxes((await sh($, ['tmux', 'list-panes', '-a', '-F', BOX_FMT], { timeoutMs: 3000 })).out)
}

// The coordinator's pane, its window and size.
async function coordBox($: any): Promise<{ pane: string; window: string; width: number; height: number }> {
  const me = ctx!.pane() ?? ''
  const b = (await boxes($)).find((x) => x.pane === me)
  return { pane: me, window: b?.window ?? '', width: b?.width ?? 0, height: b?.height ?? 0 }
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
  await $.fs.write(promptFile, workerPrompt(req.brief, ledger!.name, req.slug, 'python3 ' + $.plugin.root + '/bin/coord-report ' + ledger!.sid, at, ledger!.sid))
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
  const room = spots(ledger!, { pane: me, window: all.find((b) => b.pane === me)?.window ?? '', width, height }, all)
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
  return { result: 'Started worker ' + req.slug + ' ' + where + note + ', session ' + uuid + ', ' + req.model + '/' + req.effort + ', cwd ' + at.cwd + (at.addDirs.length ? ', add-dirs ' + at.addDirs.join(', ') : '') + '. Brief: ' + promptFile + '. It reports to you with SendMessage.' + untrusted + (near.length ? ' Other live sessions in this repository: ' + who(near) + '.' : '') }
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
  // The office inbox (office.py inbox_put): the worker's cc-mods takes it
  // within 2 s and submits it there as a prompt.
  const inbox = ctx!.home() + '/.claude/state/office/inbox/' + w.sid + '.json'
  await sh($, ['mkdir', '-p', ctx!.home() + '/.claude/state/office/inbox'])
  let old = ''
  try {
    old = String(JSON.parse((await readText($, inbox)) ?? '{}').text ?? '')
  } catch {}
  const msg = '[coordinator] ' + text
  // keep: an instruction reaches a worker in the middle of a long turn, which
  // may outlast the 2-minute stale limit of an unmarked inbox file.
  await $.fs.write(inbox, JSON.stringify({ text: old ? old + '\n\n' + msg : msg, at: now / 1000, keep: true }))
  // The first instruction ends a quiet worker's quiet: its reply is news.
  const l = w.instructed ? ledger! : { ...ledger!, workers: ledger!.workers.map((x) => (x.sid === w.sid && !x.endedAt ? { ...x, instructed: now } : x)) }
  await save($, logged(l, 'send', w.slug + ': ' + text.slice(0, 200), now))
  return { result: 'Sent to ' + w.slug + ' (' + (w.pane ?? '') + ').' + typedNote(w, now) }
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
  const kill = closeArgv(w, { pane: me, window: myWindow || undefined }, active(ledger!).filter((x) => x.relation === 'owned'))
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
