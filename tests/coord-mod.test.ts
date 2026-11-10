// Coordinator mode through the engine: what a module reload (a merge on main,
// mid-turn) does to the coord tools and to the wakes. Run with `claude plugin
// test`; `bun test` skips it.
import { expect, mock, test } from 'claude-code/testing'

const LEDGER = '/home/u/.claude/state/office/coord/sid-1.json'
const OLD = Date.now() - 600_000
const ledgerJson = () => JSON.stringify({ on: true, sid: 'sid-1', name: 'cc-mods-d9', limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 4 }, workers: [{ slug: 'brief-decision-4', sid: 'w4', relation: 'owned', pane: '%365', window: '@134', cwd: '/r/bd', at: OLD, state: 'working', attention: 'none' }], log: [], at: OLD })
// The worker's pane as tmux lists it (PANES_FMT): deciding a Read.
const PANE = '%365\t@134\tw4\twaiting\taction\t/r/bd\t\tRead ~/r/prompt.txt'

// A peer message (session.send) reaches no session unless a test says so:
// coord_send then falls back to the office inbox.
const NO_PEER = { isDelivered: false, reason: 'no live session on this machine has id w' }

function stubs(on: any, o: { files: Record<string, string>; submitted: string[]; panes: () => string; run?: (argv: string[]) => string | undefined; runs?: string[][]; peer?: (e: any) => unknown }) {
  on('session.start', () => ({ cwd: '/work' }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : e.name === 'TMUX_PANE' ? '%1' : undefined }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', (_$: any, e: any) => ({ value: { tool: 'mcp__cc-mods__' + e.name } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in o.files }))
  on('fs.read', (_$: any, e: any) => ({ value: o.files[e.path] ?? '' }))
  on('fs.stat', () => ({ value: { mtimeMs: 1 } }))
  on('fs.write', (_$: any, e: any) => {
    o.files[e.path] = String(e.data ?? e.text ?? e.content ?? '')
    return { value: undefined }
  })
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$: any, e: any) => {
    o.runs?.push(e.argv)
    if (e.argv[0] === 'tmux' && e.argv[1] === 'list-panes') return ok(o.panes())
    const out = o.run?.(e.argv)
    return out === undefined ? ok('') : out === '!' ? { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } } : ok(out)
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', (_$: any, e: any) => {
    o.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.send', (_$: any, e: any) => o.peer?.(e) ?? NO_PEER)
}

test('coord: a coord tool called while a reload is still starting the module is answered', async ($, on) => {
  // Live, three times: main changed, the plugin reloaded as coord_close was
  // about to run, and the call met a module whose session.start had not
  // read the ledger: "no tool.call hook answered this call".
  const files: Record<string, string> = { [LEDGER]: ledgerJson() }
  stubs(on, { files, submitted: [], panes: () => PANE })
  mock.clock(on)
  const starting = $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_close', slug: 'brief-decision-4' } as any)
  await starting
  expect(r.result).toContain('Closed brief-decision-4')
  expect(JSON.parse(files[LEDGER]!).workers[0].endedAt).toBeGreaterThan(0)
})

test('coord: the running turn is kept where a reload keeps it, and a worker closed during the turn is never woken for', async ($, on) => {
  // Live: PR #65's merge reloaded the coordinator's cc-mods mid-turn. The
  // new module thought no turn ran, submitted brief-decision-4's ask at
  // once, and the engine queued it to the turn's end, after coord_close.
  // A reload keeps $.state: the turn is there, and session.start reads it.
  const files: Record<string, string> = { [LEDGER]: ledgerJson() }
  const submitted: string[] = []
  let panes = PANE
  stubs(on, { files, submitted, panes: () => panes })
  const clock = mock.clock(on)
  const turn: unknown[] = []
  const reads: string[] = []
  on('state.get', (_$: any, e: any, next: any) => (e.plugin === 'cc-mods' && e.key === 'turn' && reads.push('get'), next(e)))
  on('state.set', (_$: any, e: any, next: any) => (e.plugin === 'cc-mods' && e.key === 'turn' && turn.push(e.value), next(e)))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  expect(reads.length).toBeGreaterThan(0)
  await $.turn.start({ turnId: 't1', text: 'merge it and close the worker' })
  expect(turn).toEqual([expect.objectContaining({ turnId: 't1' })])
  await clock.advance(10_000)
  await clock.advance(10_000)
  expect(submitted.filter((t) => t.startsWith('[coord]'))).toEqual([])
  panes = ''
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_close', slug: 'brief-decision-4' } as any)
  // A worker from before coord_spawn recorded what it made had its own window.
  expect(r.result).toBe("Closed brief-decision-4's window @134.")
  await $.turn.complete({ turnId: 't1', answer: 'closed it', durationMs: 5, isAborted: false, usage: null } as any)
  expect(turn.at(-1)).toBeNull()
  await clock.advance(1_000)
  expect(submitted.filter((t) => t.startsWith('[coord]'))).toEqual([])
})

