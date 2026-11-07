// Coordinator mode, the I/O side (the rules are lib/coord.ts): the /coord
// command, the coord_* tools the coordinator's Claude calls, and the watch
// that tells it when a worker needs it. register.ts calls coordStart from
// session.start and adds coordSection to the system prompt.
//
// Only the person turns the mode on (/coord on, a command Claude cannot run)
// and sets its limits. The tools refuse while it is off, so a session that
// never turned it on can start nothing.

import { HOLD_MS, PANES_FMT, active, coordSection, held, logged, observe, overlaps, parseLedger, parseLimits, parsePanes, spawnRefusal, workerArgv, workerPrompt, type Ledger, type PaneSeen, type Worker } from './lib/coord'

type Ctx = { sid: () => string; home: () => string; pane: () => string | undefined }

const TOOLS = {
  roster: {
    name: 'coord_roster',
    description: 'Coordinator mode: every live Claude session in tmux with its relation to this coordinator (owned, adopted, observed), state, attention, directory and SendMessage name. Call before starting a worker.',
    inputSchema: { type: 'object', properties: {} },
  },
  spawn: {
    name: 'coord_spawn',
    description:
      "Coordinator mode: start a worker claude in its own tmux window. With repo_dir, a worktree is made off origin's default branch at ~/worktrees/<repo>/<slug> on branch <slug>; with cwd, it runs there as is. The brief is saved to ~/research/<slug>/prompt.txt and reporting instructions are appended. Refused above the person's limits, or when a live session already works in that directory unless overlap_ok (set it only after the person said to start another anyway).",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'short task name: lowercase, digits, dashes' },
        model: { type: 'string', description: 'haiku | sonnet | opus' },
        effort: { type: 'string', description: 'low | medium | high | xhigh | max' },
        brief: { type: 'string', description: "the worker's prompt: the person's words verbatim, evidence paths, scope, when to send READY" },
        repo_dir: { type: 'string', description: 'a local git checkout to branch a worktree from' },
        cwd: { type: 'string', description: 'run in this directory instead of a new worktree' },
        overlap_ok: { type: 'boolean' },
      },
      required: ['slug', 'model', 'effort', 'brief'],
    },
  },
  send: {
    name: 'coord_send',
    description: 'Coordinator mode: send an instruction to an owned or adopted worker; it arrives in that session as a prompt starting with [coordinator]. Refused for observed sessions and while the person holds the worker.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, text: { type: 'string' } }, required: ['slug', 'text'] },
  },
  close: {
    name: 'coord_close',
    description: 'Coordinator mode: end a worker. Owned: closes its tmux window and removes its worktree (refused when the worktree has uncommitted changes). Adopted: hands it back to the person (the session keeps running).',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  },
}

let ledger: Ledger | undefined
let toolNames: Record<string, keyof typeof TOOLS> = {}
let watch: { cancel: () => void } | undefined
let ctx: Ctx | undefined

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

export function coordLedger(): Ledger | undefined {
  return ledger
}

export function coordPrompt(now: number): string | undefined {
  return ledger?.on ? coordSection(ledger, now) : undefined
}

export async function coordStart($: any, c: Ctx) {
  ctx = c
  const n = await names($)
  ledger = parseLedger(await readText($, file()), c.sid(), n.get(c.sid()) ?? c.sid().slice(0, 8), Date.now())
  if (ledger.on) await turnOn($, false)
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
  const next = { ...l, on: true, pane: ctx!.pane(), name: n.get(l.sid) ?? l.name }
  await save($, fresh ? logged(next, 'order', 'coordinator mode on', Date.now()) : next)
  await registerTools($)
  watch?.cancel()
  watch = $.clock.every(10_000, () => void tick($))
}

// Worker states, every 10 s while the mode is on. What needs the coordinator
// (a worker asking, gone, or taken over by the person) is sent to it as one
// framed prompt; the rest only updates the ledger the office draws.
let ticking = false
async function tick($: any) {
  if (ticking || !ledger?.on || !active(ledger).length) return
  ticking = true
  try {
    const { ledger: l, changes } = observe(ledger, await panes($), Date.now())
    const woke = changes.filter((c) => c.wake)
    let out = l
    for (const c of changes) out = logged(out, 'event', c.text, Date.now())
    if (changes.length || JSON.stringify(l.workers) !== JSON.stringify(ledger.workers)) await save($, out)
    if (woke.length) await $.prompt.submit({ text: '[coord] ' + woke.map((c) => c.text).join('\n[coord] ') }).catch(() => undefined)
  } finally {
    ticking = false
  }
}

