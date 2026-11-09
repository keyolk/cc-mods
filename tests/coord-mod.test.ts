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
  expect(r.result).toBe("Closed brief-decision-4's window.")
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
  if (argv[0] === 'tmux' && argv[1] === 'display-message') return 'main'
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