test('coord: a [coord] prompt taken from the queue after its worker closed is dropped', async ($, on) => {
  const files: Record<string, string> = { [LEDGER]: ledgerJson() }
  const submitted: string[] = []
  stubs(on, { files, submitted, panes: () => '' })
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.tool.call({ tool: 'mcp__cc-mods__coord_close', slug: 'brief-decision-4' } as any)
  const text = '[coord] brief-decision-4 (pane %365, window @134): asks: Read ~/r/prompt.txt (a permission ask still unsettled; a dialog there only the person can answer)'
  const out: any = await $.prompt.submit({ text, origin: { kind: 'plugin', name: 'cc-mods' }, wait: false } as any)
  expect(out.drop).toContain('ended')
  expect(submitted).toEqual([])
  // Any other plugin prompt goes through.
  await $.prompt.submit({ text: '[brief answer] x.html: A', origin: { kind: 'plugin', name: 'cc-mods' }, wait: false } as any)
  expect(submitted).toEqual(['[brief answer] x.html: A'])
})

// Spawning into /src/autoreview, a repository Claude Code has not trusted
// (like 202 of 251 here: a trusted ~ does not cover a repository under it).
const TRUST = '/home/u/.claude.json'
const spawnLedger = () => JSON.stringify({ on: true, sid: 'sid-1', name: 'cc-mods-d9', limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 4 }, workers: [], log: [], at: OLD })
function spawnRun(argv: string[]): string | undefined {
  const inRepo = (d: string) => d.startsWith('/src/autoreview') || d.startsWith('/home/u/worktrees/autoreview')
  if (argv[0] === 'git' && argv.includes('--show-toplevel')) return inRepo(argv[2]!) ? '/src/autoreview' : '!'
  if (argv[0] === 'git' && argv.includes('--git-common-dir')) return inRepo(argv[2]!) ? '/src/autoreview/.git' : '!'
  if (argv[0] === 'git' && argv.includes('symbolic-ref')) return 'origin/main'
  if (argv[0] === 'git' && argv.includes('get-url')) return 'git@github.com:keyolk/autoreview.git'
  if (argv[0] === 'uuidgen') return 'U-1'
  // The coordinator's pane, 100x30: too small to split either way, so these
  // spawns fall back to a window.
  if (argv[0] === 'tmux' && argv[1] === 'display-message') return 'main\t100\t30'
  if (argv[0] === 'tmux' && argv[1] === 'new-window') return '@9 %90'
  return undefined
}

