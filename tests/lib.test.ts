import { loginError, loginSplitArgv, needsTerminalLogin } from '../hooks/lib/mcpauth'
import { closingAsk } from '../hooks/lib/proceed'
import { forkEffect, forkPhase, forkPrompt, movedSection, setAsideMoved } from '../hooks/lib/fork'
import { expFromAnswer, expFromTool, expNeedsYou, expPreview, expStatus, lastMessage, parseOpen, parseSums } from '../hooks/lib/exp'
import { alertContexts, alertOf, rcaGrants, restoreArgvs } from '../hooks/lib/rca'
import { identityText } from '../hooks/lib/identity'
import { cockpitColumns } from '../hooks/lib/layout'
// Pure library tests: no engine, just functions.
import { expect, test } from 'claude-code/testing'

import { argocdItems, awsItem, awsLoginReused, awsReusedItem, parseMcpList, sha1Hex, ssoProfile, ccproxyItems, credentialFor, daemonItem, ghItems, mcpItems, stateFor, worst } from '../hooks/lib/auth'
import { suggest, stackOf, parseProfiles, EMPTY } from '../hooks/lib/complete'
import { browserArgv, parseBrowser, resolveBrowser } from '../hooks/lib/browser'
import { linkArgv, linkOf, parseConsole, parseDaemonStatus, parseNetwork, parseTwebPanes, pickSidePane, sideArgv, splitArgv, twebMcpStep, twebSteps } from '../hooks/lib/webside'
import { treeRows } from '../hooks/views/home'
import { filterPalette, paletteItems } from '../hooks/lib/palette'
import { helpSections } from '../hooks/lib/help'
import { isMcpTool, looksDisconnected, mcpServerKey, normalizeServer, resultText } from '../hooks/lib/mcpheal'
import { goalChip, goalVisible, parseGoal } from '../hooks/lib/goal'
import { blockOf, nowAllowed, resumePrompt } from '../hooks/lib/unblock'
import { accountStrip, bar, cacheHit, effortMix, hookName, modelStrip, seriesBy, parseJev, parseQuota, parseUsage, share, shortModel, span, sparkline, until, usd, type Usage } from '../hooks/lib/usage'
import { ROUTE_OFF, cacheGate, decide, resolveModel, routeLabel } from '../hooks/lib/route'
import { WEB_ANCHOR, engineForUrl, engineOfTarget, parseEngine, parseEngineRules, urlPicks, urlsIn, keyBytes, sgrMouse, sgrWheel, toHex, urlFromInput } from '../hooks/lib/web'
import { isKnownTime, parseStamps, rebuild, transcriptPath } from '../hooks/lib/backfill'
import { agentFlow, flowOf, paragraphs } from '../hooks/lib/flow'
import { badge, hintsFromBlock, hintsFromCommand, isProdContext, isSelfGrant, parseChannelSearch, parsePolicy, parsePolicyArgs, parseUserSearch, scopeHints, slackTargetKind } from '../hooks/lib/policy'
import { checkVerdict, ghAccountFor, gitopsFromComments, graphqlQuery, needLabel, needsAttention, parseGraphql, prLine, repoFromGh, repoFromRemote } from '../hooks/lib/prs'
import { answerFiles, dropUnsourcedTickets, IN_ANSWER, isMade, mergeOutputs, slackOutputs, textOutputs, ticketOutputs, toolOutputs } from '../hooks/lib/record'
import { clientItems, navItems, navTarget, skipHidden } from '../hooks/lib/nav'
import { classify, decide as resumeDecide, slept } from '../hooks/lib/resume'
import { parseBrief, parseWindows as parseTmuxWindows } from '../hooks/lib/elsewhere'
import { EMPTY_ORG, ghAccountFor as orgAccount, jiraKeyPattern, org, parseOrg, setOrg, stackOf as orgStack } from '../hooks/lib/org'
import { answerBody, freshItems, itemKey, parseAttention, parseRuns, resultPrompt, runOutputs, runProgress, toastFor } from '../hooks/lib/narwhal'
import { iacDetail, iacLine, iacState, parseArgoDiff, parseCodex, parsePlan, parseWindows, regionOfDir, scopeLabel, scopeOf, windowState } from '../hooks/lib/iac'
import { mcpText, newestTs, parseChannelName, parseThread, unseenReplies, followDue } from '../hooks/lib/slack'
import { publishArgv, isPaneId } from '../hooks/lib/tmux'
import { timelineBars, mermaid } from '../hooks/views/graph'
import { visibleFlow } from '../hooks/views/flow'
import { filterOutputs, matchOutput } from '../hooks/views/outputs'


// The organisation every test runs in: made-up names, so nothing here is
// one company's (lib/org.ts reads the real ones from ~/.config/cc-mods).
setOrg({
  slack: { team: 'acme', defaultTargets: { C0123ABCD45: '#team-pr-review' } },
  jira: { baseUrl: 'https://acme.atlassian.net', projects: ['ABC', 'INF', 'SECURE', 'OPS'] },
  github: { accounts: { keyolk: 'keyolk', acme: 'work-login', 'acme-ai': 'work-login', 'work-login': 'work-login' } },
  stacks: [
    { name: 'Edge', prefixes: ['edge', 'terraform-runner-edge'] },
    { name: 'Main', prefixes: ['cloud', 'main', 'prod', 'terraform-runner', 'atlantis', 'sops'] },
  ],
  awsSsoProfiles: ['cloud', 'edge', 'terraform', 'atlantis', 'sops'],
  argocdDomains: { 'tools.acme.io': '', 'edge.acme.io': ' (edge)' },
  regionFiles: [],
})

test('self-grant: mutating session_policy calls are caught, reads are not', async () => {
  expect(isSelfGrant('python3 ~/.claude/hooks/session_policy.py allow gh_merge')).toBe('session_policy.py')
  expect(isSelfGrant('python3 ~/.claude/hooks/session_policy.py mode pr-merge')).toBe('session_policy.py')
  expect(isSelfGrant('cd x && python3 /Users/a/.claude/hooks/session_policy.py clear')).toBe('session_policy.py')
  expect(isSelfGrant('python3 ~/.claude/hooks/session_policy.py show')).toBeUndefined()
  expect(isSelfGrant('python3 ~/.claude/hooks/kubectl_prod_unlock.py prod-main --duration 15')).toBe('kubectl_prod_unlock.py')
  expect(isSelfGrant('python3 ~/.claude/hooks/secret_read_unlock.py --revoke-all')).toBeUndefined()
  expect(isSelfGrant('python3 ~/.claude/hooks/ecr_push_unlock.py --status')).toBeUndefined()
  expect(isSelfGrant('grep allow session_policy.md')).toBeUndefined()
  // Same cases as ~/.claude/hooks/test_session_policy_selfgrant.py.
  const CLI = 'python3 ~/.claude/hooks/session_policy.py'
  expect(isSelfGrant(`CLAUDE_CODE_SESSION_ID=x ${CLI} allow gh_merge`)).toBe('session_policy.py')
  expect(isSelfGrant(`bash -c '${CLI} allow gh_merge'`)).toBe('session_policy.py')
  expect(isSelfGrant(`bash <<'EOF'\n${CLI} allow gh_merge\nEOF`)).toBe('session_policy.py')
  expect(isSelfGrant(`cat > /tmp/doc.md <<'EOF'\nrun ${CLI} allow gh_merge to unlock\nEOF`)).toBeUndefined()
  expect(isSelfGrant(`python3 - <<'EOF'\ns = '${CLI} allow gh_merge'\nEOF`)).toBeUndefined()
  expect(isSelfGrant("grep -n 'session_policy.py allow' SKILL.md")).toBeUndefined()
  expect(isSelfGrant("echo 'type: session_policy.py mode release'")).toBeUndefined()
})

test('policy: parse file, badge, and /policy arguments', async () => {
  const p = parsePolicy(JSON.stringify({ mode: 'custom', capabilities: { gh_merge: 'allow', prod_eks_access: 'allow' } }))
  expect(p.caps.gh_merge).toBe('allow')
  expect(p.caps.tmux_window_escape).toBe('block')
  expect(badge(p)).toBe('merge🔓 prod:ro')
  expect(badge(parsePolicy(undefined))).toBe('merge🔒')
  const scoped = parsePolicy(JSON.stringify({ capabilities: { gh_merge: 'block' }, gh_merge_repos: ['acme/infra-k8s'] }))
  expect(badge(scoped)).toBe('merge(1)')

  expect(parsePolicyArgs('')).toEqual({ argv: ['show'] })
  expect(parsePolicyArgs('mode release')).toEqual({ argv: ['mode', 'release'] })
  expect('error' in parsePolicyArgs('mode bogus')).toBe(true)
  const timed = parsePolicyArgs('allow merge acme/infra-k8s 15m')
  expect(timed).toEqual({
    argv: ['allow', 'gh_merge', '--repo', 'acme/infra-k8s'],
    ttlMs: 900000,
    revert: ['inherit', 'gh_merge', '--repo', 'acme/infra-k8s'],
  })
  expect(parsePolicyArgs('allow prod-w main-prod-apne2/kube-system')).toEqual({
    argv: ['allow', 'prod_eks_write', '--scope', 'main-prod-apne2/kube-system'],
    ttlMs: undefined,
    revert: undefined,
  })
  expect('error' in parsePolicyArgs('allow nope')).toBe(true)
})

test('auth: expiry states, gh status parsing, credential mapping', async () => {
  const now = Date.parse('2026-10-13T12:00:00Z')
  expect(stateFor(now - 1, now)).toBe('expired')
  expect(stateFor(now + 10 * 60_000, now)).toBe('soon')
  expect(stateFor(now + 3 * 3_600_000, now)).toBe('ok')
  expect(awsItem(JSON.stringify({ expiresAt: '2026-10-13T12:20:00Z' }), 'https://x/start', now).state).toBe('soon')
  expect(awsItem(undefined, 'https://x/start', now).state).toBe('expired')
  // aws sso login takes a profile, never the start URL (there is no such flag).
  expect(awsItem(undefined, 'https://x/start', now, 'cloud-a').fix).toEqual(['sh', '-c', 'aws sso logout --profile "$0"; aws sso login --profile "$0"', 'cloud-a'])
  expect(awsItem(undefined, 'https://x/start', now).fix).toBeUndefined()
  const cfg = '[profile other]\nsso_start_url = https://y/start\n\n[profile cloud-a]\nsso_start_url = https://x/start\nregion = us-east-1\n\n[profile via-session]\nsso_session = s\n[sso-session s]\nsso_start_url = https://z/start/\n'
  expect(ssoProfile(cfg, 'https://x/start')).toBe('cloud-a')
  expect(ssoProfile(cfg, 'https://z/start')).toBe('via-session')
  expect(ssoProfile(cfg, 'https://none/start')).toBeUndefined()

  const gh = ghItems(
    'github.com\n  ✓ Logged in to github.com account work-login (keyring)\n  - Active account: true\n  X Failed to log in to github.com account keyolk (keyring)\n',
  )
  expect(gh.map((g) => [g.id, g.state])).toEqual([
    ['gh:work-login', 'ok'],
    ['gh:keyolk', 'expired'],
  ])
  expect(gh[0]!.detail).toBe('active')
  expect(mcpItems('{"claude.ai Sentry":1}')[0]).toMatchObject({ label: 'MCP Sentry', state: 'unknown' })
  expect(worst([...gh])).toBe('expired')
  expect(credentialFor('aws s3 ls --profile edge-dev --region ap-northeast-2')).toBe('aws-sso')
  expect(credentialFor('kubectl --context main-prod-apne2 get pods')).toBe('aws-sso')
  expect(credentialFor('ls -la')).toBeUndefined()
})

test('flow: conclusion first, headings kept, progress folded', async () => {
  const md = [
    '설치된 2.1.287에는 아직 없습니다.',
    '',
    '## 확인 결과',
    '`prompt.autocomplete`가 0건입니다.',
    '',
    '확인하는 중입니다.',
    '',
    '```\ncode\n```',
    '',
    '| a | b |',
    '',
    '첫 프로토타입으로 /flow를 추천합니다.',
  ].join('\n')
  expect(paragraphs(md)).toEqual(['설치된 2.1.287에는 아직 없습니다.', '§ 확인 결과 `prompt.autocomplete`가 0건입니다.', '확인하는 중입니다.', '첫 프로토타입으로 /flow를 추천합니다.'])
  const f = flowOf(md, 't1', 0)
  expect(f.map((x) => x.kind)).toEqual(['conclusion', 'finding', 'progress', 'decision'])
  expect(visibleFlow(f, 'all', false).map((x) => x.kind)).toEqual(['conclusion', 'finding', 'decision'])
  expect(visibleFlow(f, 'conclusions', false).map((x) => x.kind)).toEqual(['conclusion'])
})

test('outputs: tool results and text become typed outputs', async () => {
  const pr = toolOutputs(
    'Bash',
    { command: 'gh pr create --title x' },
    { result: { stdout: 'https://github.com/acme/infra-k8s/pull/9159\n', gitOperation: { pr: { number: 9159, url: 'https://github.com/acme/infra-k8s/pull/9159', action: 'created' } } } },
    1,
  )
  expect(pr).toEqual([{ id: 'pr:acme/infra-k8s#9159', kind: 'pr', title: 'acme/infra-k8s#9159', url: 'https://github.com/acme/infra-k8s/pull/9159', at: 1, detail: 'created' }])

  // An upstream PR a command merely printed (a search, a `gh pr list`) is a
  // mention: it does not become one of this session's PRs.
  const seen = toolOutputs('Bash', { command: 'gh search prs cliproxy' }, { result: { stdout: 'https://github.com/router-for-me/CLIProxyAPI/pull/6382\n' } }, 1)
  expect(seen).toMatchObject([{ kind: 'pr', title: 'router-for-me/CLIProxyAPI#6382', detail: 'mentioned' }])
  expect(isMade(seen[0]!)).toBe(false)

  const bg = toolOutputs('Bash', { command: 'sleep 9', description: 'wait' }, { result: { stdout: '', backgroundTaskId: 'b8ahc3vr1' } }, 2)
  expect(bg[0]).toMatchObject({ kind: 'bg', title: 'wait', detail: 'b8ahc3vr1' })

  const scr = toolOutputs('Write', { file_path: '/private/tmp/claude-502/-Users-x/abc/scratchpad/note.md' }, { result: {} }, 3)
  expect(scr[0]).toMatchObject({ kind: 'scratch', title: 'note.md' })

  const art = toolOutputs('Artifact', { file_path: '/x/report.html' }, { result: { url: 'https://claude.ai/code/artifact/123', version: '2', title: 'Report' } }, 4)
  expect(art[0]).toMatchObject({ kind: 'artifact', title: 'Report', detail: 'v2' })

  expect(toolOutputs('Bash', { command: 'x' }, { deny: 'no' }, 5)).toEqual([])

  const text = textOutputs('see ABC-12155 and https://acme.slack.com/archives/C0123ABCD45/p1791964929501939 and ABC-12155', 6)
  expect(text.map((o) => o.kind)).toEqual(['ticket', 'slack'])

  // A reply's permalink and the root's are the same thread.
  const root = slackOutputs('https://acme.slack.com/archives/C0123ABCD45/p1791964929501939', 1)
  const reply = slackOutputs('<https://acme.slack.com/archives/C0123ABCD45/p1791965000123456?thread_ts=1791964929.501939&cid=C0123ABCD45>', 2)
  expect(root[0]!.id).toBe('slack:C0123ABCD45:1791964929.501939')
  expect(reply[0]!.id).toBe(root[0]!.id)
  expect(reply[0]!.url).toBe('https://acme.slack.com/archives/C0123ABCD45/p1791964929501939')
  expect(root[0]!.title).toMatch(/^Slack · C0123ABCD45 · \d\d\/\d\d \d\d:\d\d$/)
  // Slack tools: a read names the thread in its input; a send returns a permalink.
  const read = toolOutputs('mcp__claude_ai_Slack__slack_read_thread', { channel_id: 'C0123ABCD45', message_ts: '1791964929.501939' }, { result: {} }, 3)
  expect(read.map((o) => [o.id, o.detail])).toEqual([['slack:C0123ABCD45:1791964929.501939', 'read']])
  const sent = toolOutputs('mcp__claude_ai_Slack__slack_send_message', { channel_id: 'C0123ABCD45', message: 'x' }, { text: 'Sent: https://acme.slack.com/archives/C0123ABCD45/p1791970000000001' }, 4)
  expect(sent.map((o) => [o.id, o.detail])).toEqual([['slack:C0123ABCD45:1791970000.000001', 'posted']])

  const merged = mergeOutputs(pr, [...bg, ...pr])
  expect(merged.map((o) => o.id)).toEqual(['bg:b8ahc3vr1', 'pr:acme/infra-k8s#9159'])
  expect(filterOutputs([...merged, ...scr], 'all').length).toBe(3)
  expect(filterOutputs(toolOutputs('Write', { file_path: '/repo/a.ts' }, { result: {} }, 1), 'all').length).toBe(0)
})

