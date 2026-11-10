// Coordinator mode's rules (hooks/lib/coord.ts): no engine, just functions.
import { expect, test } from 'claude-code/testing'

import { COORD_CAPS, DECISION_BRIEF, TYPED_MS, PANES_FMT, WORKER_CAPS, adoptSlug, applyOps, autoAdopt, closeArgv, foreign, released, unadopt, coordSection, current, parsePending, mergeRepos, policyArgvs, policyOf, emptyLedger, typedLately, typedNote, observe, overlaps, parseLedger, parseLimits, parsePanes, recheck, spawnRefusal, splitPlan, titleArgv, unseen, workerArgv, workerPrompt, type Change, type Ledger, type PaneSeen, type Worker } from '../hooks/lib/coord'
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
  expect(spawnRefusal(on({ limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 4, autoAdopt: true } }), { ...req, model: 'opus' })).toContain('not allowed')
  // A full model id counts as its alias.
  expect(spawnRefusal(on(), { ...req, model: 'claude-opus-5-5' })).toBeUndefined()
  const full = on({ limits: { models: ['sonnet'], maxEffort: 'high', maxWorkers: 1, autoAdopt: true }, workers: [worker({ slug: 'other' })] })
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
  // A choice for the person goes on a decision brief the office can answer,
  // tagged with the coordinator's session id so the answer comes back to it.
  const ask = workerPrompt('fix it', 'cc-mods-d9', 'tmc-layout', undefined, undefined, 'coord-sid')
  expect(ask).toContain('--coordinator coord-sid --worker tmc-layout')
  expect(ask).toContain('QUESTION <one line> — <brief path>')
  expect(ask).toContain('Only a yes/no on one small step that is easy to undo goes as a plain QUESTION')
})

test('coord: a decision brief has a cost cap, the same for the coordinator and its workers', () => {
  // The person asked that a question for them never burns many tokens.
  // keyolk/briefs#2: `brief ask --new` writes the minimal page; HTML by hand
  // only when a figure is truly needed, and then still capped.
  for (const cap of ['`brief ask --new <slug> --context "<background, at most 5 lines>"', 'about 1 KB', 'no HTML written by hand', 'not the full doc:visual-brief workflow', 'At most 4 options', 'under 100 characters', 'only when a figure is truly needed', 'at most one small inline SVG', 'under 8 KB', 'no re-telling of the research'])
    expect(DECISION_BRIEF).toContain(cap)
  expect(workerPrompt('fix', 'cc-mods-d9', 'x', undefined, undefined, 'sid')).toContain(DECISION_BRIEF)
  expect(coordSection(emptyLedger('sid', 'n', NOW), NOW)).toContain(DECISION_BRIEF)
})

test('coord: questions for the person are gathered and asked once; a skill that failed a worker is reported and fixed as its own task', () => {
  const w = workerPrompt('fix', 'cc-mods-d9', 'x', undefined, undefined, 'sid')
  const c = coordSection(emptyLedger('sid', 'n', NOW), NOW)
  // The office's 지휘 view shows decisions; a worker never covers it.
  expect(w).toContain('Never run `brief show`')
  // One occasion per task: open questions found early, asked together.
  expect(w).toContain('list every open question the work raises, and go on with what needs no answer')
  expect(w).toContain('one `brief ask --new` per question (a brief holds one decision), in one `QUESTION` report with every brief path')
  expect(w).toContain('Ask alone and at once only what stops the work entirely')
  expect(c).toContain('say once in chat `결정 N건 대기` with the brief paths, not a message per question')
  expect(c).toContain('Ask alone and at once only what stops a worker entirely')
  // A skill that failed: reported, not silently worked around, and fixed apart.
  expect(w).toContain('`SKILL <skill name>: <the problem in one line> — <evidence: the command and its error, or file:line>`')
  expect(w).toContain('Do not edit the skill here: fixing it is a separate task')
  expect(c).toContain('A report line `SKILL <name>: <problem> — <evidence>`')
  expect(c).toContain('use the meta:self-enhancer or meta:skill-creator skill')
  expect(c).toContain('The worker that hit it does not edit the skill')
})