test('coord: a repository Claude Code does not trust is not refused: the worker runs in its research folder and reaches the worktree as an add-dir', async ($, on) => {
  // Live: coord_spawn refused briefs; a worker in ~/research/<slug> with the
  // worktree as --add-dir then finished briefs PR #1 with no dialog.
  const files: Record<string, string> = { [LEDGER]: spawnLedger(), [TRUST]: JSON.stringify({ projects: { '/home/u': { hasTrustDialogAccepted: true } } }) }
  const runs: string[][] = []
  stubs(on, { files, submitted: [], panes: () => '', run: spawnRun, runs })
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const trustBefore = files[TRUST]
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_spawn', slug: 'ar-x', model: 'sonnet', effort: 'low', brief: 'fix it', repo_dir: '/src/autoreview' } as any)
  const wt = '/home/u/worktrees/autoreview/ar-x'
  // ~/briefs exists here: it is added so the worker can write a decision brief
  // where the office finds it.
  expect(r.result).toContain('cwd /home/u/research/ar-x, add-dirs ' + wt + ', /home/u/briefs.')
  // The coordinator's pane is 100x30: a window instead, and the result says why.
  expect(r.result).toContain('in a new window @9 (pane %90): your pane (100x30) is too small to split')
  expect(runs.some((a) => a[0] === 'tmux' && a[1] === 'split-window')).toBe(false)
  expect(JSON.parse(files[LEDGER]!).workers[0].made).toEqual({ kind: 'window', pane: '%90', window: '@9' })
  expect(r.result).toContain('/src/autoreview is not trusted by Claude Code')
  expect(r.result).toContain('`git -C ' + wt + '`')
  expect(r.result).toContain(".claude settings (hooks, permissions, MCP) do not apply")
  // The worktree is still made, off origin.
  expect(runs.some((a) => a[0] === 'git' && a.includes('worktree') && a.includes(wt))).toBe(true)
  const nw = runs.find((a) => a[0] === 'tmux' && a[1] === 'new-window')!
  expect(nw[nw.indexOf('-c') + 1]).toBe('/home/u/research/ar-x')
  expect(nw.slice(-3)).toEqual(['/home/u/research/ar-x/prompt.txt', '--add-dir=' + wt, '--add-dir=/home/u/briefs'])
  const prompt = files['/home/u/research/ar-x/prompt.txt']!
  expect(prompt).toContain('Your tools reach `/home/u/research/ar-x`, `' + wt + '`, `/home/u/briefs` without a permission dialog')
  // The person's answer to the worker's decision brief comes back to this coordinator.
  expect(prompt).toContain('--coordinator sid-1 --worker ar-x')
  expect(prompt).toContain('QUESTION need <path>')
  expect(prompt).toContain('absolute paths under `' + wt + '`')
  expect(prompt).toContain('git -C ' + wt)
  expect(prompt).toContain(".claude settings (hooks, permissions, MCP servers) do not apply")
  const w = JSON.parse(files[LEDGER]!).workers[0]
  expect([w.cwd, w.code, w.worktree, w.addDirs]).toEqual(['/home/u/research/ar-x', wt, wt, [wt, '/home/u/briefs']])
  // Trust is the person's: never written.
  expect(files[TRUST]).toBe(trustBefore)
})

test('coord: a cwd Claude Code does not trust is reached the same way; with the research folder untrusted too, nothing starts', async ($, on) => {
  const files: Record<string, string> = { [LEDGER]: spawnLedger(), [TRUST]: JSON.stringify({ projects: { '/home/u': { hasTrustDialogAccepted: true } } }) }
  const runs: string[][] = []
  stubs(on, { files, submitted: [], panes: () => '', run: spawnRun, runs })
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_spawn', slug: 'ar-y', model: 'sonnet', effort: 'low', brief: 'look', cwd: '/src/autoreview' } as any)
  expect(r.result).toContain('cwd /home/u/research/ar-y, add-dirs /src/autoreview, /home/u/briefs.')
  expect(files['/home/u/research/ar-y/prompt.txt']).toContain('git -C /src/autoreview')
  expect(runs.some((a) => a[0] === 'git' && a.includes('worktree'))).toBe(false)
  // No trusted folder to start in at all: refused before anything is made.
  files[TRUST] = JSON.stringify({ projects: {} })
  runs.length = 0
  const no: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_spawn', slug: 'ar-z', model: 'sonnet', effort: 'low', brief: 'fix', repo_dir: '/src/autoreview' } as any)
  expect(JSON.stringify(no)).toContain('/src/autoreview is not trusted, and neither is /home/u/research/ar-z')
  expect(runs.some((a) => a[0] === 'git' && a.includes('worktree'))).toBe(false)
  expect(runs.some((a) => a[0] === 'tmux' && a[1] === 'new-window')).toBe(false)
  expect(files['/home/u/research/ar-z/prompt.txt']).toBeUndefined()
})

