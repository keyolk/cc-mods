// Coordinator mode's rules (hooks/lib/coord.ts): no engine, just functions.
import { expect, test } from 'claude-code/testing'

import { COORD_CAPS, HOLD_MS, PANES_FMT, WORKER_CAPS, coordSection, current, parsePending, mergeRepos, policyArgvs, policyOf, emptyLedger, held, observe, overlaps, parseLedger, parseLimits, parsePanes, recheck, spawnRefusal, workerArgv, workerPrompt, type Change, type Ledger, type Worker } from '../hooks/lib/coord'
import { canonicalOf, parseProjects, placement, trustTarget, trustedBy } from '../hooks/lib/trust'
import { askKey, askLabel, askState, dialogFor, toolOfNotice, type Asked } from '../hooks/lib/asks'
import { publishArgv } from '../hooks/lib/tmux'

const NOW = 1_800_000_000_000
const on = (over: Partial<Ledger> = {}): Ledger => ({ ...emptyLedger('coord-sid', 'cc-mods-d9', NOW), on: true, ...over })
const worker = (over: Partial<Worker> = {}): Worker => ({ slug: 'tmc-layout', sid: 'w1', relation: 'owned', cwd: '/w/tmc-layout', at: NOW - 120_000, state: 'working', attention: 'none', ...over })
const req = { slug: 'tmc-layout', model: 'sonnet', effort: 'medium', brief: 'do it', repoDir: '/src/tmc' }

test('coord: nothing starts while the mode is off, or beyond the limits', () => {
  expect(spawnRefusal(emptyLedger('s', 'n', NOW), req)).toContain('/coord on')
  expect(spawnRefusal(on(), req)).toBeUndefined()
  expect(spawnRefusal(on(), { ...req, slug: 'Bad Slug' })).toContain('slug')
  expect(spawnRefusal(on(), { ...req, effort: 'max' })).toContain('above the limit high')
  expect(spawnRefusal(on({ limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 4 } }), { ...req, model: 'opus' })).toContain('not allowed')
  // A full model id counts as its alias.
  expect(spawnRefusal(on(), { ...req, model: 'claude-opus-5-5' })).toBeUndefined()
  const full = on({ limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 1 }, workers: [worker({ slug: 'other' })] })
  expect(spawnRefusal(full, req)).toContain('already 1 workers')
  // An adopted session does not take a worker slot; an ended one frees it.
  expect(spawnRefusal({ ...full, workers: [worker({ slug: 'other', relation: 'adopted' })] }, req)).toBeUndefined()
  expect(spawnRefusal({ ...full, workers: [worker({ slug: 'other', endedAt: NOW })] }, req)).toBeUndefined()
  expect(spawnRefusal(on({ workers: [worker()] }), req)).toContain('already in the ledger')
  expect(spawnRefusal(on(), { ...req, repoDir: undefined })).toContain('repo_dir')
})

test('coord: the worker runs claude with its model, effort and session id, the brief read from its file', () => {
  const argv = workerArgv({ target: 'main:', slug: 'tmc-layout', cwd: '/w/tmc-layout', model: 'claude-sonnet-5-5', effort: 'medium', sid: 'u-1', promptFile: '/r/prompt.txt' })
  expect(argv.slice(0, 12)).toEqual(['new-window', '-d', '-P', '-F', '#{window_id} #{pane_id}', '-t', 'main:', '-n', 'w:tmc-layout', '-c', '/w/tmc-layout', 'sh'])
  expect(argv[13]).toContain('--disallowedTools AskUserQuestion')
  expect(argv[13]).toContain('--session-id "$s"')
  expect(argv.slice(14)).toEqual(['worker', 'sonnet', 'medium', 'u-1', 'tmc-layout', '/r/prompt.txt'])
  const p = workerPrompt('  fix it  ', 'cc-mods-d9', 'tmc-layout')
  expect(p.startsWith('fix it\n')).toBe(true)
  expect(p).toContain('SendMessage (to: "cc-mods-d9")')
  expect(p).toContain('READY <sha>')
  expect(p).not.toContain('coord-report')
  // Live: a worker's READY failed with "No agent named 'cc-mods-d9' is
  // reachable" (the coordinator's /tmp/cc-socks file was gone): the inbox
  // reaches it anyway.
  const fb = workerPrompt('fix it', 'cc-mods-d9', 'tmc-layout', 'python3 /p/bin/coord-report coord-sid')
  expect(fb).toContain("python3 /p/bin/coord-report coord-sid '[worker tmc-layout] <report>'")
})