// ---- the person's command ---------------------------------------------------

export async function coordCommand($: any, args: string): Promise<string> {
  if (!ledger || !ctx) return 'coordinator mode is not ready yet (no session)'
  const [verb = 'status', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ')
  const now = Date.now()
  if (verb === 'on') {
    await turnOn($, true)
    return 'Coordinator mode on as `' + ledger.name + '`. Limits: models ' + ledger.limits.models.join(', ') + ', effort up to ' + ledger.limits.maxEffort + ', ' + ledger.limits.maxWorkers + ' workers (/coord limits to change). The coord_* tools are there from the next prompt.'
  }
  if (verb === 'off') {
    watch?.cancel()
    watch = undefined
    await save($, logged({ ...ledger, on: false }, 'order', 'coordinator mode off', now))
    return 'Coordinator mode off. Workers keep running in their windows; the ledger stays for the next /coord on.'
  }
  if (verb === 'limits') {
    if (!arg) return 'Limits: models ' + ledger.limits.models.join(', ') + '; effort up to ' + ledger.limits.maxEffort + '; ' + ledger.limits.maxWorkers + ' workers.'
    const lim = parseLimits(arg, ledger.limits)
    if (typeof lim === 'string') return lim
    await save($, logged({ ...ledger, limits: lim }, 'limits', arg, now))
    return 'Limits now: models ' + lim.models.join(', ') + '; effort up to ' + lim.maxEffort + '; ' + lim.maxWorkers + ' workers.'
  }
  if (verb === 'adopt') {
    // By pane id (%12), session name, or the start of a session id.
    const seen = await panes($)
    const n = await names($)
    const hit = seen.find((s) => s.pane === arg || n.get(s.sid) === arg || (arg.length >= 6 && s.sid.startsWith(arg)))
    if (!hit) return 'No live session matches ' + JSON.stringify(arg) + '; give its pane id, name or session id.'
    if (hit.sid === ledger.sid) return 'That is this session.'
    if (active(ledger).some((w) => w.sid === hit.sid)) return 'Already in the ledger.'
    const slug = (n.get(hit.sid) ?? hit.sid.slice(0, 8)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40)
    const w: Worker = { slug, sid: hit.sid, relation: 'adopted', pane: hit.pane, window: hit.window, cwd: hit.cwd, at: now, state: hit.state, attention: hit.attention }
    await save($, logged({ ...ledger, workers: [...ledger.workers, w] }, 'adopt', slug + ' (' + hit.pane + ')', now))
    return 'Adopted ' + slug + ' (' + hit.pane + '). The coordinator may instruct it now.'
  }
  if (verb === 'release') {
    const w = active(ledger).find((x) => x.slug === arg)
    if (!w) return 'No worker ' + arg
    await save($, logged({ ...ledger, workers: ledger.workers.map((x) => (x === w ? { ...x, endedAt: now } : x)) }, 'release', arg, now))
    return 'Released ' + arg + '; it keeps running, now observed only.'
  }
  const rows = active(ledger).map((w) => '- ' + w.slug + ' · ' + w.relation + ' · ' + (w.model ?? '-') + '/' + (w.effort ?? '-') + ' · ' + (w.state ?? '?') + (held(w, now) ? ' · held by you' : '') + ' · ' + (w.pane ?? ''))
  return 'Coordinator mode ' + (ledger.on ? 'on' : 'off') + ' as `' + ledger.name + '`.\n' + (rows.length ? rows.join('\n') : 'No workers.') + '\n/coord on|off|adopt <pane|name>|release <slug>|limits [models <list>|effort <level>|workers <n>]'
}

// ---- the tools --------------------------------------------------------------

export function isCoordTool(tool: string): boolean {
  return tool in toolNames
}

export async function coordTool($: any, tool: string, input: any): Promise<{ result: string } | { deny: string }> {
  const kind = toolNames[tool]
  if (!ledger || !ctx) return { deny: 'coordinator mode is not ready' }
  if (!ledger.on) return { deny: 'coordinator mode is off; only the person turns it on (/coord on)' }
  if (kind === 'roster') return { result: await roster($) }
  if (kind === 'spawn') return spawn($, input ?? {})
  if (kind === 'send') return send($, input ?? {})
  if (kind === 'close') return close($, input ?? {})
  return { deny: 'unknown coordinator tool' }
}

async function roster($: any): Promise<string> {
  const seen = await panes($)
  const n = await names($)
  const mine = new Map(active(ledger!).map((w) => [w.sid, w]))
  const now = Date.now()
  const rows = seen
    .filter((s, i) => seen.findIndex((x) => x.sid === s.sid) === i)
    .map((s) => {
      const w = mine.get(s.sid)
      const rel = s.sid === ledger!.sid ? 'self' : (w?.relation ?? 'observed')
      return '| ' + (n.get(s.sid) ?? s.sid.slice(0, 8)) + ' | ' + rel + (w ? ' ' + w.slug : '') + ' | ' + s.pane + ' | ' + (s.state || '?') + (s.attention && s.attention !== 'none' ? ' (' + s.attention + ')' : '') + (w && held(w, now) ? ' HELD' : '') + ' | ' + s.cwd + ' |'
    })
  return '| name | relation | pane | state | cwd |\n|---|---|---|---|---|\n' + rows.join('\n')
}

async function spawn($: any, i: any): Promise<{ result: string } | { deny: string }> {
  const req = { slug: String(i.slug ?? ''), model: String(i.model ?? ''), effort: String(i.effort ?? ''), brief: String(i.brief ?? ''), repoDir: i.repo_dir ? String(i.repo_dir) : undefined, cwd: i.cwd ? String(i.cwd) : undefined }
  const why = spawnRefusal(ledger!, req)
  if (why) return { deny: why }
  const home = ctx!.home()
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, home)
  let cwd = req.cwd ? expand(req.cwd) : ''
  let worktree: string | undefined
  let repoName: string | undefined
  let repoTop = ''
  const seen = await panes($)
  if (req.repoDir) {
    const top = await sh($, ['git', '-C', expand(req.repoDir), 'rev-parse', '--show-toplevel'])
    if (!top.ok) return { deny: 'repo_dir is not a git checkout: ' + top.err }
    repoTop = top.out
    repoName = top.out.split('/').pop()!
    worktree = home + '/worktrees/' + repoName + '/' + req.slug
    cwd = worktree
  }
  // A session in the very directory is refused until the person decides; one
  // elsewhere in the same repository (its checkout or another worktree) is
  // only named, so the coordinator knows who else is in there.
  const n = await names($)
  const who = (ss: PaneSeen[]) => ss.map((s) => (n.get(s.sid) ?? s.sid.slice(0, 8)) + ' (' + s.pane + ', ' + s.cwd + ')').join('; ')
  const busy = seen.filter((s) => s.sid !== ledger!.sid && s.cwd.replace(/\/+$/, '') === cwd.replace(/\/+$/, ''))
  if (busy.length && !i.overlap_ok)
    return { deny: 'live sessions already work in ' + cwd + ': ' + who(busy) + '. Ask the person whether to adopt one (/coord adopt <pane>) or start another anyway (overlap_ok).' }
  const near = req.repoDir ? [...overlaps(seen, ledger!, repoTop), ...overlaps(seen, ledger!, home + '/worktrees/' + repoName)].filter((s, k, a) => a.findIndex((x) => x.sid === s.sid) === k && !busy.includes(s)) : []
  if (req.repoDir) {
    const top = repoTop
    await sh($, ['git', '-C', top, 'fetch', '-q', 'origin'], { timeoutMs: 60_000 })
    const head = await sh($, ['git', '-C', top, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
    const base = head.ok && head.out ? head.out : 'origin/main'
    const add = await sh($, ['git', '-C', top, 'worktree', 'add', '-q', '-b', req.slug, worktree!, base], { timeoutMs: 60_000 })
    if (!add.ok) return { deny: 'git worktree add failed: ' + add.err }
  }
  const research = home + '/research/' + req.slug
  await sh($, ['mkdir', '-p', research])
  const promptFile = research + '/prompt.txt'
  await $.fs.write(promptFile, workerPrompt(req.brief, ledger!.name, req.slug))
  const uuid = (await sh($, ['uuidgen'])).out.toLowerCase()
  const sess = await sh($, ['tmux', 'display-message', '-p', '-t', ctx!.pane() ?? '', '#{session_name}'], { timeoutMs: 3000 })
  if (!uuid || !sess.ok) return { deny: 'could not find this tmux session or make a session id' }
  const r = await sh($, ['tmux', ...workerArgv({ target: sess.out + ':', slug: req.slug, cwd, model: req.model, effort: req.effort, sid: uuid, promptFile })], { timeoutMs: 5000 })
  if (!r.ok) return { deny: 'tmux new-window failed: ' + r.err }
  const [window, pane] = r.out.split(' ')
  const now = Date.now()
  const w: Worker = { slug: req.slug, sid: uuid, relation: 'owned', pane, window, cwd, worktree, repoDir: repoTop || undefined, repo: repoName, model: req.model, effort: req.effort as Worker['effort'], brief: promptFile, at: now }
  await save($, logged({ ...ledger!, workers: [...ledger!.workers, w] }, 'spawn', req.slug + ' ' + req.model + '/' + req.effort + ' in ' + cwd, now))
  return { result: 'Started worker ' + req.slug + ' in window ' + window + ' (pane ' + pane + '), session ' + uuid + ', ' + req.model + '/' + req.effort + ', cwd ' + cwd + '. Brief: ' + promptFile + '. It reports to you with SendMessage.' + (near.length ? ' Other live sessions in this repository: ' + who(near) + '.' : '') }
}

async function send($: any, i: any): Promise<{ result: string } | { deny: string }> {
  const w = active(ledger!).find((x) => x.slug === String(i.slug ?? ''))
  const text = String(i.text ?? '').trim()
  if (!w) return { deny: 'no owned or adopted worker ' + i.slug + '; observed sessions are not instructed' }
  if (!text) return { deny: 'empty instruction' }
  const now = Date.now()
  if (held(w, now)) return { deny: 'the person is working in ' + w.slug + ' (held until ' + new Date(w.heldAt! + HOLD_MS).toTimeString().slice(0, 5) + '); tell the person instead' }
  // The office inbox (office.py inbox_put): the worker's cc-mods takes it
  // within 2 s and submits it there as a prompt.
  const inbox = ctx!.home() + '/.claude/state/office/inbox/' + w.sid + '.json'
  await sh($, ['mkdir', '-p', ctx!.home() + '/.claude/state/office/inbox'])
  let old = ''
  try {
    old = String(JSON.parse((await readText($, inbox)) ?? '{}').text ?? '')
  } catch {}
  const msg = '[coordinator] ' + text
  await $.fs.write(inbox, JSON.stringify({ text: old ? old + '\n\n' + msg : msg, at: now / 1000 }))
  await save($, logged(ledger!, 'send', w.slug + ': ' + text.slice(0, 200), now))
  return { result: 'Sent to ' + w.slug + ' (' + (w.pane ?? '') + ').' }
}

async function close($: any, i: any): Promise<{ result: string } | { deny: string }> {
  const w = active(ledger!).find((x) => x.slug === String(i.slug ?? ''))
  if (!w) return { deny: 'no worker ' + i.slug }
  const now = Date.now()
  if (w.relation === 'adopted') {
    await save($, logged({ ...ledger!, workers: ledger!.workers.map((x) => (x === w ? { ...x, endedAt: now } : x)) }, 'release', w.slug, now))
    return { result: 'Handed ' + w.slug + ' back to the person; it keeps running.' }
  }
  if (w.worktree) {
    const dirty = await sh($, ['git', '-C', w.worktree, 'status', '--porcelain'])
    if (dirty.ok && dirty.out) return { deny: w.worktree + ' has uncommitted changes; nothing was closed:\n' + dirty.out.split('\n').slice(0, 10).join('\n') }
  }
  if (w.window) await sh($, ['tmux', 'kill-window', '-t', w.window], { timeoutMs: 3000 })
  let note = ''
  if (w.worktree) {
    // From the main checkout: git will not remove the worktree it runs in.
    const rm = await sh($, ['git', '-C', w.repoDir ?? w.worktree, 'worktree', 'remove', w.worktree])
    note = rm.ok ? ' and removed ' + w.worktree : '; the worktree stays (' + rm.err + ')'
  }
  await save($, logged({ ...ledger!, workers: ledger!.workers.map((x) => (x === w ? { ...x, endedAt: now } : x)) }, 'close', w.slug, now))
  return { result: 'Closed ' + w.slug + "'s window" + note + '.' }
}