test('prs: graphql round trip, attention, account mapping', async () => {
  const refs = [{ repo: 'acme/infra-k8s', number: 9159 }]
  expect(graphqlQuery(refs)).toContain('repository(owner: "acme", name: "infra-k8s")')
  const body = JSON.stringify({
    data: {
      p0: {
        pullRequest: {
          url: 'u', title: 't', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
          reviews: { totalCount: 3 },
          reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
        },
      },
    },
  })
  const [s] = parseGraphql(body, refs, 7)
  expect(s).toMatchObject({ key: 'acme/infra-k8s#9159', checks: 'pass', approvals: 3, unresolved: 1 })
  expect(needsAttention(s!)).toBe('threads')
  expect(ghAccountFor('keyolk/cc-mods')).toBe('keyolk')
  expect(ghAccountFor('acme/infra-k8s')).toBe('work-login')
  expect(ghAccountFor('torvalds/linux')).toBeUndefined()
  expect(repoFromRemote('git@github.com:keyolk/cc-mods.git\n')).toBe('keyolk/cc-mods')
  expect(repoFromRemote('https://github.com/acme/infra-k8s')).toBe('acme/infra-k8s')
  expect(repoFromGh('gh pr view 3 --repo keyolk/twm')).toBe('keyolk/twm')
  expect(repoFromGh('gh pr view https://github.com/acme/proxy/pull/24')).toBe('acme/proxy')
})

test('autocomplete: stacks never mix, flags narrow the source', async () => {
  const src = {
    ...EMPTY,
    contexts: ['main-prod-apne2', 'edge-dev-apne2', 'prod-ops-apne2'],
    profiles: parseProfiles('[profile cloud-chat-prod]\nx=1\n[profile edge-dev]\n'),
    tickets: ['ABC-12155'],
    prs: [{ key: 'acme/infra-k8s#9159', title: 'gate' }],
  }
  expect(stackOf('edge-dev')).toBe('Edge')
  expect(stackOf('cloud-chat-prod')).toBe('Main')
  expect(suggest('main-p', 'kubectl --context main-p', src).map((s) => s.text)).toEqual(['main-prod-apne2'])
  expect(suggest('edg', 'kubectl --context edg', src)[0]).toEqual({ text: 'edge-dev-apne2', label: 'edge-dev-apne2', description: 'kubectl · Edge' })
  expect(suggest('--profile=cl', '--profile=cl', src)[0]!.text).toBe('--profile=cloud-chat-prod')
  expect(suggest('ABC-1', 'see ABC-1', src)[0]!.text).toBe('ABC-12155')
  expect(suggest('#91', 'merge #91', src)[0]!.text).toBe('acme/infra-k8s#9159')
  expect(suggest('a', 'a', src)).toEqual([])
})

test('tmux: publish argv stays on one pane and keeps the contract', async () => {
  expect(isPaneId('%197')).toBe(true)
  expect(isPaneId('$P')).toBe(false)
  const argv = publishArgv('%7', { state: 'waiting', attention: 'ask', session: 's1', extra: { '@cc_ctx': '42', '@cc_bad key': 'x', '@cc_auth': '' } }, 100)
  expect(argv).toEqual([
    ['set-window-option', '-t', '%7', '@cc_state', 'waiting'],
    ['set-window-option', '-t', '%7', '@cc_since', '100'],
    ['set', '-p', '-t', '%7', '@cc_pane_state', 'waiting'],
    ['set', '-p', '-t', '%7', '@cc_pane_since', '100'],
    ['set-window-option', '-t', '%7', '@cc_attention', 'ask'],
    ['set-window-option', '-t', '%7', '@cc_session', 's1'],
    ['set', '-p', '-t', '%7', '@cc_pane_session', 's1'],
    ['set-window-option', '-t', '%7', '@cc_ctx', '42'],
    ['set-window-option', '-t', '%7', '-u', '@cc_auth'],
  ])
})

test('graph: timeline bars overlap for parallel agents, mermaid nests', async () => {
  const a = { id: 'a', toolUseId: 'a', turnId: 't', type: 'Explore', description: 'x', prompt: '', status: 'completed' as const, startedAt: 0, endedAt: 50, tools: 0, kind: 'agent' as const }
  const b = { ...a, id: 'b', toolUseId: 'b', startedAt: 25, endedAt: 100, parentId: 'a' }
  const bars = timelineBars([a, b], 100, 8)
  expect(bars.map((x) => x.bar)).toEqual(['████    ', '  ██████'])
  expect(mermaid([{ turnId: 't', text: 'q', at: 0, tools: {} }], [a, b])).toContain('na --> nb')
})

import { unlockFor } from '../hooks/lib/unlock'

test('unlock: guard refusals map to the unlock the person can grant', async () => {
  const k = unlockFor(
    "BLOCKED: Non-readonly operation 'delete' on production cluster 'main-prod-apne2'.\n",
    'Bash',
    { command: 'kubectl --context main-prod-apne2 delete pod x' },
    '/h',
  )
  expect(k?.argv).toEqual(['python3', '/h/.claude/hooks/kubectl_prod_unlock.py', 'main-prod-apne2', '--duration', '15'])
  const sec = unlockFor('BLOCKED by secret_read_guard: this would pull\n\n  - /Users/x/.config/gh/hosts.yml\n', 'Read', { file_path: '/Users/x/.config/gh/hosts.yml' }, '/h')
  expect(sec?.argv.slice(1, 3)).toEqual(['/h/.claude/hooks/secret_read_unlock.py', '/Users/x/.config/gh/hosts.yml'])
  expect(unlockFor('ecr_push_guard: image built from a scratchpad (provenance)', 'Bash', {}, '/h')?.argv[1]).toBe('/h/.claude/hooks/ecr_push_unlock.py')
  expect(unlockFor('BLOCKED by session policy: gh_merge is not allowed', 'Bash', {}, '/h')).toBeUndefined()
})

test('flow: a lone heading folds into the paragraph under it, a heading with a body does not', async () => {
  expect(paragraphs('결론.\n\n## 원인 확인 결과\n\n3건입니다.')).toEqual(['결론.', '§ 원인 확인 결과 — 3건입니다.'])
  expect(paragraphs('## 확인 결과\n본문입니다.\n\n다음.')).toEqual(['§ 확인 결과 본문입니다.', '다음.'])
  expect(paragraphs('## A\n\n## B\n\n본문')).toEqual(['§ A', '§ B — 본문'])
})

import { ago, clip, hhmm, width, pad } from '../hooks/lib/text'

test('text: clip and pad count terminal cells, Hangul as two', async () => {
  expect(width('한글ab')).toBe(6)
  expect(clip('가나다라마바', 7)).toBe('가나다…')
  expect(width(clip('원인을 확인하지 못했습니다 because', 20))).toBeLessThan(21)
  expect(pad('가', 4)).toBe('가  ')
})

import { LONG_WATCH_MS, REARM_CAP, isWrite, parseExpiry, parseMonitor, shouldRearm, startedTaskId, turnMattered, watchInput, weigh } from '../hooks/lib/monitor'

const NOTE = (event: string) =>
  '<task-notification>\n<task-id>bjl0wayla</task-id>\n<summary>Monitor event: "doppler-config PR #412 팔로우업"</summary>\n<event>' +
  event +
  '</event>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>'

test('monitor: parse a Monitor notification, ignore anything else', async () => {
  expect(parseMonitor(NOTE('PR_EVENT pr=https://github.com/a/b/pull/1 checks=pending'))).toEqual({
    taskId: 'bjl0wayla',
    summary: 'doppler-config PR #412 팔로우업',
    event: 'PR_EVENT pr=https://github.com/a/b/pull/1 checks=pending',
  })
  expect(parseMonitor('hello')).toBeUndefined()
  expect(parseMonitor('<task-notification><task-id>x</task-id><summary>Background command "sleep" completed</summary></task-notification>')).toBeUndefined()
})

test('monitor: an expiry notice names its task; events and other notices do not', async () => {
  expect(parseExpiry(NOTE('[Monitor expired after 30m with no events delivered. Re-arm it if you still need the watch.]'))).toEqual({ taskId: 'bjl0wayla' })
  expect(parseExpiry(NOTE('[Monitor expired after 30m with 4 events delivered. Re-arm it if you still need the watch.]'))).toEqual({ taskId: 'bjl0wayla' })
  expect(parseExpiry(NOTE('THREAD_REPLY channel=C1 from=x :: Monitor expired after lunch'))).toBeUndefined()
  expect(parseExpiry('hello')).toBeUndefined()
})

test('monitor: the started task id comes from the record or the text', async () => {
  expect(startedTaskId({ result: { taskId: 'b1' } })).toBe('b1')
  expect(startedTaskId({ result: {}, text: 'Monitor started (task b3fp96b73, expires in 30m unless the source ends first)' })).toBe('b3fp96b73')
  expect(startedTaskId({ result: {}, text: 'nothing here' })).toBeUndefined()
})

test('monitor: only a long watch with its input and under the cap is re-armed', async () => {
  const input = watchInput({ description: 'd', timeout_ms: LONG_WATCH_MS, command: 'watch.sh' })!
  expect(input).toEqual({ description: 'd', timeout_ms: LONG_WATCH_MS, command: 'watch.sh' })
  expect(watchInput({ description: 'd', timeout_ms: 1000 })).toBeUndefined() // neither command nor ws
  const row = { taskId: 't', summary: 'd', last: '', label: '', at: 0, quiet: 0, acted: 0 }
  expect(shouldRearm({ ...row, input })).toBe(true)
  expect(shouldRearm({ ...row })).toBe(false) // started before the mod knew it
  expect(shouldRearm({ ...row, input: { ...input, timeout_ms: 300_000 } })).toBe(false) // a deadline the model set
  expect(shouldRearm({ ...row, input, rearms: REARM_CAP })).toBe(false)
  expect(shouldRearm(undefined)).toBe(false)
})

test('monitor: routine PR ticks fold, failures/conflicts/merges/reviews show', async () => {
  const w = (e: string) => weigh(parseMonitor(NOTE(e))!).weight
  expect(w('PR_EVENT pr=x checks=pending')).toBe('routine')
  expect(w('PR_EVENT pr=x checks=passing merge=blocked')).toBe('routine')
  expect(w('PR_EVENT pr=x sha=abc1234')).toBe('routine')
  expect(w('PR_EVENT pr=x issue_comments=3@2026-10-13T00:00:00Z')).toBe('routine')
  expect(w('PR_EVENT pr=x checks=failing')).toBe('act')
  expect(w('PR_EVENT pr=x merge=conflicted')).toBe('act')
  expect(w('PR_EVENT pr=x decision=CHANGES_REQUESTED')).toBe('act')
  expect(w('PR_EVENT pr=x unresolved=2')).toBe('act')
  expect(w('PR_DONE state=MERGED')).toBe('act')
  expect(weigh(parseMonitor(NOTE('PR_EVENT pr=x checks=passing merge=blocked'))!).label).toBe('checks passing · merge blocked')
})

test('monitor: a routine tick matters only if the turn wrote or needs the person', async () => {
  expect(isWrite('Bash', { command: 'gh pr view 1 --json state' })).toBe(false)
  expect(isWrite('Bash', { command: 'git push origin HEAD' })).toBe(true)
  expect(isWrite('Bash', { command: 'gh api repos/a/b/pulls/1/comments -X POST -f body=x' })).toBe(true)
  expect(isWrite('Edit', {})).toBe(true)
  expect(turnMattered('routine', false, '체크가 아직 진행 중입니다. 다음 이벤트를 기다립니다.')).toBe(false)
  expect(turnMattered('routine', true, '수정해서 push했습니다.')).toBe(true)
  expect(turnMattered('routine', false, '리뷰어 결정이 필요합니다. 어떻게 할까요?')).toBe(true)
  expect(turnMattered('act', false, '')).toBe(true)
})