test('coord: the watch wakes the coordinator for a question, an exit and the person taking over', () => {
  const l = on({ workers: [worker(), worker({ slug: 'b', sid: 'w2' }), worker({ slug: 'c', sid: 'w3' }), worker({ slug: 'fresh', sid: 'w4', at: NOW - 5_000 })] })
  const seen = parsePanes(['%1\t@1\tw1\tworking\task\t/w/tmc-layout\t', '%2\t@2\tw2\tdone\tnone\t/w/b\t' + Math.floor((NOW - 1000) / 1000), ''].join('\n'))
  const { ledger, changes } = observe(l, seen, NOW)
  expect(changes.map((c) => c.slug)).toEqual(['tmc-layout', 'b', 'b', 'c'])
  expect(changes[0]!.text).toContain('waiting on an answer')
  expect(changes[1]!.text).toContain('the person is typing')
  expect(changes[2]!.text).toContain('finished its turn')
  expect(changes[3]!.text).toContain('gone')
  // Just started and not yet published: not counted gone.
  expect(ledger.workers.find((w) => w.slug === 'fresh')!.endedAt).toBeUndefined()
  expect(ledger.workers.find((w) => w.slug === 'c')!.endedAt).toBe(NOW)
  const b = ledger.workers.find((w) => w.slug === 'b')!
  expect(held(b, NOW)).toBe(true)
  expect(held(b, NOW + HOLD_MS)).toBe(false)
  // Seen again unchanged: nothing new to say.
  expect(observe(ledger, seen, NOW + 10_000).changes).toEqual([])
})

test('coord: sessions already in a directory or the repository around it are found', () => {
  const seen = parsePanes(['%1\t@1\ts1\tdone\tnone\t/src/tmc', '%2\t@2\ts2\tdone\tnone\t/src/tmc/crates', '%3\t@3\ts3\tdone\tnone\t/src/tmcx', '%4\t@4\tcoord-sid\tdone\tnone\t/src/tmc'].join('\n'))
  expect(overlaps(seen, on(), '/src/tmc/').map((s) => s.sid)).toEqual(['s1', 's2'])
})

test('coord: a session in a parent directory is not in the repository; one in its worktree is', () => {
  // Live: a spawn in ~/src/keyolk/briefs named 13 sessions sitting in ~ and
  // one in ~/src as "other live sessions in this repository".
  const seen = parsePanes(['%1\t@1\thome\tdone\tnone\t/Users/g', '%2\t@2\tsrc\tdone\tnone\t/Users/g/src', '%3\t@3\twt\tdone\tnone\t/Users/g/worktrees/briefs/old', '%4\t@4\tsub\tdone\tnone\t/Users/g/src/keyolk/briefs/docs', '%5\t@5\tother\tdone\tnone\t/Users/g/worktrees/tmc/x'].join('\n'))
  const of = new Map([['/Users/g/worktrees/briefs/old', '/Users/g/src/keyolk/briefs/.git'], ['/Users/g/src/keyolk/briefs/docs', '/Users/g/src/keyolk/briefs/.git'], ['/Users/g/worktrees/tmc/x', '/Users/g/src/tmc/.git']])
  expect(overlaps(seen, on(), '/Users/g/src/keyolk/briefs', { common: '/Users/g/src/keyolk/briefs/.git', of }).map((s) => s.sid)).toEqual(['wt', 'sub'])
  // Git unknown: only the directory and what is under it.
  expect(overlaps(seen, on(), '/Users/g/src/keyolk/briefs').map((s) => s.sid)).toEqual(['sub'])
})

test('coord: an approval the auto classifier settles between ticks is neither a question nor a finished turn', () => {
  // Live: a worker read code; its Bash call was an ask the classifier
  // allowed, and the pane showed waiting/action. The watch said "finished
  // its turn".
  const l = on({ workers: [worker()] })
  const asking = parsePanes('%1\t@1\tw1\twaiting\taction\t/w/tmc-layout\t')
  const first = observe(l, asking, NOW)
  expect(first.changes).toEqual([])
  // Settled by the next tick: nothing.
  expect(observe(first.ledger, parsePanes('%1\t@1\tw1\tworking\tnone\t/w/tmc-layout\t'), NOW + 10_000).changes).toEqual([])
  // Still asking a tick later: the person's dialog. Once.
  const second = observe(first.ledger, asking, NOW + 10_000)
  expect(second.changes.map((c) => c.text)).toEqual(['tmc-layout (pane %1, window @1): waiting on an approval in its pane'])
  expect(observe(second.ledger, asking, NOW + 20_000).changes).toEqual([])
  // The turn's real end is still seen after it.
  const done = observe(second.ledger, parsePanes('%1\t@1\tw1\tdone\tnone\t/w/tmc-layout\t'), NOW + 30_000)
  expect(done.changes.map((c) => c.text)).toEqual(['tmc-layout: finished its turn'])
})

