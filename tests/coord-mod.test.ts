// Coordinator mode through the engine: what a module reload (a merge on main,
// mid-turn) does to the coord tools and to the wakes. Run with `claude plugin
// test`; `bun test` skips it.
import { expect, mock, test } from 'claude-code/testing'

const LEDGER = '/home/u/.claude/state/office/coord/sid-1.json'
const OLD = Date.now() - 600_000
const ledgerJson = () => JSON.stringify({ on: true, sid: 'sid-1', name: 'cc-mods-d9', limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 4 }, workers: [{ slug: 'brief-decision-4', sid: 'w4', relation: 'owned', pane: '%365', window: '@134', cwd: '/r/bd', at: OLD, state: 'working', attention: 'none' }], log: [], at: OLD })
// The worker's pane as tmux lists it (PANES_FMT): deciding a Read.
const PANE = '%365\t@134\tw4\twaiting\taction\t/r/bd\t\tRead ~/r/prompt.txt'

function stubs(on: any, o: { files: Record<string, string>; submitted: string[]; panes: () => string }) {
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
  on('process.run', (_$: any, e: any) => (e.argv[0] === 'tmux' && e.argv[1] === 'list-panes' ? ok(o.panes()) : ok('')))
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