test('backfill: a loaded transcript rebuilds flow, turns, outputs and the work graph', async () => {
  const msgs = [
    { role: 'user', text: 'resume된 세션도 보여줘', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'tu1', tool: 'Write', input: { file_path: '/repo/a.ts' }, result: {}, text: 'ok' },
        { tool_use_id: 'tu2', tool: 'Agent', input: { description: 'find code', prompt: 'look', subagent_type: 'Explore' }, agentId: 'ag1', text: 'found it', durationMs: 4000 },
        { tool_use_id: 'tu3', tool: 'Bash', input: { command: 'sleep 9', description: 'wait' }, result: { backgroundTaskId: 'b1' }, text: 'started' },
        { tool_use_id: 'tu4', tool: 'Bash', input: { command: 'sleep 1', description: 'lost' }, result: { backgroundTaskId: 'b2' }, text: 'started' },
        { tool_use_id: 'tu5', tool: 'Edit', input: { file_path: '/repo/b.ts' }, text: 'nope', isError: true as const },
      ],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{}] },
    { role: 'assistant', text: '결론입니다. https://github.com/keyolk/cc-mods/pull/7 를 열었습니다.', toolUses: [] },
    { role: 'user', text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>', toolUses: [] },
    { role: 'user', text: '다음 요청', toolUses: [] },
  ]
  const t0 = Date.parse('2026-10-14T01:00:00Z')
  const jsonl = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-14T01:00:00Z', message: { content: 'resume된 세션도 보여줘' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-14T01:00:05Z', message: { content: [{ type: 'tool_use', id: 'tu1' }, { type: 'tool_use', id: 'tu2' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-14T01:00:06Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-14T01:05:00Z', message: { content: [{ type: 'text', text: '다음 요청' }] } }),
    'not json',
  ].join('\n')
  const stamps = parseStamps(jsonl)
  expect(stamps.prompts.length).toBe(2)
  expect(stamps.tools.tu2).toBe(t0 + 5000)

  const r = rebuild(msgs, stamps, false)
  expect(r.turns.map((t) => t.text)).toEqual(['resume된 세션도 보여줘', '다음 요청'])
  expect(r.turns[0]!.at).toBe(t0)
  expect(r.turns[0]!.endedAt).toBe(t0 + 300_000)
  expect(r.turns[0]!.tools).toEqual({ Write: 1, Agent: 1, Bash: 2, Edit: 1 })
  // The subagent's answer adds its conclusion, labelled, under the same turn.
  expect(r.flow.map((f) => f.kind + (f.by ? '@agent' : ''))).toEqual(['prompt', 'conclusion@agent', 'conclusion', 'prompt'])
  const ids = r.outputs.map((o) => o.id)
  expect(ids).toContain('file:/repo/a.ts')
  expect(ids).toContain('pr:keyolk/cc-mods#7')
  expect(ids).toContain('bg:b1')
  // an errored edit produced nothing
  expect(ids).not.toContain('file:/repo/b.ts')
  const byId = Object.fromEntries(r.agents.map((a) => [a.id, a]))
  expect(byId.ag1!.status).toBe('completed')
  expect(byId.ag1!.endedAt).toBe(t0 + 5000 + 4000)
  expect(byId['bg:b1']!.status).toBe('completed')
  // not live: an unfinished task of the old process is not drawn as running
  expect(byId['bg:b2']!.status).toBe('killed')
  expect(rebuild(msgs, stamps, true).agents.find((a) => a.id === 'bg:b2')!.status).toBe('background')
})

test('backfill: without a transcript file, order holds and times read as earlier', async () => {
  const msgs = [
    { role: 'user', text: 'first', toolUses: [] },
    { role: 'assistant', text: 'answer one', toolUses: [{ tool_use_id: 'x', tool: 'Write', input: { file_path: '/r/x' }, text: 'ok' }] },
    { role: 'user', text: 'second', toolUses: [] },
  ]
  const r = rebuild(msgs)
  expect(r.turns.map((t) => t.text)).toEqual(['first', 'second'])
  expect(r.turns.every((t) => !isKnownTime(t.at))).toBe(true)
  expect(r.turns[0]!.at < r.turns[1]!.at).toBe(true)
  expect(ago(r.turns[0]!.at, Date.now())).toBe('earlier')
  expect(hhmm(r.turns[0]!.at)).toBe('--:--')
  expect(transcriptPath('/h', '/Users/a/src/x.y', 's1')).toBe('/h/.claude/projects/-Users-a-src-x-y/s1.jsonl')
})

test('daemon: a stale auth_required file is ok once the supervisor says the token is valid', async () => {
  const since = Date.parse('2026-10-11T20:36:14Z')
  const status = JSON.stringify({ status: 'auth_required', since })
  expect(daemonItem(status)!.state).toBe('expired')
  const ok = '[2026-10-13T16:53:46.263Z] [supervisor] auth: proactive refresh failed, retrying in ~60s (token still valid)\n[2026-10-13T16:54:46.329Z] [supervisor] auth: token still valid (cross-process refresh or not yet due)'
  expect(daemonItem(status, ok)).toMatchObject({ state: 'ok' })
  const bad = '[2026-10-13T16:54:46.329Z] [supervisor] auth: refresh failed: invalid_grant'
  expect(daemonItem(status, bad)!.state).toBe('expired')
  // A line older than the failure says nothing about it.
  expect(daemonItem(status, '[2026-10-10T00:00:00Z] [supervisor] auth: token still valid')!.state).toBe('expired')
  expect(daemonItem(JSON.stringify({ status: 'ok' }))!.state).toBe('ok')
})