test('coord: a wake held through the coordinator\'s turn is delivered only while still true', () => {
  // Live: "its session is gone" was queued behind the coordinator's turn and
  // arrived two minutes later, after it had found out and respawned.
  const l = on({ workers: [worker({ state: 'done', attention: 'none' }), worker({ slug: 'b', sid: 'w2', endedAt: NOW }), worker({ slug: 'c', sid: 'w3', state: 'working', attention: 'none' })] })
  const c = (sid: string, kind: 'ask' | 'held' | 'turn' | 'gone') => ({ slug: sid, sid, kind, text: '', wake: true })
  expect(current(c('w1', 'turn'), l, NOW)).toBe(true)
  expect(current(c('w2', 'gone'), l, NOW)).toBe(true)
  // Working again (the coordinator sent it more): no longer finished.
  expect(current(c('w3', 'turn'), l, NOW)).toBe(false)
  expect(current(c('w3', 'ask'), l, NOW)).toBe(false)
  expect(current(c('w1', 'held'), l, NOW)).toBe(false)
  expect(current(c('nobody', 'gone'), l, NOW)).toBe(false)
})

test('trust: Claude Code\'s rule, read only', () => {
  const projects = parseProjects(JSON.stringify({ projects: { '/Users/g': { hasTrustDialogAccepted: true }, '/Users/g/src/keyolk/cc-mods': { hasTrustDialogAccepted: true }, '/Users/g/src': { hasTrustDialogAccepted: false }, '/odd': [] } }))
  // A worktree shares its main checkout's trust.
  const ccWt = { dir: '/Users/g/worktrees/cc-mods/x', top: '/Users/g/worktrees/cc-mods/x', canonical: canonicalOf('/Users/g/src/keyolk/cc-mods/.git') }
  expect(trustedBy(projects, ccWt)).toBe('/Users/g/src/keyolk/cc-mods')
  // Live: ~ was trusted and the dialog still came: inside git the walk
  // stops at the toplevel.
  const briefsWt = { dir: '/Users/g/worktrees/briefs/b', top: '/Users/g/worktrees/briefs/b', canonical: canonicalOf('/Users/g/src/keyolk/briefs/.git') }
  expect(trustedBy(projects, briefsWt)).toBeUndefined()
  expect(trustTarget(briefsWt)).toBe('/Users/g/src/keyolk/briefs')
  // A trusted folder between the directory and its toplevel counts.
  expect(trustedBy(projects, { dir: '/Users/g/src/keyolk/cc-mods/hooks', top: '/Users/g/src/keyolk/cc-mods', canonical: '/elsewhere' })).toBe('/Users/g/src/keyolk/cc-mods')
  // Outside git, any parent.
  expect(trustedBy(projects, { dir: '/Users/g/research/x' })).toBe('/Users/g')
  expect(trustedBy(projects, { dir: '/odd/x' })).toBeUndefined()
  expect(parseProjects('{oops')).toEqual({})
  expect(canonicalOf('/srv/repo.git/')).toBe('/srv/repo.git')
})

test('coord: a ledger from disk keeps sane limits; the prompt names the workers', () => {
  const l = parseLedger(JSON.stringify({ on: true, limits: { models: [], maxEffort: 'turbo', maxWorkers: -1 }, workers: [{ slug: 'a', sid: 'x', relation: 'owned', cwd: '/a', at: 1 }, { nope: 1 }] }), 'sid', 'n', NOW)
  expect(l.limits).toEqual({ models: ['haiku', 'sonnet', 'opus'], maxEffort: 'high', maxWorkers: 4 })
  expect(l.workers.length).toBe(1)
  expect(parseLedger('{oops', 'sid', 'n', NOW).on).toBe(false)
  const text = coordSection(l, NOW)
  expect(text).toContain('`n`, the coordinator')
  expect(text).toContain('| a | owned |')
  // The office's two prompts are named, so the coordinator knows what to do with them.
  expect(text).toContain('`brief ask <brief>`')
  expect(text).toContain('[brief answer]')
  expect(text).toContain('[office→coord]')
})