test('coord: a worker goes where coord_route placed it, a window that holds this coordinator\'s workers; a place with no room falls back and says so', async ($, on) => {
  // Worker a has the fallback window @7 this coordinator made; the
  // coordinator's own pane (100x30) is too small to split.
  const a = { slug: 'a', sid: 'w-a', relation: 'owned', pane: '%70', window: '@7', made: { kind: 'window', pane: '%70', window: '@7' }, cwd: '/r/a', at: OLD, state: 'working', attention: 'none' }
  const files: Record<string, string> = { [LEDGER]: JSON.stringify({ ...JSON.parse(spawnLedger()), workers: [a] }), [TRUST]: JSON.stringify({ projects: { '/home/u': { hasTrustDialogAccepted: true } } }) }
  const runs: string[][] = []
  const boxes = ['@1\t%1\t100\t30', '@7\t%70\t240\t60'].join('\n')
  stubs(on, { files, submitted: [], panes: () => boxes, runs, run: (argv) => (argv[0] === 'tmux' && argv[1] === 'split-window' ? '@7 %72' : spawnRun(argv)) })
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_spawn', slug: 'ar-w', model: 'sonnet', effort: 'low', brief: 'look', cwd: '/src/autoreview', window: '@7' } as any)
  expect(r.result).toContain('Started worker ar-w in pane %72, split beside %70, next to a (80 columns) in window @7,')
  const sp = runs.find((x) => x[0] === 'tmux' && x[1] === 'split-window')!
  expect(sp.slice(0, 11)).toEqual(['tmux', 'split-window', '-d', '-h', '-l', '80', '-P', '-F', '#{window_id} #{pane_id}', '-t', '%70'])
  expect(JSON.parse(files[LEDGER]!).workers[1].made).toEqual({ kind: 'pane', pane: '%72', window: '@7' })
  // A window that is not a place (the person's @9): the default, here a new
  // window since the coordinator's pane has no room.
  runs.length = 0
  const r2: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_spawn', slug: 'ar-v', model: 'sonnet', effort: 'low', brief: 'look', cwd: '/src/autoreview', window: '@9' } as any)
  expect(r2.result).toContain('in a new window @9 (pane %90): your pane (100x30) is too small to split')
  expect(r2.result).toContain('(window @9 is not a place for a worker now (none, or new); used a new window instead)')
  expect(runs.some((x) => x[0] === 'tmux' && x[1] === 'split-window')).toBe(false)
})

test('coord_route: one cheap model call over the live sessions; its answer is checked and handed back, never acted on; a failed or bad answer is an error', async ($, on) => {
  // Auto-adopt off (/coord limits adopt off), so the session in autoreview stays observed.
  const files: Record<string, string> = { [LEDGER]: JSON.stringify({ ...JSON.parse(ledgerJson()), limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 4, autoAdopt: false } }) }
  const runs: string[][] = []
  // The coordinator, its worker brief-decision-4 at work, and an observed session in autoreview.
  const panes = ['%1\t@1\tsid-1\tdone\tnone\t/work\t\t', '%365\t@134\tw4\tworking\tnone\t/r/bd\t\t', '%7\t@7\tobs\tdone\tnone\t/src/autoreview\t\t'].join('\n')
  stubs(on, {
    files,
    submitted: [],
    panes: () => panes,
    runs,
    run: (argv) => {
      if (argv[0] === 'sh' && String(argv[2]).includes('jq')) return JSON.stringify(['obs', 'fix the review bot']) + '\n' + JSON.stringify(['obs', '<task-notification>x'])
      return spawnRun(argv)
    },
  })
  mock.clock(on)
  const asked: any[] = []
  let reply: any = { isAnswered: true, text: '```json\n{"action":"adopt","target":"obs","reason":"already on the review bot"}\n```', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  on('model.complete', (_$: any, e: any) => {
    asked.push(e)
    return { value: reply }
  })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_route', task: 'the review bot double-posts' } as any)
  expect(asked.length).toBe(1)
  expect(asked[0].model).toBe('haiku')
  const sent = JSON.parse(String(asked[0].prompt))
  expect(sent.task).toBe('the review bot double-posts')
  expect(sent.limits).toEqual({ models: ['sonnet'], maxEffort: 'high', maxWorkers: 4, ownedWorkers: 1 })
  // The coordinator itself is no candidate; the observed session carries its prompts and repository.
  expect(sent.sessions.map((s: any) => s.relation)).toEqual(['owned', 'observed'])
  expect(sent.sessions[1]).toMatchObject({ pane: '%7', repo: '/src/autoreview', prompts: ['fix the review bot'] })
  expect(r.result).toContain('Route: adopt obs')
  expect(r.result).toContain('/coord adopt %7')
  // Nothing was started or sent: the coordinator acts.
  expect(runs.some((a) => a[0] === 'tmux' && a[1] === 'new-window')).toBe(false)
  expect(Object.keys(files).some((f) => f.includes('/inbox/'))).toBe(false)

  reply = { isAnswered: true, text: '{"action":"spawn","repo_dir":"/src/autoreview","model":"sonnet","effort":"low","reason":"r"}', usage: reply.usage }
  const s: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_route', task: 'x' } as any)
  expect(s.result).toContain('coord_spawn repo_dir=/src/autoreview model=sonnet effort=low')

  reply = { isAnswered: true, text: '{"action":"send","target":"obs","reason":"r"}', usage: reply.usage }
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__cc-mods__coord_route', task: 'x' } as any))).toContain('observed session')
  reply = { isAnswered: true, text: 'I would send it to obs.', usage: reply.usage }
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__cc-mods__coord_route', task: 'x' } as any))).toContain('did not answer with JSON')
  reply = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: reply.usage }
  const f = JSON.stringify(await $.tool.call({ tool: 'mcp__cc-mods__coord_route', task: 'x' } as any))
  expect(f).toContain('no answer (api-error 529 overloaded)')
  expect(f).toContain('nothing was decided')
})