test('argocd: token exp decoded per login; long-expired logins do not count', async () => {
  const jwt = (exp: number) => 'h.' + btoa(JSON.stringify({ exp: Math.floor(exp / 1000), name: 'x' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.s'
  const now = Date.parse('2026-10-14T05:00:00+09:00')
  const cfg = [
    'contexts:',
    '- name: argocd.tools.acme.io',
    'users:',
    '- auth-token: ' + jwt(now - 2 * 3_600_000),
    '  name: argocd.tools.acme.io',
    '- auth-token: ' + jwt(now - 200 * 86_400_000),
    '  name: argocd-kb.tools.acme.io',
    '- auth-token: ' + jwt(now + 4 * 3_600_000),
    '  name: argocd.edge.acme.io',
    '- name: kubernetes',
  ].join('\n')
  const items = argocdItems(cfg, now)
  expect(items.map((i) => [i.label, i.state])).toEqual([
    ['ArgoCD argocd', 'expired'],
    ['ArgoCD argocd-kb', 'unknown'],
    ['ArgoCD argocd (edge)', 'ok'],
  ])
  expect(items[0]!.fix).toEqual(['argocd', 'login', 'argocd.tools.acme.io', '--sso', '--grpc-web'])
  expect(JSON.stringify(items)).not.toContain('h.')
  expect(worst(items)).toBe('expired')
  expect(argocdItems(undefined, now)).toEqual([])
})

test('ccproxy: state from ccproxy, remaining quota as detail, low quota alone stays ok', async () => {
  const json = JSON.stringify({
    accounts: [
      { name: 'claude-acme', state: 'ready', stale_quota: true, budget: { kind: 'windows', five_hour: { left_pct: 96.4 }, seven_day: { left_pct: 7 } } },
      { name: 'claude-personal', state: 'cooldown', cooldown: 'retry after 3h · unified quota exhausted', budget: { kind: 'windows', five_hour: { left_pct: 0 }, seven_day: { left_pct: 40 } } },
      { name: 'codex-acme', state: 'auth-failed', budget: { kind: 'spend_cap', capped: false } },
      { name: 'cursor', state: 'ready', budget: { kind: 'pool', pool_name: 'api', pool: { left_pct: 100 } } },
      { name: 'kiro', state: 'ready', stale_quota: true, budget: { kind: 'none', reason: 'no usage API' } },
      { name: 'old', state: 'disabled', budget: { kind: 'none' } },
    ],
  })
  const items = ccproxyItems(json)
  expect(items.map((i) => [i.label, i.state, i.detail])).toEqual([
    ['ccproxy claude-acme', 'ok', '5h 96% · 7d 7% left (last known)'],
    ['ccproxy claude-personal', 'soon', 'cooldown · retry after 3h · unified quota exhausted · 5h 0% · 7d 40% left'],
    ['ccproxy codex-acme', 'expired', 'auth-failed · not capped'],
    ['ccproxy cursor', 'ok', 'api pool 100% left'],
    ['ccproxy kiro', 'ok', 'no usage API'],
    ['ccproxy old', 'unknown', 'disabled · no usage API'],
  ])
  expect(ccproxyItems('usage: ccproxy status')).toEqual([])
  expect(ccproxyItems(undefined)).toEqual([])
})

test('browser: choices parse, inherit unsets the pane option', async () => {
  expect(parseBrowser('tweb-chrome')).toBe('tweb-chrome')
  expect(parseBrowser(' ')).toBe('inherit')
  expect(parseBrowser(undefined)).toBe('inherit')
  expect(parseBrowser('firefox')).toBeUndefined()
  expect(browserArgv('%7', 'tweb')).toEqual(['set-option', '-p', '-t', '%7', '@browser', 'tweb'])
  expect(browserArgv('%7', 'inherit')).toEqual(['set-option', '-p', '-t', '%7', '-u', '@browser'])
  // Resolved as tmux-chrome's open does: env, pane, window, global, the old flag, else chrome.
  expect(resolveBrowser({})).toBe('chrome')
  expect(resolveBrowser({ pane: 'tweb', window: 'chrome' })).toBe('tweb')
  expect(resolveBrowser({ env: 'tweb-webkit', pane: 'tweb' })).toBe('tweb-webkit')
  expect(resolveBrowser({ window: '', global: 'tweb-chrome' })).toBe('tweb-chrome')
  expect(resolveBrowser({ twebFlag: '1' })).toBe('tweb')
  expect(resolveBrowser({ twebFlag: '0' })).toBe('chrome')
  expect(resolveBrowser({ pane: 'tweb-tauri' })).toBe('tweb-webkit')
  expect(resolveBrowser({ pane: 'firefox' })).toBe('chrome')
})

test('web: anchor, SGR mouse and wheel, key bytes', async () => {
  expect(WEB_ANCHOR).toBe('│ go:')
  expect(urlFromInput('https://a.b/c?d=1')).toBe('https://a.b/c?d=1')
  expect(urlFromInput('github.com/keyolk/tweb')).toBe('https://github.com/keyolk/tweb')
  expect(urlFromInput('localhost:5173')).toBe('http://localhost:5173')
  expect(urlFromInput('about:blank')).toBe('about:blank')
  expect(urlFromInput('kitty graphics protocol')).toBe('https://www.google.com/search?q=kitty%20graphics%20protocol')
  expect(urlFromInput('   ')).toBeUndefined()
  expect(toHex('a\x1b')).toBe('611b')
  expect(sgrMouse({ t: 'p', type: 'down', x: 0, y: 0, button: 'left' })).toBe('\x1b[<0;1;1M')
  expect(sgrMouse({ t: 'p', type: 'up', x: 9, y: 4, button: 'left' })).toBe('\x1b[<0;10;5m')
  expect(sgrMouse({ t: 'p', type: 'move', x: 2, y: 3 })).toBe('\x1b[<35;3;4M')
  expect(sgrMouse({ t: 'p', type: 'down', x: 1, y: 1, button: 'right', ctrl: true })).toBe('\x1b[<18;2;2M')
  expect(sgrMouse({ t: 'p', type: 'enter', x: 0, y: 0 })).toBeUndefined()
  expect(sgrWheel(true, 4, 2)).toBe('\x1b[<64;5;3M')
  expect(sgrWheel(false, 0, 0)).toBe('\x1b[<65;1;1M')
  expect(keyBytes({ t: 'k', key: 'return' })).toBe('\r')
  expect(keyBytes({ t: 'k', key: 'up' })).toBe('\x1b[A')
  expect(keyBytes({ t: 'k', key: 'c', ctrl: true })).toBe('\x03')
  expect(keyBytes({ t: 'k', key: 'tab', shift: true })).toBe('\x1b[Z')
  expect(keyBytes({ t: 'k', key: 'b', meta: true })).toBe('\x1bb')
  expect(keyBytes({ t: 'k', key: '한' })).toBe('한')
  expect(keyBytes({ t: 'k', key: 'f13' })).toBeUndefined()
})

test('route: Jev picks the effort only when sure; model only when asked', async () => {
  const on = { effort: true, model: false }
  expect(decide(ROUTE_OFF, { effort: 'xhigh', confidence: 1 }, 'high')).toEqual({ confidence: 1, kept: 'off' })
  expect(decide(on, { effort: 'xhigh', confidence: 0.98 }, 'high')).toEqual({ confidence: 0.98, effort: 'xhigh' })
  expect(decide(on, { effort: 'low', confidence: 0.6 }, 'high').kept).toBe('unsure')
  expect(decide(on, { effort: null, confidence: 0 }, 'high').kept).toBe('no-answer')
  expect(decide(on, undefined, 'high').kept).toBe('no-answer')
  expect(decide(on, { effort: 'max', confidence: 1 }, 'high').kept).toBe('no-answer')
  // A model that takes no effort: nothing to rewrite.
  expect(decide(on, { effort: 'low', confidence: 1 }, undefined)).toEqual({ confidence: 1, kept: 'no-effort-model' })
  // Model routing: light work to Sonnet, harder work keeps the session's model.
  expect(decide({ effort: true, model: true }, { effort: 'low', confidence: 1 }, 'high')).toEqual({ confidence: 1, effort: 'low', model: 'sonnet' })
  expect(decide({ effort: false, model: true }, { effort: 'xhigh', confidence: 1 }, 'high')).toEqual({ confidence: 1 })
  expect(routeLabel(decide(on, { effort: 'high', confidence: 0.9 }, 'medium'))).toBe('effort high (90%)')
  expect(routeLabel(undefined)).toBe('no decision yet')
})

test('treeRows: columns stack, rows take the tallest, borders and margins add', async () => {
  const T = (s: string) => ({ type: 'Text', props: { children: [s] } })
  const col = (...c: any[]) => ({ type: 'Box', props: { flexDirection: 'column', children: c } })
  const row = (...c: any[]) => ({ type: 'Box', props: { flexDirection: 'row', children: c } })
  expect(treeRows(col(T('a'), T('b'), T('c')))).toBe(3)
  expect(treeRows(row(col(T('a'), T('b')), T('c')))).toBe(2)
  expect(treeRows({ type: 'Box', props: { borderStyle: 'round', marginTop: 1, children: [T('a')] } })).toBe(4)
  // As built elements are: children beside props.
  expect(treeRows({ type: 'Box', props: { flexDirection: 'column' }, children: [T('a'), T('b')] })).toBe(2)
})

test('palette: lists settings and actions, fuzzy-ranks by title and keywords', async () => {
  const items = paletteItems({
    tabs: [{ id: 'policy', label: 'Policy', hotkey: '5' }, { id: 'web', label: 'Web', hotkey: '6' }],
    caps: [{ cap: 'gh_merge', label: 'merge', value: 'block' }, { cap: 'auto_effort', label: 'effort', value: 'allow' }],
    route: { effort: true, model: false },
    browser: 'chrome',
    web: { running: true, engine: 'electron', device: '', rate: 30 },
  })
  const ids = items.map((i) => i.id)
  expect(ids).toContain('policy:allow:gh_merge')
  expect(ids).toContain('policy:inherit:auto_effort')
  expect(ids).toContain('route:effort:off')
  expect(ids).not.toContain('browser:chrome')
  expect(ids).toContain('web:engine:chrome')
  expect(filterPalette(items, 'devtool')[0]!.id).toBe('web:devtools')
  expect(filterPalette(items, 'merge')[0]!.id).toBe('policy:allow:gh_merge')
  expect(filterPalette(items, 'iph')[0]!.id).toBe('web:device:iPhone 12')
  expect(filterPalette(items, 'gw')[0]!.id).toBe('tab:web')
  expect(filterPalette(items, 'zzzz')).toEqual([])
  expect(filterPalette(items, '').length).toBe(12)
  // Places inside tabs, found by several words in any order.
  expect(filterPalette(items, 'side question')[0]!.id).toBe('go:side')
  expect(filterPalette(items, 'question side')[0]!.id).toBe('go:side')
  expect(filterPalette(items, 'jira')[0]!.id).toBe('out:ticket')
  expect(filterPalette(items, 'pr')[0]!.id).toBe('out:pr')
  expect(filterPalette(items, 'chat decisions')[0]!.id).toBe('chat:decisions')
})

test('usage: ccproxy session summary parses; sparkline scales and keeps gaps', async () => {
  const u = parseUsage(JSON.stringify({
    session: 's', requests: 3, bucket_seconds: 300,
    last: { at: 1, account: 'claude-personal', model: 'claude-opus-5-5', effort: 'medium', status: 200, reason: 'continuation', ms: 9000, tokens: { output: 900, cache_read: 1 } },
    accounts: [{ name: 'claude-personal', requests: 2, tokens: { output: 10 } }], models: [], trend: [{ start: 0, requests: 1, output: 5 }],
  }))
  expect(u?.last?.account).toBe('claude-personal')
  expect(parseUsage('error: usage: ccproxy ...')).toBeUndefined()
  expect(sparkline([0, 1, 4, 8])).toBe(' ▁▄█')
  expect(sparkline([0, 0])).toBe('  ')
  expect(shortModel('claude-opus-5-5')).toBe('opus-5-5')
  expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
  expect(share(1, 4)).toBe('25%')
  // An older ccproxy: groups without ms/efforts, no totals; tokens default to 0.
  expect(u?.totals.cache_read).toBe(0)
  expect(u?.accounts[0]?.tokens.cache_read).toBe(0)
  expect(cacheHit({ input: 10, output: 0, cache_read: 900, cache_create: 90 })).toBe('90%')
  expect(cacheHit({ input: 0, output: 5, cache_read: 0, cache_create: 0 })).toBe('')
  expect(effortMix({ high: 1, medium: 3 })).toBe('medium 75% · high 25%')
  expect(effortMix(undefined)).toBe('')
  expect(modelStrip([{ start: 0, requests: 0, output: 0 }, { start: 1, requests: 2, output: 0, models: { 'claude-opus-5-5': 2 } }, { start: 2, requests: 3, output: 0, models: { 'claude-haiku-4-5': 1, 'claude-sonnet-5-5': 2 } }])).toBe(' Os')
  expect(span(300)).toBe('5m')
  expect(span(8100)).toBe('2h15m')
  expect(hookName('cc-bridge:route')).toBe('cockpit route')
  expect(hookName('jev_dodge_check.py')).toBe('jev_dodge_check')
})

test('usage: quota windows parse from ccproxy status; bar and until format', async () => {
  const q = parseQuota(JSON.stringify({ accounts: [
    { name: 'work', state: 'cooldown', cooldown_until: 200, budget: { kind: 'windows', five_hour: { left_pct: 81, reset_at: 100 }, seven_day: { left_pct: 0, reset_at: 200 } } },
    { name: 'cursor', state: 'ready', budget: { kind: 'pool', pool_name: 'api', pool: { left_pct: 100 } } },
    { name: 'kiro', state: 'ready', budget: { kind: 'none', reason: 'no usage API' } },
  ] }))
  expect(q[0]!.windows.map((w) => w.label + w.left)).toEqual(['5h81', '7d0'])
  const withFable = parseQuota(JSON.stringify({ accounts: [{ name: 'w', state: 'ready', budget: { kind: 'windows', seven_day: { left_pct: 10 }, scoped: [{ model: 'Fable', left_pct: 100, reset_at: 9, active: false }] } }] }))
  expect(withFable[0]!.windows.map((w) => w.label + w.left + (w.scoped ? 's' : ''))).toEqual(['7d10', 'Fable100s'])
  expect(q[1]!.windows[0]!.label).toBe('api')
  expect(q[2]!.note).toBe('no usage API')
  expect(bar(48, 10)).toBe('█████░░░░░')
  expect(until(1000 + 3 * 3600 + 120, 1000 * 1000)).toBe('3h2m')
  expect(until(1000 + 3 * 86400, 1000 * 1000)).toBe('3d')
  expect(until(10, 1000 * 1000)).toBe('')
})

test('policy scope hints: guard denials, prod commands, PR repos; granted ones drop out', () => {
  const deny = 'BLOCKED by session policy: prod_eks_write=block.\nAsk the user to grant it; only they can (e.g. `/policy allow prod-w main-prod-apne2/kube-system 15m`).'
  expect(hintsFromBlock(deny)).toEqual([{ cap: 'prod_eks_write', scope: 'main-prod-apne2/kube-system', why: 'blocked' }])
  expect(hintsFromBlock('(e.g. `/policy allow merge owner/repo`)')).toEqual([])
  expect(hintsFromBlock('`/policy allow merge acme/infra-k8s`')).toEqual([{ cap: 'gh_merge', scope: 'acme/infra-k8s', why: 'blocked' }])

  expect(isProdContext('main-prod-apne2')).toBe(true)
  expect(isProdContext('edge-preprod-x')).toBe(false)
  const kc = 'kube' + 'ctl'
  expect(hintsFromCommand(kc + ' --context=main-prod-apne2 -n istio-system get pods', () => undefined).map((h) => h.cap + ' ' + h.scope)).toEqual([
    'prod_eks_access main-prod-apne2/istio-system',
    'prod_eks_write main-prod-apne2/istio-system',
  ])
  expect(hintsFromCommand(kc + ' --context prod-ops-apne2 get pods', () => undefined)).toEqual([])
  expect(hintsFromCommand('gh pr merge 3 --repo acme/x', () => 'acme/x')).toEqual([{ cap: 'gh_merge', scope: 'acme/x', why: 'used' }])

  const policy = parsePolicy(JSON.stringify({ mode: 'default', gh_merge: 'block', gh_merge_repos: ['acme/done'] }))
  const got = scopeHints(
    [
      { cap: 'gh_merge', scope: 'acme/x', why: 'cwd' },
      { cap: 'gh_merge', scope: 'acme/done', why: 'pr' },
      { cap: 'gh_merge', scope: 'acme/x', why: 'blocked' },
      { cap: 'prod_eks_access', scope: 'main-prod-apne2', why: 'used' },
    ],
    policy,
  )
  // Best reason wins, blocked first, already-scoped repo dropped.
  expect(got.map((h) => h.why + ' ' + h.scope)).toEqual(['blocked acme/x', 'used main-prod-apne2'])
})

test('nest PR verdict: cancelled runs do not fail it, a failed policy check waits on approve_policies, BEHIND/BLOCKED are stuck', () => {
  // The shapes infra-nest returned on 2026-10-14.
  const ctx = (context: string, state: string) => ({ context, state })
  const run = (name: string, status: string, conclusion?: string) => ({ name, status, conclusion })
  const v = checkVerdict(
    [run('SOC2', 'COMPLETED', 'CANCELLED'), run('claude', 'COMPLETED', 'SKIPPED'), ctx('Gordon', 'SUCCESS'), ctx('atlantis/plan', 'SUCCESS'), ctx('atlantis/policy_check', 'FAILURE')],
    'FAILURE',
  )
  expect(v).toEqual({ checks: 'pass', failing: [], policy: 'fail' })
  expect(checkVerdict([ctx('atlantis/plan', 'PENDING'), run('semgrep', 'IN_PROGRESS')]).checks).toBe('pending')
  expect(checkVerdict([run('claude-review', 'COMPLETED', 'FAILURE'), ctx('Gordon', 'SUCCESS')])).toMatchObject({ checks: 'fail', failing: ['claude-review'] })
  expect(checkVerdict(undefined, 'FAILURE').checks).toBe('fail')

  const base = { key: 'acme/infra-nest#1', url: 'u', title: 't', state: 'OPEN' as const, isDraft: false, checks: 'pass' as const, review: '', approvals: 0, unresolved: 0, mergeable: 'MERGEABLE', mergeState: 'BLOCKED', at: 0 }
  expect(needsAttention({ ...base, policy: 'fail' })).toBe('policy')
  expect(prLine({ ...base, policy: 'fail' })).toContain('approve_policies')
  expect(needsAttention({ ...base, mergeState: 'BEHIND', approvals: 2 })).toBe('behind')
  expect(needLabel({ ...base, mergeState: 'BEHIND' })).toBe('behind base')
  expect(needsAttention(base)).toBe('review')
  // Approved but held by an open thread: the thread is the reason, not review.
  expect(needsAttention({ ...base, approvals: 2, unresolved: 1 })).toBe('threads')
  expect(prLine({ ...base, approvals: 2, unresolved: 1 })).not.toContain('needs review')
  expect(needsAttention({ ...base, mergeState: 'CLEAN' })).toBe('ready')
})

test('slack: thread and channel text parse; unseen is others after the seen mark, and my reply moves the mark', () => {
  // The detailed text slack_read_thread returned on 2026-10-14.
  const text =
    '=== THREAD PARENT MESSAGE ===\nFrom: Sam Lee <sam@acme.com> (U0123ABCD47)\nTime: 2026-10-14 17:02:09 KST\nMessage TS: 1791964929.501939\nReview Request\n\n' +
    '=== THREAD REPLIES (3 total) ===\n\n--- Reply 1 of 3 ---\nFrom: Sam Lee <sam@acme.com> (U0123ABCD47)\nTime: x\nMessage TS: 1791964938.841409\ndetails\n\n' +
    '--- Reply 2 of 3 ---\nFrom: Auto Reviewer (B0715GCKUUR)\nTime: x\nMessage TS: 1791965047.536329\nbot\n\n' +
    '--- Reply 3 of 3 ---\nFrom: Jane Doe <jane@acme.com> (U0123)\nTime: x\nMessage TS: 1791966000.000100\nlgtm\n'
  const t = parseThread(text)
  expect(t.parent?.ts).toBe('1791964929.501939')
  expect(t.replies.map((r) => [r.name, r.user])).toEqual([['Sam Lee', 'U0123ABCD47'], ['Auto Reviewer', 'B0715GCKUUR'], ['Jane Doe', 'U0123']])
  expect(newestTs(t)).toBe('1791966000.000100')
  const me = { email: 'sam@acme.com' }
  expect(unseenReplies(t.replies, '1791964938.841409', me).map((r) => r.name)).toEqual(['Auto Reviewer', 'Jane Doe'])
  expect(unseenReplies(t.replies, '1791966000.000100', me)).toEqual([])
  // A reply of mine after theirs means I saw theirs.
  const mine = [...t.replies, { name: 'Sam Lee', email: 'sam@acme.com', user: 'U0123ABCD47', ts: '1791967000.000001' }]
  expect(unseenReplies(mine, '1791964938.841409', me)).toEqual([])
  expect(parseChannelName('Channel: #team-pr-review (C0123ABCD45)\n\nx')).toBe('#team-pr-review')
  expect(mcpText({ content: [{ type: 'text', text: JSON.stringify({ messages: 'Channel: #a (C1)' }) }] })).toBe('Channel: #a (C1)')
  expect(mcpText({ content: [{ type: 'text', text: JSON.stringify({ results: '1. Jane Doe - U1' }) }] })).toBe('1. Jane Doe - U1')
})

test('nav: down goes to the next row near the same column, right stays on the row', () => {
  const T = (t: string) => ({ type: 'Text', props: {}, children: [t] })
  const B = (key: string, t: string) => ({ type: 'Button', props: { key }, children: [T(t)] })
  const row = (...c: any[]) => ({ type: 'Box', props: { flexDirection: 'row', columnGap: 1 }, children: c })
  // Two capability rows, as on the Policy tab, with a help line between.
  const tree = {
    type: 'Box',
    props: { flexDirection: 'column' },
    children: [
      row(T('merge  '), B('m-allow', 'allow'), B('m-block', 'block'), B('m-inherit', '[inherit]')),
      T('gh pr merge'),
      row(T('prod   '), B('p-allow', 'allow'), B('p-block', 'block'), B('p-inherit', '[inherit]')),
      { type: 'Box', props: { display: 'none' }, children: [B('catch-q', 'q')] },
    ],
  }
  const items = navItems(tree)
  expect(items.filter((i) => !i.hidden).map((i) => i.key)).toEqual(['m-allow', 'm-block', 'm-inherit', 'p-allow', 'p-block', 'p-inherit'])
  // A display-none button keeps its place in the ring order, marked hidden.
  expect(items.find((i) => i.key === 'catch-q')?.hidden).toBe(true)
  expect(navTarget(items, 'm-block', 'down')?.key).toBe('p-block')
  expect(navTarget(items, 'p-inherit', 'up')?.key).toBe('m-inherit')
  expect(navTarget(items, 'm-block', 'right')?.key).toBe('m-inherit')
  expect(navTarget(items, 'm-inherit', 'right')).toBeUndefined()
  expect(navTarget(items, 'p-allow', 'down')).toBeUndefined()
})

test('nav: Client regions have coordinates but never enter focus navigation', () => {
  const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [
    { type: 'Button', props: { key: 'a', label: 'a' } },
    { type: 'Client', props: { key: 'page', width: 40, height: 12 } },
    { type: 'Button', props: { key: 'b', label: 'b' } },
  ] }
  expect(navItems(tree).map((i) => i.key)).toEqual(['a', 'b'])
  expect(clientItems(tree)).toEqual([{ key: 'page', x: 0, y: 1, w: 40, h: 12, client: true }])
})

test('nav: a wrapping row breaks at the pane width', () => {
  const B = (key: string, t: string) => ({ type: 'Button', props: { key }, children: [t] })
  const tree = { type: 'Box', props: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 2 }, children: [B('a', 'x'.repeat(10)), B('b', 'x'.repeat(10)), B('c', 'x'.repeat(10))] }
  const items = navItems(tree, 25)
  expect(items.map((i) => [i.key, i.x, i.y])).toEqual([['a', 0, 0], ['b', 12, 0], ['c', 0, 1]])
  expect(navTarget(items, 'b', 'down')?.key).toBe('c')
})

test('slack policy targets: kinds, search parsing, guard hint, default channel never a candidate', () => {
  expect(slackTargetKind('C0123ABCD45')).toBe('id')
  expect(slackTargetKind('u0123abcd46')).toBe('id')
  expect(slackTargetKind('#prod-alerts')).toBe('channel')
  expect(slackTargetKind('@jane')).toBe('person')
  expect(slackTargetKind('general')).toBeUndefined()
  // Shapes slack_search_channels / slack_search_users returned on 2026-10-14.
  expect(parseChannelSearch('## Channels (1 results)\n1. #team-pr-review (C0123ABCD45) - private_channel - Creator: Jace Son', '#team-pr-review')).toBe('C0123ABCD45')
  expect(parseChannelSearch('1. #team-pr-review-old (C1) - x', '#team-pr-review')).toBeUndefined()
  expect(parseUserSearch('## Users (1 results)\n1. Jane Doe - U0123ABCD46 - jane@acme.com\n')).toEqual({ id: 'U0123ABCD46', name: 'Jane Doe' })
  expect(hintsFromBlock('(e.g. `/policy allow slack U0123ABCD46`).')).toEqual([{ cap: 'slack_send', scope: 'U0123ABCD46', why: 'blocked' }])
  expect(parsePolicyArgs('allow slack #ops')).toEqual({ argv: ['allow', 'slack_send', '--scope', '#ops'] })
  const p = parsePolicy(JSON.stringify({ mode: 'custom', slack_send_targets: ['U0123ABCD46'] }))
  expect(p.scopes.slack_send).toEqual(['U0123ABCD46'])
  expect(badge(p)).toContain('slack(1)')
  const got = scopeHints(
    [
      { cap: 'slack_send', scope: 'C0123ABCD45', why: 'thread' },
      { cap: 'slack_send', scope: 'U0123ABCD46', why: 'used' },
      { cap: 'slack_send', scope: 'C0OPS12345', why: 'thread' },
    ],
    p,
  )
  expect(got.map((h) => h.scope)).toEqual(['C0OPS12345'])
})

test('jev usage: parse and money', () => {
  expect(usd(0.000377658)).toBe('$0.0004')
  expect(usd(1.003579)).toBe('$1.00')
  expect(parseJev({})).toBeUndefined()
  const j = parseJev({ today: { calls: 3, cost: 0.0004, in: 1849 }, week: { calls: 3, cost: 0.0004, in: 1849 }, callers: [{ name: 'cc-bridge.py', calls: 1, cost: 0.0001 }], gateway: { requests: 3839, cost: 1.0, since: '2026-10-07' } })
  expect(j?.callers[0]?.name).toBe('cc-bridge.py')
  expect(j?.gateway?.requests).toBe(3839)
  // An older bridge: no hours, kinds or session.
  expect(j?.hours).toEqual([])
  expect(j?.kinds).toEqual([])
  expect(j?.session).toBeUndefined()
})

test('nav: Tab and Shift+Tab step over hidden catchers to the next visible element', () => {
  const order = ['catch-a', 'catch-b', 'palette-toggle', 'cockpit-home', 'cockpit-flow', 'cockpit-usage', 'hk-side-ask', 'side-input', 'tab-all']
  // Tab from usage lands on the hidden ask button: on to the field.
  expect(skipHidden(order, 'hk-side-ask', 'cockpit-usage')).toBe('side-input')
  // Tab from the last element wraps onto the first catcher: on to the first tab.
  expect(skipHidden(order, 'catch-a', 'tab-all')).toBe('cockpit-home')
  // Shift+Tab from the first tab steps onto the last catcher: back to the end.
  expect(skipHidden(order, 'palette-toggle', 'cockpit-home')).toBe('tab-all')
  // Shift+Tab from the field onto the ask button: back to usage.
  expect(skipHidden(order, 'hk-side-ask', 'side-input')).toBe('cockpit-usage')
  // Ring position unknown (a stray letter pressed a catcher): forward.
  expect(skipHidden(order, 'catch-b', undefined)).toBe('cockpit-home')
})

test('iac: atlantis plan/apply/window/labels and gitops argodiff/codex, from the shapes seen 2026-10-14', () => {
  expect(parsePlan('Plan: 2 to add, 0 to change, 1 to destroy.')).toEqual({ add: 2, change: 0, destroy: 1 })
  expect(parsePlan('No changes. Your infrastructure matches the configuration.')).toEqual({ add: 0, change: 0, destroy: 0 })
  expect(regionOfDir('aws/chat-prod/use1/us3/30-service/common-gateway')).toBe('us3')
  const windows = parseWindows('    - sbregion: us3\n      name: us3\n      sync_window:\n        schedule: "0 13 * * *"\n        duration: 8h\n    - sbregion: preprod\n      name: preprod\n')
  expect(windows).toEqual({ us3: { minute: 0, hour: 13, durationMin: 480 } })
  expect(windowState(windows.us3!, Date.UTC(2026, 9, 14, 14, 30))).toEqual({ open: true, minutes: 390 })
  expect(windowState(windows.us3!, Date.UTC(2026, 9, 14, 11, 0))).toEqual({ open: false, minutes: 120 })

  const nest = {
    labels: { nodes: [{ name: 'production' }, { name: 'auto-review/approved' }, { name: 'auto-review/skipped' }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { context: 'atlantis/plan: aws/chat-prod/use1/us3/30-service/common-gateway/default', state: 'SUCCESS', description: 'Plan: 2 to add, 0 to change, 1 to destroy.' },
      { context: 'atlantis/policy_check', state: 'FAILURE', description: '1/1 projects failed policy checks.' },
    ] } } } }] },
  }
  const st = iacState('acme/infra-nest', nest)!
  expect(st.autoReview).toBe('approved')
  expect(iacLine(st, windows, Date.UTC(2026, 9, 14, 11, 0))).toBe('📍 us3 · plan +2 ~0 -1 · 🕒 window in 2h · 🤖 auto-approved')
  const bypass = iacState('acme/infra-nest', { ...nest, labels: { nodes: [{ name: 'timewindow-bypass' }, { name: 'DO NOT APPLY' }] } })!
  expect(iacLine(bypass, windows, 0)).toBe('📍 us3 · ⛔ DO NOT APPLY · plan +2 ~0 -1 · ⏭ window bypass')
  expect(iacDetail(st, windows, Date.UTC(2026, 9, 14, 14, 30)).join('\n')).toContain('window open, 6h30m left')

  const argo = '<!-- argodiff:comment -->\n## 🔄 ArgoCD Application Diff\n### 4 application(s) with changes (out of 116 checked)\n<details>\n<summary>Click to see applications with changes</summary>\n\n- `app-a`\n- `app-b`\n\n</details>'
  expect(parseArgoDiff(argo)).toEqual({ changed: 4, checked: 116, apps: ['app-a', 'app-b'] })
  const codex = '<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** <relative-time>x</relative-time> | `4856db1` | PR opened |'
  expect(parseCodex(codex, '4856db18d9')).toEqual({ state: 'done', commit: '4856db1' })
  expect(parseCodex(codex, 'aaaaaaa000')).toEqual({ state: 'stale', commit: '4856db1' })
  const k8s = iacState('acme/infra-k8s', { headRefOid: '4856db18d9', labels: { nodes: [{ name: 'auto-review/needs-human' }] }, comments: { nodes: [{ body: argo }, { body: codex }] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ name: 'claude-review', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] } })!
  expect(iacLine(k8s, {}, 0)).toBe('argodiff 4 apps: app-a, app-b · codex ✓ · claude ✓ · 👤 needs human')
  expect(iacState('keyolk/tweb', {})).toBeUndefined()
})