test('coord: /coord limits', () => {
  const cur = on().limits
  expect(parseLimits('models opus,claude-sonnet-5-5', cur)).toEqual({ ...cur, models: ['opus', 'sonnet'] })
  expect(parseLimits('models gpt', cur)).toContain('comma list')
  expect(parseLimits('effort xhigh', cur)).toEqual({ ...cur, maxEffort: 'xhigh' })
  expect(parseLimits('workers 99', cur)).toContain('1 to 12')
  expect(parseLimits('', cur)).toContain('limits:')
})

test('coord: the brief, the worker\'s first prompt, does not count as the person typing', () => {
  const l = on({ workers: [worker({ at: NOW - 30_000 })] })
  const seen = parsePanes('%1\t@1\tw1\tworking\tnone\t/w/tmc-layout\t' + Math.floor((NOW - 29_000) / 1000))
  expect(observe(l, seen, NOW).changes).toEqual([])
  const later = parsePanes('%1\t@1\tw1\tworking\tnone\t/w/tmc-layout\t' + Math.floor((NOW + 60_000) / 1000))
  expect(observe(l, later, NOW + 61_000).changes.map((c) => c.text)[0]).toContain('the person is typing')
})

test('coord: a turn that ended between two ticks still wakes the coordinator', () => {
  // Live: the ledger went from no state straight to waiting; the worker had
  // already sent READY.
  const l = on({ workers: [worker({ state: undefined, at: NOW - 300_000 })] })
  const seen = parsePanes('%1\t@1\tw1\twaiting\tnone\t/w/tmc-layout\t')
  expect(observe(l, seen, NOW).changes.map((c) => c.text)).toEqual(['tmc-layout: finished its turn'])
  // Just started, not yet working: nothing.
  expect(observe(on({ workers: [worker({ state: undefined, at: NOW - 5_000 })] }), seen, NOW).changes).toEqual([])
  // Already idle last time: nothing new.
  expect(observe(on({ workers: [worker({ state: 'done' })] }), seen, NOW).changes).toEqual([])
})

test('coord: the coordinator merges only in its workers\' repositories; a worker does nothing outward', () => {
  expect(policyArgvs(COORD_CAPS, ['keyolk/tmc'])).toEqual([['mode', 'default'], ['block', 'gh_merge'], ['block', 'prod_eks_write'], ['block', 'slack_send'], ['block', 'tmux_window_escape'], ['allow', 'auto_continue'], ['allow', 'gh_merge', '--repo', 'keyolk/tmc']])
  expect(WORKER_CAPS).toMatchObject({ gh_merge: 'block', slack_send: 'block', auto_model: 'block', auto_effort: 'block', auto_continue: 'allow' })
  const l = on({ workers: [worker({ repo: 'keyolk/tmc' }), worker({ slug: 'b', repo: 'keyolk/tmc' }), worker({ slug: 'c', repo: undefined }), worker({ slug: 'd', repo: 'keyolk/tweb', endedAt: NOW })] })
  expect(mergeRepos(l)).toEqual(['keyolk/tmc'])
  const base = { mode: 'custom', caps: { gh_merge: 'allow', prod_eks_access: 'allow', prod_eks_write: 'allow', slack_send: 'allow', tmux_window_escape: 'allow', auto_continue: 'inherit', auto_effort: 'inherit', auto_model: 'inherit' }, explicit: {}, scopes: {} } as any
  const p = policyOf(COORD_CAPS, ['keyolk/tmc'], base)
  expect(p.caps.gh_merge).toBe('block')
  expect(p.caps.prod_eks_access).toBe('allow')
  expect(p.scopes).toEqual({ gh_merge: ['keyolk/tmc'] })
})