// A worker in a pane split off the coordinator's (%1), at work.
const paneLedger = () => JSON.stringify({ on: true, sid: 'sid-1', name: 'cc-mods-d9', limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 4 }, workers: [{ slug: 'coord-route', sid: 'w96', relation: 'owned', pane: '%386', window: '@1', made: { kind: 'pane', pane: '%386', window: '@1' }, cwd: '/r/cr', at: OLD, state: 'working', attention: 'none' }], log: [], at: OLD })

test('coord_close kills the pane it made and nothing else: not the coordinator\'s pane, not its window', async ($, on) => {
  const files: Record<string, string> = { [LEDGER]: paneLedger() }
  const runs: string[][] = []
  stubs(on, { files, submitted: [], panes: () => '', runs, run: (a) => (a[0] === 'tmux' && a[1] === 'display-message' ? '@1' : undefined) })
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_close', slug: 'coord-route' } as any)
  expect(r.result).toBe("Closed coord-route's pane %386.")
  const kills = runs.filter((a) => a[0] === 'tmux' && a[1]!.startsWith('kill-'))
  expect(kills).toEqual([['tmux', 'kill-pane', '-t', '%386']])
  // A ledger that names the coordinator's own pane as the worker's: nothing is killed.
  files[LEDGER] = paneLedger().replaceAll('%386', '%1')
  runs.length = 0
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const self: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_close', slug: 'coord-route' } as any)
  expect(self.result).toContain('no pane or window of its own to close')
  expect(runs.some((a) => a[0] === 'tmux' && a[1]!.startsWith('kill-'))).toBe(false)
})

test('coord: a claude -p child naming the worker\'s pane does not make the worker gone while its session lives', async ($, on) => {
  // Live: coord-route's `claude -p` child (8edc482b) published itself in pane
  // %386, and the coordinator heard "coord-route: its session is gone".
  const files: Record<string, string> = { [LEDGER]: paneLedger() }
  const submitted: string[] = []
  let live = 'w96'
  const asked: string[][] = []
  stubs(on, {
    files,
    submitted,
    panes: () => '%1\t@1\tsid-1\tdone\tnone\t/work\t\t\n%386\t@1\tchild-8edc\tworking\tnone\t/r/cr\t\t',
    run: (a) => (a[0] === 'sh' && String(a[2]).includes('ps -o comm=') ? (asked.push(a.slice(3)), live) : undefined),
  })
  const clock = mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await clock.advance(10_000)
  await clock.advance(10_000)
  expect(asked.at(-1)).toEqual(['/home/u', 'w96'])
  expect(submitted.filter((t) => t.includes('gone'))).toEqual([])
  expect(JSON.parse(files[LEDGER]!).workers[0].endedAt).toBeUndefined()
  // The worker's own session ends: then it is gone.
  live = ''
  await clock.advance(10_000)
  expect(submitted.filter((t) => t.includes('coord-route: its session is gone'))).toHaveLength(1)
  expect(JSON.parse(files[LEDGER]!).workers[0].endedAt).toBeGreaterThan(0)
})