test('coord: a worker is split off the coordinator\'s pane, the longer side, a third of it; too small either way, a window', () => {
  // Wide: beside it. Tall (cells are about twice as tall as wide): below it.
  expect(splitPlan(200, 50)).toEqual({ dir: '-h', size: 66 })
  expect(splitPlan(100, 60)).toEqual({ dir: '-v', size: 20 })
  // Wide but too narrow for a 60-column worker: below, when 15 rows fit.
  expect(splitPlan(150, 60)).toEqual({ dir: '-v', size: 20 })
  // 60 columns on each side is the least.
  expect(splitPlan(180, 40)).toEqual({ dir: '-h', size: 60 })
  expect(splitPlan(179, 40)).toBeUndefined()
  expect(splitPlan(120, 40)).toBeUndefined()
  expect(splitPlan(0, 0)).toBeUndefined()
  const argv = workerArgv({ target: '%42', split: { dir: '-h', size: 66 }, slug: 'tmc-layout', cwd: '/w/tmc-layout', model: 'sonnet', effort: 'medium', sid: 'u-1', promptFile: '/r/prompt.txt', addDirs: ['/r'] })
  // Detached (the person's keyboard stays), off the coordinator's pane; no
  // window name, no select-layout over the tweb panes and the cockpit.
  expect(argv.slice(0, 12)).toEqual(['split-window', '-d', '-h', '-l', '66', '-P', '-F', '#{window_id} #{pane_id}', '-t', '%42', '-c', '/w/tmc-layout'])
  expect(argv.slice(12, 14)).toEqual(['sh', '-c'])
  expect(argv.slice(15)).toEqual(['worker', 'sonnet', 'medium', 'u-1', 'tmc-layout', '/r/prompt.txt', '--add-dir=/r'])
  expect(argv).not.toContain('-n')
  // Labelled by @title: Claude Code rewrites pane_title over OSC.
  expect(titleArgv('%90', 'tmc-layout')).toEqual(['set', '-p', '-t', '%90', '@title', 'w:tmc-layout'])
})

test('coord: close kills only the pane (or fallback window) the spawn made, never the coordinator\'s own', () => {
  const coord = { pane: '%1', window: '@1' }
  expect(closeArgv(worker({ pane: '%90', window: '@1', made: { kind: 'pane', pane: '%90', window: '@1' } }), coord)).toEqual(['kill-pane', '-t', '%90'])
  // The session moved elsewhere since (pane/window follow it): the recorded pane is still the one.
  expect(closeArgv(worker({ pane: '%77', window: '@7', made: { kind: 'pane', pane: '%90', window: '@1' } }), coord)).toEqual(['kill-pane', '-t', '%90'])
  expect(closeArgv(worker({ made: { kind: 'window', pane: '%91', window: '@9' } }), coord)).toEqual(['kill-window', '-t', '@9'])
  // Never the coordinator's pane, nor the window it is in.
  expect(closeArgv(worker({ made: { kind: 'pane', pane: '%1', window: '@1' } }), coord)).toBeUndefined()
  expect(closeArgv(worker({ made: { kind: 'window', pane: '%91', window: '@1' } }), coord)).toBeUndefined()
  expect(closeArgv(worker({ made: { kind: 'pane', pane: '', window: '@1' } }), coord)).toBeUndefined()
  // A worker from before `made` had its own window; an adopted one is not ours to kill.
  expect(closeArgv(worker({ pane: '%5', window: '@5' }), coord)).toEqual(['kill-window', '-t', '@5'])
  expect(closeArgv(worker({ pane: '%1', window: '@1' }), coord)).toBeUndefined()
  expect(closeArgv(worker({ relation: 'adopted', pane: '%5', window: '@5' }), coord)).toBeUndefined()
})

test('coord: a worker whose pane names another session is not gone while its own session is alive', () => {
  // Live: worker coord-route (pane %386, 96a4ba54) ran `claude -p`; the child
  // (8edc482b) took the pane's @cc_pane_session and the coordinator heard
  // "coord-route: its session is gone" with the worker still at work.
  const l = on({ workers: [worker({ slug: 'coord-route', sid: '96a4ba54', pane: '%386', window: '@1' })] })
  const seen = parsePanes('%386\t@1\t8edc482b\tworking\tnone\t/w/coord-route\t')
  expect(unseen(l, seen, NOW).map((w) => w.sid)).toEqual(['96a4ba54'])
  const kept = observe(l, seen, NOW, new Set(['96a4ba54']))
  expect(kept.changes).toEqual([])
  expect(kept.ledger.workers[0]!.endedAt).toBeUndefined()
  expect(kept.ledger.workers[0]!.pane).toBe('%386')
  // Its session really ended: gone, once.
  const gone = observe(l, seen, NOW, new Set())
  expect(gone.changes.map((c) => c.text)).toEqual(['coord-route: its session is gone (pane closed or claude exited)'])
  // Just started, or already ended: not asked about.
  expect(unseen(on({ workers: [worker({ at: NOW - 5_000 }), worker({ slug: 'b', sid: 'w2', endedAt: NOW })] }), [], NOW)).toEqual([])
})