test('coord: pending decisions from command.py keep only what the tab can draw', () => {
  const got = parsePending(JSON.stringify([
    { file: 'a.html', title: 'A', coordinatorName: 'c', decision: { question: 'q?', options: [{ label: 'x' }, { nope: 1 }, { label: 'y', detail: 'd' }], recommended: 5, worker: 'w', asked: 't' } },
    { file: 'b.html', decision: { options: [] } },
    'junk',
  ]))
  expect(got).toEqual([{ file: 'a.html', title: 'A', question: 'q?', options: [{ label: 'x', detail: '' }, { label: 'y', detail: 'd' }], recommended: null, coordinator: 'c', worker: 'w', asked: 't' }])
  expect(parsePending('{oops')).toEqual([])
  expect(parsePending('{}')).toEqual([])
})

test('coord: a worker spawned with add_dirs runs claude --add-dir=<dir>, never swallowing the brief', () => {
  // Live: brief-decision-3 ran in ~/research/brief-decision and stopped at a
  // dialog reading ~/worktrees/briefs/brief-decision/bin/brief.py.
  const argv = workerArgv({ target: 'main:', slug: 'b', cwd: '/r/b', model: 'opus', effort: 'high', sid: 'u-2', promptFile: '/r/b/prompt.txt', addDirs: ['/w/briefs/b', '/odd dir'] })
  expect(argv.slice(14)).toEqual(['worker', 'opus', 'high', 'u-2', 'b', '/r/b/prompt.txt', '--add-dir=/w/briefs/b', '--add-dir=/odd dir'])
  // The shell keeps the first five and hands the rest to claude before its
  // other options: --add-dir takes several values, so a spaced form before
  // the prompt would read the prompt as a directory.
  // Under bun test only: the plugin test runtime has no process to spawn.
  const bun = (globalThis as any).Bun
  const run = bun?.spawnSync(['sh', '-c', argv[13]!.replace('exec claude', 'printf "%s\\n" claude').replace('"$(cat "$p")"', '"<$p>"'), ...argv.slice(14)])
  if (run) expect(run.stdout.toString().trim().split('\n')).toEqual(['claude', '--add-dir=/w/briefs/b', '--add-dir=/odd dir', '--model', 'opus', '--effort', 'high', '--permission-mode', 'auto', '--disallowedTools', 'AskUserQuestion', '--session-id', 'u-2', '-n', 'b', '</r/b/prompt.txt>'])
  expect(spawnRefusal(on(), { ...req, addDirs: ['~/worktrees/briefs', '/abs'] })).toBeUndefined()
  expect(spawnRefusal(on(), { ...req, addDirs: ['relative/dir'] })).toContain('add_dirs')
  expect(spawnRefusal(on(), { ...req, addDirs: '/not/a/list' })).toContain('add_dirs')
})

test('asks: a call is named by its tool and target; a dialog is matched to its call', () => {
  expect(askLabel('Read', { file_path: '/Users/g/worktrees/briefs/b/bin/brief.py' }, '/Users/g')).toBe('Read ~/worktrees/briefs/b/bin/brief.py')
  expect(askLabel('Bash', { command: 'git push\torigin\n main' })).toBe('Bash git push origin main')
  expect(askLabel('mcp__slack__send', {})).toBe('slack send')
  expect(askLabel('Bash', { command: 'x'.repeat(300) }).length).toBe(140)
  expect(toolOfNotice('Claude needs your permission to use Read')).toBe('Read')
  expect(toolOfNotice('Claude is waiting for your input')).toBeUndefined()
  const a = (id: string, tool: string, input: unknown, shown?: boolean): Asked => ({ id, tool, label: askLabel(tool, input), key: askKey(tool, input), shown })
  // Live: two parallel Reads outside the cwd both asked.
  const brief = a('t1', 'Read', { file_path: '/w/bin/brief.py' })
  const readme = a('t2', 'Read', { file_path: '/w/README.md' })
  expect(dialogFor([brief, readme], 'Read', { file_path: '/w/README.md' })).toBe(readme)
  expect(dialogFor([brief, readme], 'Read')).toBe(brief)
  // A notice after the request hook marked one: the same one.
  expect(dialogFor([brief, { ...readme, shown: true }], 'Read')?.id).toBe('t2')
  expect(dialogFor([brief], 'Bash')).toBeUndefined()
  expect(askState([])).toBeUndefined()
  expect(askState([brief, readme])).toEqual({ attention: 'action', label: 'Read /w/bin/brief.py' })
  expect(askState([brief, { ...readme, shown: true }])).toEqual({ attention: 'ask', label: 'Read /w/README.md' })
})