test('iac scope: regions or clusters from changed paths; shared files mean everywhere', () => {
  expect(scopeOf(['charts/databird/values/chat-prod/ap1/calls.yaml', 'charts/databird/values/chat-prod/ap1/desk.yaml'])).toEqual({ names: ['ap1'], broad: false })
  expect(scopeOf(['charts/pager/values.yaml', 'charts/pager/tests/render.sh'])).toEqual({ names: [], broad: true })
  expect(scopeOf(['argocd/applicationset/addons/config/cluster/prod-dev-cluster-ypwf.yaml'])).toEqual({ names: ['prod-dev-cluster-ypwf'], broad: false })
  expect(scopeOf(['.github/workflows/x.yml'])).toBeUndefined()
  // Atlantis: shared snippets reach the region dirs changed with them.
  const nest = ['_snippet/_sbregion_ref/30-service/common-gateway/main.tf', 'aws/chat-prod/use1/us3/30-service/common-gateway/main.tf']
  expect(scopeOf(nest, 'atlantis')).toEqual({ names: ['us3'], broad: false })
  expect(scopeOf(['_snippet/_sbregion_ref/30-service/common-gateway/main.tf'], 'atlantis')).toEqual({ names: [], broad: true })
  expect(scopeLabel({ names: ['ap1', 'us3'], broad: false })).toBe('📍 ap1, us3')
  expect(scopeLabel({ names: ['a', 'b', 'c', 'd'], broad: false })).toBe('📍 4 targets')
  expect(scopeLabel({ names: ['ap1'], broad: true })).toBeUndefined()
})

test('gitops comments: the jq-reduced lines are enough for ArgoDiff and Codex; the main query fetches no bodies', () => {
  expect(graphqlQuery([{ repo: 'acme/infra-k8s', number: 1 }])).not.toContain('comments(')
  expect(graphqlQuery([{ repo: 'acme/infra-k8s', number: 1 }])).toContain('files(first: 80)')
  const out = [
    '<!-- argodiff:comment -->\n<summary>opsapne2-service-catalog <a href="x">↗</a></summary>\n</details>\n### 1 application(s) with changes (out of 1 checked)\n<summary>Click to see applications with changes</summary>\n- `opsapne2-service-catalog`\n</details>\n<<<END>>>',
    '<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** <relative-time>x</relative-time> | `4856db1` | PR opened |\n<<<END>>>',
    '\n<<<END>>>',
  ].join('\n')
  expect(gitopsFromComments(out, '4856db18d9')).toEqual({ argodiff: { changed: 1, checked: 1, apps: ['opsapne2-service-catalog'] }, codex: { state: 'done', commit: '4856db1' } })
})

test('nav: alignItems center lines a button up with the text row of a bordered field beside it', () => {
  const B = (key: string, t: string) => ({ type: 'Button', props: { key }, children: [t] })
  const field = (key: string) => ({ type: 'Box', props: { borderStyle: 'round', paddingX: 1 }, children: [{ type: 'Input', props: { key, label: 'go', placeholder: 'x' } }] })
  const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [
    { type: 'Box', props: { flexDirection: 'row' }, children: [B('tab-a', 'A'), B('tab-b', 'B')] },
    { type: 'Box', props: { flexDirection: 'row', alignItems: 'center', columnGap: 1 }, children: [field('addr'), field('keys'), B('gear', '⚙'), B('close', '✕')] },
  ] }
  const items = navItems(tree)
  const y = (k: string) => items.find((i) => i.key === k)!.y
  expect(y('gear')).toBe(y('addr'))
  expect(navTarget(items, 'tab-a', 'down')?.key).toBe('addr')
})

test('nav: grown fields split the row width, so Down from a tab lands on the field under it', () => {
  const B = (key: string, t: string) => ({ type: 'Button', props: { key }, children: [t] })
  const field = (key: string) => ({ type: 'Box', props: { borderStyle: 'round', paddingX: 1, flexGrow: 1, width: 0 }, children: [{ type: 'Input', props: { key, label: 'go', placeholder: 'x' } }] })
  const tabs = { type: 'Box', props: { flexDirection: 'row', columnGap: 3 }, children: ['1: Now', '2: Chat', '3: Work', '4: Outputs', '5: Policy', '6: Web', '7: Usage'].map((t, i) => B('tab-' + i, t)) }
  const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [tabs, { type: 'Box', props: { flexDirection: 'row', alignItems: 'center', columnGap: 1 }, children: [field('addr'), field('keys'), B('gear', '⚙'), B('close', '✕')] }] }
  const items = navItems(tree, 120)
  expect(navTarget(items, 'tab-5', 'down')?.key).toBe('addr')
  expect(navTarget(items, 'close', 'up')?.key).toBe('tab-6')
})

test('flow: a long finding is kept whole (the row clips, the selected entry shows all of it)', () => {
  const long = '원인은 ' + '아주 긴 설명 '.repeat(80) + '끝.'
  const fs = flowOf('결론입니다.\n\n' + long, 't1', 0)
  expect(fs[1]!.text.endsWith('끝.')).toBe(true)
  expect(fs[1]!.text.length).toBeGreaterThan(400)
})

test('elsewhere: windows waiting on the person ranked, this session left out; dayx brief to-dos', () => {
  const out = [
    'main|2|daily|waiting|none|edge-k8s|100|s-daily',
    'main|5|cco|waiting|action||300|s-cco',
    'main|3|vpn|waiting|ask|slack 다시 체크|200|s-tw',
    'main|15|mods|done|none||400|me',
    'main|9|x|working|none||500|s-x',
    'main|1|fish||||',
  ].join('\n')
  const w = parseTmuxWindows(out, 'me')
  expect(w.map((x) => [x.window, x.attention])).toEqual([['5:cco', 'action'], ['3:vpn', 'ask'], ['2:daily', 'idle'], ['9:x', 'working']])
  expect(w[3]!.session).toBe('s-x')
  // With window ids the target follows the window across sessions; the label stays session:index.
  const moved = parseTmuxWindows('side|4|cco|waiting|action||300|s-cco|@12', 'me')[0]!
  expect([moved.target, moved.where]).toEqual(['@12', 'side:4'])
  expect(w[0]!.target).toBe('main:5')
  expect(w[1]!.title).toBe('slack 다시 체크')
  const brief = '# dayx brief\n\n## 한눈에\n- 열림 177 = 내 것 1\n\n## 오늘 due\n- 없음\n\n## 열어 둔 일 (어제 마감 정리)\n- fix the band\n\n## 내 차례 (상위 5)\n- Review acme/core-k8s#1121\n\n---\n## 기타\n- ignored'
  expect(parseBrief(brief)).toEqual([
    { text: '열림 177 = 내 것 1', kind: 'summary' },
    { text: 'fix the band', kind: 'open' },
    { text: 'Review acme/core-k8s#1121', kind: 'turn' },
  ])
})