test('coord: coord_send goes as a peer message, which reaches a worker mid-turn; no inbox file is written', async ($, on) => {
  // Live (2026-11-10): a plugin prompt through the inbox waited 25 minutes
  // for office-say-first's turn to end; a peer message is read at the
  // worker's next tool call.
  const files: Record<string, string> = { [LEDGER]: ledgerJson() }
  const peers: any[] = []
  stubs(on, { files, submitted: [], panes: () => '', peer: (e) => (peers.push(e), { isDelivered: true }) })
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_send', slug: 'brief-decision-4', text: 'first' } as any)
  expect(peers.map((e) => [e.to, e.text])).toEqual([[expect.stringContaining('w4'), '[coordinator] first']])
  expect(r.result).toBe('Sent to brief-decision-4 (%365): delivered into its session (mid-turn: at its next tool call).')
  expect(Object.keys(files).some((f) => f.includes('/inbox/'))).toBe(false)
  expect(JSON.parse(files[LEDGER]!).log.at(-1)).toMatchObject({ kind: 'send', text: 'brief-decision-4: first' })
})

test('coord: with no peer message, coord_send writes the inbox marked keep with its sender, and merges with an older one keeping its age', async ($, on) => {
  const files: Record<string, string> = { [LEDGER]: ledgerJson() }
  stubs(on, { files, submitted: [], panes: () => '' })
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const inbox = '/home/u/.claude/state/office/inbox/w4.json'
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_send', slug: 'brief-decision-4', text: 'first' } as any)
  expect(r.result).toContain('left in its office inbox (no peer message: no live session on this machine has id w)')
  expect(r.result).toContain('a [coord] wake tells you if it never does')
  const one = JSON.parse(files[inbox]!)
  expect(one).toMatchObject({ text: '[coordinator] first', keep: true, from: 'sid-1', slug: 'brief-decision-4' })
  await $.tool.call({ tool: 'mcp__cc-mods__coord_send', slug: 'brief-decision-4', text: 'second' } as any)
  expect(JSON.parse(files[inbox]!)).toMatchObject({ text: '[coordinator] first\n\n[coordinator] second', keep: true, at: one.at })
})

test('coord: an instruction past the inline limit goes whole to a file the worker reaches; the message carries its head and path', async ($, on) => {
  const ledger = JSON.parse(ledgerJson())
  ledger.workers[0].addDirs = ['/home/u/briefs', '/home/u/research/brief-decision-4']
  const files: Record<string, string> = { [LEDGER]: JSON.stringify(ledger) }
  const peers: any[] = []
  stubs(on, { files, submitted: [], panes: () => '', peer: (e) => (peers.push(e), { isDelivered: true }) })
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const long = 'do this: ' + 'y'.repeat(120_000) + ' END'
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_send', slug: 'brief-decision-4', text: long } as any)
  const path = Object.keys(files).find((f) => f.startsWith('/home/u/research/brief-decision-4/coord-'))!
  expect(files[path]).toBe(long)
  expect(peers[0].text.length).toBeLessThan(3_000)
  expect(peers[0].text.startsWith('[coordinator] do this: yyy')).toBe(true)
  expect(peers[0].text).toContain('전문: ' + path)
  expect(r.result).toContain('Its 120013 characters went to a file')
})