test('coord: a permission dialog in a worker is "asks: <tool> <target>" with its pane and window, not a finished turn', () => {
  // Live: brief-decision-3 (pane %358) sat at a dialog for a Read outside its
  // cwd; its pane said waiting/none and the coordinator heard "finished its turn".
  expect(PANES_FMT.split('\t').at(-1)).toBe('#{@cc_pane_asks}')
  expect(publishArgv('%358', { attention: 'ask', extra: { '@cc_pane_asks': 'Read ~/x.py' } }, 1)).toEqual([
    ['set-window-option', '-t', '%358', '@cc_attention', 'ask'],
    ['set', '-p', '-t', '%358', '@cc_pane_attention', 'ask'],
    ['set', '-p', '-t', '%358', '@cc_pane_asks', 'Read ~/x.py'],
  ])
  expect(publishArgv('%358', { extra: { '@cc_pane_asks': '' } }, 1)).toEqual([['set', '-p', '-t', '%358', '-u', '@cc_pane_asks']])
  const l = on({ workers: [worker({ slug: 'brief-decision-3', sid: 'w1' })] })
  const dialog = parsePanes('%358\t@132\tw1\twaiting\task\t/r/brief-decision\t\tRead ~/worktrees/briefs/brief-decision/bin/brief.py')
  const first = observe(l, dialog, NOW)
  expect(first.changes.map((c) => [c.kind, c.text])).toEqual([['ask', 'brief-decision-3 (pane %358, window @132): asks: Read ~/worktrees/briefs/brief-decision/bin/brief.py (a permission dialog only the person can answer in that pane)']])
  expect(first.ledger.workers[0]!.asks).toBe('Read ~/worktrees/briefs/brief-decision/bin/brief.py')
  expect(observe(first.ledger, dialog, NOW + 10_000).changes).toEqual([])
  // Its action ticks first, then the dialog for the same call: told once.
  const action = parsePanes('%358\t@132\tw1\twaiting\taction\t/r/brief-decision\t\tRead ~/x.py')
  const a1 = observe(l, action, NOW)
  const a2 = observe(a1.ledger, action, NOW + 10_000)
  expect(a2.changes.map((c) => c.text)).toEqual(['brief-decision-3 (pane %358, window @132): asks: Read ~/x.py (a permission ask still unsettled; a dialog there only the person can answer)'])
  expect(observe(a2.ledger, parsePanes('%358\t@132\tw1\twaiting\task\t/r/brief-decision\t\tRead ~/x.py'), NOW + 20_000).changes).toEqual([])
  // Answered: it runs (working), then its turn ends.
  const ran = observe(a2.ledger, parsePanes('%358\t@132\tw1\tworking\tnone\t/r/brief-decision\t\t'), NOW + 30_000)
  expect(ran.changes).toEqual([])
  expect(observe(ran.ledger, parsePanes('%358\t@132\tw1\tdone\tnone\t/r/brief-decision\t\t'), NOW + 40_000).changes.map((c) => c.text)).toEqual(['brief-decision-3: finished its turn'])
  expect(coordSection(l, NOW)).toContain('asks: <tool> <target>')
})

test('coord: two calls each caught in action on consecutive ticks are not one stuck ask', () => {
  // Live: coord-ask-order ran a python test (in action at one tick), then a
  // cp to its own scratchpad (in action at the next); auto mode allowed both
  // in ~3 s with no dialog, and the coordinator heard "asks: Bash cp …".
  const l = on({ workers: [worker({ slug: 'coord-ask-order' })] })
  const at = (asks: string) => parsePanes('%367\t@136\tw1\twaiting\taction\t/w/x\t\t' + asks)
  const first = observe(l, at('Bash python3 -m unittest discover'), NOW)
  expect(observe(first.ledger, at('Bash cp hooks/register.ts /private/tmp/claude-502/x/scratchpad/r.ts'), NOW + 10_000).changes).toEqual([])
  // The same call still deciding a tick later is the ask.
  const again = observe(first.ledger, at('Bash python3 -m unittest discover'), NOW + 10_000)
  expect(again.changes.map((c) => c.kind)).toEqual(['ask'])
})