test('coord: the watch wakes the coordinator for a question, a finished turn and an exit; the person typing is recorded, not told', () => {
  const l = on({ workers: [worker(), worker({ slug: 'b', sid: 'w2' }), worker({ slug: 'c', sid: 'w3' }), worker({ slug: 'fresh', sid: 'w4', at: NOW - 5_000 })] })
  const seen = parsePanes(['%1\t@1\tw1\tworking\task\t/w/tmc-layout\t', '%2\t@2\tw2\tdone\tnone\t/w/b\t' + Math.floor((NOW - 1000) / 1000), ''].join('\n'))
  const { ledger, changes } = observe(l, seen, NOW)
  expect(changes.map((c) => c.slug)).toEqual(['tmc-layout', 'b', 'c'])
  expect(changes[0]!.text).toContain('waiting on an answer')
  expect(changes[1]!.text).toContain('finished its turn')
  expect(changes[2]!.text).toContain('gone')
  expect(changes.some((c) => /send it nothing|typing/.test(c.text))).toBe(false)
  // Just started and not yet published: not counted gone.
  expect(ledger.workers.find((w) => w.slug === 'fresh')!.endedAt).toBeUndefined()
  expect(ledger.workers.find((w) => w.slug === 'c')!.endedAt).toBe(NOW)
  const b = ledger.workers.find((w) => w.slug === 'b')!
  expect(b.typedAt).toBe(NOW - 1000)
  expect(typedLately(b, NOW)).toBe(true)
  expect(typedLately(b, NOW + TYPED_MS)).toBe(false)
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
  const c = (sid: string, kind: 'ask' | 'turn' | 'gone') => ({ slug: sid, sid, kind, text: '', wake: true })
  expect(current(c('w1', 'turn'), l, NOW)).toBe(true)
  expect(current(c('w2', 'gone'), l, NOW)).toBe(true)
  // Working again (the coordinator sent it more): no longer finished.
  expect(current(c('w3', 'turn'), l, NOW)).toBe(false)
  expect(current(c('w3', 'ask'), l, NOW)).toBe(false)
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
  expect(l.limits).toEqual({ models: ['haiku', 'sonnet', 'opus'], maxEffort: 'high', maxWorkers: 4, autoAdopt: true })
  expect(l.workers.length).toBe(1)
  expect(parseLedger('{oops', 'sid', 'n', NOW).on).toBe(false)
  const text = coordSection(l, NOW)
  expect(text).toContain('`n`, the coordinator')
  expect(text).toContain('| a | owned |')
  // The office's two prompts are named, so the coordinator knows what to do with them.
  expect(text).toContain('`brief ask <brief>`')
  // A decision is shown on a brief by default; chat alone only for a small yes/no.
  expect(text).toContain('the default is a decision brief, not a question in chat alone')
  expect(text).toContain('`--coordinator sid`')
  // Live: `brief show` covered the office's pane and its controls.
  expect(text).toContain('while the office is up (`curl -sf http://localhost:8796/` answers), never run `brief show`')
  expect(text).toContain('In chat write one line and the brief path')
  expect(text).toContain('Only a yes/no on one small step that is easy to undo')
  expect(text).toContain('do not ask it again')
  expect(text).toContain('[brief answer]')
  expect(text).toContain('Every task goes to another Claude session, however small')
  expect(text).toContain('[office→coord]')
  // The office's box is the person saying "you pick": never asked back where it goes.
  expect(text).toContain("hand it out at once with `coord_route`")
  expect(text).toContain('never ask the person where it goes')
  expect(text).toContain('spawn in the most plausible repository and report the reason in one line')
  expect(text).toContain('Never ask the person where a task goes')
  expect(text).not.toContain('Ask the person where a task goes only when')
  expect(text).toContain("`[office→coord] (re: <brief file>, worker <slug>) <text>`")
  expect(text).toContain('when it names no worker or that worker is gone, `coord_route` it')
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
  const first = observe(l, seen, NOW)
  expect(first.changes).toEqual([])
  expect(first.ledger.workers[0]!.typedAt).toBeUndefined()
  const later = parsePanes('%1\t@1\tw1\tworking\tnone\t/w/tmc-layout\t' + Math.floor((NOW + 60_000) / 1000))
  expect(observe(l, later, NOW + 61_000).ledger.workers[0]!.typedAt).toBe(NOW + 60_000)
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

// ---- auto-adopt: every live session is a worker while the mode is on ------

const live = (sid: string, over: Partial<PaneSeen> = {}): PaneSeen => ({ pane: '%' + sid, window: '@1', sid, state: 'done', attention: 'none', cwd: '/src/' + sid, ...over })

test('coord: with the mode on every live session is adopted, but not itself, a worker it has, or one it handed back', () => {
  const l = on({ workers: [worker({ sid: 'w1' })], released: ['gone-back'] })
  const seen = [live('coord-sid'), live('w1'), live('ops'), live('ops'), live('gone-back'), live('x9abcdef')]
  const { ledger: next, adopted } = autoAdopt(l, seen, new Map([['ops', 'ops-k8s']]), new Set(), NOW)
  expect(adopted.map((w) => [w.slug, w.sid, w.relation, w.auto])).toEqual([['ops-k8s', 'ops', 'adopted', true], ['x9abcdef', 'x9abcdef', 'adopted', true]])
  expect(adopted[0]).toMatchObject({ pane: '%ops', cwd: '/src/ops', at: NOW })
  expect(next.workers.length).toBe(3)
  expect(next.log.at(-1)).toMatchObject({ kind: 'adopt', text: 'auto: ops-k8s (%ops), x9abcdef (%x9abcdef)' })
  // Nothing new: the very same ledger, so the mod does not save.
  expect(autoAdopt(next, seen, new Map(), new Set(), NOW + 1).ledger).toBe(next)
  // Off, or the mode off: nothing.
  expect(autoAdopt(on({ limits: { ...on().limits, autoAdopt: false } }), seen, new Map(), new Set(), NOW).adopted).toEqual([])
  expect(autoAdopt({ ...l, on: false }, seen, new Map(), new Set(), NOW).adopted).toEqual([])
})

test('coord: another coordinator that is on, and its owned workers, are not adopted', () => {
  const other = JSON.stringify({ on: true, sid: 'c2', workers: [{ slug: 'a', sid: 'c2w', relation: 'owned' }, { slug: 'b', sid: 'c2old', endedAt: 1 }, { slug: 'c', sid: 'c2ad', relation: 'adopted' }, { slug: 'd', sid: 'c2legacy' }] })
  const skip = foreign([other, JSON.stringify({ on: false, sid: 'c3', workers: [{ slug: 'z', sid: 'c3w' }] }), '{oops', JSON.stringify({ on: true, sid: 'coord-sid' })], 'coord-sid')
  // A worker from before `relation` was written is owned, as the office reads it.
  expect([...skip].sort()).toEqual(['c2', 'c2legacy', 'c2w'])
  const { adopted } = autoAdopt(on(), ['c2', 'c2w', 'c2old', 'c2ad', 'c3', 'c3w'].map((s) => live(s)), new Map(), skip, NOW)
  expect(adopted.map((w) => w.sid)).toEqual(['c2old', 'c2ad', 'c3', 'c3w'])
  // One adopted before it turned coordinator is dropped while still quiet;
  // one the coordinator has instructed stays.
  const l = on({ workers: [worker({ sid: 'c2', slug: 'c2', relation: 'adopted', auto: true }), worker({ sid: 'c2w', slug: 'c2w', relation: 'adopted', auto: true, instructed: NOW - 5 })] })
  expect(autoAdopt(l, [], new Map(), skip, NOW).ledger.workers.map((w) => w.sid)).toEqual(['c2w'])
})

test('coord: a slug from the session name, SLUG-shaped and unique among the active workers', () => {
  expect(adoptSlug('ops-k8s', 'abcd1234', new Set())).toBe('ops-k8s')
  expect(adoptSlug('My Session!', 'abcd1234', new Set())).toBe('my-session')
  expect(adoptSlug(undefined, 'ABCD1234-ffff', new Set())).toBe('abcd1234')
  expect(adoptSlug('--', 'abcd1234', new Set())).toBe('abcd1234')
  expect(adoptSlug('ops-k8s', 'abcd1234', new Set(['ops-k8s']))).toBe('ops-k8s-abcd')
  expect(adoptSlug('ops-k8s', 'abcd1234', new Set(['ops-k8s', 'ops-k8s-abcd']))).toBe('ops-k8s-abcd1')
  expect(adoptSlug('x'.repeat(60), 'abcd1234', new Set(['x'.repeat(40)]))).toMatch(/^x{34}-abcd$/)
  // Two sessions with one name, adopted in one pass.
  const { adopted } = autoAdopt(on(), [live('s1aaaaaa'), live('s2bbbbbb')], new Map([['s1aaaaaa', 'cc-mods'], ['s2bbbbbb', 'cc-mods']]), new Set(), NOW)
  expect(adopted.map((w) => w.slug)).toEqual(['cc-mods', 'cc-mods-s2bb'])
})

test('coord: the office asks a release and this coordinator applies it to its own ledger', () => {
  const w = worker({ slug: 'ops-k8s', sid: 'ops', relation: 'adopted', auto: true })
  const l = on({ workers: [w, worker({ slug: 'mine', sid: 'w2' })] })
  const raw = JSON.stringify({ ops: [{ op: 'release', sid: 'ops', slug: 'ops-k8s', at: 1 }, { op: 'release', sid: 'nobody' }, { op: 'close', sid: 'w2' }, 7] })
  const { ledger, done } = applyOps(l, raw, NOW)
  expect(done).toEqual(['ops-k8s'])
  expect(ledger.released).toEqual(['ops'])
  expect(ledger.workers.map((x) => [x.slug, x.endedAt])).toEqual([['ops-k8s', NOW], ['mine', undefined]])
  // A half-written or empty file asks nothing.
  for (const bad of ['{half', undefined, '{}', '{"ops": 3}']) expect(applyOps(l, bad, NOW)).toEqual({ ledger: l, done: [] })
})

test('coord: a session handed back is never adopted again, until the person adopts it', () => {
  const w = worker({ slug: 'ops-k8s', sid: 'ops', relation: 'adopted', auto: true })
  const l = released(on({ workers: [w] }), w, NOW)
  expect(l.workers[0]!.endedAt).toBe(NOW)
  expect(l.released).toEqual(['ops'])
  expect(l.log.at(-1)).toMatchObject({ kind: 'release', text: 'ops-k8s' })
  expect(autoAdopt(l, [live('ops')], new Map(), new Set(), NOW + 60_000).adopted).toEqual([])
  // Recorded once, and kept across a save.
  expect(released(l, w, NOW + 1).released).toEqual(['ops'])
  expect(parseLedger(JSON.stringify({ ...l, released: ['ops', 7] }), 'coord-sid', 'n', NOW).released).toEqual(['ops'])
  // The ended quiet entry itself is dropped at the next pass.
  expect(autoAdopt(l, [live('new')], new Map(), new Set(), NOW).ledger.workers.map((x) => x.sid)).toEqual(['new'])
})

test('coord: adopted sessions never count toward the worker limit; only owned ones do', () => {
  const lim = { ...on().limits, maxWorkers: 1 }
  const many = autoAdopt(on({ limits: lim }), ['a1', 'a2', 'a3', 'a4', 'a5'].map((s) => live(s)), new Map(), new Set(), NOW).ledger
  expect(many.workers.length).toBe(5)
  expect(spawnRefusal(many, req)).toBeUndefined()
  expect(spawnRefusal({ ...many, workers: [...many.workers, worker({ slug: 'mine', sid: 'm1' })] }, req)).toContain('already 1 workers')
})

test('coord: /coord limits adopt on|off; a ledger from before the setting adopts; off sends the quiet ones back to observed', () => {
  const cur = on().limits
  expect(cur.autoAdopt).toBe(true)
  expect(parseLimits('adopt off', cur)).toEqual({ ...cur, autoAdopt: false })
  expect(parseLimits('adopt on', { ...cur, autoAdopt: false })).toEqual(cur)
  expect(parseLimits('adopt maybe', cur)).toBe('adopt: on or off')
  expect(parseLedger(JSON.stringify({ on: true, limits: { maxWorkers: 2 } }), 's', 'n', NOW).limits.autoAdopt).toBe(true)
  expect(parseLedger(JSON.stringify({ on: true, limits: { autoAdopt: false } }), 's', 'n', NOW).limits.autoAdopt).toBe(false)
  const l = on({ workers: [worker({ slug: 'q', sid: 'q', relation: 'adopted', auto: true }), worker({ slug: 't', sid: 't', relation: 'adopted', auto: true, instructed: NOW - 1 }), worker({ slug: 'h', sid: 'h', relation: 'adopted' }), worker()] })
  const off = unadopt(l, NOW)
  expect(off.workers.map((w) => w.slug)).toEqual(['t', 'h', 'tmc-layout'])
  expect(off.released).toEqual([])
  expect(unadopt(off, NOW)).toBe(off)
  expect(coordSection(on({ limits: { ...cur, autoAdopt: false } }), NOW)).toContain('/coord limits adopt off')
  const text = coordSection(on({ workers: [worker({ slug: 'q', sid: 'q', relation: 'adopted', auto: true })] }), NOW)
  expect(text).toContain('Every live session is your adopted worker')
  expect(text).toContain("Adopted, the person's (not instructed yet; coord_roster has their state): q /w/tmc-layout.")
  expect(text).toContain('No workers yet.')
  const told = coordSection(on({ workers: [worker({ slug: 'q', sid: 'q', relation: 'adopted', auto: true, instructed: NOW })] }), NOW)
  expect(told).toContain('| q | adopted (auto) |')
  expect(told).not.toContain("Adopted, the person's")
  expect(text).toContain('4 owned workers; auto-adopt on.')
})

test('coord: the person typing in an auto-adopted session is only noted; its own work wakes nobody until the coordinator instructs it', () => {
  const t = (ms: number) => String(Math.floor(ms / 1000))
  // Typed 2 minutes before it was adopted: noted for the rest of TYPED_MS.
  const [a] = autoAdopt(on(), parsePanes('%7\t@1\tops\tdone\tnone\t/src/ops\t' + t(NOW - 120_000)), new Map(), new Set(), NOW).adopted
  expect(a!.typedAt).toBe(NOW - 120_000)
  expect(typedLately(a!, NOW)).toBe(true)
  expect(typedNote(a!, NOW)).toBe(' Note: the person typed in this pane lately (' + new Date(NOW - 120_000).toTimeString().slice(0, 5) + ', 2 min ago); their draft is not touched.')
  expect(typedNote(a!, NOW - 120_000 + TYPED_MS)).toBe('')
  // Typed again after adoption, even within the first minute: recorded, no change at all.
  const l = on({ workers: [{ ...a!, typedAt: undefined }] })
  const r = observe(l, parsePanes('%7\t@1\tops\tworking\tnone\t/src/ops\t' + t(NOW + 5_000)), NOW + 6_000)
  expect(r.changes).toEqual([])
  expect(r.ledger.workers[0]!.typedAt).toBe(NOW + 5_000)
  // Its turns end silently, its asks do not wake; gone does not wake either.
  const busy = on({ workers: [{ ...a!, state: 'working', typedAt: undefined }] })
  expect(observe(busy, parsePanes('%7\t@1\tops\tdone\tnone\t/src/ops\t'), NOW + 600_000).changes).toEqual([])
  expect(observe(busy, parsePanes('%7\t@1\tops\twaiting\task\t/src/ops\t'), NOW + 600_000).changes).toEqual([expect.objectContaining({ kind: 'ask', wake: false })])
  expect(observe(busy, [], NOW + 600_000).changes).toEqual([expect.objectContaining({ kind: 'gone', wake: false })])
  // Instructed once: its turns are news.
  const told = on({ workers: [{ ...a!, state: 'working', typedAt: undefined, instructed: NOW + 1 }] })
  expect(observe(told, parsePanes('%7\t@1\tops\tdone\tnone\t/src/ops\t'), NOW + 600_000).changes).toEqual([expect.objectContaining({ kind: 'turn', wake: true })])
  // Handed over by the person (/coord adopt): wakes as before.
  const manual = on({ workers: [{ ...a!, auto: undefined, state: 'working', typedAt: undefined }] })
  expect(observe(manual, parsePanes('%7\t@1\tops\tdone\tnone\t/src/ops\t'), NOW + 600_000).changes).toEqual([expect.objectContaining({ kind: 'turn', wake: true })])
})