test('coord: with the mode on every live session is adopted but another coordinator and its owned workers; coord_send reaches one; coord_close hands it back for good', async ($, on) => {
  const OTHER = '/home/u/.claude/state/office/coord/c2.json'
  const other = { on: true, sid: 'c2', name: 'other', workers: [{ slug: 'x', sid: 'c2w', relation: 'owned' }] }
  const files: Record<string, string> = { [LEDGER]: ledgerJson(), [OTHER]: JSON.stringify(other) }
  // The coordinator, its worker, the person's ops-k8s session (typed in 20 minutes ago), another coordinator and its worker.
  const typed = String(Math.floor((Date.now() - 20 * 60_000) / 1000))
  let rows = ['%1\t@1\tsid-1\tdone\tnone\t/work\t\t', '%365\t@134\tw4\tworking\tnone\t/r/bd\t\t', '%7\t@7\tops\tdone\tnone\t/src/ops-k8s\t' + typed + '\t', '%8\t@8\tc2\tdone\tnone\t/src/c2\t\t', '%9\t@8\tc2w\tworking\tnone\t/src/c2w\t\t']
  const runs: string[][] = []
  stubs(on, {
    files,
    submitted: [],
    panes: () => rows.join('\n'),
    runs,
    run: (argv) => {
      const cmd = String(argv[2] ?? '')
      if (argv[0] === 'sh' && cmd.includes('.claude/sessions') && !cmd.includes('ps -o')) return '{"s":"ops","n":"ops-k8s"}\n{"s":"sid-1","n":"cc-mods-d9"}'
      // The other ledgers, one compact JSON each, this one left out.
      if (argv[0] === 'sh' && cmd.startsWith('for f in')) return argv[4] === LEDGER ? JSON.stringify(other) : '!'
      return undefined
    },
  })
  const clock = mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const before: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_roster' } as any)
  expect(before.result).toContain('| ops-k8s | adopted (auto) ops-k8s | %7 |')
  expect(before.result).toContain('| c2 | observed | %8 |')
  expect(before.result).toContain('| c2w | observed | %9 |')
  const w = () => JSON.parse(files[LEDGER]!).workers.find((x: any) => x.sid === 'ops')
  expect(w()).toMatchObject({ slug: 'ops-k8s', relation: 'adopted', auto: true })
  expect(w().endedAt).toBeUndefined()
  // Typed in 20 minutes ago: past the hold, so it takes an instruction.
  const sent: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_send', slug: 'ops-k8s', text: 'the person says: keep the alert' } as any)
  expect(sent.result.startsWith('Sent to ops-k8s (%7): left in its office inbox')).toBe(true)
  expect(JSON.parse(files['/home/u/.claude/state/office/inbox/ops.json']!).text).toBe('[coordinator] the person says: keep the alert')
  expect(w().instructed).toBeGreaterThan(0)
  const closed: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_close', slug: 'ops-k8s' } as any)
  expect(closed.result).toContain('Handed ops-k8s back to the person')
  // Its pane is not touched.
  expect(runs.some((a) => a[0] === 'tmux' && String(a[1]).startsWith('kill'))).toBe(false)
  expect(JSON.parse(files[LEDGER]!).released).toEqual(['ops'])
  await clock.advance(10_000)
  const after: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_roster' } as any)
  expect(after.result).toContain('| ops-k8s | observed | %7 |')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__cc-mods__coord_send', slug: 'ops-k8s', text: 'x' } as any))).toContain('/coord adopt')
  // A session that appears later is adopted by the watch, without a roster call.
  rows = [...rows, '%10\t@1\tnew1abcd\tworking\tnone\t/src/n\t\t']
  await clock.advance(10_000)
  expect(JSON.parse(files[LEDGER]!).workers.find((x: any) => x.sid === 'new1abcd')).toMatchObject({ slug: 'new1abcd', relation: 'adopted', auto: true })
})

test('coord: an auto-adopted session the person just typed in still takes coord_send; the result notes it', async ($, on) => {
  const files: Record<string, string> = { [LEDGER]: ledgerJson() }
  const typed = String(Math.floor((Date.now() - 60_000) / 1000))
  stubs(on, { files, submitted: [], panes: () => ['%1\t@1\tsid-1\tdone\tnone\t/work\t\t', '%7\t@7\tops\tdone\tnone\t/src/ops-k8s\t' + typed + '\t'].join('\n'), run: (argv) => (argv[0] === 'sh' && String(argv[2]).includes('.claude/sessions') && !String(argv[2]).includes('ps -o') ? '{"s":"ops","n":"ops-k8s"}' : undefined) })
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_roster' } as any)
  const at = new Date(Number(typed) * 1000).toTimeString().slice(0, 5)
  expect(r.result).toContain('| ops-k8s | adopted (auto) ops-k8s | %7 | done person typed ' + at + ' |')
  const s: any = await $.tool.call({ tool: 'mcp__cc-mods__coord_send', slug: 'ops-k8s', text: 'x' } as any)
  expect(s.deny).toBeUndefined()
  expect(s.result.endsWith('. Note: the person typed in this pane lately (' + at + ', 1 min ago); their draft is not touched.')).toBe(true)
  expect(JSON.parse(files['/home/u/.claude/state/office/inbox/ops.json']!).text).toBe('[coordinator] x')
})