test('resume: the API errors seen in transcripts are classified; decide waits for the network', () => {
  // The messages in this machine's transcripts (2026-10-14).
  expect(classify('unknown', 'API Error: Connection lost while your computer was asleep')).toBe('network')
  expect(classify('server_error', 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.')).toBe('network')
  expect(classify('unknown', 'API Error: No response from API')).toBe('network')
  expect(classify('unknown', 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)')).toBe('network')
  expect(classify('server_error', 'API Error: 502 dial tcp 100.101.198.158:443: connect: operation timed out. This is a server-side issue')).toBe('network')
  expect(classify('server_error', 'API Error: 502 stream error: stream ID 1; CANCEL; received from peer.')).toBe('server')
  expect(classify('rate_limit', 'API Error: 429')).toBe('rate')
  expect(classify('authentication_failed', 'Login expired · Please run /login')).toBe('never')
  expect(classify('invalid_request', 'API Error: Invalid prompt: your prompt was flagged as potentially violating our usage policy')).toBe('never')
  const p = { at: 1000, cls: 'network' as const, message: '', attempts: 0, nextAt: 1000 }
  expect(resumeDecide(p, 5000, { reachable: false, turnSince: false, enabled: true })).toEqual({ act: 'wait' })
  expect(resumeDecide(p, 5000, { reachable: true, turnSince: false, enabled: true })).toEqual({ act: 'resume' })
  expect(resumeDecide(p, 5000, { reachable: true, turnSince: true, enabled: true }).act).toBe('drop')
  expect(resumeDecide({ ...p, attempts: 3 }, 5000, { reachable: true, turnSince: false, enabled: true }).act).toBe('drop')
  expect(resumeDecide(p, 5000, { reachable: true, turnSince: false, enabled: false }).act).toBe('drop')
  expect(slept(15_000, 16_000)).toBe(false)
  expect(slept(15_000, 600_000)).toBe(true)
})

test('route: the routed family goes out as a full id, never a bare alias', () => {
  expect(resolveModel('sonnet', 'claude-opus-5-5[1m]', 'claude-sonnet-5-5[1m]')).toBe('claude-sonnet-5-5[1m]')
  expect(resolveModel('sonnet', 'claude-opus-5-5', 'claude-sonnet-5-5[1m]')).toBe('claude-sonnet-5-5')
  expect(resolveModel('sonnet', 'claude-opus-5-5[1m]', undefined)).toBe('claude-sonnet-5-5[1m]')
  expect(resolveModel('sonnet', 'claude-fable-5-1', undefined)).toBe('claude-sonnet-5-1')
  expect(resolveModel('sonnet', 'gpt-5', undefined)).toBeUndefined()
  expect(resolveModel('sonnet', 'claude-opus-5-5', 'claude-haiku-5-5')).toBeUndefined()
})

test('route cache gate: a pick lands only at a cache boundary; otherwise the previous step is repeated', () => {
  const pick = { confidence: 0.9, effort: 'low' as const, model: 'claude-sonnet-5-5[1m]' }
  const last = { effort: 'xhigh', model: 'claude-opus-5-5[1m]', at: 0 }
  // First step: nothing to keep warm.
  expect(cacheGate(pick, { stepEffort: 'xhigh', stepModel: 'claude-opus-5-5[1m]', now: 1000 })).toEqual(pick)
  // Warm and large: held, and the previous effort/model are what is sent.
  const held = cacheGate(pick, { stepEffort: 'xhigh', stepModel: 'claude-opus-5-5[1m]', last, ctxTokens: 600_000, now: 60_000 })
  expect(held.kept).toBe('cache')
  expect(held.effort).toBeUndefined()
  expect(held.model).toBeUndefined()
  // The session default would flip it back (step says medium, last ran xhigh): hold re-sends xhigh.
  const back = cacheGate({ confidence: 0.9, effort: 'medium' }, { stepEffort: 'medium', stepModel: 'claude-opus-5-5', last: { effort: 'xhigh', model: 'claude-opus-5-5', at: 0 }, ctxTokens: 600_000, now: 60_000 })
  expect(back).toMatchObject({ kept: 'cache', effort: 'xhigh' })
  // Cold (idle past the TTL) or small: applied.
  expect(cacheGate(pick, { stepEffort: 'xhigh', stepModel: 'claude-opus-5-5[1m]', last, ctxTokens: 600_000, now: 61 * 60_000 })).toEqual(pick)
  expect(cacheGate(pick, { stepEffort: 'xhigh', stepModel: 'claude-opus-5-5[1m]', last, ctxTokens: 12_000, now: 60_000 })).toEqual(pick)
  // Same as before: nothing to hold.
  expect(cacheGate({ confidence: 0.9, effort: 'xhigh' }, { stepEffort: 'xhigh', stepModel: 'claude-opus-5-5[1m]', last, ctxTokens: 600_000, now: 60_000 }).kept).toBeUndefined()
})

test('goal: parse, visibility after it ends, header chip', () => {
  expect(parseGoal({ goal: null })).toBeNull()
  const g = parseGoal({ goal: { condition: 'x', active: false, met: true, setAt: 1, checks: 4, lastAt: 2, reason: 'done', ended: 'met', endedAt: 1000 } })!
  expect(goalChip(g)).toBe('🎯 goal met')
  expect(goalVisible(g, 1000 * 1000 + 60_000)).toBe(true)
  expect(goalVisible(g, 1000 * 1000 + 2 * 60 * 60_000)).toBe(false)
  expect(goalChip({ ...g, active: true, checks: 0 })).toBe('🎯 goal')
})

test('unblock: a guard refusal is recorded and released by the grant that covers it', () => {
  const p = parsePolicy(undefined)
  const merge = blockOf('BLOCKED by session policy: gh_merge is not allowed in this session.\nTarget repo: keyolk/tweb\nAsk the user to grant it; only they can (e.g. `/policy allow merge keyolk/tweb`).', p, 'gh pr merge 169', 't1', 1)!
  expect(merge.scope).toBe('keyolk/tweb')
  expect(nowAllowed(merge, p)).toBe(false)
  expect(nowAllowed(merge, { ...p, scopes: { gh_merge: ['keyolk/other'] } })).toBe(false)
  expect(nowAllowed(merge, { ...p, scopes: { gh_merge: ['Keyolk/Tweb'] } })).toBe(true)
  expect(nowAllowed(merge, { ...p, caps: { ...p.caps, gh_merge: 'allow' } })).toBe(true)
  // No repo named: any merge grant added since lets it go.
  const anon = blockOf('BLOCKED by session policy: gh_merge is not allowed in this session.\n(e.g. `/policy allow merge owner/repo`).', p, 'gh pr merge', 't1', 1)!
  expect(anon.scope).toBeUndefined()
  expect(nowAllowed(anon, { ...p, scopes: { gh_merge: ['a/b'] } })).toBe(true)
  // prod: a ctx grant covers its namespaces.
  const w = blockOf('BLOCKED by session policy: prod_eks_write=block.\n(e.g. `/policy allow prod-w main-apne2-prod/kube-system 15m`).', p, 'kubectl apply', 't1', 1)!
  expect(nowAllowed(w, { ...p, scopes: { prod_eks_write: ['main-apne2-prod'] } })).toBe(true)
  // The self-grant refusal is not a block a grant resumes.
  expect(blockOf('BLOCKED by session policy: only the user may change session policy.', p, 'x', 't1', 1)).toBeUndefined()
  expect(resumePrompt([merge])).toContain('gh_merge keyolk/tweb: `gh pr merge 169`')
})

test('aws: a login that leaves the expiry in place reused the portal session', () => {
  expect(awsLoginReused(1_000_000, 1_000_000)).toBe(true)
  expect(awsLoginReused(1_000_000, 1_000_000 + 8 * 3600_000)).toBe(false)
  expect(awsLoginReused(undefined, 1)).toBe(false)
  const it = awsReusedItem({ id: 'aws-sso', label: 'AWS SSO', state: 'soon' }, 'https://d-x.awsapps.com/start', '02:45')
  expect(it.detail).toContain('ends 02:45')
  expect(it.alt?.argv).toEqual(['open', 'https://d-x.awsapps.com/start'])
})

test('web engines: electron, chrome and webkit (tauri is webkit); targets map to engines', () => {
  expect(parseEngine('tauri')).toBe('webkit')
  expect(parseEngine('WebKit')).toBe('webkit')
  expect(parseEngine('chrome')).toBe('chrome')
  expect(parseEngine('firefox')).toBeUndefined()
  expect(engineOfTarget('tweb-webkit')).toBe('webkit')
  expect(engineOfTarget('tweb-chrome')).toBe('chrome')
  expect(engineOfTarget('tweb')).toBe('electron')
  expect(parseBrowser('tweb-webkit')).toBe('tweb-webkit')
  expect(parseBrowser('tweb-tauri')).toBe('tweb-webkit')
})

test('usage: series per model and per account across the trend, busiest first', () => {
  const sl = (output: number) => ({ requests: 1, output, input: 0, cache_read: 0 })
  const trend: Usage['trend'] = [
    { start: 0, requests: 1, output: 10, by_model: { 'claude-opus-5-5': sl(10) }, by_account: { a: sl(10) } },
    { start: 1, requests: 0, output: 0 },
    { start: 2, requests: 2, output: 30, by_model: { 'claude-opus-5-5': sl(25), 'claude-haiku-4-5': sl(5) }, by_account: { b: sl(30) } },
  ]
  const m = seriesBy(trend, 'by_model')
  expect(m.map((s) => s.name)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5'])
  expect(m[0]!.values).toEqual([10, 0, 25])
  expect(m[1]!.values).toEqual([0, 0, 5])
  expect(seriesBy(trend, 'by_account').map((s) => [s.name, s.total])).toEqual([['b', 30], ['a', 10]])
  expect(seriesBy([{ start: 0, requests: 1, output: 1 }], 'by_model')).toEqual([])
})

test('narwhal: attention parsed, fresh items once, answer body, result prompt', async () => {
  const body = JSON.stringify({
    items: [
      { kind: 'question', run_id: 's1', request: 'install it', at: '', title: '#3 checkpoint · which?', question: { id: 3, task_id: 'research', text: 'which?', options: ['a', 'b'], recommended: 1 } },
      { kind: 'done', run_id: 's2', request: 'guide', at: '', title: 'done', summary: 'dayx는 로컬 서비스다.' },
      { nonsense: true },
    ],
  })
  const items = parseAttention(body)
  expect(items.length).toBe(2)
  expect(itemKey(items[0]!)).toBe('s1#q3')
  expect(itemKey(items[1]!)).toBe('s2#done')
  expect(parseAttention('not json')).toEqual([])
  expect(parseAttention(undefined)).toEqual([])

  expect(freshItems(items, []).length).toBe(2)
  expect(freshItems(items, ['s1#q3']).map(itemKey)).toEqual(['s2#done'])

  expect(JSON.parse(answerBody('s1', 3, 'b'))).toEqual({ run_id: 's1', answers: [{ id: 3, answer: 'b' }] })
  expect(resultPrompt(items[1]!)).toContain('narwhal run s2 finished (guide). Its answer starts: dayx는 로컬 서비스다.')
  expect(toastFor(items[0]!)).toBe('narwhal asks: which?')
})

test('usage: which account served each bucket, and how often the session switched', () => {
  const sl = (requests: number) => ({ requests, output: 0, input: 0, cache_read: 0 })
  const trend: Usage['trend'] = [
    { start: 0, requests: 2, output: 0, by_account: { personal: sl(2) } },
    { start: 1, requests: 0, output: 0 },
    { start: 2, requests: 3, output: 0, by_account: { acme: sl(2), personal: sl(1) } },
    { start: 3, requests: 1, output: 0, by_account: { personal: sl(1) } },
  ]
  expect(accountStrip(trend, ['personal', 'acme'])).toEqual({ strip: 'A bA', switches: 2 })
})

test('narwhal: runs parsed; their PRs, files and answer become outputs; progress line', async () => {
  const runs = parseRuns(JSON.stringify({
    runs: [{ run_id: 's1', request: 'install dayx', state: 'done', started_at: '2026-10-15T01:00:00Z', ended_at: '2026-10-15T01:10:00Z', done: 2, failed: 0, running: 0,
      answer: 'dayx is installed.', artifacts: { prs: ['https://github.com/keyolk/dayx/pull/12'], files: ['/src/dayx/STATUS.md'] },
      tasks: [{ id: 'task-1', state: 'completed' }, { id: 'synthesis', state: 'completed' }] }, { bad: 1 }],
  }))
  expect(runs.length).toBe(1)
  const outs = runOutputs(runs)
  expect(outs.map((o) => o.id)).toEqual(['pr:keyolk/dayx#12', 'scratch:/src/dayx/STATUS.md', 'narwhal:s1'])
  expect(outs[0]!.detail).toBe('narwhal · install dayx')
  expect(outs[2]!.detail).toBe('dayx is installed.')
  expect(runProgress(runs[0]!)).toBe('2/2 done')
  expect(runProgress({ ...runs[0]!, done: 1, running: 1, waiting: 2 })).toBe('1/2 done · 1 running · 2 waiting for you')
  expect(parseRuns('nope')).toEqual([])
})

test('layout: the cockpit docks at about 3 in 8 of the terminal, the chat never under 4:3', () => {
  expect(cockpitColumns(160)).toBe(60) // 100:60 = 5:3
  expect(cockpitColumns(240)).toBe(90)
  expect(cockpitColumns(120)).toBe(48) // the floor, under 3/7 of 120 = 51
  expect(cockpitColumns(400)).toBe(140) // capped
  for (const w of [130, 170, 210, 300]) expect((w - cockpitColumns(w)) / cockpitColumns(w)).toBeGreaterThanOrEqual(4 / 3 - 0.05)
})

// The alert-bot thread the daily session was handed (shape as slack_read_thread returns it).
const ALERT_BOT = [
  '=== THREAD PARENT MESSAGE ===',
  'From: Pager <botuser-T0ACME00001-A0ACMEBOT01@slack-bots.com> (U0ACMEBOT11)',
  'Time: 2026-10-15 06:20:15 KST',
  'Message TS: 1792012815.915499',
  ':large_yellow_circle: *<https://pager.tools.acme.io/?page=incidents&amp;incidentId=inc-1|[sb] [apse1] ClickHouseTooManyPartsPerPartition ( prod o11y dataplatform clickhouse )>*',
  'ClickHouse [dataplatform/apse1/prod] has &gt;300 parts per partition',
  '#2001  |  critical  |  source grafana',
  '',
  '=== THREAD REPLIES (2 total) ===',
  '--- Reply 1 of 2 ---',
  'From: SRE bot <botuser-T0ACME00001-A0ACMEBOT02@slack-bots.com> (U0123ABCD48)',
  'Time: 2026-10-15 06:20:17 KST',
  'Message TS: 1792012817.104129',
  '*Labels:*',
  '- `alertname` = ClickHouseTooManyPartsPerPartition',
  '- `env` = prod',
  '- `product` = dataplatform',
  '- `sbregion` = apse1',
  '- `service` = clickhouse',
].join('\n')

test('rca: a bot-posted alert thread is an alert; its labels pick the contexts and namespace to write in', () => {
  const a = alertOf(ALERT_BOT, 'https://acme.slack.com/archives/C0ALERTS001/p1792012815915499', 'C0ALERTS001', '1792012815.915499')!
  expect(a.title).toBe('[sb] [apse1] ClickHouseTooManyPartsPerPartition ( prod o11y dataplatform clickhouse )')
  expect(a.labels).toMatchObject({ env: 'prod', product: 'dataplatform', sbregion: 'apse1', service: 'clickhouse', severity: 'critical' })
  const ctxs = ['dataplatform-apse1-airflow-local-prod', 'dataplatform-apse1-airflow-local-preprod', 'main-apse1-prod', 'dataplatform-use1-prod']
  expect(alertContexts(a, ctxs)).toEqual(['dataplatform-apse1-airflow-local-prod'])
  expect(rcaGrants(a, ctxs).map((g) => g.argv.join(' '))).toEqual([
    'mode rca',
    'allow prod_eks_write --scope dataplatform-apse1-airflow-local-prod/clickhouse',
    'allow slack_send --scope C0ALERTS001',
  ])
  expect(rcaGrants(a, ctxs)[1]!.revert).toEqual(['inherit', 'prod_eks_write', '--scope', 'dataplatform-apse1-airflow-local-prod/clickhouse'])
  // A person's thread is not an alert, whatever it says.
  expect(alertOf(ALERT_BOT.replace('From: Pager <botuser-T0ACME00001-A0ACMEBOT01@slack-bots.com>', 'From: Sam Lee <sam@acme.com>'), 'u', 'C', '1')).toBeUndefined()
})

test('rca: ending it puts the policy back as it was, named mode or custom, scopes included', () => {
  const named = parsePolicy(JSON.stringify({ mode: 'pr-merge', capabilities: { gh_merge: 'allow' }, gh_merge_repos: ['keyolk/tweb'] }))
  expect(restoreArgvs(named)).toEqual([['mode', 'pr-merge'], ['allow', 'gh_merge', '--repo', 'keyolk/tweb']])
  const custom = parsePolicy(JSON.stringify({ mode: 'custom', capabilities: { prod_eks_access: 'allow', prod_eks_write: 'allow' }, slack_send_targets: ['C0ALERTS001'] }))
  expect(restoreArgvs(custom)).toEqual([['mode', 'default'], ['allow', 'prod_eks_access'], ['allow', 'prod_eks_write'], ['allow', 'slack_send', '--scope', 'C0ALERTS001']])
})

test('identity: what another session needs to find and read this one', () => {
  const t = identityText({ session: 'cddefc86', window: 'local:1 daily', pane: '%216', cwd: '/Users/g', topic: 'RCA: ClickHouse parts', state: 'working', transcript: '/Users/g/.claude/projects/-Users-g/cddefc86.jsonl', links: ['https://acme.slack.com/archives/C/p1'] })
  expect(t).toContain('Claude Code session cddefc86 (working)')
  expect(t).toContain('- where: tmux local:1 daily · %216 · /Users/g')
  expect(t).toContain('- transcript: /Users/g/.claude/projects/-Users-g/cddefc86.jsonl')
  expect(t).toContain('claude --resume cddefc86 --fork-session')
})

test('fork: a late answer carries the topic on instead of asking it again; a running one moves it', () => {
  const offer = { prompt: 'deploy the docs site', p: 0.9, at: 0, later: 0 }
  const turns = [
    { turnId: 't1', text: 'fix the band', at: 1, endedAt: 2, tools: {} },
    { turnId: 't2', text: 'deploy the docs site', at: 3, tools: {} },
  ]
  expect(forkPhase(offer, turns)).toEqual({ kind: 'running', turnId: 't2' })
  expect(forkPrompt(offer, { kind: 'running', turnId: 't2' })).toContain('멈춘 지점부터 이어서')
  turns[1]!.endedAt = 4
  const done = forkPhase(offer, turns)
  expect(done).toEqual({ kind: 'answered' })
  expect(forkPrompt(offer, done)).toContain('답은 대화에 이미 있다')
  expect(forkEffect(done)).toMatch(/answered here already/)
  expect(forkPhase({ ...offer, prompt: 'gone' }, turns)).toEqual({ kind: 'unknown' })
  expect(forkPrompt({ ...offer, prompt: 'gone' }, { kind: 'unknown' })).toBe('gone')
  expect(movedSection([{ prompt: 'deploy the docs site', pane: '%9' }])).toContain('- tmux pane %9: deploy the docs site')
})

test('outputs: tickets are the ones this session works on, not every key a tool printed', () => {
  // `cat ~/.config/jira/context.json`: the Jira skill's epic cache.
  const cache = toolOutputs('Bash', { command: 'cat ~/.config/jira/context.json' }, { result: { stdout: '{"epics":[{"key":"ABC-3"},{"key":"ABC-179"}]}' } }, 1)
  expect(cache.filter((o) => o.kind === 'ticket')).toEqual([])
  const branch = toolOutputs('Bash', { command: 'git worktree add -q -b ABC-12775-usage-detail ../wt origin/master' }, { result: { stdout: '' } }, 1)
  expect(branch.filter((o) => o.kind === 'ticket').map((o) => [o.title, o.detail])).toEqual([['ABC-12775', 'in a branch or PR']])
  expect(toolOutputs('mcp__claude_ai_Atlassian__getJiraIssue', { issueIdOrKey: 'ABC-12796' }, { result: 'ABC-1 ABC-2' }, 1).map((o) => o.title)).toEqual(['ABC-12796'])
  expect(textOutputs('see ABC-1', 1, false).filter((o) => o.kind === 'ticket')).toEqual([])
  expect(textOutputs('see ABC-12', 1).find((o) => o.kind === 'ticket')?.detail).toBe('mentioned')
  expect(dropUnsourcedTickets([{ id: 'ticket:ABC-3', kind: 'ticket', title: 'ABC-3', at: 1 }, { id: 'ticket:ABC-4', kind: 'ticket', title: 'ABC-4', at: 1, detail: 'created' }]).map((o) => o.title)).toEqual(['ABC-4'])
})

test('web: the go field offers the session URLs, newest first, narrowed by every typed word', () => {
  const outs = [
    { url: 'https://github.com/acme/ccproxy/pull/267', title: 'acme/ccproxy#267', kind: 'pr', at: 3 },
    { url: 'https://acme.slack.com/archives/C0ALERTS001/p1792012815915499', title: '#alerts thread', kind: 'slack', at: 2 },
    { url: 'https://github.com/acme/ccproxy/pull/267', title: 'dup', kind: 'pr', at: 1 },
    { title: 'a scratch file', kind: 'scratch', at: 4 },
  ]
  expect(urlPicks(outs, '').map((p) => p.kind)).toEqual(['pr', 'slack'])
  // The rest first: a dashboard outranks newer PRs, threads and tickets.
  const mixed = [...outs, { url: 'https://grafana-internal.tools.acme.io/d/x', title: 'grafana', kind: 'link', at: 0 }, { url: 'https://acme.atlassian.net/browse/ABC-1', title: 'ABC-1', kind: 'ticket', at: 9 }]
  expect(urlPicks(mixed, '').map((p) => p.kind)).toEqual(['link', 'ticket', 'pr', 'slack'])
  expect(urlPicks(outs, 'slack alert').map((p) => p.kind)).toEqual(['slack'])
  expect(urlPicks(outs, 'nothing')).toEqual([])
})

test('web: URLs in an answer become picks, without trailing punctuation or markdown', () => {
  expect(urlsIn('see https://example.com/docs. and [x](https://a.io/b?c=1), or `https://q.dev`', 1).map((u) => [u.url, u.title])).toEqual([
    ['https://example.com/docs', 'example.com/docs'],
    ['https://a.io/b?c=1', 'a.io/b'],
    ['https://q.dev', 'q.dev'],
  ])
})

test('outputs: what the session made, apart from what it was handed or looked at', () => {
  const pasted = slackOutputs('https://acme.slack.com/archives/C0ALERTS001/p1792012815915499', 1).map((o) => ({ ...o, detail: 'from your prompt' }))
  expect(isMade(pasted[0]!)).toBe(false)
  expect(isMade({ kind: 'slack', detail: 'replied' })).toBe(true)
  expect(isMade({ kind: 'ticket', detail: 'mentioned' })).toBe(false)
  expect(isMade({ kind: 'ticket', detail: 'created' })).toBe(true)
  expect(isMade({ kind: 'link' })).toBe(false)
  // A PR is the session's only when it acted on it or was handed it.
  expect(isMade({ kind: 'pr' })).toBe(false)
  expect(isMade({ kind: 'pr', detail: 'mentioned' })).toBe(false)
  expect(isMade({ kind: 'pr', detail: 'created' })).toBe(true)
  expect(isMade({ kind: 'pr', detail: 'from your prompt' })).toBe(true)
  // A thread replied in, then linked in an answer, stays replied in.
  const replied = { ...pasted[0]!, detail: 'replied' }
  const merged = mergeOutputs([replied], [{ ...pasted[0]!, detail: undefined }])
  expect(merged[0]!.detail).toBe('replied')
  const both = [replied, ...pasted.map((o) => ({ ...o, id: o.id + 'x' }))]
  expect(filterOutputs(both, 'all', 'in').length).toBe(1)
  expect(filterOutputs(both, 'slack', 'out').map((o) => o.detail)).toEqual(['replied'])
})

test('auth: claude mcp list gives each server its state; names without claude.ai are the person\'s own', () => {
  const items = parseMcpList('Checking MCP server health…\n\nclaude.ai Slack: https://x - ✔ Connected\nclaude.ai Clay: https://y - ! Needs authentication\ngestalt: https://g (HTTP) - ! Needs authentication\nrea: bunx rea mcp - ✗ Failed to connect')
  expect(items.map((i) => [i.id, i.state, !!i.mine])).toEqual([
    ['mcp:claude.ai Slack', 'ok', false],
    ['mcp:claude.ai Clay', 'unknown', false],
    ['mcp:gestalt', 'expired', true],
    ['mcp:rea', 'expired', true],
  ])
  expect(items[3]!.detail).toBe('failed to connect')
  expect(items[0]!.fix).toBeUndefined()
})

test('flow: a subagent keeps its conclusion, decisions and findings, labelled; they sit under the turn that started it', () => {
  const a = agentFlow('결론: 원인은 TTL입니다.\n\n## 원인\n측정 결과 548개 part가 level 0입니다.\n\n진행 중 메모입니다.\n\n## 제안\nMOVE PART로 옮기기를 추천합니다.', 't1', 5, 'review:bugs', 'review-changes')
  expect(a.map((e) => e.kind)).toEqual(['conclusion', 'finding', 'decision'])
  expect(a.every((e) => e.by === 'review:bugs' && e.run === 'review-changes')).toBe(true)
  // A run that finished after the next prompt still shows under its own turn.
  const entries = [
    { at: 1, turnId: 't1', kind: 'prompt' as const, text: 'review' },
    { at: 2, turnId: 't1', kind: 'conclusion' as const, text: 'started' },
    { at: 3, turnId: 't2', kind: 'prompt' as const, text: 'next thing' },
    ...a,
  ]
  expect(visibleFlow(entries, 'all', false).map((e) => e.turnId + ':' + e.kind)).toEqual(['t1:prompt', 't1:conclusion', 't1:conclusion', 't1:finding', 't1:decision', 't2:prompt'])
  expect(visibleFlow(entries, 'agents', false).map((e) => e.kind)).toEqual(['prompt', 'conclusion', 'finding', 'decision'])
})

test('web: engine rules by URL — host and subdomains, * globs, path prefixes, first match wins', () => {
  const rules = parseEngineRules('claude.ai=chrome, *.okta.com chrome\ngithub.com/acme=webkit, bad=nope, https://Example.com/=electron, github.com=chrome')
  expect(rules.map((r) => r.pattern)).toEqual(['claude.ai', '*.okta.com', 'github.com/acme', 'example.com', 'github.com'])
  expect(engineForUrl('https://claude.ai/new', rules)).toBe('chrome')
  expect(engineForUrl('https://www.claude.ai/', rules)).toBe('chrome')
  expect(engineForUrl('https://notclaude.ai/', rules)).toBeUndefined()
  expect(engineForUrl('https://acme.okta.com/app', rules)).toBe('chrome')
  expect(engineForUrl('https://github.com/acme/infra', rules)).toBe('webkit')
  expect(engineForUrl('https://github.com/acmex', rules)).toBe('chrome')
  expect(engineForUrl('https://example.com/a', rules)).toBe('electron')
  expect(engineForUrl('about:blank', rules)).toBeUndefined()
  expect(engineForUrl('data:text/html,x', rules)).toBeUndefined()
})

test('help: fixed sections plus the open tab\'s letters, k and repeats dropped', () => {
  const s = helpSections('Chat', [{ key: 'a', label: 'All' }, { key: 'k', label: 'search' }, { key: 'a', label: 'All' }, { key: 'i', label: 'ask' }])
  expect(s.map((x) => x.title)).toEqual(['Anywhere', 'Cockpit', 'This tab (Chat)', 'Search', 'Commands'])
  expect(s[2]!.rows).toEqual([['a', 'All'], ['i', 'ask']])
  expect(helpSections('Now', []).map((x) => x.title)).not.toContain('This tab (Now)')
})

test('In/Out filter: every word in kind words, title, URL, path or detail, any order, case-insensitive', () => {
  const slack = { id: 's', kind: 'slack' as const, title: 'Slack · #infra-alerts', url: 'https://acme.slack.com/archives/C1/p1', at: 1 }
  const jira = { id: 'j', kind: 'ticket' as const, title: 'ABC-123', url: 'https://acme.atlassian.net/browse/ABC-123', at: 1 }
  expect(matchOutput(slack, '')).toBe(true)
  expect(matchOutput(slack, 'slack')).toBe(true)
  expect(matchOutput(slack, 'INFRA slack')).toBe(true)
  expect(matchOutput(slack, 'jira')).toBe(false)
  expect(matchOutput(jira, 'jira')).toBe(true)
  expect(matchOutput(jira, 'abc-12')).toBe(true)
  expect(matchOutput(jira, 'abc-12 slack')).toBe(false)
  expect(filterOutputs([slack, jira], 'all', 'out', 'jira').map((o) => o.id)).toEqual([])
})

test('org: parsed from the file, bad fields dropped, and with none each feature is off', async () => {
  const saved = org()
  const o = parseOrg(JSON.stringify({
    slack: { team: 'acme', defaultTargets: { C1: '#r', bad: 3 } },
    jira: { baseUrl: 'https://acme.atlassian.net/', projects: ['ABC', 'lower', 7] },
    github: { accounts: { Acme: 'w', other: '' } },
    stacks: [{ name: 'Main', prefixes: ['prod-'] }, { name: '', prefixes: ['x'] }, { name: 'Empty', prefixes: [] }],
    awsSsoProfiles: ['cloud', 1],
  }))
  expect(o.slack.defaultTargets).toEqual({ C1: '#r' })
  expect(o.jira).toEqual({ baseUrl: 'https://acme.atlassian.net', projects: ['ABC'] })
  expect(o.stacks).toEqual([{ name: 'Main', prefixes: ['prod-'] }])
  expect(o.awsSsoProfiles).toEqual(['cloud'])
  expect(orgAccount('acme/repo', o)).toBe('w')
  expect(orgAccount('other/repo', o)).toBeUndefined()
  expect(orgAccount('nobody/repo', o)).toBeUndefined()
  expect(orgStack('prod-x', o)).toBe('Main')
  expect([...'see ABC-12 and XYZ-3'.matchAll(jiraKeyPattern(o)!)].map((m) => m[0])).toEqual(['ABC-12'])
  expect(parseOrg('not json')).toEqual(EMPTY_ORG)
  expect(parseOrg(undefined)).toEqual(EMPTY_ORG)

  // No file: no ticket outputs, no stack labels, no SSO pre-check, no
  // default Slack target, no account switching.
  setOrg(EMPTY_ORG)
  try {
    expect(ticketOutputs('ABC-12 is done', 1)).toEqual([])
    expect(stackOf('prod-x')).toBe('')
    expect(credentialFor('aws --profile cloud-x s3 ls')).toBeUndefined()
    expect(ghAccountFor('acme/x')).toBeUndefined()
  } finally {
    setOrg(saved)
  }
})

test('mcp heal: a dropped-server failure is told from a tool error; a tool maps to its server', () => {
  expect(isMcpTool('mcp__claude_ai_Slack__slack_read_thread')).toBe(true)
  expect(isMcpTool('Bash')).toBe(false)
  expect(looksDisconnected({ isError: true, result: { content: [{ type: 'text', text: 'MCP error -32000: Connection closed' }] } })).toBe(true)
  expect(looksDisconnected({ deny: 'MCP server "portal" is not connected' })).toBe(true)
  expect(looksDisconnected({ isError: true, result: 'read tcp 127.0.0.1:1->127.0.0.1:2: read: connection reset by peer' })).toBe(true)
  // A real tool error (bad argument, not found) is the tool's, not the server's.
  expect(looksDisconnected({ isError: true, result: { content: [{ type: 'text', text: 'channel_not_found' }] } })).toBe(false)
  expect(resultText({ result: { a: ['x', { b: 'y' }] } })).toBe('x\ny')
  // A tool name maps back to its server by the engine's normalization.
  expect(mcpServerKey('mcp__claude_ai_Slack__slack_read_thread')).toBe('claude_ai_Slack')
  expect(normalizeServer('claude.ai Slack')).toBe('claude_ai_Slack')
  expect(mcpServerKey('Bash')).toBeUndefined()
})

test('slack follow: due only when auto, unseen replies exist and their newest is not the one already run', () => {
  const st = { channel: 'C1', root: '1.0', replies: 2, unseen: 1, newest: '2.0', checkedAt: 0 }
  expect(followDue(st, { auto: true })).toBe(true)
  expect(followDue(st, { auto: true, lastRun: '2.0' })).toBe(false)
  expect(followDue(st, { auto: false })).toBe(false)
  expect(followDue({ ...st, unseen: 0 }, { auto: true })).toBe(false)
  expect(followDue(undefined, { auto: true })).toBe(false)
})

test('webside: tweb panes narrowed to this window; the driven pane stays, else the wanted engine', () => {
  const json = JSON.stringify([
    { pane: '%66', status: { browser: 'electron', pane: null, tabs: { tabs: [{ index: 0, title: 'hosted', url: 'https://a/' }] } } },
    { pane: '%43', status: { browser: 'electron', pane: null, tabs: { tabs: [{ index: 0, title: 'A', url: 'https://a/', active: true }] } } },
    { pane: '%44', status: { browser: 'chrome', pane: '%44', tabs: { tabs: [] } } },
    { pane: '%9', status: { browser: 'webkit', pane: '%9', tabs: { tabs: [] } } },
  ])
  const panes = parseTwebPanes(json, new Set(['%42', '%43', '%44', '%66']), '%66')
  // An Electron pane reports status.pane null; the page this session hosts
  // is listed under its own pane (%66); %9 is in another window.
  expect(panes.map((p) => p.pane)).toEqual(['%43', '%44'])
  expect(panes[0]?.tabs[0]).toEqual({ index: 0, title: 'A', url: 'https://a/', active: true })
  expect(pickSidePane(panes, { prefer: '%44' })?.pane).toBe('%44')
  expect(pickSidePane(panes, { engine: 'chrome' })?.pane).toBe('%44')
  // A managed-Chrome URL must not land in Electron.
  expect(pickSidePane(panes, { engine: 'webkit', strict: true })).toBeUndefined()
  expect(pickSidePane(panes, { engine: 'webkit' })?.pane).toBe('%43')
  expect(parseTwebPanes('not json', new Set())).toEqual([])
  expect(sideArgv('%43', ['tab', 'switch', '1'])).toEqual(['tweb', 'tab', 'switch', '1', '--pane', '%43'])
  expect(splitArgv('%42', 'chrome', 'https://x/', '/work')).toEqual(['split-window', '-h', '-P', '-F', '#{pane_id}', '-t', '%42', '-c', '/work', 'tweb', 'open', '--engine', 'chrome', 'https://x/'])
})

test('webside: tweb commands in a Bash line and tweb MCP tools read as automation steps; console and network parse', () => {
  expect(twebSteps('tweb snapshot --pane %43 && tweb fill e3 "a b" --pane %43 --json')).toEqual([
    { verb: 'snapshot', detail: '', pane: '%43' },
    { verb: 'fill', detail: 'e3 a b', pane: '%43' },
  ])
  expect(twebSteps('~/.local/bin/tweb click e1')).toEqual([{ verb: 'click', detail: 'e1', pane: undefined }])
  expect(twebSteps('tweb config list; tweb --help; echo tweb')).toEqual([])
  expect(twebSteps('git status')).toEqual([])
  expect(twebMcpStep('mcp__tweb__click', { ref: 'e2', pane: '%43' })).toEqual({ verb: 'click', detail: 'ref=e2', pane: '%43' })
  expect(twebMcpStep('mcp__slack__send', {})).toBeUndefined()
  expect(parseConsole(JSON.stringify({ messages: [{ at: 't', level: 'warning', message: '%cHi\nmore' }] }))).toEqual([{ at: 't', level: 'warning', text: 'Hi' }])
  expect(parseNetwork(JSON.stringify({ requests: [{ timestamp: 't', method: 'GET', statusCode: 404, resourceType: 'script', url: 'u' }] }))).toEqual([{ at: 't', method: 'GET', status: 404, type: 'script', url: 'u', failed: false }])
  expect(parseConsole('nope')).toEqual([])
})

test('webside: the mod-to-tweb link from tweb panes and tweb daemon status', () => {
  expect(linkOf({ exitCode: 0, stdout: '[]' }, 5)).toEqual({ state: 'ok', at: 5 })
  expect(linkOf({ exitCode: 1, stderr: 'boot\nerror: twebd socket refused' }, 5)).toEqual({ state: 'down', at: 5, detail: 'error: twebd socket refused' })
  expect(linkOf({ exitCode: 127, stderr: '' }, 5).state).toBe('missing')
  expect(linkOf(new Error('spawn tweb ENOENT'), 5).state).toBe('missing')
  expect(linkOf({ exitCode: 0, stdout: 'not json' }, 5).state).toBe('down')
  expect(parseDaemonStatus('pid 597\nsocket /tmp/s.sock\nuptime_ms 68672955\npanes 2\nprotocol 2\nengine running (pid 85347)\n')).toEqual({ pid: 597, uptimeMs: 68672955, panes: 2, protocol: 2, engine: 'running (pid 85347)' })
  expect(parseDaemonStatus('')).toBeUndefined()
})

test('webside: the pane reports who is at it; the cockpit links itself by its own pane', () => {
  const json = JSON.stringify([{ pane: '%43', status: { browser: 'electron', presence: { driving: { method: 'click', at: 5 }, link: { owner: 'cc-mods %42', since: 1, expiresAt: 99 }, conflictAt: 7, lastAgent: null }, tabs: { tabs: [] } } }, { pane: '%44', status: { browser: 'chrome', tabs: { tabs: [] } } }])
  const panes = parseTwebPanes(json, new Set(['%43', '%44']))
  expect(panes[0]?.presence).toEqual({ driving: { method: 'click', at: 5 }, link: { owner: 'cc-mods %42', expiresAt: 99 }, conflictAt: 7 })
  expect(panes[1]?.presence).toBeUndefined()
  expect(linkArgv('%43', '%42')).toEqual(['tweb', 'link', '--owner', 'cc-mods %42', '--ttl', '90', '--pane', '%43'])
})

test('closingAsk names the question an answer ends on, past a trailing link', () => {
  expect(closingAsk('원인을 찾았습니다.\n\n이어서 테스트도 고칠까요?\n\nhttps://github.com/keyolk/cc-mods/pull/17')).toBe('이어서 테스트도 고칠까요?')
  expect(closingAsk('Done.\nShall I also update the README?')).toBe('Shall I also update the README?')
})

test('loginError: a server not connected in this session points to /mcp, anything else passes through', () => {
  const raw = 'HooksError: cc-mods: $.mcp.call: no connected MCP tool "authenticate" on a server named "gestalt"'
  expect(loginError(new Error(raw), 'gestalt')).toBe('not connected in this session, so it offers no login tool here: run /mcp, pick gestalt, then Authenticate')
  expect(loginError(new Error('timeout'), 'gestalt')).toBe('Error: timeout')
})

test('a server not connected here logs in from a pane under this one', () => {
  expect(needsTerminalLogin(new Error('$.mcp.call: no connected MCP tool "authenticate" on a server named "gestalt"'))).toBe(true)
  expect(needsTerminalLogin(new Error('timeout'))).toBe(false)
  expect(loginSplitArgv('%42', 'gestalt')).toEqual(['split-window', '-v', '-l', '6', '-d', '-P', '-F', '#{pane_id}', '-t', '%42', 'claude', 'mcp', 'login', '--no-browser', 'gestalt'])
})


test('fork: the moved request is set aside here as one exchange; the rest keeps its handles', () => {
  const u = (text: string, handle: string, toolResults?: unknown[]) => ({ role: 'user' as const, text, toolUses: [], toolResults, handle })
  const a = (text: string, handle: string) => ({ role: 'assistant' as const, text, toolUses: [], handle })
  const msgs = [u('fix the band', 'h1'), a('fixed', 'h2'), u('deploy the docs site please', 'h3'), a('', 'h4'), u('', 'h5', [{}]), a('deploying', 'h6'), u('[Request interrupted by user]', 'h7'), u('next thing', 'h8'), a('ok', 'h9')]
  const out = setAsideMoved(msgs, { prompt: 'deploy the docs site please', pane: '%77' })!
  expect(out.map((m) => m.handle)).toEqual(['h1', 'h2', undefined, undefined, 'h8', 'h9'])
  expect(out[2]).toMatchObject({ role: 'user', text: 'deploy the docs site please' })
  expect(out[3]?.text).toContain('%77')
  // At the end of the transcript, the span runs to the end.
  expect(setAsideMoved(msgs.slice(0, 7), { prompt: 'deploy the docs site please', pane: '%77' })!.map((m) => m.handle)).toEqual(['h1', 'h2', undefined, undefined])
  expect(setAsideMoved(msgs, { prompt: 'not here', pane: '%77' })).toBeNull()
})

test('outputs: an answer hands over files by path, or by name under a folder it names; versions are not files', () => {
  const dir = '/private/tmp/claude-502/-x/sid/scratchpad/tg'
  const t = 'All in `' + dir + '/`:\n| `probes.csv` | 2KB |\n| `connector.log.gz` | 5MB |\nversion `2.1.280`; also ~/logs/a.txt and (/var/log/x.log).'
  const fs = answerFiles(t, 1)
  expect(fs.map((o) => o.path).sort()).toEqual(['/var/log/x.log', '~/logs/a.txt', dir + '/connector.log.gz', dir + '/probes.csv'].sort())
  expect(fs.find((o) => o.path === dir + '/probes.csv')).toMatchObject({ kind: 'scratch', detail: IN_ANSWER })
  expect(fs.find((o) => o.path === '/var/log/x.log')?.kind).toBe('file')
  // No folder named: bare names stay names.
  expect(answerFiles('see `probes.csv`', 1)).toEqual([])
  // A named file outside the scratchpad shows in All and Files, first in Files; a plain edit does not.
  const edit = toolOutputs('Write', { file_path: '/repo/a.ts' }, { result: {} }, 5)
  const old = toolOutputs('Write', { file_path: dir + '/old.md' }, { result: {} }, 9)
  const list = [...old, ...edit, ...fs]
  expect(filterOutputs(list, 'all').some((o) => o.path === '/var/log/x.log')).toBe(true)
  expect(filterOutputs(list, 'all').some((o) => o.path === '/repo/a.ts')).toBe(false)
  expect(filterOutputs(list, 'scratch').at(-1)?.path).toBe(dir + '/old.md')
})

test('auth: the SSO cache file is named by sha1 of the start URL from org.json; none set, no AWS row', () => {
  expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
  expect(sha1Hex('https://d-1234567890.awsapps.com/start')).toBe('7487b5b67d5fa1132cf33fa93ae51ef38cc37752')
  // Past one 64-byte block.
  expect(sha1Hex('a'.repeat(100))).toBe('7f9000257a4918d7072655ea468540cdcbd42e0c')
  expect(parseOrg(JSON.stringify({ awsSsoStartUrl: ' https://d-1234567890.awsapps.com/start ' })).awsSsoStartUrl).toBe('https://d-1234567890.awsapps.com/start')
  expect(parseOrg('{}').awsSsoStartUrl).toBeUndefined()
})

test('exp: a session that writes into ~/exp/<date>_<topic> is linked to it; reading one is not; README Open, last message and sums parse', () => {
  const dir = '/Users/a/exp/2026-10-14_vendor_17043'
  expect(expFromTool('Write', { file_path: dir + '/attachments/probes.csv' }, 1).map((o) => [o.kind, o.path, o.detail])).toEqual([['exp', dir, 'archived']])
  expect(expFromTool('Bash', { command: 'mkdir -p ~/exp/2026-10-14_vendor_17043/{attachments,drafts} && mv /tmp/x.gz "$HOME/exp/2026-10-14_vendor_17043/attachments/"' }, 1).map((o) => o.path)).toEqual(['~/exp/2026-10-14_vendor_17043'])
  expect(expFromTool('Bash', { command: 'ls -la ~/exp/2026-10-14_vendor_17043' }, 1)).toEqual([])
  expect(expFromTool('Bash', { command: 'cat x > ~/exp/2026-10-14_vendor_17043/work/x.txt' }, 1)).toHaveLength(1)
  // Not a dated folder: not an archive.
  expect(expFromTool('Write', { file_path: '/Users/a/exp/.gw/x' }, 1)).toEqual([])
  expect(expFromAnswer('All kept in `' + dir + '/`.', 1).map((o) => [o.path, o.detail])).toEqual([[dir, 'named']])

  const readme = '# T\n\n## Open\n- Attachments promised on 2026-10-21 — not delivered yet.\n- See `correspondence.md` for every message in/out.\n- Vendor asks for DEBUG logs.\n  | a | b |\n\n## Files\n- x'
  expect(parseOpen(readme)).toEqual(['Attachments promised on 2026-10-21 — not delivered yet.', 'Vendor asks for DEBUG logs.'])
  expect(parseOpen('# T\n## Files\n- x')).toEqual([])
  const corr = '# C\n\n| time | dir | who | link | gist | files |\n|---|---|---|---|---|---|\n| 10-14 10:31 | out | me | l | reported | — |\n| 10-22 05:43 | in | Sam | l | asks for DEBUG logs | — |\n'
  expect(lastMessage(corr)).toBe('10-22 05:43 · in · asks for DEBUG logs')

  const sums = parseSums('a.gz: OK\nb.csv: FAILED\nc.log: FAILED open or read\n--ls\nSHA256SUMS\na.gz\nb.csv\nd.txt\n')!
  expect(sums).toEqual({ ok: 1, failed: ['b.csv', 'c.log'], unlisted: ['d.txt'] })
  expect(parseSums('')).toBeUndefined()
  const c = { open: ['x'], sums, at: 1 }
  expect(expStatus(c)).toBe('1 open · ⚠ 2 changed')
  expect(expNeedsYou({ open: [], sums: { ok: 2, failed: [], unlisted: [] }, at: 1 })).toBe(false)
  expect(expPreview(dir, c, readme)).toContain('not in SHA256SUMS: `d.txt`')
})
