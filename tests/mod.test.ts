// Engine-backed tests for the hooks module. Run with `claude plugin test`
// (needs the hooks-modules rollout on; `bun test` skips this file).
import { expect, mock, test } from 'claude-code/testing'

// Common stubs for what session.start touches.
const TEST_ORG = JSON.stringify({
  slack: { team: 'acme', defaultTargets: { C0123ABCD45: '#team-pr-review' } },
  jira: { baseUrl: 'https://acme.atlassian.net', projects: ['ABC', 'INF', 'SECURE', 'OPS'] },
  github: { accounts: { keyolk: 'keyolk', acme: 'work-login', 'acme-ai': 'work-login', 'work-login': 'work-login' } },
  stacks: [{ name: 'Edge', prefixes: ['edge'] }, { name: 'Main', prefixes: ['cloud', 'main', 'prod', 'terraform-runner', 'atlantis', 'sops'] }],
  awsSsoProfiles: ['cloud', 'edge', 'terraform', 'atlantis', 'sops'],
  awsSsoStartUrl: 'https://d-1234567890.awsapps.com/start',
  argocdDomains: { 'tools.acme.io': '', 'edge.acme.io': ' (edge)' },
})

function baseStubs(on: any, opts: { pane?: string; policyJson?: string; policyBox?: { json: string }; files?: Record<string, string>; written?: Record<string, string>; run?: (argv: string[]) => { code: number; out: string } | undefined; runs?: string[][]; store?: Record<string, unknown>; route?: string | (() => string); fork?: string; windows?: string; reach?: () => boolean; submitted?: string[]; toasts?: string[]; usage?: (argv: string[]) => { code: number; out: string; err?: string }; status?: string; goal?: unknown; attention?: (req: any) => unknown; mtime?: (path: string) => number | undefined } = {}) {
  const runs = opts.runs ?? []
  on('session.start', () => ({ cwd: '/work' }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/u' : e.name === 'TMUX_PANE' ? opts.pane : undefined }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('command.register', () => ({ value: undefined }))
  const store = opts.store
  on('store.get', (_$: any, e: any) => ({ value: store?.[e.key] }))
  on('store.set', (_$: any, e: any) => {
    if (store) store[e.key] = e.value
    return { value: undefined }
  })
  const policyText = () => opts.policyBox?.json ?? opts.policyJson
  // The made-up organisation the lib tests use (lib/org.ts), unless a test
  // brings its own org.json.
  const fileFor = (path: string) => {
    const own = Object.entries(opts.files ?? {}).find(([k]) => path.endsWith(k))?.[1]
    return own ?? (path.endsWith('.config/cc-mods/org.json') ? TEST_ORG : undefined)
  }
  on('fs.exists', (_$: any, e: any) => ({ value: fileFor(e.path) !== undefined || (!!policyText() && e.path.endsWith('sid-1.json')) }))
  on('fs.read', (_$: any, e: any) => ({ value: fileFor(e.path) ?? policyText() ?? '' }))
  // A policy file's mtime follows its text, so a rewrite shows as a change.
  on('fs.stat', (_$: any, e: any) => ({ value: e.path.endsWith('sid-1.json') ? { mtimeMs: (policyText() ?? '').length } : { mtimeMs: opts.mtime?.(e.path) ?? 1 } }))
  on('fs.write', (_$: any, e: any) => {
    if (opts.written) opts.written[e.path] = String(e.data ?? e.text ?? e.content ?? '')
    return { value: undefined }
  })
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    const own = opts.run?.(e.argv)
    if (own) return { value: { exitCode: own.code, stdout: own.out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (opts.status !== undefined && e.argv[0] === 'ccproxy' && e.argv[1] === 'status') {
      return { value: { exitCode: 0, stdout: opts.status, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (opts.usage && e.argv[0] === 'ccproxy' && e.argv[1] === 'usage') {
      const u = opts.usage(e.argv)
      return { value: { exitCode: u.code, stdout: u.out, stderr: u.err ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (opts.fork !== undefined && String(e.argv[1] ?? '').endsWith('cc-bridge.py') && e.argv[2] === 'fork') return { value: { exitCode: 0, stdout: opts.fork, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (opts.route !== undefined && e.argv.at(-1) === 'route') return { value: { exitCode: 0, stdout: typeof opts.route === 'function' ? opts.route() : opts.route, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (opts.reach && e.argv[0] === '/usr/bin/curl') return { value: { exitCode: opts.reach() ? 0 : 28, stdout: opts.reach() ? '404' : '000', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (opts.windows !== undefined && e.argv[0] === 'tmux' && e.argv[1] === 'list-windows' && String(e.argv.at(-1)).includes('@cc_attention')) return { value: { exitCode: 0, stdout: opts.windows, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: 'git@github.com:keyolk/cc-mods.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (opts.goal !== undefined && String(e.argv[1] ?? '').endsWith('cc-bridge.py') && e.argv[2] === 'goal') return { value: { exitCode: 0, stdout: JSON.stringify(opts.goal), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (String(e.argv[1] ?? '').endsWith('cc-bridge.py') && e.argv[2] === 'jev_usage') {
      const jev = {
        today: { calls: 12, cost: 0.0016, in: 3400 }, week: { calls: 40, cost: 0.0052, in: 9900 }, session: { calls: 5, cost: 0.0007, in: 900, p50: 610, p95: 820 },
        hours: Array.from({ length: 24 }, (_, i) => ({ start: 1791900000 + i * 3600, calls: i % 3, cost: 0.0001, ms: 600 })),
        kinds: [{ name: 'ask', calls: 30, cost: 0.004, p50: 650, p95: 850 }, { name: 'choose', calls: 10, cost: 0.0012, p50: 620, p95: 730 }],
        callers: [{ name: 'flow_fork_hint.py', calls: 30, cost: 0.004, today: 9, kinds: { ask: 30 }, p50: 640, p95: 840 }, { name: 'cc-bridge:route', calls: 10, cost: 0.0012, today: 3, kinds: { choose: 10 }, p50: 620, p95: 730 }], gateway: { requests: 3839, cost: 1.0036, since: '2026-10-07' } }
      return { value: { exitCode: 0, stdout: JSON.stringify(jev), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (opts.attention && String(e.argv[1] ?? '').endsWith('cc-bridge.py') && e.argv[2] === 'attention') return { value: { exitCode: 0, stdout: JSON.stringify(opts.attention(JSON.parse(e.init?.stdin ?? '{}'))), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (String(e.argv[1] ?? '').endsWith('cc-bridge.py')) return { value: { exitCode: 0, stdout: '{"attention":"ask"}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$: any, e: any) => {
    opts.toasts?.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', (_$: any, e: any) => {
    opts.submitted?.push(e.text)
    return { text: e.text }
  })
  return runs
}

test('Claude cannot self-grant session policy through Bash', async ($, on) => {
  baseStubs(on)
  on('tool.call', () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'python3 ~/.claude/hooks/session_policy.py allow gh_merge' })
  expect(r.deny).toMatch(/only the user/)
  const ok: any = await $.tool.call({ tool: 'Bash', command: 'python3 ~/.claude/hooks/session_policy.py show' })
  expect(ok.result.stdout).toBe('ran')
})

test('/policy changes only from the person, through the CLI with the session id', async ($, on) => {
  const runs = baseStubs(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const fromPlugin: any = await $.command.run({ command: 'policy', args: 'allow merge', origin: { kind: 'plugin', name: 'x' } } as any)
  expect(fromPlugin.text).toMatch(/typed by a person/)
  expect(runs.some((a) => a.includes('allow'))).toBe(false)
  await $.command.run({ command: 'policy', args: 'allow merge acme/infra-k8s', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  const call = runs.find((a) => a.includes('allow'))
  expect(call?.slice(-4)).toEqual(['allow', 'gh_merge', '--repo', 'acme/infra-k8s'])
})

test('a turn publishes working, then the classified attention, on this pane only', async ($, on) => {
  const runs = baseStubs(on, { pane: '%42' })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'do the thing please, it is long enough', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 't1', text: 'do the thing please, it is long enough' })
  await $.turn.complete({ turnId: 't1', answer: '머지해 주실래요?', durationMs: 5, isAborted: false, usage: null } as any)
  const tmux = runs.filter((a) => a[0] === 'tmux')
  expect(tmux.every((a) => a.includes('%42'))).toBe(true)
  const states = tmux.filter((a) => a.includes('@cc_state')).map((a) => a[a.length - 1])
  expect(states).toEqual(['working', 'waiting'])
  expect(tmux.some((a) => a.includes('@cc_attention') && a[a.length - 1] === 'ask')).toBe(true)
})

test('auto_continue answers a plain proceed question after a pause the person can type over', async ($, on) => {
  const submitted: string[] = []
  const asked: any[] = []
  // Jev's stand-in: "go on?" only for a local step, and only when asked to judge it.
  const attention = (req: any) => (asked.push(req), { attention: 'ask', proceed: !!req.proceed && /고칠까요/.test(req.message) })
  const runs = baseStubs(on, { pane: '%42', submitted, attention, policyJson: JSON.stringify({ mode: 'autopilot', capabilities: { auto_continue: 'allow' } }) })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'fix the flaky test please', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 't1', text: 'fix the flaky test please' })
  await $.turn.complete({ turnId: 't1', answer: '원인을 찾았습니다.\n\n이어서 테스트도 고칠까요?', durationMs: 5, isAborted: false, usage: null } as any)
  const states = runs.filter((a) => a[0] === 'tmux' && a.includes('@cc_state')).map((a) => a[a.length - 1])
  expect(states.at(-1)).toBe('working')
  expect(submitted.filter((t) => t.includes('auto_continue'))).toEqual([])
  await clock.advance(3_000)
  expect(submitted.filter((t) => t.includes('auto_continue')).length).toBe(1)
  expect(asked[0].proceed).toBe(true)

  // Jev says it is more than "go on?" (a merge): it stays the person's.
  await $.turn.start({ turnId: 't2', text: 'x' })
  await $.turn.complete({ turnId: 't2', answer: 'PR이 green입니다. 머지할까요?', durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(5_000)
  expect(submitted.filter((t) => t.includes('auto_continue')).length).toBe(1)

  // The person typing first cancels the pending answer.
  await $.turn.start({ turnId: 't3', text: 'x' })
  await $.turn.complete({ turnId: 't3', answer: '다음 파일도 고칠까요?', durationMs: 5, isAborted: false, usage: null } as any)
  await $.prompt.submit({ text: '잠깐, 그건 두자', origin: { kind: 'composer' }, wait: false } as any)
  await clock.advance(5_000)
  expect(submitted.filter((t) => t.includes('auto_continue')).length).toBe(1)
})

test('without auto_continue a proceed question waits for the person', async ($, on) => {
  const submitted: string[] = []
  const asked: any[] = []
  baseStubs(on, { pane: '%42', submitted, attention: (req: any) => (asked.push(req), { attention: 'ask', proceed: !!req.proceed }) })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'x' })
  await $.turn.complete({ turnId: 't1', answer: '이어서 테스트도 고칠까요?', durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(5_000)
  expect(asked.at(-1).proceed).toBe(false)
  expect(submitted.filter((t) => t.includes('auto_continue'))).toEqual([])
})

test('outside tmux nothing is published', async ($, on) => {
  const runs = baseStubs(on)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'x' })
  expect(runs.filter((a) => a[0] === 'tmux')).toEqual([])
})

const COCKPIT = {
  plugin: 'cc-mods',
  component: 'Pane',
  requestId: 'cc-cockpit',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'cockpit', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('office: a reply left for this session from the office goes in as the person\'s prompt, once; a stale one is dropped', async ($, on) => {
  const submitted: string[] = []
  const files: Record<string, string> = {}
  const runs = baseStubs(on, { pane: '%42', submitted, files, run: (a) => (a[0] === 'rm' ? (delete files[a.at(-1)!.replace(/^.*\/\.claude\//, '.claude/')], { code: 0, out: '' }) : undefined) })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  files['.claude/state/office/inbox/sid-1.json'] = JSON.stringify({ text: '1번으로 해 주세요', at: Date.now() / 1000 })
  await clock.advance(2_100)
  expect(submitted).toContain('1번으로 해 주세요')
  expect(runs.some((a) => a[0] === 'rm' && String(a.at(-1)).endsWith('/.claude/state/office/inbox/sid-1.json'))).toBe(true)
  await clock.advance(4_100)
  expect(submitted.filter((t) => t === '1번으로 해 주세요')).toHaveLength(1)
  files['.claude/state/office/inbox/sid-1.json'] = JSON.stringify({ text: 'old', at: Date.now() / 1000 - 600 })
  await clock.advance(2_100)
  expect(submitted).not.toContain('old')
})

test('the policy pane draws a row per capability and applies a mode', async ($, on) => {
  const runs = baseStubs(on, { policyJson: JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' } }) })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-policy' })
  expect(await ui.find({ key: 'cap-gh_merge' })).toBeDefined()
  expect(await ui.find({ key: 'cap-tmux_window_escape' })).toBeDefined()
  await ui.press({ key: 'mode-pr-merge' })
  expect(runs.some((a) => a.slice(-2).join(' ') === 'mode pr-merge')).toBe(true)
  await ui.unmount()
})

test('god mode: one press allows every capability after a confirm, and the policy from before comes back when it ends or on its time', async ($, on) => {
  const box = { json: JSON.stringify({ mode: 'pr-merge', capabilities: {}, gh_merge_repos: ['acme/infra'] }) }
  const runs = baseStubs(on, { policyBox: box })
  const answers = ['cancel', 'allow everything', 'allow everything']
  // $.ui.ask is AskUserQuestion's tool.call: the person's choice comes back as its answer.
  on('tool.call', (_$: any, e: any) => (e.tool === 'AskUserQuestion' ? ({ result: { answers: { [e.questions?.[0]?.question ?? '']: answers.shift() } } } as any) : ({ result: {} } as any)))
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-policy' })
  const policyRuns = () => runs.filter((a) => String(a[1] ?? '').endsWith('session_policy.py')).map((a) => a.slice(2).join(' '))
  // Cancelled: nothing changes.
  await ui.press({ key: 'god-30' })
  expect(policyRuns().filter((a) => a.startsWith('allow'))).toEqual([])
  await ui.press({ key: 'god-30' })
  for (const cap of ['gh_merge', 'prod_eks_access', 'prod_eks_write', 'slack_send', 'tmux_window_escape']) expect(policyRuns()).toContain('allow ' + cap)
  // The guard file now says everything is allowed.
  box.json = JSON.stringify({ mode: 'custom', capabilities: Object.fromEntries(['gh_merge', 'prod_eks_access', 'prod_eks_write', 'slack_send', 'auto_continue', 'auto_effort', 'auto_model', 'tmux_window_escape'].map((c) => [c, 'allow'])) })
  await clock.advance(30_000)
  expect(JSON.stringify(await ui.drawn())).toContain('GOD MODE · everything allowed')
  // Ended by the person: the mode and the scope from before are put back.
  const n = policyRuns().length
  await ui.press({ key: 'god-off' })
  expect(policyRuns().slice(n)).toEqual(['mode pr-merge', 'allow gh_merge --repo acme/infra'])
  // The stub CLI does not write: the file says what the restore made it.
  box.json = JSON.stringify({ mode: 'pr-merge', capabilities: {}, gh_merge_repos: ['acme/infra'] })
  await clock.advance(30_000)
  expect(JSON.stringify(await ui.drawn())).not.toContain('GOD MODE · everything allowed')
  // Again, and left alone: it ends by itself after its minutes.
  await ui.press({ key: 'god-15' })
  expect(policyRuns().filter((a) => a === 'allow prod_eks_write')).toHaveLength(2)
  const m = policyRuns().length
  await clock.advance(15 * 60_000 + 10)
  expect(policyRuns().slice(m)).toEqual(['mode pr-merge', 'allow gh_merge --repo acme/infra'])
  await ui.unmount()
})

test('a scope the policy guard blocked is offered on the Policy tab and granted with one press', async ($, on) => {
  const runs = baseStubs(on, { policyJson: JSON.stringify({ mode: 'custom', capabilities: { prod_eks_write: 'block' } }) })
  const deny = 'BLOCKED by session policy: prod_eks_write=block.\n(e.g. `/policy allow prod-w main-prod-apne2/kube-system 15m`).'
  on('tool.call', () => ({ deny }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'kube' + 'ctl --context main-prod-apne2 -n kube-system delete pod x', description: 'x' } as any).catch(() => undefined)
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-policy' })
  await ui.press({ key: 'hint-prod_eks_write-main-prod-apne2/kube-system' })
  expect(runs.some((a) => a.slice(-4).join(' ') === 'allow prod_eks_write --scope main-prod-apne2/kube-system')).toBe(true)
  await ui.unmount()
})

test('a call the policy refused runs again by itself once a /policy grant covers it', async ($, on) => {
  const box = { json: JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' } }) }
  const submitted: string[] = []
  baseStubs(on, { policyBox: box, submitted })
  const deny = 'BLOCKED by session policy: gh_merge is not allowed in this session.\nTarget repo: keyolk/tweb\n(e.g. `/policy allow merge keyolk/tweb`).'
  on('tool.call', () => ({ deny }))
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  on('classic.UserPromptSubmit', () => ({}) as any)
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 'm1', text: 'merge it' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 169 --repo keyolk/tweb --squash', description: 'x' } as any).catch(() => undefined)
  await $.turn.complete({ turnId: 'm1', answer: 'merge is blocked; run /policy allow merge keyolk/tweb', durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(1000)
  // An unrelated grant does nothing.
  box.json = JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' }, gh_merge_repos: ['keyolk/other'] })
  await clock.advance(11_000)
  expect(submitted.filter((t) => t.includes('세션 정책이 바뀌어'))).toEqual([])
  // The grant that covers it: picked up from the file and continued, once.
  box.json = JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' }, gh_merge_repos: ['keyolk/other', 'keyolk/tweb'] })
  await clock.advance(11_000)
  const resumed = submitted.filter((t) => t.includes('세션 정책이 바뀌어'))
  expect(resumed.length).toBe(1)
  expect(resumed[0]).toContain('gh pr merge 169 --repo keyolk/tweb --squash')
  await clock.advance(30_000)
  expect(submitted.filter((t) => t.includes('세션 정책이 바뀌어')).length).toBe(1)
  // Every later prompt reloads the policy (classic.UserPromptSubmit): the
  // resumed block is gone, so none of them resumes it again. Live, one grant
  // resumed the merge four times before this.
  for (const text of ['merged?', 'install it', 'status']) {
    await $.classic.UserPromptSubmit({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-1', transcript_path: '', cwd: '/work', prompt: text } as any)
    await clock.advance(1000)
  }
  box.json = JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'allow' } })
  await clock.advance(11_000)
  expect(submitted.filter((t) => t.includes('세션 정책이 바뀌어')).length).toBe(1)
})

test('an out-of-band policy grant is in the very next composed prompt', async ($, on) => {
  const box = { json: JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' } }) }
  baseStubs(on, { policyBox: box })
  mock.clock(on)
  on('classic.UserPromptSubmit', () => ({}) as any)
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })

  box.json = JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' }, gh_merge_repos: ['keyolk/narwhal'] })
  await $.classic.UserPromptSubmit({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-1', transcript_path: '', cwd: '/work', prompt: 'done' } as any)
  const composed: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: ['Bash'], outputStyle: null, traits: [] })
  const policy = composed.sections.find((s: any) => s.id === 'cc-mods:policy')?.text ?? ''
  expect(policy).toContain('gh_merge scoped-allow: keyolk/narwhal')
})

test('outputs collected from a tool call show in the outputs pane', async ($, on) => {
  baseStubs(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg123' } }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 9', description: 'wait a bit', run_in_background: true } as any)
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-outputs' })
  expect(await ui.find({ key: 'out-bg:bg123' })).toBeDefined()
  await ui.unmount()
})

test('a folder the session archives into under ~/exp is linked: Needs you shows what it owes and a changed attachment; a press opens it in In/Out', async ($, on) => {
  const dir = '/home/u/exp/2026-10-14_vendor_17043'
  const runs = baseStubs(on, {
    pane: '%42',
    files: {
      [dir + '/README.md']: '# Vendor ticket\n\n## Open\n- Attachments promised on 2026-10-21 — not delivered yet.\n',
      [dir + '/correspondence.md']: '| time | dir | who | link | gist | files |\n|---|---|---|---|---|---|\n| 10-22 05:43 | in | Sam | l | asks for DEBUG logs | — |\n',
    },
    run: (argv) => (argv[0] === 'sh' && argv.at(-1) === dir + '/attachments' ? { code: 1, out: 'a.gz: OK\nb.csv: FAILED\n--ls\nSHA256SUMS\na.gz\nb.csv\n' } : undefined),
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Write', file_path: dir + '/attachments/b.csv', content: 'x' } as any)
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  const row = 'home-exp-' + dir
  expect(await ui.find({ key: row })).toBeDefined()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('1 open · ⚠ 1 changed')
  expect(drawn).toContain('Attachments promised')
  expect(runs.some((a) => a[0] === 'sh' && a.at(-1) === dir + '/attachments')).toBe(true)
  await ui.press({ key: row })
  expect(await ui.find({ key: 'out-exp:' + dir })).toBeDefined()
  const pane = JSON.stringify(await ui.drawn())
  expect(pane).toContain('changed or missing')
  expect(pane).toContain('asks for DEBUG logs')
  await ui.unmount()
})

test('flow pane shows the prompt and the conclusion, not tool calls', async ($, on) => {
  baseStubs(on)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  mock.clock(on)
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'why is the band red', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 't1', text: 'why is the band red' })
  await $.turn.complete({ turnId: 't1', answer: 'MCP needs-auth 항목 때문이었습니다.\n\n## 원인 확인 결과\n4건 모두 미사용입니다.', durationMs: 5, isAborted: false, usage: null } as any)
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-flow' })
  expect(await ui.find({ key: 'flow-0' })).toBeDefined()
  expect(await ui.find({ key: 'flow-1' })).toBeDefined()
  await ui.unmount()
})

test('the cockpit tabs draw a valid tree on terminal and desktop', async ($, on) => {
  baseStubs(on, { policyJson: JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'allow' }, gh_merge_repos: [] }) })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  on('store.keys', () => ({ value: [] }))
  mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'draw everything please', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 't1', text: 'draw everything please' })
  await $.turn.complete({ turnId: 't1', answer: '결론입니다.\n\n## 원인 확인 결과\n3건입니다.\n\n추천합니다.', durationMs: 5, isAborted: false, usage: null } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...COCKPIT, surface } as any)
    expect(await ui.find({ type: 'Text', text: 'cockpit' })).toBeDefined()
    // Now groups what is in progress and this session; every tab is one press away and
    // keeps the tab row, so there is no drill-in to back out of.
    expect(await ui.find({ key: 'group-now' })).toBeDefined()
    expect(await ui.find({ key: 'group-session' })).toBeDefined()
    const holds: Record<string, string[]> = { flow: ['Side questions'], graph: ['Watch'], outputs: [], policy: ['Auth'] }
    for (const [id, parts] of Object.entries(holds)) {
      await ui.press({ key: 'cockpit-' + id })
      for (const t of parts) expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
      for (const t of ['cockpit-home', 'cockpit-flow', 'cockpit-graph', 'cockpit-outputs', 'cockpit-policy']) expect(await ui.find({ key: t })).toBeDefined()
      await ui.press({ key: 'cockpit-home' })
      expect(await ui.find({ key: 'group-now' })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('focus moves out of the cockpit onto engine stops are refused, moves between its own elements pass', async ($, on) => {
  baseStubs(on)
  on('ui.focus', () => ({}))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const out = await $.ui.focus({ component: 'Pane', requestId: 'cc-cockpit', origin: { kind: 'person' } } as any)
  expect(out).toEqual({ deny: 'focus stays in the cockpit' })
  const inside = await $.ui.focus({ component: 'Pane', requestId: 'cc-cockpit', element: 'cockpit-flow', plugin: 'cc-mods', origin: { kind: 'person' } } as any)
  expect((inside as any).deny).toBeUndefined()
})

const MON = (event: string) =>
  '<task-notification>\n<task-id>bmon1</task-id>\n<summary>Monitor event: "infra-k8s PR #9159 팔로우업"</summary>\n<event>' + event + '</event>\n</task-notification>'

test('Now › Watch lists every running watch; a press selects it and stop ends it (TaskStop), an auto Slack follow-up turns off the same way', async ($, on) => {
  const store: Record<string, unknown> = { 'slack-follow': { 'C0123ABCD45:1791964929.501939': { auto: true } } }
  baseStubs(on, { store })
  const stops: any[] = []
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'TaskStop') stops.push(e)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.append', (_$: any, e: any) => ({ message: e.message, uuid: e.uuid }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.turn.start({ turnId: 'm1', text: MON('PR_EVENT pr=https://github.com/acme/infra-k8s/pull/9159 checks=pending') })
  await $.turn.complete({ turnId: 'm1', answer: '진행 중입니다.', durationMs: 5, isAborted: false, usage: null } as any)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  expect(await ui.find({ key: 'home-watch-m:bmon1' })).toBeDefined()
  expect(await ui.find({ key: 'home-watch-f:C0123ABCD45:1791964929.501939' })).toBeDefined()
  // Stop shows only after the row is selected: one stray click stops nothing.
  expect(await ui.find({ key: 'home-watch-stop-m:bmon1' })).toBeUndefined()
  await ui.press({ key: 'home-watch-m:bmon1' })
  await ui.press({ key: 'home-watch-stop-m:bmon1' })
  for (let i = 0; i < 200 && !stops.length; i++) await Promise.resolve()
  expect(stops[0]).toMatchObject({ tool: 'TaskStop', task_id: 'bmon1' })
  for (let i = 0; i < 200 && (await ui.find({ key: 'home-watch-m:bmon1' })); i++) await Promise.resolve()
  expect(await ui.find({ key: 'home-watch-m:bmon1' })).toBeUndefined()
  // The Slack follow-up row turns auto off.
  await ui.press({ key: 'home-watch-f:C0123ABCD45:1791964929.501939' })
  await ui.press({ key: 'home-watch-stop-f:C0123ABCD45:1791964929.501939' })
  for (let i = 0; i < 200 && (store['slack-follow'] as any)['C0123ABCD45:1791964929.501939']; i++) await Promise.resolve()
  expect((store['slack-follow'] as any)['C0123ABCD45:1791964929.501939']).toBeUndefined()
  expect(await ui.find({ key: 'home-watch-f:C0123ABCD45:1791964929.501939' })).toBeUndefined()
  await ui.unmount()
})

test('a routine Monitor tick leaves the transcript for the cockpit and the band; a failing one stays', async ($, on) => {
  baseStubs(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.append', (_$: any, e: any) => ({ message: e.message, uuid: e.uuid }))
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: ['ENGINE ROW'] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })

  // Routine: checks went pending, Claude only read the PR.
  await $.turn.start({ turnId: 'm1', text: MON('PR_EVENT pr=https://github.com/acme/infra-k8s/pull/9159 checks=pending') })
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 9159 --json state', tool_use_id: 'tu-quiet' } as any)
  await $.turn.complete({ turnId: 'm1', answer: '체크가 아직 진행 중입니다. 다음 이벤트를 기다립니다.', durationMs: 5, isAborted: false, usage: null } as any)

  const row = await $.ui.mount({ plugin: 'cc-mods', component: 'ToolUse', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { tool_use_id: 'tu-quiet', tool: 'Bash', input: { command: 'gh pr view' }, isRunning: false, isErrored: false, isInterrupted: false } } as any)
  expect(await row.find({ type: 'Text', text: /gh pr view/ })).toBeUndefined()
  await row.unmount()
  const note = await $.ui.mount({ plugin: 'cc-mods', component: 'UserMessage', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { text: MON('PR_EVENT pr=x checks=pending'), origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'bmon1' } } } as any)
  // Routine: no row at all in the transcript.
  expect(await note.find({ type: 'Text', text: /infra-k8s PR #9159/ })).toBeUndefined()
  expect(await note.find({ type: 'Text', text: 'ENGINE ROW' })).toBeUndefined()
  await note.unmount()
  const ans = await $.ui.mount({ plugin: 'cc-mods', component: 'AssistantMessage', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { text: '체크가 아직 진행 중입니다. 다음 이벤트를 기다립니다.', isFirstOfReply: true, isSummary: false } } as any)
  expect(await ans.find({ type: 'Text', text: /체크가 아직 진행 중입니다/ })).toBeUndefined()
  expect(await ans.find({ type: 'Text', text: 'ENGINE ROW' })).toBeUndefined()
  await ans.unmount()

  // Act: checks failing stays in the transcript and earns a flow entry.
  await $.turn.start({ turnId: 'm2', text: MON('PR_EVENT pr=https://github.com/acme/infra-k8s/pull/9159 checks=failing') })
  await $.tool.call({ tool: 'Bash', command: 'gh pr checks 9159', tool_use_id: 'tu-loud' } as any)
  await $.turn.complete({ turnId: 'm2', answer: 'lint 체크가 실패했습니다.', durationMs: 5, isAborted: false, usage: null } as any)
  const loud = await $.ui.mount({ plugin: 'cc-mods', component: 'ToolUse', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { tool_use_id: 'tu-loud', tool: 'Bash', input: { command: 'gh pr checks' }, isRunning: false, isErrored: false, isInterrupted: false } } as any)
  expect(await loud.find({ type: 'Text', text: 'ENGINE ROW' })).toBeDefined() // the engine's own row, unfolded
  await loud.unmount()
  const loudNote = await $.ui.mount({ plugin: 'cc-mods', component: 'UserMessage', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { text: MON('PR_EVENT pr=x checks=failing'), origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'bmon1' } } } as any)
  expect(await loudNote.find({ type: 'Text', text: /❗ watch · infra-k8s PR #9159 팔로우업 · checks failing/ })).toBeDefined()
  await loudNote.unmount()

  // With the cockpit closed, the band carries one row for the watches.
  const band = await $.ui.mount({ plugin: 'cc-mods', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { bodyColumns: 116 } } as any)
  expect(await band.find({ type: 'Text', text: /infra-k8s PR #9159 팔로우업/ })).toBeDefined()
  await band.unmount()

  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /infra-k8s PR #9159 팔로우업/ })).toBeDefined()
  await ui.press({ key: 'cockpit-flow' })
  expect(await ui.find({ type: 'Text', text: /watch · infra-k8s PR #9159 팔로우업 — checks failing/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /다음 이벤트를 기다립니다/ })).toBeUndefined()
  await ui.unmount()
})

const EXPIRED = (id: string, desc: string) =>
  '<task-notification>\n<task-id>' + id + '</task-id>\n<summary>Monitor event: "' + desc + '"</summary>\n<event>[Monitor expired after 30m with no events delivered. Re-arm it if you still need the watch.]</event>\n</task-notification>'

// A command the test feeds: push() writes a stdout line, end() exits it.
function spawnStub(on: any) {
  const children = new Map<string, { argv: string[]; push: (t: string) => void; end: (code: number) => void }>()
  on('process.spawn', (async function* (_$: any, e: any) {
    const q: string[] = []
    let wake = () => {}
    let code: number | undefined
    const c = { argv: e.argv, push: (t: string) => (q.push(t), wake()), end: (n: number) => ((code = n), wake()) }
    children.set(String(e.argv.at(-1)), c)
    for (;;) {
      while (q.length) yield { stream: 'stdout' as const, text: q.shift()! }
      if (code !== undefined) return { value: { code, signal: null } }
      await new Promise<void>((r) => (wake = r))
    }
  }) as any)
  return children
}

// The held watch's loop runs detached: let its pending steps through.
const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

test('a long watch that expires is held by the cockpit: no more expiry rows, events and its end still reach the model', async ($, on) => {
  const reached: string[] = []
  baseStubs(on, { submitted: reached })
  const clock = mock.clock(on)
  const children = spawnStub(on)
  const monitors: any[] = []
  let n = 0
  on('tool.call', (_$: any, e: any) => {
    if (e.tool !== 'Monitor') return { result: { stdout: '', stderr: '', interrupted: false } }
    monitors.push(e)
    n += 1
    return { result: {}, text: 'Monitor started (task bm' + n + ', expires in 30m unless the source ends first)' }
  })
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: ['ENGINE ROW'] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })

  await $.tool.call({ tool: 'Monitor', description: 'replies in a thread', timeout_ms: 1_800_000, command: 'watch_thread.sh C1 1.2 U1 60', tool_use_id: 'tu-m1' } as any)
  await $.tool.call({ tool: 'Monitor', description: 'tell me in five minutes', timeout_ms: 300_000, command: 'sleep 300', tool_use_id: 'tu-m2' } as any)
  expect(n).toBe(2)

  // The long one: the cockpit runs the same command; no Monitor is started again.
  const out: any = await $.prompt.submit({ text: EXPIRED('bm1', 'replies in a thread'), origin: { kind: 'task-notification' }, wait: false } as any)
  expect(out.drop).toMatch(/held by the cockpit · replies in a thread · cw-bm1/)
  expect(n).toBe(2)
  const held = children.get('watch_thread.sh C1 1.2 U1 60')!
  expect(held.argv).toEqual(['/bin/bash', '-c', 'watch_thread.sh C1 1.2 U1 60'])
  expect(reached).toHaveLength(0)

  // Past what used to be its next expiry, nothing reaches the model.
  await clock.advance(3_600_000)
  await settle()
  expect(reached).toHaveLength(0)

  // An event does, shaped as a Monitor event under the held id.
  held.push('NEW_REPLY ts=1.3 user=U2\n')
  await settle()
  expect(reached).toHaveLength(1)
  expect(reached[0]).toMatch(/<task-id>cw-bm1<\/task-id>[\s\S]*Monitor event: "replies in a thread"[\s\S]*<event>NEW_REPLY ts=1.3 user=U2<\/event>/)

  // Its row folds like any Monitor event.
  const row = await $.ui.mount({ plugin: 'cc-mods', component: 'UserMessage', surface: 'terminal', viewport: { columns: 120, rows: 40 }, props: { text: reached[0], origin: { kind: 'plugin', name: 'cc-mods' }, isExpanded: false } } as any)
  expect(await row.find({ type: 'Text', text: 'ENGINE ROW' })).toBeUndefined()
  await row.unmount()

  // The Watch card says who holds it.
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-graph' })
  expect(await ui.find({ type: 'Text', text: /held by cockpit/ })).toBeDefined()
  await ui.unmount()

  // TaskStop with the id the model's own Monitor returned stops it.
  const stopped: any = await $.tool.call({ tool: 'TaskStop', task_id: 'bm1' } as any)
  expect(stopped.result).toMatchObject({ task_id: 'cw-bm1' })
  // Whatever it prints afterwards reaches no one.
  held.push('NEW_REPLY ts=1.4 user=U3\n')
  await settle()
  expect(reached).toHaveLength(1)

  // The short one is a deadline: the model hears about it.
  await $.prompt.submit({ text: EXPIRED('bm2', 'tell me in five minutes'), origin: { kind: 'task-notification' }, wait: false } as any)
  expect(reached).toHaveLength(2)

  // A task the mod never saw start also reaches the model.
  await $.prompt.submit({ text: EXPIRED('bzz', 'older watch'), origin: { kind: 'task-notification' }, wait: false } as any)
  expect(reached).toHaveLength(3)

  // A held watch whose command exits says so, once.
  await $.tool.call({ tool: 'Monitor', description: 'ci run', timeout_ms: 1_800_000, command: 'pr-watch o/r 7', tool_use_id: 'tu-m3' } as any)
  await $.prompt.submit({ text: EXPIRED('bm3', 'ci run'), origin: { kind: 'task-notification' }, wait: false } as any)
  children.get('pr-watch o/r 7')!.end(0)
  await settle()
  expect(reached).toHaveLength(4)
  expect(reached[3]).toMatch(/cw-bm3[\s\S]*\[Monitor command exited with code 0\]/)

  // One held to the cap expires to the model, as a capped re-arm did.
  await $.tool.call({ tool: 'Monitor', description: 'slow', timeout_ms: 1_800_000, command: 'slow.sh', tool_use_id: 'tu-m4' } as any)
  await $.prompt.submit({ text: EXPIRED('bm4', 'slow'), origin: { kind: 'task-notification' }, wait: false } as any)
  await clock.advance(24 * 1_800_000 + 1)
  await settle()
  expect(reached).toHaveLength(5)
  expect(reached[4]).toMatch(/cw-bm4[\s\S]*Monitor expired: the cockpit held it/)
  children.get('slow.sh')!.push('LATE\n')
  await settle()
  expect(reached).toHaveLength(5)
})

test('a long socket watch is still re-armed through Monitor', async ($, on) => {
  const reached: string[] = []
  baseStubs(on, { submitted: reached })
  let n = 0
  const monitors: any[] = []
  on('tool.call', (_$: any, e: any) => {
    if (e.tool !== 'Monitor') return { result: { stdout: '', stderr: '', interrupted: false } }
    monitors.push(e)
    n += 1
    return { result: {}, text: 'Monitor started (task bs' + n + ', expires in 30m unless the source ends first)' }
  })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.tool.call({ tool: 'Monitor', description: 'feed', timeout_ms: 1_800_000, ws: { url: 'wss://x/feed' }, tool_use_id: 'tu-w1' } as any)
  const out: any = await $.prompt.submit({ text: EXPIRED('bs1', 'feed'), origin: { kind: 'task-notification' }, wait: false } as any)
  expect(out.drop).toMatch(/re-armed · feed · bs2/)
  expect(monitors[1]).toMatchObject({ tool: 'Monitor', ws: { url: 'wss://x/feed' } })
  const again: any = await $.prompt.submit({ text: EXPIRED('bs2', 'feed'), origin: { kind: 'task-notification' }, wait: false } as any)
  expect(again.drop).toMatch(/bs3/)
  expect(reached).toHaveLength(0)
})

test('a session loaded with history rebuilds the cockpit from the transcript', async ($, on) => {
  const runs = baseStubs(on)
  const clock = mock.clock(on)
  on('session.messages', (_$: any, e: any) =>
    e?.agentId
      ? { value: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 's1', tool: 'Read', input: {} }, { tool_use_id: 's2', tool: 'Grep', input: {} }] }] }
      : {
          value: [
            { role: 'user', text: 'what did we ship yesterday', toolUses: [] },
            {
              role: 'assistant',
              text: '결론입니다. https://github.com/keyolk/cc-mods/pull/7',
              // The PR is this session's because a command here created it,
              // not because the answer links it.
              toolUses: [
                {
                  tool_use_id: 'tu1',
                  tool: 'Bash',
                  input: { command: 'gh pr create' },
                  result: { stdout: 'https://github.com/keyolk/cc-mods/pull/7\n', gitOperation: { pr: { url: 'https://github.com/keyolk/cc-mods/pull/7', action: 'created' } } },
                },
                { tool_use_id: 'tu2', tool: 'Agent', input: { description: 'find code', prompt: 'look', subagent_type: 'Explore' }, agentId: 'ag1', text: 'found it' },
              ],
            },
          ],
        },
  )
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  // A PR row on the Now tab opens the PR page; it does not start a turn.
  await ui.press({ key: 'home-out-pr:keyolk/cc-mods#7' })
  expect(runs.some((a) => a.some((x) => x.endsWith('tmux-chrome-open')) && a.includes('https://github.com/keyolk/cc-mods/pull/7'))).toBe(true)
  await ui.press({ key: 'cockpit-outputs' })
  expect(await ui.find({ key: 'out-pr:keyolk/cc-mods#7' })).toBeDefined()
  await ui.press({ key: 'cockpit-flow' })
  expect(await ui.find({ key: 'flow-0' })).toBeDefined()
  await ui.unmount()
})

test('the browser option sets this pane on start, /browser switches it, the end unsets it', { options: { browser: 'tweb-chrome' } } as any, async ($, on) => {
  // tmux answers what it was told: the pane's @browser as last set, nothing for the window or global.
  let paneBrowser = ''
  const runs = baseStubs(on, {
    pane: '%42',
    run: (a) => {
      if (a[0] !== 'tmux') return undefined
      if (a[1] === 'set-option' && a.includes('@browser')) paneBrowser = a.includes('-u') ? '' : String(a.at(-1))
      if (a[1] === 'show-options') return { code: 0, out: a[2] === '-p' ? paneBrowser + '\n' : '\n' }
      if (String(a[1]).includes('tmux-chrome')) return { code: 0, out: 'Usage: tmux-chrome {switch|list}\n' }
      return undefined
    },
  })
  mock.clock(on)
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  const opt = (a: string[]) => a[0] === 'tmux' && a[1] === 'set-option' && a.includes('@browser')
  expect(runs.filter(opt).at(-1)).toEqual(['tmux', 'set-option', '-p', '-t', '%42', '@browser', 'tweb-chrome'])
  const r: any = await $.command.run({ command: 'browser', args: 'tweb', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  expect(runs.filter(opt).at(-1)).toEqual(['tmux', 'set-option', '-p', '-t', '%42', '@browser', 'tweb'])
  expect(r.text).toBe('Links open in: TWeb (Electron) (this session)')
  // Asked with nothing to set: read back from tmux, never tmux-chrome's usage text.
  const now: any = await $.command.run({ command: 'browser', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  expect(now.text).toBe('Links open in: TWeb (Electron) (this session)')
  expect(runs.some((a) => String(a[0]).endsWith('tmux-chrome'))).toBe(false)
  const bad: any = await $.command.run({ command: 'browser', args: 'firefox', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  expect(bad.text).toMatch(/Unknown browser/)
  const page: any = await $.command.run({ command: 'browser', args: 'tweb open google.com', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  expect(page.text).toMatch(/To open a page, \/web <url>/)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sid-1', resume: {} } as any)
  expect(runs.filter(opt).at(-1)).toEqual(['tmux', 'set-option', '-p', '-t', '%42', '-u', '@browser'])
})

test('the Web tab: /web starts the bridge, the region draws a marker, a click reaches the page', { options: { browserEmbed: true } } as any, async ($, on) => {
  const runs = baseStubs(on, { pane: '%42' })
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  let cockpitFocused = false
  on('ui.panes', () => ({ value: [{ id: 'cc-cockpit', title: 'cockpit', isShown: true, isFocused: cockpitFocused, isPlaced: true }] }) as any)
  on('ui.open', () => ({ isPlaced: true }) as any)
  const spawned: string[][] = []
  // The bridge says it is ready and the page loaded, then stays up.
  // The bridge stays up (as the real one does) until the test releases it:
  // a stream that ended would read as the browser having exited.
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  on('process.spawn', (async function* (_$: any, e: any) {
    spawned.push(e.argv)
    yield { stream: 'stdout' as const, text: '{"event":"ready"}\n{"event":"loaded","url":"https://example.com/","title":"Example Domain"}\n' }
    await held
    return { value: { code: 0, signal: null } }
  }) as any)
  const fetched: { url: string; body?: string; socketPath?: string }[] = []
  on('http.fetch', (_$: any, e: any) => {
    fetched.push({ url: e.url, body: e.init?.body, socketPath: e.init?.socketPath })
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.command.run({ command: 'web', args: 'example.com', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  expect(r.text).toMatch(/Opening https:\/\/example\.com/)
  const argv = spawned.find((a) => a.some((x) => x.endsWith('/bin/cc-browser')))!
  expect(argv).toContain('--pane')
  expect(argv[argv.indexOf('--url') + 1]).toBe('https://example.com')
  expect(argv[argv.indexOf('--engine') + 1]).toBe('electron')
  // The bridge's socket is advertised on the pane for tmux-chrome.
  expect(runs.some((a) => a[0] === 'tmux' && a.includes('@cc_web'))).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...COCKPIT, surface } as any)
    await ui.press({ key: 'cockpit-web' })
    expect(await ui.find({ key: 'web-keyboard' })).toBeDefined()
    expect(await ui.find({ key: 'web-back' })).toBeUndefined()
    await ui.unmount()
  }

  const term = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await term.press({ key: 'cockpit-web' })
  expect(await term.find({ key: 'web-region' })).toBeDefined()
  await term.resize({ columns: 60, rows: 18, in: 'web-region' })
  // Nothing is drawn for the bridge to find: it anchors on the page header row
  // and gets the page's size from the mod.
  expect(JSON.stringify(await term.drawn({ in: 'web-region' }))).not.toMatch(/cc-web/)
  const region = fetched.filter((f) => f.url.endsWith('/region')).at(-1)
  expect(JSON.parse(region!.body!).cols).toBe(80)
  await term.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'web-region' })
  const input = fetched.filter((f) => f.url.endsWith('/input')).at(-1)
  expect(JSON.parse(input!.body!).hex).toBe('1b5b3c303b333b314d')
  expect(input!.socketPath).toMatch(/cc-browser-sid-1-1\.sock$/)
  expect(JSON.stringify(await term.drawn())).toContain('⌨ PAGE')
  expect(JSON.stringify(await term.drawn())).toContain('⌨ TWeb')
  // Page mode is mirrored to the pane option tmux's Escape/alt+w/alt+tab read.
  expect(runs.some((a) => a[0] === 'tmux' && a.includes('@cc_web_page') && a.at(-1) === '1')).toBe(true)
  await term.key({ key: 'a', in: 'web-region' })
  expect(JSON.parse(fetched.filter((f) => f.url.endsWith('/input')).at(-1)!.body!).hex).toBe('61')
  // In PAGE, Esc (the borrowed action) goes to TWeb as 1b; alt+w returns to controls.
  await term.press({ key: 'hk-escape' })
  expect(JSON.parse(fetched.filter((f) => f.url.endsWith('/input')).at(-1)!.body!).hex).toBe('1b')
  await term.press({ key: 'hk-web-keyboard' })
  expect(JSON.stringify(await term.drawn())).toContain('⌘ CTRL')
  expect(JSON.stringify(await term.drawn())).toContain('⌨ Cockpit')
  // alt+w from controls synthesizes a click into the rendered Client.
  await term.press({ key: 'hk-web-keyboard' })
  const mouse = runs.findLast((a) => a[0] === 'tmux' && a[1] === 'send-keys' && a.includes('-H'))
  const bytes = String.fromCharCode(...mouse!.slice(mouse!.indexOf('-H') + 1).map((h) => parseInt(h, 16)))
  expect(bytes).toMatch(/^\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m$/)
  // An actual page event confirms PAGE; alt+tab changes mode first, then sends alt+c to Claude.
  await term.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'web-region' })
  cockpitFocused = true
  await term.press({ key: 'hk-cockpit-focus' })
  expect(runs.some((a) => a[0] === 'tmux' && a[1] === 'send-keys' && a.at(-1) === 'M-c')).toBe(true)
  expect(JSON.stringify(await term.drawn())).toContain('⌘ CTRL')

  // Float: TWeb's own `w` cannot reach it from the page, so the tab has a button.
  await term.press({ key: 'web-float' })
  expect(JSON.parse(fetched.filter((f) => f.url.endsWith('/cmd')).at(-1)!.body!).argv).toEqual(['float'])
  expect(JSON.stringify(await term.drawn())).toContain('⧉ pin')
  await term.press({ key: 'web-float' })
  expect(JSON.parse(fetched.filter((f) => f.url.endsWith('/cmd')).at(-1)!.body!).argv).toEqual(['pin'])

  // Settings: the rows open from the header's ⚙; a device applies in place,
  // another engine starts a new bridge at the same URL.
  await term.press({ key: 'web-settings' })
  expect(await term.find({ key: 'web-engine-Chrome' })).toBeDefined()
  await term.press({ key: 'web-device-iPhone 12' })
  expect(JSON.parse(fetched.filter((f) => f.url.endsWith('/cmd')).at(-1)!.body!).argv).toEqual(['device', 'iPhone 12'])
  await term.press({ key: 'web-engine-Chrome' })
  const second = spawned.filter((a) => a.some((x) => x.endsWith('/bin/cc-browser'))).at(-1)!
  expect(second[second.indexOf('--engine') + 1]).toBe('chrome')
  expect(second[second.indexOf('--socket') + 1]).toMatch(/cc-browser-sid-1-2\.sock$/)
  await term.unmount()
  // Left held: ending the stream here would run the module's exit path after
  // the test's environment is torn down.
  void release
})

test('routing: with auto_effort allowed in the session policy, main steps carry the effort Jev picked', async ($, on) => {
  // The session's policy file allows auto_effort; cc-bridge's route answers xhigh.
  const runs = baseStubs(on, {
    policyJson: JSON.stringify({ mode: 'custom', capabilities: { auto_effort: 'allow' } }),
    route: '{"effort":"xhigh","confidence":0.97}',
  })
  mock.clock(on)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  const sent: any[] = []
  on('turn.step', (async function* (_$: any, e: any) {
    sent.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  }) as any)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'prod is losing writes under load, find the race', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 't1', text: 'prod is losing writes under load, find the race' })
  for await (const _ of ($.turn as any).step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 3 })) void _
  expect(sent.at(-1).effort).toBe('xhigh')
  expect(sent.at(-1).model).toBe('claude-opus-5-5')
  const shown: any = await $.command.run({ command: 'route', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  expect(shown.text).toMatch(/Auto effort on .*session policy.*effort xhigh \(97%\)/)

  // /route off is the policy CLI's `inherit auto_effort`, and only a person's command runs it.
  const fromPlugin: any = await $.command.run({ command: 'route', args: 'off', origin: { kind: 'plugin', name: 'x' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  expect(fromPlugin.text).toMatch(/typed by a person/)
  expect(runs.some((a) => a.includes('auto_effort'))).toBe(false)
  await $.command.run({ command: 'route', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any)
  expect(runs.find((a) => a.includes('auto_effort'))?.slice(-2)).toEqual(['inherit', 'auto_effort'])
})

test('the palette opens only on purpose (k, alt+s), alt+s closes it, and it runs what it finds', async ($, on) => {
  baseStubs(on)
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  // Closed at start. q is no cockpit hotkey: the catch-all claims it so it does
  // not reach the prompt, and it opens nothing.
  expect(await ui.find({ key: 'palette-query' })).toBeUndefined()
  await ui.press({ key: 'catch-q' })
  expect(await ui.find({ key: 'palette-query' })).toBeUndefined()
  // The alt+s chord (engine action settings:search) toggles it both ways.
  await ui.press({ key: 'palette-toggle' })
  expect(await ui.find({ key: 'palette-query' })).toBeDefined()
  expect(await ui.find({ key: 'palette-toggle' })).toBeDefined()
  await ui.press({ key: 'palette-toggle' })
  expect(await ui.find({ key: 'palette-query' })).toBeUndefined()
  await ui.press({ key: 'catch-k' })
  expect(await ui.find({ key: 'palette-query' })).toBeDefined()
  await ui.input({ key: 'palette-query', text: 'policy', kind: 'change' })
  expect(await ui.find({ key: 'palette-tab:policy' })).toBeDefined()
  // Tab moves the ring off the field; the cockpit keeps it there and moves
  // the selection down one.
  const down: any = await $.ui.focus({ component: 'Pane', requestId: 'cc-cockpit', element: 'palette-tab:policy', plugin: 'cc-mods', origin: { kind: 'person' } } as any)
  expect(down.deny).toMatch(/keeps the keyboard/)
  expect(JSON.stringify(await ui.drawn())).toMatch(/› Policy {2}/)
  // Esc (the borrowed action, drawn with the palette open too) closes it.
  await ui.press({ key: 'hk-escape' })
  expect(await ui.find({ key: 'palette-query' })).toBeUndefined()
  await ui.press({ key: 'palette-toggle' })
  await ui.input({ key: 'palette-query', text: 'policy', kind: 'change' })
  await ui.input({ key: 'palette-query', text: 'policy', kind: 'submit' })
  // Ran Go to Policy and closed.
  expect(await ui.find({ key: 'palette-query' })).toBeUndefined()
  expect(await ui.find({ key: 'cap-gh_merge' })).toBeDefined()
  await ui.unmount()
})

test('the palette lands where it was sent: "side question" opens the Chat tab at the side question field, a list at its tab', async ($, on) => {
  baseStubs(on)
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  // The keyboard move itself ($.ui.focus) needs a pane that holds the keys,
  // which a mounted test pane does not; this checks where each pick lands.
  await ui.press({ key: 'palette-toggle' })
  await ui.input({ key: 'palette-query', text: 'side question', kind: 'change' })
  expect(await ui.find({ key: 'palette-go:side' })).toBeDefined()
  await ui.input({ key: 'palette-query', text: 'side question', kind: 'submit' })
  expect(await ui.find({ key: 'palette-query' })).toBeUndefined()
  expect(await ui.find({ key: 'side-input' })).toBeDefined()
  await ui.press({ key: 'palette-toggle' })
  await ui.input({ key: 'palette-query', text: 'jira', kind: 'change' })
  await ui.input({ key: 'palette-query', text: 'jira', kind: 'submit' })
  expect(JSON.stringify(await ui.drawn())).toMatch(/"key":"cockpit-outputs"[^\]]*"underline":true/)
  expect(await ui.find({ key: 'tab-ticket' })).toBeDefined()
  await ui.press({ key: 'palette-toggle' })
  await ui.input({ key: 'palette-query', text: 'usage', kind: 'change' })
  await ui.input({ key: 'palette-query', text: 'usage', kind: 'submit' })
  expect(JSON.stringify(await ui.drawn())).toMatch(/"key":"cockpit-usage"[^\]]*"underline":true/)
  await ui.unmount()
})

test('alt+/ shows every key: anywhere, cockpit, the open tab\'s own letters; Esc (a move off it) or alt+/ closes it', async ($, on) => {
  baseStubs(on)
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-flow' })
  expect(await ui.find({ key: 'help-close' })).toBeUndefined()
  await ui.press({ key: 'hk-help' })
  expect(await ui.find({ key: 'help-close' })).toBeDefined()
  const drawn = JSON.stringify(await ui.drawn())
  for (const s of ['Anywhere', 'alt+s', 'ctrl+x x', 'This tab (Chat)', 'Conclusions', '/side [q]']) expect(drawn).toContain(s)
  // The Chat tab's `i` (ask a side question) is a hidden hotkey: listed too.
  expect(drawn).toMatch(/"children":\["i"\]/)
  const esc: any = await $.ui.focus({ component: 'Pane', requestId: 'cc-cockpit', element: 'cockpit-home', plugin: 'cc-mods', origin: { kind: 'person' } } as any)
  expect(esc.deny).toMatch(/closed the key help/)
  expect(await ui.find({ key: 'help-close' })).toBeUndefined()
  await ui.press({ key: 'hk-help' })
  expect(await ui.find({ key: 'help-close' })).toBeDefined()
  await ui.press({ key: 'hk-help' })
  expect(await ui.find({ key: 'help-close' })).toBeUndefined()
  await ui.unmount()
})

test('slash-command candidates hide the cockpit; ending or submitting the first token restores the same pane without focus', async ($, on) => {
  const store: Record<string, unknown> = { 'cockpit-settings': { slashHide: true } }
  baseStubs(on, { store })
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('prompt.fill', () => ({ isFilled: true }))
  let shown = true
  const opens: any[] = []
  const closes: any[] = []
  on('ui.panes', () => ({ value: shown ? [{ id: 'cc-cockpit', title: 'cockpit', isShown: true, isFocused: false, isPlaced: true }] : [] }) as any)
  on('ui.close', (_$: any, e: any) => {
    closes.push(e)
    shown = false
    return { value: undefined }
  })
  on('ui.open', (_$: any, e: any) => {
    opens.push(e)
    shown = true
    return { value: { isPlaced: true } } as any
  })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  // A plugin fill raises prompt.change; `/` keeps the full-width typeahead clear of the dock.
  let r: any = await $.prompt.fill({ text: '/', mode: 'replace', origin: { kind: 'plugin', name: 'test' } })
  expect(r.isFilled).toBe(true)
  expect(closes).toHaveLength(1)
  r = await $.prompt.fill({ text: '/side', mode: 'replace', origin: { kind: 'plugin', name: 'test' } })
  expect(r.isFilled).toBe(true)
  expect(closes).toHaveLength(1)
  // The space ends the candidate token: same cockpit returns, never taking the keyboard.
  r = await $.prompt.fill({ text: '/side ', mode: 'replace', origin: { kind: 'plugin', name: 'test' } })
  expect(r.isFilled).toBe(true)
  expect(opens.at(-1)).toMatchObject({ id: 'cc-cockpit' })
  expect(opens.at(-1)?.focus).toBeUndefined()
  // It hides a second time, and submit restores it too.
  await $.prompt.fill({ text: '/web', mode: 'replace', origin: { kind: 'plugin', name: 'test' } })
  expect(closes).toHaveLength(2)
  await $.prompt.submit({ text: '/web', origin: { kind: 'composer' }, wait: false } as any)
  expect(opens).toHaveLength(2)
})

test('slash-command cockpit hiding can be disabled in Settings, restoring a pane it hid', async ($, on) => {
  const store: Record<string, unknown> = { 'cockpit-settings': { slashHide: true } }
  baseStubs(on, { store })
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('prompt.fill', () => ({ isFilled: true }))
  let shown = true
  let opens = 0
  on('ui.panes', () => ({ value: shown ? [{ id: 'cc-cockpit', title: 'cockpit', isShown: true, isFocused: false, isPlaced: true }] : [] }) as any)
  on('ui.close', () => { shown = false; return { value: undefined } })
  on('ui.open', () => { shown = true; opens++; return { value: { isPlaced: true } } as any })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.fill({ text: '/', mode: 'replace', origin: { kind: 'plugin', name: 'test' } })
  expect(shown).toBe(false)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-settings' })
  await ui.press({ key: 'set-slash-hide-off' })
  expect(shown).toBe(true)
  expect(opens).toBe(1)
  expect((store['cockpit-settings'] as any).slashHide).toBe(false)
  await $.prompt.fill({ text: '/', mode: 'replace', origin: { kind: 'plugin', name: 'test' } })
  expect(shown).toBe(true)
  await ui.unmount()
})

test('MCP heal: a call failing on a dropped server reconnects that one server when the turn ends, once per gap; no timer, no reconnect all; Settings turns it off', async ($, on) => {
  const store: Record<string, unknown> = { 'cockpit-settings': {} }
  const toasts: string[] = []
  // The server names come from the credential radar's `claude mcp list`.
  const list = ['claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected', 'portal: https://portal.acme.io/mcp (HTTP) - ✔ Connected'].join('\n')
  baseStubs(on, { store, toasts, run: (argv) => (argv[0] === 'claude' && argv[1] === 'mcp' && argv[2] === 'list' ? { code: 0, out: list } : undefined) })
  on('mcp.call', () => ({ value: { content: [] } }) as any)
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  const reconnects: string[] = []
  on('command.run', (_$: any, e: any) => {
    if (e.command === 'mcp') reconnects.push(e.args)
    return { text: e.command === 'mcp' ? 'Reconnected 1 of 1 MCP servers' : '' }
  })
  let answer: any = { isError: true, result: { content: [{ type: 'text', text: 'MCP error -32000: Connection closed' }] } }
  on('tool.call', () => answer)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }) as any)
  let turn = 0
  const endTurn = async () => {
    const id = 't' + ++turn
    await $.turn.start({ turnId: id, text: 'x' })
    await $.turn.complete({ turnId: id, answer: '', durationMs: 1, isAborted: false, usage: null } as any)
  }
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  await clock.advance(0)
  // No timer: a long idle stretch reconnects nothing.
  await clock.advance(10 * 60_000)
  expect(reconnects).toEqual([])
  await $.tool.call({ tool: 'mcp__claude_ai_Slack__slack_read_thread', input: {} } as any)
  // Not from inside the call: at the end of the turn.
  expect(reconnects).toEqual([])
  await endTurn()
  for (let i = 0; i < 2000 && !reconnects.length; i++) await Promise.resolve()
  expect(reconnects).toEqual(['reconnect claude.ai Slack'])
  // Again within the gap: nothing.
  await $.tool.call({ tool: 'mcp__claude_ai_Slack__slack_read_thread', input: {} } as any)
  await endTurn()
  for (let i = 0; i < 2000; i++) await Promise.resolve()
  expect(reconnects).toHaveLength(1)
  // A tool error that is the tool's own does not reconnect anything.
  await clock.advance(3 * 60_000)
  answer = { isError: true, result: { content: [{ type: 'text', text: 'channel_not_found' }] } }
  await $.tool.call({ tool: 'mcp__portal__x', input: {} } as any)
  await endTurn()
  for (let i = 0; i < 2000; i++) await Promise.resolve()
  expect(reconnects).toHaveLength(1)
  // Settings turns the automatic part off.
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-settings' })
  await ui.press({ key: 'set-mcp-heal-off' })
  expect((store['cockpit-settings'] as any).mcpHeal).toBe(false)
  const before = reconnects.length
  answer = { isError: true, result: 'connection reset by peer' }
  await $.tool.call({ tool: 'mcp__portal__x', input: {} } as any)
  await endTurn()
  for (let i = 0; i < 2000; i++) await Promise.resolve()
  expect(reconnects).toHaveLength(before)
  await ui.unmount()
})

test('the Now tab shows the Model card from ccproxy usage, and says when ccproxy is too old', async ($, on) => {
  const runs: string[][] = []
  let usageOut = ''
  on('store.keys', () => ({ value: [] }))
  usageOut = JSON.stringify({
    session: 'sid-1', requests: 4, bucket_seconds: 300,
    last: { at: 1791960000, account: 'claude-personal', model: 'claude-opus-5-5', effort: 'medium', status: 200, reason: 'continuation', ms: 9000, tokens: { output: 900, cache_read: 800000 } },
    accounts: [{ name: 'claude-personal', requests: 3, tokens: { output: 10 } }, { name: 'claude-acme', requests: 1, tokens: { output: 2 } }],
    models: [{ name: 'claude-opus-5-5', requests: 4, tokens: { output: 12 } }],
    trend: [{ start: 0, requests: 1, output: 5 }, { start: 300, requests: 3, output: 20 }],
  })
  // An older ccproxy prints its whole help for an unknown command.
  baseStubs(on, { runs, usage: () => (usageOut ? { code: 0, out: usageOut } : { code: 1, out: 'ccproxy - Claude Code multi-account proxy\n' }) })
  const clock = mock.clock(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/claude-personal · opus-5-5 · medium/)
  expect(drawn).toMatch(/why: continuation/)
  expect(drawn).toMatch(/claude-personal 75%/)
  expect(runs.some((a) => a[0] === 'ccproxy' && a.includes('--session') && a.includes('sid-1'))).toBe(true)
  await ui.unmount()

  usageOut = ''
  await $.turn.complete({ turnId: 't9', answer: 'done', durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(0)
  const ui2 = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  expect(JSON.stringify(await ui2.drawn())).toMatch(/too old for usage/)
  await ui2.unmount()
})

test('the Usage tab draws accounts with quota windows, models and trend; w switches to 6h', async ($, on) => {
  const runs: string[][] = []
  const usage = JSON.stringify({
    session: 'sid-1', requests: 4, bucket_seconds: 300,
    last: { at: 1791960000, account: 'claude-personal', model: 'claude-opus-5-5', effort: 'high', status: 200, reason: 'continuation', ms: 2000, tokens: { output: 9, cache_read: 1 } },
    accounts: [{ name: 'claude-personal', requests: 4, tokens: { output: 30 } }],
    models: [{ name: 'claude-opus-5-5', requests: 4, tokens: { output: 30 } }],
    trend: [{ start: 0, requests: 1, output: 5 }, { start: 300, requests: 3, output: 25 }],
  })
  const status = JSON.stringify({ accounts: [
    { name: 'claude-personal', state: 'ready', budget: { kind: 'windows', five_hour: { left_pct: 48 }, seven_day: { left_pct: 86 } } },
    { name: 'claude-acme', state: 'cooldown', budget: { kind: 'windows', five_hour: { left_pct: 81 }, seven_day: { left_pct: 0 }, scoped: [{ model: 'Fable', left_pct: 100 }] } },
  ] })
  baseStubs(on, { runs, usage: () => ({ code: 0, out: usage }), status })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-usage' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/claude-personal · opus-5-5 · effort high/)
  expect(drawn).toMatch(/48%/)
  expect(drawn).toMatch(/cooldown/)
  expect(drawn).toMatch(/not used here/)
  // A model's own weekly allowance on its own row, apart from the full 7d window.
  expect(drawn).toMatch(/own: Fable [█░]+ 100%/)
  // Jev: what the hooks spent, by hook, beside the team-wide gateway line.
  expect(drawn).toMatch(/12 calls/)
  expect(drawn).toMatch(/\$0\.0016/)
  expect(drawn).toMatch(/flow_fork_hint/)
  expect(drawn).toMatch(/30 \(9 today\)/)
  expect(drawn).toMatch(/cockpit route/)
  expect(drawn).toMatch(/p50 610ms · p95 820ms/)
  expect(drawn).toMatch(/choose/)
  expect(drawn).toMatch(/whole team since 2026-10-07: 3839 calls · \$1\.00/)
  await ui.press({ key: 'usage-window-6h' })
  await clock.advance(0)
  const last = runs.filter((a) => a[0] === 'ccproxy' && a[1] === 'usage').at(-1)!
  expect(last.slice(-4)).toEqual(['--bucket', '30m', '--buckets', '12'])
  await ui.unmount()
})

test('the Usage tab details the session: cache, per-model latency and effort, model strip; s asks for the whole session', async ($, on) => {
  const runs: string[][] = []
  const tokens = (o: number, r: number, c: number) => ({ input: 10, output: o, cache_read: r, cache_create: c })
  const usage = JSON.stringify({
    session: 'sid-1', requests: 4, bucket_seconds: 7800, first_at: 1791905864,
    totals: tokens(40, 900, 90),
    accounts: [{ name: 'claude-personal', requests: 4, tokens: tokens(40, 900, 90) }],
    models: [
      { name: 'claude-opus-5-5', requests: 3, tokens: tokens(30, 800, 50), ms: 9000, efforts: { medium: 2, high: 1 } },
      { name: 'claude-sonnet-5-5', requests: 1, tokens: tokens(10, 100, 40), ms: 1000, efforts: { low: 1 } },
    ],
    trend: [
      { start: 0, requests: 0, output: 0, input: 0, cache_read: 0, cache_create: 0 },
      { start: 7800, requests: 2, output: 20, input: 40, cache_read: 500, cache_create: 30, models: { 'claude-opus-5-5': 2 } },
      { start: 15600, requests: 2, output: 20, input: 50, cache_read: 400, cache_create: 60, models: { 'claude-opus-5-5': 1, 'claude-sonnet-5-5': 1 },
        by_model: { 'claude-opus-5-5': { requests: 1, output: 12, input: 0, cache_read: 0 }, 'claude-sonnet-5-5': { requests: 1, output: 8, input: 0, cache_read: 0 } },
        by_account: { 'claude-personal': { requests: 2, output: 20, input: 0, cache_read: 0 } } },
    ],
  })
  // An older ccproxy rejects `--bucket session`; the tab falls back to 6h.
  let old = false
  baseStubs(on, { runs, usage: (argv) => (old && argv.includes('session') ? { code: 1, out: '', err: '--bucket: want a duration of at least 1m, got "session"' } : { code: 0, out: usage }) })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await clock.advance(0)
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-usage' })
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/cache hit 90%/)
  expect(drawn).toMatch(/3\.0s avg/)
  expect(drawn).toMatch(/medium 67% · high 33%/)
  expect(drawn).toMatch(/cache wr/)
  // The session window starts at the first busy bucket: no leading gap.
  expect(drawn).toMatch(/"Oo"/)
  // One line per model and per account.
  expect(drawn).toMatch(/output by model/)
  expect(drawn).toMatch(/sonnet-5-5/)
  // This session by account: its own trend and the served-by strip, apart from the quota rows.
  expect(drawn).toMatch(/This session by account/)
  expect(drawn).toMatch(/served by/)
  expect(drawn).toMatch(/quota across all sessions/)
  await ui.press({ key: 'usage-window-session' })
  await clock.advance(0)
  const last = runs.filter((a) => a[0] === 'ccproxy' && a[1] === 'usage').at(-1)!
  expect(last.slice(-4)).toEqual(['--bucket', 'session', '--buckets', '24'])
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/whole session, 2h10m buckets/)
  old = true
  await ui.press({ key: 'usage-refresh' })
  await clock.advance(0)
  const after = runs.filter((a) => a[0] === 'ccproxy' && a[1] === 'usage').slice(-2)
  expect(after[0]!.slice(-4)).toEqual(['--bucket', 'session', '--buckets', '24'])
  expect(after[1]!.slice(-4)).toEqual(['--bucket', '30m', '--buckets', '12'])
  await ui.unmount()
})

test('an interactive session opens the cockpit at start, without the keyboard', async ($, on) => {
  baseStubs(on)
  const clock = mock.clock(on)
  const opens: any[] = []
  on('ui.panes', () => ({ value: [] }) as any)
  on('ui.open', (_$: any, e: any) => {
    opens.push(e)
    return { value: { isPlaced: true } } as any
  })
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(10)
  expect(opens.map((o) => [o.id, o.focus])).toEqual([['cc-cockpit', undefined]])
})

test('cockpitOnStart off leaves the cockpit closed', { options: { cockpitOnStart: false } } as any, async ($, on) => {
  baseStubs(on)
  const clock = mock.clock(on)
  const opens: any[] = []
  on('ui.panes', () => ({ value: [] }) as any)
  on('ui.open', (_$: any, e: any) => {
    opens.push(e)
    return { value: { isPlaced: true } } as any
  })
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(10)
  expect(opens).toEqual([])
})

test('a Slack thread pasted into a prompt is an input, not an output: In/Out › Inputs (and its Slack tab); opens from the palette', async ($, on) => {
  const runs = baseStubs(on)
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'follow up https://acme.slack.com/archives/C0123ABCD45/p1791965000123456?thread_ts=1791964929.501939', origin: { kind: 'composer' }, wait: false } as any)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-outputs' })
  // All lists what the session made; a pasted thread is what it was handed.
  expect(await ui.find({ key: 'out-slack:C0123ABCD45:1791964929.501939' })).toBeUndefined()
  await ui.press({ key: 'tab-slack' })
  expect(await ui.find({ key: 'out-slack:C0123ABCD45:1791964929.501939' })).toBeUndefined()
  await ui.press({ key: 'side-in' })
  expect(await ui.find({ key: 'out-slack:C0123ABCD45:1791964929.501939' })).toBeDefined()
  await ui.press({ key: 'tab-all' })
  expect(await ui.find({ key: 'out-slack:C0123ABCD45:1791964929.501939' })).toBeDefined()
  await ui.press({ key: 'palette-toggle' })
  await ui.input({ key: 'palette-query', text: 'slack', kind: 'change' })
  await ui.press({ key: 'palette-slack:https://acme.slack.com/archives/C0123ABCD45/p1791964929501939' })
  expect(runs.some((a) => a.some((x) => x.endsWith('tmux-chrome-open')) && a.includes('https://acme.slack.com/archives/C0123ABCD45/p1791964929501939'))).toBe(true)
  await ui.unmount()
})

test('In/Out: the filter field narrows by words in kind, title or URL, on both sides; ✕ clears it', async ($, on) => {
  baseStubs(on)
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'see https://acme.slack.com/archives/C0123ABCD45/p1791965000123456?thread_ts=1791964929.501939 and https://acme.atlassian.net/browse/ABC-123', origin: { kind: 'composer' }, wait: false } as any)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-outputs' })
  await ui.press({ key: 'side-in' })
  const slackRow = 'out-slack:C0123ABCD45:1791964929.501939'
  const rows = async () => ((await ui.findAll({ type: 'Button' })) as any[]).map((b) => String(b.key ?? b.props?.key ?? '')).filter((k) => k.startsWith('out-') && !k.startsWith('out-filter'))
  expect(await ui.find({ key: slackRow })).toBeDefined()
  const before = (await rows()).length
  expect(before).toBeGreaterThan(1)
  // A kind's own word (jira) keeps only that kind; the Slack thread goes.
  await ui.input({ key: 'out-filter', text: 'jira', kind: 'change' })
  expect(await ui.find({ key: slackRow })).toBeUndefined()
  expect((await rows()).some((k) => /abc-123/i.test(k))).toBe(true)
  // Two words, any order, both must match.
  await ui.input({ key: 'out-filter', text: 'C0123ABCD45 slack', kind: 'change' })
  expect(await ui.find({ key: slackRow })).toBeDefined()
  expect((await rows()).length).toBe(1)
  await ui.input({ key: 'out-filter', text: 'nothing-like-this', kind: 'change' })
  expect(JSON.stringify(await ui.drawn())).toContain('Nothing matches')
  await ui.press({ key: 'out-filter-clear' })
  expect((await rows()).length).toBe(before)
  await ui.unmount()
})

test('In/Out: files an answer hands over are starred deliverables, first under Files; an archive previews its contents; folder reveals it', async ($, on) => {
  const dir = '/private/tmp/claude-502/-work/sid-1/scratchpad/tg'
  const runs = baseStubs(on, {
    files: { [dir + '/probes.csv']: 'a,b', [dir + '/connector.log.gz']: '' },
    run: (argv) => (argv[0] === 'sh' && argv.at(-1) === dir + '/connector.log.gz' ? { code: 0, out: '5.6M connector.log.gz\n\n2026-10-14 07:30 conn up\n' } : undefined),
  })
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.turn.start({ turnId: 't1', text: 'attachments ready?' })
  const answer = 'All in `' + dir + '/`:\n\n| file | size |\n|---|---|\n| `probes.csv` | 2KB |\n| `connector.log.gz` | 5.6MB |\n| `gone.txt` | 1KB |'
  await $.turn.complete({ turnId: 't1', answer, durationMs: 5, isAborted: false, usage: null } as any)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-outputs' })
  await ui.press({ key: 'tab-scratch' })
  const gz = 'out-scratch:' + dir + '/connector.log.gz'
  expect(await ui.find({ key: gz })).toBeDefined()
  expect(await ui.find({ key: 'out-scratch:' + dir + '/probes.csv' })).toBeDefined()
  // Named but not there: left out.
  expect(await ui.find({ key: 'out-scratch:' + dir + '/gone.txt' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('★')
  await ui.press({ key: gz })
  expect(JSON.stringify(await ui.drawn())).toContain('conn up')
  await ui.press({ key: 'out-reveal' })
  expect(runs.some((a) => a[0] === 'open' && a[1] === '-R' && a[2] === dir + '/connector.log.gz')).toBe(true)
  await ui.unmount()
})

test('a tracked Slack thread shows its channel name and new replies in Needs you; opening it marks them seen', async ($, on) => {
  const runs = baseStubs(on, { store: {} })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  const head = '=== THREAD PARENT MESSAGE ===\nFrom: Sam Lee <sam@acme.com> (U0123ABCD47)\nTime: x\nMessage TS: 1791964929.501939\nhi\n\n=== THREAD REPLIES ===\n'
  let replies = ''
  on('mcp.call', (_$: any, e: any) => {
    const text = e.tool === 'slack_read_channel' ? 'Channel: #team-pr-review (C0123ABCD45)\n' : head + replies
    return { value: { content: [{ type: 'text', text: JSON.stringify({ messages: text }) }] } } as any
  })
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'look https://acme.slack.com/archives/C0123ABCD45/p1791964929501939', origin: { kind: 'composer' }, wait: false } as any)
  await clock.advance(10)
  // Jane replies after the thread was first seen.
  replies = '--- Reply 1 of 1 ---\nFrom: Jane Doe <jane@acme.com> (U0123)\nTime: x\nMessage TS: 1791966000.000100\nlgtm\n'
  await clock.advance(3 * 60_000)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  const row = await ui.find({ key: 'home-slack-slack:C0123ABCD45:1791964929.501939' })
  expect(row).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toMatch(/#team-pr-review/)
  expect(JSON.stringify(await ui.drawn())).toMatch(/1 new · Jane Doe/)
  await ui.press({ key: 'home-slack-slack:C0123ABCD45:1791964929.501939' })
  await clock.advance(10)
  expect(runs.some((a) => a.includes('https://acme.slack.com/archives/C0123ABCD45/p1791964929501939'))).toBe(true)
  expect(await ui.find({ key: 'home-slack-slack:C0123ABCD45:1791964929.501939' })).toBeUndefined()
  await ui.unmount()
})

test('Slack follow-up: In/Out runs sb:slack-followup on a thread now, and auto runs it once per new batch of replies', async ($, on) => {
  const store: Record<string, unknown> = {}
  baseStubs(on, { store })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  const head = '=== THREAD PARENT MESSAGE ===\nFrom: Sam Lee <sam@acme.com> (U0123ABCD47)\nTime: x\nMessage TS: 1791964929.501939\nhi\n\n=== THREAD REPLIES ===\n'
  let replies = ''
  on('mcp.call', (_$: any, e: any) => {
    const text = e.tool === 'slack_read_channel' ? 'Channel: #team-pr-review (C0123ABCD45)\n' : head + replies
    return { value: { content: [{ type: 'text', text: JSON.stringify({ messages: text }) }] } } as any
  })
  const followups: string[] = []
  on('command.run', (_$: any, e: any) => {
    if (e.command === 'sb:slack-followup') followups.push(e.args)
    return { text: '' }
  })
  const url = 'https://acme.slack.com/archives/C0123ABCD45/p1791964929501939'
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'look ' + url, origin: { kind: 'composer' }, wait: false } as any)
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-outputs' })
  await ui.press({ key: 'side-in' })
  await ui.press({ key: 'out-slack:C0123ABCD45:1791964929.501939' })
  // Now, by hand.
  await ui.press({ key: 'out-follow' })
  expect(followups).toEqual([url])
  // Auto: what is there when it is turned on is handled; a new reply starts one run.
  await ui.press({ key: 'out-auto-follow' })
  expect((store['slack-follow'] as any)['C0123ABCD45:1791964929.501939'].auto).toBe(true)
  expect(JSON.stringify(await ui.drawn())).toContain('auto follow-up: on')
  await clock.advance(3 * 60_000)
  expect(followups).toHaveLength(1)
  replies = '--- Reply 1 of 1 ---\nFrom: Jane Doe <jane@acme.com> (U0123)\nTime: x\nMessage TS: 1791966000.000100\nwhy?\n'
  await clock.advance(3 * 60_000)
  expect(followups).toEqual([url, url])
  // The same reply, polled again: no second run.
  await clock.advance(3 * 60_000)
  expect(followups).toHaveLength(2)
  // Off: a further reply runs nothing.
  await ui.press({ key: 'out-auto-follow' })
  replies += '--- Reply 2 of 2 ---\nFrom: Jane Doe <jane@acme.com> (U0123)\nTime: x\nMessage TS: 1791966100.000100\nping\n'
  await clock.advance(3 * 60_000)
  expect(followups).toHaveLength(2)
  await ui.unmount()
})

test('Policy tab: allowed targets carry a remove press, and slack @person resolves to an id before the grant', async ($, on) => {
  const runs = baseStubs(on, { store: {}, policyJson: JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' }, gh_merge_repos: ['acme/ccproxy'] }) })
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('mcp.call', (_$: any, e: any) => {
    const text = e.tool === 'slack_search_users' ? '## Users (1 results)\n1. Jane Doe - U0123ABCD46 - jane@acme.com\n' : ''
    return { value: { content: [{ type: 'text', text: JSON.stringify({ results: text }) }] } } as any
  })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-policy' })
  // The review channel is listed as a default; the merge repo has a remove press.
  expect(await ui.find({ key: 'scope-fixed-C0123ABCD45' })).toBeDefined()
  await ui.press({ key: 'scope-rm-gh_merge-acme/ccproxy' })
  expect(runs.some((a) => a.slice(-4).join(' ') === 'inherit gh_merge --repo acme/ccproxy')).toBe(true)
  await ui.input({ key: 'scope-input', text: 'slack @jane', kind: 'submit' })
  expect(runs.some((a) => a.slice(-4).join(' ') === 'allow slack_send --scope U0123ABCD46')).toBe(true)
  await ui.unmount()
})

test('with the cockpit open, the fork offer is asked in the cockpit and the band holds no button that takes alt+c', async ($, on) => {
  // A tracked PR, so the band has a row that must not ride along with the fork.
  const pr = { key: 'acme/infra-k8s#9159', url: 'https://github.com/acme/infra-k8s/pull/9159', title: 't', state: 'OPEN', isDraft: false, checks: 'pass', review: '', approvals: 0, unresolved: 0, mergeable: 'MERGEABLE', mergeState: 'BLOCKED', at: 9e15 }
  baseStubs(on, { pane: '%42', fork: JSON.stringify({ p: 0.9, threshold: 0.6 }), store: { prs: { [pr.key]: pr }, 'pr-watch': { [pr.key]: { session: 'sid-1', at: Date.now() } } } })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.focus', () => ({ value: {} }) as any)
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: ['ENGINE ROW'] }))
  // The PR is this session's: a command here created it.
  on('tool.call', () => ({ result: { stdout: pr.url + '\n', stderr: '', interrupted: false, gitOperation: { pr: { url: pr.url, action: 'created' } } } }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'fix the band', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 't1', text: 'fix the band' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill', description: 'open PR' } as any)
  await $.turn.complete({ turnId: 't1', answer: 'opened https://github.com/acme/infra-k8s/pull/9159', durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(10)
  // Cockpit closed: the band shows the PR.
  const closed = await $.ui.mount({ plugin: 'cc-mods', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 200, rows: 40 }, props: { bodyColumns: 196 } } as any)
  expect(await closed.find({ key: 'pr-open-acme/infra-k8s#9159' })).toBeDefined()
  await closed.unmount()
  await $.command.run({ command: 'cockpit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as any)
  await $.prompt.submit({ text: 'something entirely different now please', origin: { kind: 'composer' }, wait: false } as any)
  await clock.advance(10)
  const band = await $.ui.mount({ plugin: 'cc-mods', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 200, rows: 40 }, props: { bodyColumns: 196 } } as any)
  // The band says where to answer, with no Button: abovePrompt:focus (alt+c)
  // picks a focusable band ahead of the open cockpit.
  expect(JSON.stringify(await band.drawn())).toContain('answer in the cockpit (alt+tab)')
  expect(await band.find({ key: 'fork-no' })).toBeUndefined()
  expect(JSON.stringify(await band.drawn())).not.toContain('"type":"Button"')
  // Only the fork row: nothing else rides along to vanish with it.
  expect(await band.find({ key: 'pr-open-acme/infra-k8s#9159' })).toBeUndefined()
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  expect(await ui.find({ key: 'home-fork-no' })).toBeDefined()
  await ui.press({ key: 'home-fork-no' })
  expect(await ui.find({ key: 'home-fork-no' })).toBeUndefined()
  expect(JSON.stringify(await band.drawn())).not.toContain('answer in the cockpit')
  await ui.unmount()
  await band.unmount()
})

test('a PR only mentioned (a subagent read it, an answer linked it) stays out of Needs you', async ($, on) => {
  const pr = { key: 'router-for-me/CLIProxyAPI#6382', url: 'https://github.com/router-for-me/CLIProxyAPI/pull/6382', title: 'x', state: 'OPEN', isDraft: true, checks: 'fail', review: 'REVIEW_REQUIRED', approvals: 0, unresolved: 0, mergeable: 'CONFLICTING', mergeState: 'DIRTY', at: 9e15 }
  baseStubs(on, { pane: '%42', store: { prs: { [pr.key]: pr } } })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'how do other proxies do this', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'm1', text: 'how do other proxies do this' })
  await $.turn.complete({ turnId: 'm1', answer: 'upstream tried it in ' + pr.url, durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  expect(await ui.find({ key: 'home-pr-fu-' + pr.key })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('Needs you')
})

test('the PR follow-up button runs the skill command and reports that it queued', async ($, on) => {
  const pr = { key: 'acme/platform-tools#1849', url: 'https://github.com/acme/platform-tools/pull/1849', title: 'cells', state: 'OPEN', isDraft: false, checks: 'pass', review: '', approvals: 0, unresolved: 0, mergeable: 'MERGEABLE', mergeState: 'BLOCKED', at: 9e15 }
  const calls: any[] = []
  const toasts: string[] = []
  baseStubs(on, { pane: '%42', store: { prs: { [pr.key]: pr }, 'pr-watch': { [pr.key]: { session: 'sid-1', at: Date.now() } } }, toasts })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('command.run', (_$: any, e: any) => {
    calls.push(e)
    return { text: 'started' }
  })
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'follow the PR ' + pr.url, origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'pr1', text: 'follow the PR' })
  await $.turn.complete({ turnId: 'pr1', answer: 'opened ' + pr.url, durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'home-pr-fu-acme/platform-tools#1849' })
  await clock.advance(10)
  expect(calls.some((e) => e.command === 'sb:pr-followup' && e.args === pr.url)).toBe(true)
  expect(toasts).toContain('PR follow-up queued')
  await ui.unmount()
})

test('a Workflow run is one node in the Work tab with its agents under it, closed by its task notification', async ($, on) => {
  baseStubs(on)
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('tool.call', (_$: any, e: any) =>
    e.tool === 'Workflow' ? ({ result: { status: 'async_launched', taskId: 'wtask1', runId: 'wf_abc123', workflowName: 'review-changes' } } as any) : ({ result: {} } as any),
  )
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag-wf-1' }) as any)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('session.messages', () => ({ value: [] }))
  on('session.receive', (_$: any, e: any) => ({ text: e.text }) as any)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'review my changes with a workflow', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'tw', text: 'review my changes with a workflow' })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu-wf', script: "export const meta = { name: 'review-changes', description: 'Review changed files' }" } as any)
  await $.agent.spawn({ tool_use_id: 'tu-wf', prompt: 'review bugs', description: 'review:bugs', subagentType: 'general-purpose', workflow: { runId: 'wf_abc123', agentIndex: 1 } } as any)
  const ui = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-graph' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/review-changes — Review changed files/)
  expect(await ui.find({ key: 'node-wf:wf_abc123' })).toBeDefined()
  expect(await ui.find({ key: 'node-ag-wf-1' })).toBeDefined()
  await ui.unmount()
  await $.session.receive({ text: '<task-notification><task-id>wtask1</task-id><status>completed</status></task-notification>', origin: { kind: 'task-notification' } } as any)
  const after = await $.ui.mount({ ...COCKPIT, surface: 'terminal' } as any)
  await after.press({ key: 'cockpit-graph' })
  // The run's node is done (✓), no longer counted as running work.
  expect(JSON.stringify(await after.drawn())).not.toMatch(/Work"\]\},\{"type":"Text","props":\{"color":"warning"\},"children":\[" ⏳2"/)
  await after.unmount()
})

test('alt+<letter> presses the letter hotkey drawn on the open tab (Korean-input-proof)', async ($, on) => {
  const runs = baseStubs(on, { usage: () => ({ code: 0, out: '' }) })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-usage' })
  await ui.drawn()
  // alt+w reaches the hidden relay (its engine action); it presses Usage's `w` (6h window).
  await ui.press({ key: 'alt-w' })
  await clock.advance(0)
  const last = runs.filter((a) => a[0] === 'ccproxy' && a[1] === 'usage').at(-1)!
  expect(last.slice(-4)).toEqual(['--bucket', '30m', '--buckets', '12'])
  await ui.unmount()
})

test('the Settings tab sets where links go, the Web tab defaults and whether the cockpit opens at start', async ($, on) => {
  const store: Record<string, unknown> = {}
  const runs = baseStubs(on, { pane: '%42', store })
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-settings' })
  await ui.press({ key: 'set-browser-tweb' })
  expect(runs.some((a) => a.join(' ') === 'tmux set-option -p -t %42 @browser tweb')).toBe(true)
  await ui.press({ key: 'set-start-off' })
  expect((store['cockpit-settings'] as any)?.onStart).toBe(false)
  await ui.press({ key: 'set-effort-on' })
  expect(runs.some((a) => a.slice(-2).join(' ') === 'allow auto_effort')).toBe(true)
  await ui.unmount()
})

test('Chat: selecting a long decision draws its whole text', async ($, on) => {
  baseStubs(on)
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'what did we decide', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'd1', text: 'what did we decide' })
  const tail = 'THE-END-OF-THE-DECISION'
  await $.turn.complete({ turnId: 'd1', answer: '결론입니다.\n\n## 결정\n이렇게 하기로 했습니다. ' + '근거가 길게 이어집니다. '.repeat(40) + tail, durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-flow' })
  // The row is one clipped line; the full text is drawn only once selected.
  expect(await ui.find({ key: 'flow-full-2' })).toBeUndefined()
  await ui.press({ key: 'flow-2' })
  const full: any = await ui.find({ key: 'flow-full-2' })
  expect(JSON.stringify(full)).toContain(tail)
  await ui.unmount()
})

test('Chat: selecting the conclusion opens the whole answer, tables and code included', async ($, on) => {
  baseStubs(on)
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'explain', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'w1', text: 'explain' })
  const answer = '결론입니다.\n\n## 원인\n첫 문단.\n\n| a | b |\n|---|---|\n| TABLE-CELL | 2 |\n\n```\nCODE-LINE\n```'
  await $.turn.complete({ turnId: 'w1', answer, durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-flow' })
  // The rows never carry the table or the code.
  expect(JSON.stringify(await ui.drawn())).not.toContain('TABLE-CELL')
  await ui.press({ key: 'flow-1' })
  const full = JSON.stringify(await ui.find({ key: 'flow-full-1' }))
  expect(full).toContain('TABLE-CELL')
  expect(full).toContain('CODE-LINE')
  expect(JSON.stringify(await ui.drawn())).toContain('copy answer')
  await ui.unmount()
})

test('Now: Elsewhere lists other windows waiting on the person; a press brings that window in front, by its id, even in another tmux session', async ($, on) => {
  // tmux list-windows answers with one window that needs action, in another session.
  const runs = baseStubs(on, { pane: '%42', windows: 'side|5|cco|waiting|action|review the plan|100|other-sid|@12\n' })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(61_000)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  expect(JSON.stringify(await ui.drawn())).toMatch(/review the plan/)
  await ui.press({ key: 'win-@12' })
  const focus = runs.find((a) => a[0] === 'sh' && /switch-client/.test(a[2] ?? ''))
  expect(focus?.slice(3)).toEqual(['%42', '@12'])
  await ui.unmount()
})

test('a turn killed by a disconnect is continued once the API answers again, and not twice', async ($, on) => {
  let up = false
  const submitted: string[] = []
  const runs = baseStubs(on, { reach: () => up, submitted })
  on('classic.StopFailure', () => ({}) as any)
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 'a1', text: 'deploy it' })
  await $.turn.complete({ turnId: 'a1', answer: '', reason: 'error', durationMs: 5, isAborted: false, usage: null } as any)
  await $.classic.StopFailure({ hook_event_name: 'StopFailure', session_id: 'sid-1', transcript_path: '', cwd: '/work', error: 'unknown', last_assistant_message: 'API Error: Connection lost while your computer was asleep' } as any)
  await clock.advance(30_000)
  expect(submitted).toEqual([]) // still offline
  up = true
  await clock.advance(16_000)
  // Back, but every session stalled by the outage sees that on the same tick:
  // this one waits its own share of RESUME_SPREAD_MS (sid-1: 26.5 s) first.
  expect(submitted).toEqual([])
  await clock.advance(30_000)
  expect(submitted).toEqual(['keep going'])
  expect(runs.some((a) => a[0] === '/usr/bin/curl')).toBe(true)
  await clock.advance(30_000)
  expect(submitted).toEqual(['keep going']) // one at a time: waits for its turn to start
  // The resumed turn fails again: the streak goes on (second try), then it answers.
  await $.turn.start({ turnId: 'a2', text: 'keep going' })
  await $.turn.complete({ turnId: 'a2', answer: '', reason: 'error', durationMs: 5, isAborted: false, usage: null } as any)
  await $.classic.StopFailure({ hook_event_name: 'StopFailure', session_id: 'sid-1', transcript_path: '', cwd: '/work', error: 'unknown', last_assistant_message: 'API Error: No response from API' } as any)
  // Its 10 s backoff, plus the same spread.
  await clock.advance(45_000)
  expect(submitted).toEqual(['keep going', 'keep going'])
  await $.turn.start({ turnId: 'a3', text: 'keep going' })
  await $.turn.complete({ turnId: 'a3', answer: 'done', reason: 'answer', durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(60_000)
  expect(submitted).toEqual(['keep going', 'keep going']) // answered: nothing more
  // A failure the person then answers themselves is left to them.
  await $.turn.start({ turnId: 'b1', text: 'next' })
  await $.turn.complete({ turnId: 'b1', answer: '', reason: 'error', durationMs: 5, isAborted: false, usage: null } as any)
  await $.classic.StopFailure({ hook_event_name: 'StopFailure', session_id: 'sid-1', transcript_path: '', cwd: '/work', error: 'unknown', last_assistant_message: 'API Error: Connection refused (ECONNREFUSED)' } as any)
  await $.turn.start({ turnId: 'b2', text: 'try again please' })
  await clock.advance(30_000)
  expect(submitted).toEqual(['keep going', 'keep going'])
})

test('PR poll on a dead network: the failure backs off machine-wide instead of retrying every 90 s', async ($, on) => {
  // The lease file round-trips: what the module writes is what it reads back.
  const files: Record<string, string> = {}
  const runs: string[][] = []
  const store: Record<string, unknown> = { 'pr-watch': { 'keyolk/cc-mods#7': { session: 'sid-1', at: Date.now() } } }
  baseStubs(on, {
    pane: '%42',
    files,
    written: files,
    store,
    runs,
    run: (argv) => (argv[0] === 'gh' && argv[1] === 'api' ? { code: 1, out: '' } : argv[0] === 'gh' && argv[1] === 'auth' && argv[2] === 'token' ? { code: 0, out: 'tok\n' } : undefined),
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  const graphql = () => runs.filter((a) => a[0] === 'gh' && a[1] === 'api' && a[2] === 'graphql').length
  await clock.advance(1_000)
  expect(graphql()).toBe(1)
  // 90 s ticks for 10 minutes ran 7 queries before. Backing off 90, 180, 360 s
  // from the first failure, the 2nd runs at 90 s, the 3rd at 270 s, the 4th at 630 s.
  await clock.advance(10 * 60_000)
  expect(graphql()).toBe(3)
  await clock.advance(30_000)
  expect(graphql()).toBe(4)
  // The token is read once, not on every poll.
  expect(runs.filter((a) => a[0] === 'gh' && a[1] === 'auth' && a[2] === 'token').length).toBe(1)
  // A failed poll does not rewrite the shared PR cache.
  expect(store.prs).toBeUndefined()
  const lease = JSON.parse(Object.entries(files).find(([k]) => k.endsWith('/lease/pr-poll.json'))![1])
  expect(lease).toMatchObject({ by: 'sid-1', fails: 4 })
})

test('PR poll: a watched PR GitHub never answers for does not let this session past the hold', async ($, on) => {
  // Another session holds the poll; the watch list (shared) has a PR nobody can read.
  const files: Record<string, string> = {
    '/home/u/.claude/state/cc-mods/lease/pr-poll.json': JSON.stringify({ by: 'other-sid', until: Number.MAX_SAFE_INTEGER, fails: 0, failUntil: 0 }),
  }
  const runs: string[][] = []
  const pr = { key: 'keyolk/cc-mods#7', state: 'OPEN', at: Date.now() - 60_000 }
  const watch = { [pr.key]: { session: 'sid-1', at: Date.now() }, 'acme/gone#9': { session: 'other-sid', at: Date.now() } }
  baseStubs(on, { pane: '%42', files, written: files, runs, store: { prs: { [pr.key]: pr }, 'pr-watch': watch } })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(5 * 60_000)
  expect(runs.some((a) => a[0] === 'gh' && a[1] === 'api')).toBe(false)
})

test('PR poll: one account failing does not back off the accounts that answer', async ($, on) => {
  const files: Record<string, string> = {}
  const runs: string[][] = []
  const now = Date.now()
  // keyolk answers; acme (work-login) fails every time.
  const store: Record<string, unknown> = { 'pr-watch': { 'keyolk/cc-mods#7': { session: 'sid-1', at: now }, 'acme/infra#3': { session: 'sid-1', at: now } } }
  const answer = JSON.stringify({ data: { p0: { pullRequest: { number: 7, state: 'OPEN', title: 't', url: 'https://github.com/keyolk/cc-mods/pull/7', headRefOid: 'a', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, commits: { nodes: [] }, reviewThreads: { nodes: [] } } } } })
  baseStubs(on, {
    pane: '%42',
    files,
    written: files,
    store,
    runs,
    run: (argv) => {
      if (argv[0] === 'gh' && argv[1] === 'auth' && argv[2] === 'token') return { code: 0, out: argv[4] + '-tok\n' }
      if (argv[0] === 'gh' && argv[1] === 'api' && argv[2] === 'graphql') return String(argv[4]).includes('cc-mods') ? { code: 0, out: answer } : { code: 1, out: '' }
      return undefined
    },
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(1_000)
  const lease = () => JSON.parse(Object.entries(files).find(([k]) => k.endsWith('/lease/pr-poll.json'))![1])
  expect(lease()).toMatchObject({ fails: 0, failUntil: 0 })
})

test('PR poll: while another session holds the poll, this one reads the shared cache and runs nothing', async ($, on) => {
  const files: Record<string, string> = {
    '/home/u/.claude/state/cc-mods/lease/pr-poll.json': JSON.stringify({ by: 'other-sid', until: Number.MAX_SAFE_INTEGER, fails: 0, failUntil: 0 }),
  }
  const runs: string[][] = []
  // Cached a minute ago: stale enough that this session would poll on its own.
  const pr = { key: 'keyolk/cc-mods#7', state: 'OPEN', at: Date.now() - 60_000 }
  baseStubs(on, { pane: '%42', files, written: files, runs, store: { prs: { [pr.key]: pr }, 'pr-watch': { [pr.key]: { session: 'sid-1', at: Date.now() } } } })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(5 * 60_000)
  expect(runs.some((a) => a[0] === 'gh' && a[1] === 'api')).toBe(false)
})

test('a credential file changing in every session at once refreshes the radar in one of them', async ($, on) => {
  // Another session took the forced refresh a moment ago.
  const files: Record<string, string> = {
    '/home/u/.claude/state/cc-mods/lease/radar-force.json': JSON.stringify({ by: 'other-sid', until: Number.MAX_SAFE_INTEGER, fails: 0, failUntil: 0 }),
  }
  const runs: string[][] = []
  let mtime = 1
  baseStubs(on, { pane: '%42', files, written: files, runs, store: {}, mtime: (path) => (path.endsWith('hosts.yml') ? mtime : undefined) })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(11_000)
  const before = runs.filter((a) => a[0] === 'gh' && a[1] === 'auth' && a[2] === 'status').length
  mtime = 2 // a gh login somewhere
  await clock.advance(10_000)
  // No forced radar here: no gh auth status beyond what the start ran.
  const status = () => runs.filter((a) => a[0] === 'gh' && a[1] === 'auth' && a[2] === 'status').length
  expect(status()).toBe(before)
  // Its hold over, the next change is this session's to refresh.
  files['/home/u/.claude/state/cc-mods/lease/radar-force.json'] = JSON.stringify({ by: 'other-sid', until: 0, fails: 0, failUntil: 0 })
  mtime = 3
  await clock.advance(10_000)
  expect(status()).toBe(before + 1)
})

test('session start drops other sessions outputs copies the store no longer needs', async ($, on) => {
  const now = Date.now()
  const store: Record<string, unknown> = {
    sessions: { 'live-sid': { cwd: '/w', at: now - 86_400_000 }, 'old-sid': { cwd: '/w', at: now - 86_400_000 } },
    'outputs:live-sid': [{ id: 'a', kind: 'link', title: 'a', at: now - 86_400_000 }],
    'outputs:old-sid': [{ id: 'b', kind: 'link', title: 'b', at: now - 30 * 86_400_000 }],
    'outputs:gone-sid': [{ id: 'c', kind: 'link', title: 'c', at: now - 3600_000 }],
  }
  baseStubs(on, { pane: '%42', store })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.delete', (_$: any, e: any) => {
    delete store[e.key]
    return { value: undefined }
  })
  const clock = mock.clock(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  // The start notes the session without waiting on it.
  await clock.advance(100)
  // gone-sid is missing from the session map but active an hour ago: kept.
  expect(Object.keys(store).filter((k) => k.startsWith('outputs:')).sort()).toEqual(['outputs:gone-sid', 'outputs:live-sid'])
})

test('routing sends the full model id, and on a warm large context repeats the previous step instead of switching', async ($, on) => {
  baseStubs(on, {
    policyJson: JSON.stringify({ mode: 'custom', capabilities: { auto_effort: 'allow', auto_model: 'allow' } }),
    route: () => routeAnswer,
  })
  let routeAnswer = '{"effort":"low","confidence":0.95}'
  const clock = mock.clock(on)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  let ctx = 5_000
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: ctx, window: 1_000_000 }, rateLimits: [] } }) as any)
  const sent: any[] = []
  on('turn.step', (async function* (_$: any, e: any) {
    sent.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] }
  }) as any)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  // Small context: the pick lands, as a full id (never the bare alias).
  await $.prompt.submit({ text: 'rename this variable', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'r1', text: 'rename this variable' })
  for await (const _ of ($.turn as any).step({ turnId: 'r1', index: 0, model: 'claude-opus-5-5[1m]', effort: 'xhigh', messageCount: 3 })) void _
  expect(sent.at(-1)).toMatchObject({ effort: 'low', model: 'claude-sonnet-5-5[1m]' })
  // Large and warm, Jev now wants xhigh on opus: held on what the last step ran.
  ctx = 600_000
  routeAnswer = '{"effort":"xhigh","confidence":0.95}'
  await clock.advance(60_000)
  await $.prompt.submit({ text: 'also fix the typo', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'r2', text: 'also fix the typo' })
  for await (const _ of ($.turn as any).step({ turnId: 'r2', index: 0, model: 'claude-opus-5-5[1m]', effort: 'xhigh', messageCount: 9 })) void _
  expect(sent.at(-1)).toMatchObject({ effort: 'low', model: 'claude-sonnet-5-5[1m]' })
  // Idle past the TTL: the cache is cold anyway, so the new pick lands.
  await clock.advance(61 * 60_000)
  await $.prompt.submit({ text: 'now design the migration', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'r3', text: 'now design the migration' })
  for await (const _ of ($.turn as any).step({ turnId: 'r3', index: 0, model: 'claude-opus-5-5[1m]', effort: 'medium', messageCount: 11 })) void _
  expect(sent.at(-1)).toMatchObject({ effort: 'xhigh', model: 'claude-opus-5-5[1m]' })
})

test('a /goal shows on the Now tab with the evaluator verdict, and in every tab header', async ($, on) => {
  const goal = { goal: { condition: 'co-f 셀 생성·삭제 검증 완료', active: true, met: false, setAt: 1791859663, checks: 3, lastAt: 1791990975, reason: '삭제 쪽 검증이 아직 수행되지 않았습니다.', ended: '', endedAt: 0 } }
  baseStubs(on, { usage: () => ({ code: 0, out: '' }), goal })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work', transcript_path: '/t.jsonl' } as any)
  await clock.advance(0)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/🎯 co-f 셀 생성·삭제 검증 완료/)
  expect(drawn).toMatch(/3 checks/)
  expect(drawn).toMatch(/삭제 쪽 검증이 아직/)
  await ui.press({ key: 'cockpit-usage' })
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/🎯 goal · 3 checks/)
  await ui.unmount()
})

test('an MCP server needing auth logs in from the cockpit: authenticate, open the URL, finish on the pasted callback', async ($, on) => {
  const files: Record<string, string> = { 'mcp-needs-auth-cache.json': JSON.stringify({ 'sentry': { timestamp: 1 } }) }
  const runs = baseStubs(on, { files })
  const calls: any[] = []
  on('mcp.call', (_$: any, e: any) => {
    calls.push(e)
    if (e.tool === 'authenticate') return { value: { content: [{ type: 'text', text: 'Open this URL to authorize: https://api.clay.com/oauth/authorize?client_id=x&state=s' }] } } as any
    return { value: { content: [{ type: 'text', text: 'Authentication complete.' }] } } as any
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-auth' })
  // Connectors are folded behind a count: unfold, then press one.
  await ui.press({ key: 'auth-mcp-toggle' })
  await ui.press({ key: 'auth-row-mcp:sentry' })
  await clock.advance(0)
  // No /mcp in the prompt: the connector's own authenticate tool, and its URL opened.
  expect(calls[0]).toMatchObject({ server: 'sentry', tool: 'authenticate' })
  expect(runs.some((a) => a[0] === 'open' && a[1] === 'https://api.clay.com/oauth/authorize?client_id=x&state=s')).toBe(true)
  expect(JSON.stringify(await ui.drawn())).toContain('log in to sentry in the browser')
  // The browser could not reach localhost: the pasted callback finishes it.
  await ui.input({ key: 'mcp-callback', text: 'http://localhost:53682/callback?code=abc&state=s', kind: 'submit' })
  await clock.advance(0)
  expect(calls[1]).toMatchObject({ server: 'sentry', tool: 'complete_authentication', args: { callback_url: 'http://localhost:53682/callback?code=abc&state=s' } })
  expect(JSON.stringify(await ui.drawn())).toContain('sentry: logged in')
  await ui.unmount()
})

test('an MCP server login started from the cockpit finishes by itself when the callback reaches Claude Code', async ($, on) => {
  const files: Record<string, string> = { 'mcp-needs-auth-cache.json': JSON.stringify({ 'sentry': { timestamp: 1 } }) }
  baseStubs(on, { files })
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'https://api.clay.com/oauth/authorize?x=1' }] } }) as any)
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-auth' })
  // Connectors are folded behind a count: unfold, then press one.
  await ui.press({ key: 'auth-mcp-toggle' })
  await ui.press({ key: 'auth-row-mcp:sentry' })
  await clock.advance(0)
  files['mcp-needs-auth-cache.json'] = '{}'
  await clock.advance(3500)
  expect(JSON.stringify(await ui.drawn())).toContain('sentry: logged in')
  await ui.unmount()
})

test('a finished login clears that connector from Needs you at once, though the last claude mcp list still said it needed auth', async ($, on) => {
  const files: Record<string, string> = { 'mcp-needs-auth-cache.json': JSON.stringify({ gestalt: { timestamp: 1 } }) }
  // The list is read before the login and not again soon: it keeps saying so.
  const list = 'gestalt: https://gestalt.tools.acme.io/mcp (HTTP) - ! Needs authentication\n'
  baseStubs(on, { pane: '%42', files, run: (a) => (a[0] === 'claude' && a[2] === 'list' ? { code: 0, out: list } : undefined) })
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'https://gestalt.tools.acme.io/oauth/authorize?x=1' }] } }) as any)
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  await clock.advance(0)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  expect(await ui.find({ key: 'home-auth-mcp:gestalt' })).toBeDefined()
  await ui.press({ key: 'home-auth-mcp:gestalt' })
  await clock.advance(0)
  files['mcp-needs-auth-cache.json'] = '{}'
  await clock.advance(3500)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('gestalt: logged in')
  expect(await ui.find({ key: 'home-auth-mcp:gestalt' })).toBeUndefined()
  await ui.unmount()
})

test('a claude.ai connector is authorized on claude.ai from the cockpit, without /mcp', async ($, on) => {
  const files: Record<string, string> = { 'mcp-needs-auth-cache.json': JSON.stringify({ 'claude.ai Clay': { timestamp: 1 } }) }
  let connected = false
  const url = 'https://claude.ai/api/organizations/org/mcp/start-auth/mcpsrv_1?product_surface=sdk-cli'
  const runs = baseStubs(on, {
    files,
    run: (argv) =>
      argv[0] === 'claude' && argv[2] === 'login'
        ? { code: 0, out: 'Visit this URL to authorize:\n  \u001b]8;;' + url + '\u0007' + url + '\u001b]8;;\u0007\n' }
        : argv[0] === 'claude' && argv[2] === 'get'
          ? { code: connected ? 0 : 1, out: 'claude.ai Clay:\n  Status: ' + (connected ? '✔ Connected' : '! Needs authentication') }
          : undefined,
  })
  const calls: any[] = []
  on('mcp.call', (_$: any, e: any) => {
    calls.push(e)
    return { value: { content: [] } } as any
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-auth' })
  // Connectors are folded behind a count: unfold, then press one.
  await ui.press({ key: 'auth-mcp-toggle' })
  await ui.press({ key: 'auth-row-mcp:claude.ai Clay' })
  await clock.advance(0)
  expect(calls).toEqual([]) // its authenticate tool only says "run /mcp"
  expect(runs.some((a) => a[0] === 'open' && a[1] === url)).toBe(true)
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('authorize Clay on claude.ai')
  expect(await ui.find({ key: 'mcp-callback' })).toBeUndefined()
  connected = true
  await clock.advance(10_500)
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('authorized on claude.ai')
  expect(drawn).toContain('authorized · restart to use')
  await ui.unmount()
})

test('credentials have their own Auth tab, grouped by kind; the Policy tab holds only policy', async ($, on) => {
  baseStubs(on, { files: { 'mcp-needs-auth-cache.json': JSON.stringify({ 'claude.ai Clay': { timestamp: 1 } }) } })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-policy' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('auth-row-')
  await ui.press({ key: 'cockpit-auth' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('claude.ai connectors')
  expect(drawn).toContain('1 without a login')
  // Folded until asked: the org's unused connectors do not fill the tab.
  expect(await ui.find({ key: 'auth-row-mcp:claude.ai Clay' })).toBeUndefined()
  await ui.press({ key: 'auth-mcp-toggle' })
  expect(await ui.find({ key: 'auth-row-mcp:claude.ai Clay' })).toBeDefined()
  await ui.unmount()
})

test('Coder instances appear in Auth and an expired one logs into its exact deployment', async ($, on) => {
  const org = JSON.stringify({ ...JSON.parse(TEST_ORG), coderInstances: { east: 'https://coder-east.example.com', west: 'https://coder-west.example.com' } })
  const runs = baseStubs(on, {
    files: {
      '.config/cc-mods/org.json': org,
      'Library/Application Support/coderv2/url': 'https://coder-east.example.com\n',
    },
    run: (argv) => {
      if (argv[0] === 'coder' && argv[1] === 'login') return { code: 0, out: '' }
      return undefined
    },
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-auth' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Coder east')
  expect(drawn).toContain('expired')
  expect(drawn).toContain('Coder west')
  await ui.press({ key: 'auth-row-coder:east' })
  await clock.advance(0)
  expect(runs.some((a) => a.join(' ') === 'coder login https://coder-east.example.com')).toBe(true)
  await ui.unmount()
})

test('an AWS login that leaves the expiry in place says the portal session was reused, with a portal button', async ($, on) => {
  const exp = new Date(Date.now() + 25 * 60_000).toISOString()
  const files = { '7487b5b67d5fa1132cf33fa93ae51ef38cc37752.json': JSON.stringify({ startUrl: 'https://d-1234567890.awsapps.com/start', expiresAt: exp }), '.aws/config': '[profile p]\nsso_start_url = https://d-1234567890.awsapps.com/start\n' }
  const runs = baseStubs(on, { files })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-auth' })
  await ui.press({ key: 'auth-row-aws-sso' })
  await clock.advance(0)
  expect(runs.some((a) => a[0] === 'sh' && a[2]!.includes('aws sso logout') && a[2]!.includes('aws sso login') && a[3] === 'p')).toBe(true)
  expect(JSON.stringify(await ui.drawn())).toContain('login reused the portal session')
  await ui.press({ key: 'auth-alt-aws-sso' })
  expect(runs.some((a) => a.join(' ') === 'open https://d-1234567890.awsapps.com/start')).toBe(true)
  await ui.unmount()
})

test('/web --webkit (or --tauri) draws the page on the WebKit engine; an unknown engine is refused', { options: { browserEmbed: true } } as any, async ($, on) => {
  baseStubs(on, { pane: '%42' })
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [{ id: 'cc-cockpit', title: 'cockpit', isShown: true, isFocused: false, isPlaced: true }] }) as any)
  on('ui.open', () => ({ isPlaced: true }) as any)
  const spawned: string[][] = []
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  on('process.spawn', (async function* (_$: any, e: any) {
    spawned.push(e.argv)
    yield { stream: 'stdout' as const, text: '{"event":"ready"}\n' }
    await held
    return { value: { code: 0, signal: null } }
  }) as any)
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  // --tauri is tweb's old name for the WebKit engine; an unknown flag is refused.
  const w: any = await $.command.run({ command: 'web', args: '--tauri example.org', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  expect(w.text).toMatch(/Opening https:\/\/example\.org/)
  const wk = spawned.filter((a) => a.some((x) => x.endsWith('/bin/cc-browser'))).at(-1)!
  expect(wk[wk.indexOf('--engine') + 1]).toBe('webkit')
  const bad: any = await $.command.run({ command: 'web', args: '--gecko example.org', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  expect(bad.text).toMatch(/Unknown engine --gecko/)
  // Left held, as the Web tab test does: ending the stream here would run the
  // module's exit path after the test's environment is torn down.
  void release
})

test('the Web tab picks the engine by URL rule: claude.ai on Chrome, a redirect there reopens on Chrome, --electron wins; Settings edits the rules', { options: { browserEmbed: true } } as any, async ($, on) => {
  const store: Record<string, unknown> = { 'cockpit-settings': { engineRules: 'claude.ai=chrome' } }
  baseStubs(on, { pane: '%42', store })
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [{ id: 'cc-cockpit', title: 'cockpit', isShown: true, isFocused: false, isPlaced: true }] }) as any)
  on('ui.open', () => ({ isPlaced: true }) as any)
  const spawned: string[][] = []
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  on('process.spawn', (async function* (_$: any, e: any) {
    spawned.push(e.argv)
    yield { stream: 'stdout' as const, text: '{"event":"ready"}\n' }
    // example.org redirects to a claude.ai login.
    if (e.argv.includes('https://example.org')) yield { stream: 'stdout' as const, text: '{"event":"loaded","url":"https://claude.ai/login","title":"x"}\n' }
    await held
    return { value: { code: 0, signal: null } }
  }) as any)
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const engines = () => spawned.filter((a) => a.some((x) => x.endsWith('/bin/cc-browser'))).map((a) => a[a.indexOf('--engine') + 1])
  const web = (args: string) => $.command.run({ command: 'web', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  await web('claude.ai/new')
  expect(engines().at(-1)).toBe('chrome')
  const beforeRedirect = engines().length
  await web('example.org')
  // example.org itself has no rule (the default engine); its redirect to claude.ai reopens on Chrome.
  // Wait for two *new* bridges: checking only the last engine exited at once on
  // the Chrome bridge from the preceding command.
  for (let i = 0; i < 500 && engines().length < beforeRedirect + 2; i++) await Promise.resolve()
  expect(engines().slice(-2)).toEqual(['electron', 'chrome'])
  await web('--electron claude.ai')
  expect(engines().at(-1)).toBe('electron')
  // Settings: add a rule, and a pattern given again replaces its old one.
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-settings' })
  expect(await ui.find({ key: 'set-rule-claude.ai' })).toBeDefined()
  await ui.input({ key: 'set-rule-input', text: 'github.com/acme webkit', kind: 'submit' })
  await ui.input({ key: 'set-rule-input', text: 'claude.ai=webkit', kind: 'submit' })
  expect((store['cockpit-settings'] as any).engineRules).toBe('claude.ai=webkit, github.com/acme=webkit')
  await ui.press({ key: 'set-rule-github.com/acme' })
  expect((store['cockpit-settings'] as any).engineRules).toBe('claude.ai=webkit')
  await ui.unmount()
  void release
})

test('a narwhal run this session started asks in Needs you; pressing an option answers it through the daemon', async ($, on) => {
  const attention = JSON.stringify({
    items: [{ kind: 'question', run_id: 's1', request: 'install dayx locally', at: '', title: '#3 checkpoint · SessionStart hook only?',
      question: { id: 3, task_id: 'research', text: 'SessionStart hook only?', options: ['SessionStart only', 'both hooks'], recommended: 1, grounds: ['N3: UserPromptSubmit p99 55.6ms > 50ms'] } }],
  })
  const runs = baseStubs(on, {
    store: {},
    files: { '.narwhal/daemon.url': 'http://127.0.0.1:9\n' },
    run: (argv) => {
      if (argv[0] !== '/usr/bin/curl') return undefined
      const url = String(argv.at(-1))
      if (url.includes('/control/attention?session=sid-1')) return { code: 0, out: attention }
      if (url.endsWith('/control/answer')) return { code: 0, out: '{"answered":1,"open":0}' }
      return undefined
    },
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/SessionStart hook only\?/)
  expect(drawn).toMatch(/N3: UserPromptSubmit p99/)
  expect(drawn).toMatch(/SessionStart only ★/)
  await ui.press({ key: 'nw-s1#q3-o1' })
  await clock.advance(10)
  const post = runs.find((a) => a[0] === '/usr/bin/curl' && String(a.at(-1)).endsWith('/control/answer'))
  expect(post).toBeDefined()
  expect(JSON.parse(post![post!.indexOf('-d') + 1]!)).toEqual({ run_id: 's1', answers: [{ id: 3, answer: 'both hooks' }] })
  await ui.unmount()
})

test('the Work tab lists the narwhal runs this session started, and a press opens the run in a monitor split', async ($, on) => {
  const runsBody = JSON.stringify({
    runs: [{ run_id: 's9', request: 'install dayx locally', state: 'active', started_at: new Date().toISOString(), done: 1, failed: 0, running: 1, artifacts: {},
      tasks: [{ id: 'task-1', name: 'install', state: 'completed', outcome: 'binary installed' }, { id: 'task-2', name: 'hook', state: 'dispatched' }] }],
  })
  const runs = baseStubs(on, {
    store: {},
    pane: '%42',
    files: { '.narwhal/daemon.url': 'http://127.0.0.1:9\n' },
    run: (argv) => {
      if (argv[0] !== '/usr/bin/curl') return undefined
      const url = String(argv.at(-1))
      if (url.includes('/control/attention')) return { code: 0, out: '{"items":[]}' }
      if (url.includes('/control/runs?session=sid-1')) return { code: 0, out: runsBody }
      return undefined
    },
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-graph' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/install dayx locally/)
  expect(drawn).toMatch(/1\/2 done · 1 running/)
  expect(drawn).toMatch(/binary installed/)
  await ui.press({ key: 'nwrun-open-s9' })
  expect(runs.some((a) => a[0] === 'tmux' && a.includes('split-window') && a.includes('narwhal monitor --run s9'))).toBe(true)
  await ui.unmount()
})

test('an alert thread the person pastes starts RCA mode: grants, a card, and ending it reverts them', async ($, on) => {
  const runs = baseStubs(on, { pane: '%42', policyJson: JSON.stringify({ mode: 'custom', capabilities: {} }) })
  const thread = [
    '=== THREAD PARENT MESSAGE ===',
    'From: Pager <botuser-T0ACME00001-A0ACMEBOT01@slack-bots.com> (U0ACMEBOT11)',
    'Time: 2026-10-15 06:20:15 KST',
    'Message TS: 1792012815.915499',
    ':large_yellow_circle: *<https://pager.tools.acme.io/?page=incidents|[sb] [apse1] ClickHouseTooManyPartsPerPartition>*',
    '#2001  |  critical  |  source grafana',
  ].join('\n')
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ messages: thread }) }] } }) as any)
  const copied: string[] = []
  on('ui.copy', (_$: any, e: any) => {
    copied.push(e.text)
    return { value: undefined } as any
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  const policyRuns = () => runs.filter((a) => String(a[1] ?? '').endsWith('session_policy.py')).map((a) => a.slice(2).join(' '))
  // A prompt Claude or a plugin submits never grants anything.
  await $.prompt.submit({ text: 'look https://acme.slack.com/archives/C0ALERTS001/p1792012815915499', origin: { kind: 'plugin', name: 'x' }, wait: false } as any)
  expect(policyRuns().filter((r) => r.startsWith('allow') || r.startsWith('mode'))).toEqual([])
  await $.prompt.submit({ text: 'https://acme.slack.com/archives/C0ALERTS001/p1792012815915499', origin: { kind: 'composer' }, wait: false } as any)
  expect(policyRuns()).toContain('mode rca')
  expect(policyRuns()).toContain('allow slack_send --scope C0ALERTS001')
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('🚨 RCA')
  expect(drawn).toContain('ClickHouseTooManyPartsPerPartition')
  // The identity, one press from the top of any tab, names the RCA and the thread.
  await ui.press({ key: 'share-session' })
  expect(copied.at(-1)).toContain('Claude Code session sid-1')
  expect(copied.at(-1)).toContain('topic: RCA: [sb] [apse1] ClickHouseTooManyPartsPerPartition')
  expect(copied.at(-1)).toContain('https://acme.slack.com/archives/C0ALERTS001/p1792012815915499')
  await ui.press({ key: 'rca-end' })
  // Ending it puts the policy back: custom with nothing set is the default mode.
  expect(policyRuns().at(-1)).toBe('mode default')
  expect(JSON.stringify(await ui.drawn())).not.toContain('🚨 RCA')
  await ui.unmount()
})

test('Elsewhere lists working sessions too, each with a copy of its identity', async ($, on) => {
  const runs = baseStubs(on, { pane: '%42', windows: 'local|1|daily|working|none|RCA clickhouse|100|cddefc86\n', run: (argv) => (argv[0] === 'sh' && argv[3] === 'cddefc86' ? { code: 0, out: '/h/.claude/projects/-h/cddefc86.jsonl\n' } : undefined) })
  const copied: string[] = []
  on('ui.copy', (_$: any, e: any) => {
    copied.push(e.text)
    return { value: undefined } as any
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(31_000)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  expect(JSON.stringify(await ui.drawn())).toContain('1:daily')
  await ui.press({ key: 'share-local:1' })
  expect(copied.at(-1)).toContain('Claude Code session cddefc86 (working)')
  expect(copied.at(-1)).toContain('- transcript: /h/.claude/projects/-h/cddefc86.jsonl')
  void runs
  await ui.unmount()
})

test('/rca with no link starts RCA on the alert this session was handed; with none, it asks for the link', async ($, on) => {
  // Settings: no automatic RCA, so only /rca starts it.
  const runs = baseStubs(on, { pane: '%42', policyJson: JSON.stringify({ mode: 'custom', capabilities: {} }), store: { 'cockpit-settings': { rcaAuto: false } } })
  const alert = '=== THREAD PARENT MESSAGE ===\nFrom: Pager <botuser-T0ACME00001-A0ACMEBOT01@slack-bots.com> (U0ACMEBOT11)\nTime: x\nMessage TS: 1792012815.915499\n*<https://pager.tools.acme.io/|[sb] [apse1] ClickHouseTooManyPartsPerPartition>*\n#2001  |  critical  |  source grafana'
  const chat = '=== THREAD PARENT MESSAGE ===\nFrom: Sam Lee <sam@acme.com> (U0123ABCD47)\nTime: x\nMessage TS: 1792000000.000001\nlunch?'
  on('mcp.call', (_$: any, e: any) => ({ value: { content: [{ type: 'text', text: JSON.stringify({ messages: e.args.message_ts === '1792012815.915499' ? alert : chat }) }] } }) as any)
  let msgs: any[] = []
  on('session.messages', () => ({ value: msgs }))
  const filled: string[] = []
  on('prompt.fill', (_$: any, e: any) => {
    filled.push(e.text)
    return { isFilled: true } as any
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  const rca = (args: string) => $.command.run({ command: 'rca', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any) as Promise<any>
  // Nothing in the session: the command comes back for the link.
  let r = await rca('')
  expect(r.text).toMatch(/No Slack thread in this session/)
  expect(filled.at(-1)).toBe('/rca ')
  // A chat thread only: still asks.
  msgs = [{ role: 'user', text: 'see https://acme.slack.com/archives/C1/p1792000000000001', toolUses: [] }]
  r = await rca('')
  expect(r.text).toMatch(/None of the 1 Slack threads/)
  // The alert, pasted earlier: found, and RCA starts on it.
  msgs = [{ role: 'user', text: 'https://acme.slack.com/archives/C0ALERTS001/p1792012815915499', toolUses: [] }, { role: 'assistant', text: 'looking', toolUses: [] }, ...msgs]
  r = await rca('')
  expect(r.text).toMatch(/RCA mode on for \[sb\] \[apse1\] ClickHouseTooManyPartsPerPartition/)
  const policyRuns = runs.filter((a) => String(a[1] ?? '').endsWith('session_policy.py')).map((a) => a.slice(2).join(' '))
  expect(policyRuns).toContain('allow slack_send --scope C0ALERTS001')
})

test('a fork taken while the prompt still runs stops it here and moves it; taken late, it carries the topic on', async ($, on) => {
  const written: Record<string, string> = {}
  const runs = baseStubs(on, { written, pane: '%42', fork: JSON.stringify({ p: 0.9, threshold: 0.6 }), run: (argv) => (String(argv[1] ?? '').endsWith('cc_fork.py') ? { code: 0, out: '%77\n' } : undefined) })
  const aborted: string[] = []
  on('turn.abort', (_$: any, e: any) => {
    aborted.push(e.turnId)
    return { value: undefined } as any
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  // Core's compaction: only reached when the mod lets one through.
  let coreCompacted = 0
  on('session.compact', (_$: any, e: any) => {
    coreCompacted++
    return { messages: e.messages }
  })
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'fix the band', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 't1', text: 'fix the band' })
  await $.turn.complete({ turnId: 't1', answer: 'fixed', durationMs: 5, isAborted: false, usage: null } as any)
  // The separate task, offered while its turn runs.
  await $.prompt.submit({ text: 'deploy the docs site please', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 't2', text: 'deploy the docs site please' })
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  expect(JSON.stringify(await ui.drawn())).toContain('fork moves this request to a new pane and stops it here')
  // Nothing moved yet: a plugin compaction passes through to core.
  const msg = (role: string, text: string, handle: string) => ({ role, text, toolUses: [], handle })
  const transcript = [msg('user', 'fix the band', 'h1'), msg('assistant', 'fixed', 'h2'), msg('user', 'deploy the docs site please', 'h3'), msg('assistant', 'deploying', 'h4')]
  await $.session.compact({ trigger: 'plugin', messages: transcript } as any)
  expect(coreCompacted).toBe(1)
  await ui.press({ key: 'home-fork-yes' })
  expect(aborted).toEqual(['t2'])
  const prompt = Object.entries(written).find(([k]) => k.includes('/fork/pending-'))?.[1] ?? ''
  expect(prompt).toContain('멈춘 지점부터 이어서')
  expect(prompt).toContain('deploy the docs site please')
  expect(runs.some((a) => String(a[1] ?? '').endsWith('cc_fork.py'))).toBe(true)
  // Then this session's copy of the request is set aside, with no model call.
  const set = (await $.session.compact({ trigger: 'plugin', messages: transcript } as any)) as any
  expect(set.messages.map((m: any) => m.handle ?? m.text)).toEqual(['h1', 'h2', 'deploy the docs site please', expect.stringContaining('%77')])
  expect(coreCompacted).toBe(1)
  await clock.advance(2000)
  await ui.unmount()
})

test('the Web tab go field opens a picker of this session URLs; typing narrows it, a press opens one', { options: { browserEmbed: true } } as any, async ($, on) => {
  baseStubs(on, { pane: '%42' })
  on('ui.focus', () => ({ value: {} }) as any)
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.turn.start({ turnId: 'u1', text: 'x' })
  await $.turn.complete({ turnId: 'u1', answer: 'opened https://github.com/acme/ccproxy/pull/267 and https://acme.slack.com/archives/C0ALERTS001/p1792012815915499', durationMs: 5, isAborted: false, usage: null } as any)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-web' })
  expect(await ui.find({ key: 'web-pick-0' })).toBeUndefined()
  // The person moves the ring onto the go field.
  await $.ui.focus({ component: 'Pane', requestId: 'cc-cockpit', element: 'web-address', plugin: 'cc-mods', origin: { kind: 'person' } } as any)
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('from this session')
  expect(drawn).toContain('ccproxy/pull/267')
  await ui.input({ key: 'web-address', text: 'slack', kind: 'change' })
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('ccproxy/pull/267')
  expect(drawn).toContain('C0ALERTS001')
  // Elsewhere: the picker closes and forgets the query.
  await $.ui.focus({ component: 'Pane', requestId: 'cc-cockpit', element: 'cockpit-home', plugin: 'cc-mods', origin: { kind: 'person' } } as any)
  await ui.press({ key: 'cockpit-web' })
  expect(await ui.find({ key: 'web-pick-0' })).toBeUndefined()
  await ui.unmount()
})

test('by default pages open in a TWeb pane beside: /web splits one, the Web tab shows its tabs and drives it with tweb --pane', async ($, on) => {
  // The window holds this pane and, once split, %43 running TWeb.
  let split = false
  const panesJson = () => JSON.stringify(split ? [{ pane: '%43', status: { browser: 'electron', pane: '%43', presence: { link: { owner: 'cc-mods %42', expiresAt: 9e15 }, driving: null, conflictAt: null }, tabs: { active: 0, tabs: [{ active: true, index: 0, title: 'Example Domain', url: 'https://example.com/' }, { active: false, index: 1, title: 'Docs', url: 'https://docs.example.com/' }] } } }, { pane: '%9', status: { browser: 'chrome', pane: '%9', tabs: { tabs: [] } } }] : [])
  const runs = baseStubs(on, {
    pane: '%42',
    run: (a) => {
      if (a[0] === 'tmux' && a[1] === 'list-panes') return { code: 0, out: split ? '%42\n%43\n' : '%42\n' }
      if (a[0] === 'tweb' && a[1] === 'panes') return { code: 0, out: panesJson() }
      if (a[0] === 'tweb' && a[1] === 'daemon') return { code: 0, out: 'pid 597\nsocket /tmp/twebd.sock\nuptime_ms 7260000\npanes 2\nprotocol 2\nengine running (pid 85347)\n' }
      if (a[0] === 'tweb' && a[1] === 'console') return { code: 0, out: JSON.stringify({ messages: [{ at: '2026-10-21T01:00:00Z', level: 'error', message: 'Uncaught boom\n  at x.js:1' }, { at: '2026-10-21T01:00:01Z', level: 'log', message: 'ready' }] }) }
      if (a[0] === 'tweb' && a[1] === 'network') return { code: 0, out: JSON.stringify({ requests: [{ timestamp: '2026-10-21T01:00:02Z', method: 'POST', statusCode: 500, resourceType: 'fetch', url: 'https://example.com/api' }] }) }
      if (a[0] === 'tmux' && a[1] === 'split-window') {
        split = true
        return { code: 0, out: '%43\n' }
      }
      return undefined
    },
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }) as any)
  on('tool.call', () => ({ result: { stdout: 'clicked', stderr: '', interrupted: false } }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const r: any = await $.command.run({ command: 'web', args: 'example.com', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  expect(r.text).toMatch(/TWeb pane beside/)
  const sp = runs.find((a) => a[0] === 'tmux' && a[1] === 'split-window')!
  expect(sp.slice(-5)).toEqual(['tweb', 'open', '--engine', 'electron', 'https://example.com'])
  expect(sp[sp.indexOf('-t') + 1]).toBe('%42')
  // No bridge, no page drawn in the cockpit.
  expect(runs.some((a) => a.some((x) => String(x).endsWith('/bin/cc-browser')))).toBe(false)
  await clock.advance(3000)

  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-web' })
  await clock.advance(10)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('pane %43')
  // The link to tweb, and its supervisor, head the tab; the pane says it shows the cockpit as linked.
  expect(runs.some((a) => a.join(' ') === 'tweb link --owner cc-mods %42 --ttl 90 --pane %43')).toBe(true)
  expect(drawn).toContain('⇄ pane %43 shows it is linked here')
  expect(drawn).toContain('● tweb linked')
  expect(drawn).toContain('twebd 597 · up 2h1m · 2 panes hosted · engine running')
  expect(drawn).toContain('Example Domain')
  expect(drawn).toContain('docs.example.com')
  // The Chrome pane in another window is not listed; this one is driven.
  expect(drawn).not.toContain('%9')
  await ui.press({ key: 'web-side-back' })
  expect(runs.some((a) => a.join(' ') === 'tweb back --pane %43')).toBe(true)
  await ui.press({ key: 'web-side-tab-1' })
  expect(runs.some((a) => a.join(' ') === 'tweb tab switch 1 --pane %43')).toBe(true)
  // The go field navigates the pane it drives instead of splitting again.
  await ui.input({ key: 'web-address', text: 'example.org', kind: 'change' })
  await ui.input({ key: 'web-address', text: 'example.org', kind: 'submit' })
  expect(runs.some((a) => a.join(' ') === 'tweb navigate https://example.org --pane %43')).toBe(true)
  expect(runs.filter((a) => a[1] === 'split-window').length).toBe(1)
  // Console: the pane's records, read with tweb console.
  await ui.press({ key: 'web-side-panel-console' })
  await clock.advance(10)
  expect(runs.some((a) => a.join(' ') === 'tweb console --json --limit 40 --pane %43')).toBe(true)
  let shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('Uncaught boom')
  expect(shown).toContain('1 errors')
  await ui.press({ key: 'web-side-panel-network' })
  await clock.advance(10)
  shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('https://example.com/api')
  expect(shown).toContain('500')
  // Claude drives the browser: the step is logged and the badge shows, then ends.
  await $.tool.call({ tool: 'Bash', command: 'tweb snapshot --pane %43 && tweb click e3 --pane %43', tool_use_id: 'tu1' } as any)
  await ui.press({ key: 'web-side-panel-auto' })
  shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('Claude is driving')
  expect(shown).toContain('✓ click')
  expect(shown).toContain('e3')
  await clock.advance(9000)
  // Folding and reopening the panel draws the tab again.
  await ui.press({ key: 'web-side-panel-auto' })
  await ui.press({ key: 'web-side-panel-auto' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('Claude is driving')
  // tweb's own setup is not automation.
  await $.tool.call({ tool: 'Bash', command: 'tweb config list', tool_use_id: 'tu2' } as any)
  expect(JSON.stringify(await ui.drawn())).toContain('automation · 2')
  await ui.press({ key: 'web-side-focus' })
  expect(runs.some((a) => a.join(' ') === 'tmux select-pane -t %43')).toBe(true)
  await ui.press({ key: 'web-side-close' })
  expect(runs.some((a) => a.join(' ') === 'tmux kill-pane -t %43')).toBe(true)
  await ui.unmount()
})

test('the Web tab and its tab-row badge say when tweb does not answer', async ($, on) => {
  baseStubs(on, {
    pane: '%42',
    run: (a) => {
      if (a[0] === 'tmux' && a[1] === 'list-panes') return { code: 0, out: '%42\n' }
      if (a[0] === 'tweb' && a[1] === 'panes') return { code: 1, out: 'error: cannot reach twebd' }
      return undefined
    },
  })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }) as any)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-web' })
  await clock.advance(10)
  await ui.press({ key: 'cockpit-web' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('✗ tweb unreachable')
  expect(drawn).toContain('cannot reach twebd')
  expect(drawn).toContain('"children":["Web"]},{"type":"Text","props":{"color":"error"},"children":[" ✗"]}')
  await ui.unmount()
})

test('Chat shows the turn in progress under its prompt: steps, tools, what it said last; gone when it completes', async ($, on) => {
  baseStubs(on)
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  let step = 0
  on('turn.step', (async function* (_$: any, e: any) {
    step++
    return step === 1
      ? { turnId: e.turnId, index: e.index, answer: 'Checking the parts table first.', toolUses: [{ id: 'u1', name: 'Bash', input: {} }] }
      : { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ id: 'u2', name: 'Bash', input: {} }, { id: 'u3', name: 'Read', input: {} }] }
  }) as any)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'why are inserts slow', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'l1', text: 'why are inserts slow' })
  for await (const _ of ($.turn as any).step({ turnId: 'l1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 3 })) void _
  for await (const _ of ($.turn as any).step({ turnId: 'l1', index: 1, model: 'claude-opus-5-5', effort: 'medium', messageCount: 5 })) void _
  await clock.advance(10)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-flow' })
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('⏳ working · step 2 · Bash ×2 · Read')
  expect(drawn).toContain('Checking the parts table first.')
  await $.turn.complete({ turnId: 'l1', answer: 'Parts merge is blocked.', durationMs: 5, isAborted: false, usage: null } as any)
  await clock.advance(10)
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('⏳ working')
  expect(drawn).toContain('Parts merge is blocked.')
  await ui.unmount()
})

test('alt+c from the prompt opens the cockpit when it is closed (the band carries the action)', async ($, on) => {
  baseStubs(on, { pane: '%42' })
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }) as any)
  const opened: any[] = []
  on('ui.open', (_$: any, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } } as any
  })
  on('ui.focus', () => ({ value: {} }) as any)
  on('ui.render', ($$: any, e: any) => $$.ui.resolve(e).Text({ children: ['ENGINE ROW'] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const band = await $.ui.mount({ plugin: 'cc-mods', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 200, rows: 40 }, props: { bodyColumns: 196 } } as any)
  const btn: any = await band.find({ key: 'hk-cockpit-open' })
  expect(btn?.props?.action).toBe('agents:setGroup')
  await band.press({ key: 'hk-cockpit-open' })
  expect(opened.at(-1)).toMatchObject({ id: 'cc-cockpit', focus: true })
  await band.unmount()
})

test('alt+←/→ from the prompt: the cockpit takes the keyboard, the chord is replayed into it through tmux, alt+c hands it back; from a field only after the ring moves to the tab button; a refused focus replays nothing', async ($, on) => {
  const runs: string[][] = []
  const toasts: string[] = []
  baseStubs(on, { pane: '%42', runs, toasts })
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  // The prompt holds the keyboard until an open asks for it; a draft refuses it.
  let focused = false
  let draft = false
  on('ui.panes', () => ({ value: [{ id: 'cc-cockpit', title: 'cockpit', isShown: true, isFocused: focused, isPlaced: true }] }) as any)
  on('ui.open', (_$: any, e: any) => {
    if (e.focus && !draft) focused = true
    return { value: { isPlaced: true } } as any
  })
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  // The cockpit is open (mounted): its catcher carries the borrowed actions.
  expect(((await ui.find({ key: 'hk-grow' })) as any)?.props?.action).toBe('agents:previousGroup')
  expect(((await ui.find({ key: 'hk-shrink' })) as any)?.props?.action).toBe('agents:nextGroup')
  const sends = () => runs.filter((a) => a[0] === 'tmux' && a[1] === 'send-keys').map((a) => a.at(-1))
  await ui.press({ key: 'hk-shrink' })
  expect(sends()).toEqual(['M-Right', 'M-c'])
  await clock.advance(500)
  // Already in the cockpit (a text field there, PaneField binds the chord to
  // the borrowed action): the ring has to move onto the tab button first.
  // A mounted test pane cannot take a plugin's focus move, so this is the
  // refused case: nothing replayed, which would only come back to the field.
  await ui.press({ key: 'hk-grow' })
  expect(sends()).toEqual(['M-Right', 'M-c'])
  await clock.advance(500)
  // A draft in the composer refuses the focus: nothing replayed, a toast says why.
  focused = false
  draft = true
  await ui.press({ key: 'hk-grow' })
  expect(sends()).toEqual(['M-Right', 'M-c'])
  expect(toasts.some((t) => /prompt has text/.test(t))).toBe(true)
  await ui.unmount()
})

test('Auth: MCP servers the person set up come first, state from claude mcp list; a login link opens in their own Chrome', async ($, on) => {
  const list = [
    'Checking MCP server health…',
    '',
    'claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected',
    'claude.ai Clay: https://api.clay.com/v3/mcp - ! Needs authentication',
    'portal: https://platform-portal.tools.acme.io/mcp (HTTP) - ✔ Connected',
    'gestalt: https://gestalt.tools.acme.io/mcp (HTTP) - ! Needs authentication',
  ].join('\n')
  const url = 'https://claude.ai/api/organizations/org/mcp/start-auth/mcpsrv_1?product_surface=sdk-cli'
  const runs = baseStubs(on, {
    pane: '%42',
    run: (argv) =>
      argv[0] === 'claude' && argv[1] === 'mcp' && argv[2] === 'list'
        ? { code: 0, out: list }
        : argv[0] === 'claude' && argv[2] === 'login'
          ? { code: 0, out: 'Visit this URL to authorize:\n  ' + url + '\n' }
          : undefined,
  })
  on('mcp.call', () => ({ value: { content: [] } }) as any)
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await clock.advance(0)
  await clock.advance(0)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-auth' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Your MCP servers')
  expect(drawn.indexOf('Your MCP servers')).toBeLessThan(drawn.indexOf('claude.ai connectors'))
  expect(await ui.find({ key: 'auth-row-mcp:gestalt' })).toBeDefined()
  expect(drawn).toContain('1 connected · 1 without a login')
  await ui.press({ key: 'auth-mcp-toggle' })
  await ui.press({ key: 'auth-row-mcp:claude.ai Clay' })
  await clock.advance(0)
  // Not `open URL`: a headless Chrome would take it. tmux-chrome, as the person's Chrome.
  expect(runs.some((a) => a[0] === 'tmux-chrome' && a[1] === 'open' && a[2] === url)).toBe(true)
  expect(runs.some((a) => a[0] === 'open' && a[1] === url)).toBe(false)
  expect(await ui.find({ key: 'mcp-copy' })).toBeDefined()
  await ui.unmount()
})

test('a Workflow agent\'s decisions and findings land in Chat under the turn that ran it, labelled with the agent', async ($, on) => {
  baseStubs(on)
  mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('tool.call', (_$: any, e: any) =>
    e.tool === 'Workflow' ? ({ result: { status: 'async_launched', taskId: 'wtask2', runId: 'wf_def456', workflowName: 'review-changes' } } as any) : ({ result: {} } as any),
  )
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag-wf-2' }) as any)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.prompt.submit({ text: 'review with a workflow', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'tw2', text: 'review with a workflow' })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu-wf2', script: "export const meta = { name: 'review-changes', description: 'Review changed files' }" } as any)
  await $.agent.spawn({ tool_use_id: 'tu-wf2', prompt: 'review bugs', description: 'review:bugs', subagentType: 'general-purpose', workflow: { runId: 'wf_def456', agentIndex: 1 } } as any)
  await $.turn.complete({ turnId: 'tw2', answer: 'Launched the review.', durationMs: 5, isAborted: false, usage: null } as any)
  // The next prompt comes before the run's agent finishes.
  await $.prompt.submit({ text: 'meanwhile, something else', origin: { kind: 'composer' }, wait: false } as any)
  await $.turn.start({ turnId: 'tw3', text: 'meanwhile, something else' })
  await $.turn.complete({ agentId: 'ag-wf-2', turnId: 'sub1', answer: '결론: off-by-one이 하나 있습니다.\n\n## 원인\n측정 결과 루프가 n+1번 돕니다.', durationMs: 5, isAborted: false, usage: null } as any)
  const ui = await $.ui.mount<'terminal', 'Pane'>({ ...COCKPIT, surface: 'terminal' } as any)
  await ui.press({ key: 'cockpit-flow' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('⤷ review:bugs')
  expect(drawn).toContain('off-by-one')
  // Under the workflow's turn, before the later prompt.
  expect(drawn.indexOf('off-by-one')).toBeLessThan(drawn.indexOf('meanwhile, something else'))
  await ui.press({ key: 'tab-agents' })
  const agents = JSON.stringify(await ui.drawn())
  expect(agents).toContain('off-by-one')
  expect(agents).not.toContain('meanwhile, something else')
  await ui.unmount()
})

test('a command that ran and printed a policy block message is not a block: a later grant does not resume it', async ($, on) => {
  const box = { json: JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' } }) }
  const submitted: string[] = []
  baseStubs(on, { policyBox: box, submitted })
  // It ran: a grep over transcripts whose output quotes another session's block.
  on('tool.call', () => ({ result: { stdout: "BLOCKED by session policy: gh_merge is not allowed in this session.\\nTarget repo: keyolk/tweb\\n(e.g. `/policy allow merge keyolk/tweb`).", stderr: '', interrupted: false } }) as any)
  on('classic.UserPromptSubmit', () => ({}) as any)
  const clock = mock.clock(on)
  on('store.keys', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  await $.turn.start({ turnId: 'g1', text: 'look' })
  await $.tool.call({ tool: 'Bash', command: "grep -o 'BLOCKED by session policy[^\"]*' ~/.claude/projects/*/*.jsonl", description: 'x' } as any)
  await $.turn.complete({ turnId: 'g1', answer: 'found', durationMs: 5, isAborted: false, usage: null } as any)
  // One watcher tick first, so it has a stamp to see the grant change against.
  await clock.advance(11_000)
  box.json = JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'block' }, gh_merge_repos: ['keyolk/tweb'] })
  await clock.advance(11_000)
  expect(submitted.filter((t) => t.includes('세션 정책이 바뀌어'))).toEqual([])
})

test('/office restarts a server left over from older code and keeps a current one', async ($, on) => {
  // fs.stat answers mtimeMs 1 for every file, so the code on disk is
  // office.py:0,resources.py:0. The server is "old" until it is restarted.
  let stamp = 'office.py:-1,resources.py:-1'
  let alive = true
  const runs = baseStubs(on, {
    pane: '%42',
    run: (a) => {
      if (a[0] === '/usr/bin/curl' && String(a.at(-1)).endsWith('/version')) return alive ? { code: 0, out: JSON.stringify({ stamp, pid: 4242 }) } : { code: 7, out: '' }
      if (a[0] === '/usr/bin/curl') return alive ? { code: 0, out: '200' } : { code: 7, out: '000' }
      if (a[0] === 'sh' && String(a[2]).includes('kill')) { alive = false; return { code: 0, out: '' } }
      if (a[0] === 'sh' && String(a[2]).includes('nohup')) { alive = true; stamp = 'office.py:0,resources.py:0'; return { code: 0, out: '' } }
      if (a[0] === 'sh') return { code: 0, out: '' }
      return undefined
    },
  })
  mock.clock(on)
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('store.keys', () => ({ value: [] }))
  await $.session.start({ surface: null, isInteractive: true, cwd: '/work' })
  const cmd = { command: 'office', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as any
  await $.command.run(cmd)
  const kills = () => runs.filter((a) => a[0] === 'sh' && String(a[2]).includes('kill'))
  const starts = () => runs.filter((a) => a[0] === 'sh' && String(a[2]).includes('nohup'))
  expect(kills().length).toBe(1)
  expect(kills()[0]!.at(-1)).toBe('4242')
  // Only a process running office.py is stopped.
  expect(String(kills()[0]![2])).toContain('office/office.py')
  expect(starts().length).toBe(1)
  // Now current: a second /office leaves it running.
  await $.command.run(cmd)
  expect(kills().length).toBe(1)
  expect(starts().length).toBe(1)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sid-1', resume: {} } as any)
})