test('coord: a [coord] prompt that waited in the queue loses the lines about workers closed since', () => {
  // Live: brief-decision-4's ask went out mid-turn (a reload had reset the
  // turn flag), sat queued, and arrived a minute after coord_close.
  const ask = { slug: 'brief-decision-4', sid: 'w4', kind: 'ask' as const, text: 'brief-decision-4 (pane %365, window @134): asks: Read ~/r/prompt.txt (a permission ask still unsettled; a dialog there only the person can answer)', wake: true }
  const turn = { slug: 'tmc-layout', sid: 'w1', kind: 'turn' as const, text: 'tmc-layout: finished its turn', wake: true }
  const open = on({ workers: [worker({ state: 'done', attention: 'none' }), worker({ slug: 'brief-decision-4', sid: 'w4', state: 'waiting', attention: 'action', asks: 'Read ~/r/prompt.txt' })] })
  const closed: Ledger = { ...open, workers: open.workers.map((w) => (w.sid === 'w4' ? { ...w, endedAt: NOW } : w)) }
  const sent = new Map<string, Change>([[ask.text, ask], [turn.text, turn]])
  const both = '[coord] ' + ask.text + '\n[coord] ' + turn.text
  expect(recheck(both, open, NOW, sent)).toBe(both)
  expect(recheck(both, closed, NOW, sent)).toBe('[coord] ' + turn.text)
  expect(recheck('[coord] ' + ask.text, closed, NOW, sent)).toBeUndefined()
  // Sent before a reload (no record of it): matched by slug, dropped once ended.
  expect(recheck('[coord] ' + ask.text, closed, NOW, new Map())).toBeUndefined()
  expect(recheck('[coord] ' + ask.text, open, NOW, new Map())).toBe('[coord] ' + ask.text)
  // A gone worker stays news; other prompts pass untouched.
  expect(recheck('[coord] brief-decision-4: its session is gone (window closed or claude exited)', closed, NOW, new Map())).toContain('gone')
  expect(recheck('[brief answer] x.html: A', closed, NOW, sent)).toBe('[brief answer] x.html: A')
})

test('coord: where a worker runs: its research folder always reachable, an untrusted repository reached as an add-dir', () => {
  const base = { code: '/h/worktrees/ar/x', research: '/h/research/x/', addDirs: ['/h/worktrees/briefs'] }
  expect(placement({ ...base, codeTrusted: true, researchTrusted: true })).toEqual({ cwd: '/h/worktrees/ar/x', addDirs: ['/h/worktrees/briefs', '/h/research/x'] })
  // Live: brief-decision-4 was told to read ~/research/<slug>/prompt.txt from
  // a worktree cwd and stopped at "Read outside the working directories".
  expect(placement({ ...base, codeTrusted: false, researchTrusted: true })).toEqual({ cwd: '/h/research/x', addDirs: ['/h/worktrees/ar/x', '/h/worktrees/briefs'], outside: '/h/worktrees/ar/x' })
  expect(placement({ ...base, codeTrusted: false, researchTrusted: false })).toBeUndefined()
  // The cwd itself, or a folder under it, needs no add-dir.
  expect(placement({ code: '/h/research/x', research: '/h/research/x', addDirs: ['/h/research/x/ev', '/h/a/', '/h/a'], codeTrusted: true, researchTrusted: true })).toEqual({ cwd: '/h/research/x', addDirs: ['/h/a'] })
})

test('coord: the worker is told what its tools reach and to ask for anything else; the coordinator never sends it outside them', () => {
  const p = workerPrompt('fix', 'cc-mods-d9', 'x', undefined, { cwd: '/h/research/x', addDirs: ['/h/worktrees/ar/x'], outside: '/h/worktrees/ar/x' })
  expect(p).toContain('Your tools reach `/h/research/x`, `/h/worktrees/ar/x` without a permission dialog')
  expect(p).toContain('do not read it; send the coordinator `QUESTION need <path>`')
  expect(p).toContain('`git -C /h/worktrees/ar/x …`')
  expect(p).toContain(".claude settings (hooks, permissions, MCP servers) do not apply")
  const trusted = workerPrompt('fix', 'cc-mods-d9', 'x', undefined, { cwd: '/w/x', addDirs: ['/h/research/x'] })
  expect(trusted).toContain('QUESTION need <path>')
  expect(trusted).not.toContain('git -C')
  const text = coordSection(on({ workers: [worker({ cwd: '/h/research/x', code: '/h/worktrees/ar/x' })] }), NOW)
  expect(text).toContain('never tell it to read a path outside them')
  expect(text).toContain('put a folder it needs in add_dirs at spawn')
  expect(text).toContain('A repository Claude Code does not trust is not refused')
  expect(text).toContain('/h/research/x (code /h/worktrees/ar/x)')
})
