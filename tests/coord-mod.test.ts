// Coordinator mode through the engine: what a module reload (a merge on main,
// mid-turn) does to the coord tools and to the wakes. Run with `claude plugin
// test`; `bun test` skips it.
import { expect, mock, test } from 'claude-code/testing'

const LEDGER = '/home/u/.claude/state/office/coord/sid-1.json'
const OLD = Date.now() - 600_000
const ledgerJson = () => JSON.stringify({ on: true, sid: 'sid-1', name: 'cc-mods-d9', limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 4 }, workers: [{ slug: 'brief-decision-4', sid: 'w4', relation: 'owned', pane: '%365', window: '@134', cwd: '/r/bd', at: OLD, state: 'working', attention: 'none' }], log: [], at: OLD })
// The worker's pane as tmux lists it (PANES_FMT): deciding a Read.
const PANE = '%365\t@134\tw4\twaiting\taction\t/r/bd\t\tRead ~/r/prompt.txt'

function stubs(on: any, o: { files: Record<string, string>; submitted: string[]; panes: () => string; run?: (argv: string[]) => string | undefined; runs?: string[][] }) {
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
  expect(r.result).toContain('cwd /home/u/research/ar-x, add-dirs ' + wt + '.')
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
  expect(nw.slice(-2)).toEqual(['/home/u/research/ar-x/prompt.txt', '--add-dir=' + wt])
  const prompt = files['/home/u/research/ar-x/prompt.txt']!
  expect(prompt).toContain('Your tools reach `/home/u/research/ar-x`, `' + wt + '` without a permission dialog')
  expect(prompt).toContain('QUESTION need <path>')
  expect(prompt).toContain('absolute paths under `' + wt + '`')
  expect(prompt).toContain('git -C ' + wt)
  expect(prompt).toContain(".claude settings (hooks, permissions, MCP servers) do not apply")
  const w = JSON.parse(files[LEDGER]!).workers[0]
  expect([w.cwd, w.code, w.worktree, w.addDirs]).toEqual(['/home/u/research/ar-x', wt, wt, [wt]])
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
  expect(r.result).toContain('cwd /home/u/research/ar-y, add-dirs /src/autoreview.')
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

test('coord_route: one cheap model call over the live sessions; its answer is checked and handed back, never acted on; a failed or bad answer is an error', async ($, on) => {
  const files: Record<string, string> = { [LEDGER]: ledgerJson() }
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