test('coord: coord_review adds and updates the queue file; an office confirm reaches the next composed prompt', async ($, on) => {
  const REVIEW = '/home/u/.claude/state/office/coord/review/sid-1.json'
  const files: Record<string, string> = { [LEDGER]: ledgerJson() }
  const submitted: string[] = []
  const runs: string[][] = []
  stubs(on, { files, submitted, panes: () => PANE, runs })
  mock.clock(on)
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__cc-mods__coord_review', ...input } as any) as any
  const added = await call({ action: 'add', id: 'cc-mods#85', title: '검토 대기열', changed: '지휘 view에 🔎 검토', check: 'j/k로 넘겨 보기', links: ['https://github.com/keyolk/cc-mods/pull/85'] })
  expect(added.result).toBe('Added cc-mods#85. 검토 대기 1건 (say only this in chat; the office shows the items).')
  // Not coord/*.json, where the ledgers are globbed.
  expect(runs).toContainEqual(['mkdir', '-p', '/home/u/.claude/state/office/coord/review'])
  const updated = await call({ action: 'update', id: 'cc-mods#85', verified: '8899 live run' })
  expect(updated.result).toContain('Updated cc-mods#85. 검토 대기 1건')
  expect(JSON.parse(files[REVIEW]!).items[0]).toMatchObject({ id: 'cc-mods#85', title: '검토 대기열', verified: '8899 live run', state: 'open' })
  expect((await call({ action: 'update', id: 'nope', title: 'x' })).deny).toContain('add it first')
  expect((await call({ action: 'list' })).result).toContain('| cc-mods#85 | 검토 대기열 |')
  const compose = async () => ((await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] })) as any).sections.find((s: any) => s.id === 'cc-mods:policy')?.text ?? ''
  expect(await compose()).toContain('Review queue (coord_review): 1 open — cc-mods#85.')
  // The office confirms in the file, then its prompt arrives.
  const f = JSON.parse(files[REVIEW]!)
  f.items[0].state = 'confirmed'
  f.items[0].confirmedAt = Date.now()
  files[REVIEW] = JSON.stringify(f)
  await $.prompt.submit({ text: '[review] confirmed cc-mods#85', origin: { kind: 'plugin', name: 'cc-mods' }, wait: false } as any)
  expect(submitted).toEqual(['[review] confirmed cc-mods#85'])
  const after = await compose()
  expect(after).toContain('# Coordinator mode (cc-mods)')
  expect(after).not.toContain('Review queue (coord_review)')
  expect((await call({ action: 'list' })).result).toContain('Review queue empty.\n1 confirmed in the last 7 days')
})

// Live: cc-plugin-sec-default sends prompt.compose past the user tier, so
// "# Coordinator mode" never reached the coordinator. No compose here, as
// there: the rules and the roster go as note rows, each again only when it
// changed, on a [coord] wake (a plugin's prompt) as on the person's.
test('coord: where prompt.compose never runs, the coordinator rules and roster go as note rows, the roster again when a worker leaves', async ($, on) => {
  const files: Record<string, string> = { [LEDGER]: ledgerJson(), '/home/u/.claude/state/session_policy/sid-1.json': JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' } }) }
  stubs(on, { files, submitted: [], panes: () => PANE })
  mock.clock(on)
  const session = mock.session(on)
  on('session.messages', () => ({ value: session.appended().map((r: any) => ({ role: 'user', content: r.message.content })) }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const notes = () => session.appended().filter((r: any) => r.door === 'note').map((r: any) => r.message.content.map((b: any) => b.text).join(''))

  await $.prompt.submit({ text: 'what is brief-decision-4 doing?', origin: { kind: 'composer' }, wait: false } as any)
  expect(notes().length).toBe(1)
  expect(notes()[0]).toContain('[cc-mods context: coordinator #')
  expect(notes()[0]).toContain('# Coordinator mode (cc-mods)\nYou are `cc-mods-d9`, the coordinator.')
  expect(notes()[0]).toContain('| brief-decision-4 | owned |')
  expect(notes()[0]).toContain('# Session policy (custom)')

  // A [coord] wake is a plugin's prompt: nothing changed, no row.
  await $.prompt.submit({ text: '[coord] brief-decision-4: finished its turn', origin: { kind: 'plugin', name: 'cc-mods' }, wait: false } as any)
  expect(notes().length).toBe(1)

  // The worker closes: only the roster goes again; the rules stay as sent.
  await $.tool.call({ tool: 'mcp__cc-mods__coord_close', slug: 'brief-decision-4' } as any)
  await $.prompt.submit({ text: '[coord] the review queue changed', origin: { kind: 'plugin', name: 'cc-mods' }, wait: false } as any)
  expect(notes().length).toBe(2)
  expect(notes()[1]).toContain('[cc-mods context: workers #')
  expect(notes()[1]).toContain('This replaces the earlier workers context.\nNo workers yet.')
  expect(notes()[1]).not.toContain('# Coordinator mode')
  expect(notes()[1]).not.toContain('# Session policy')
})
