// cc-mods: a session cockpit for a tmux-centred Claude Code setup.
//
//   tmux state      @cc_state/@cc_attention from the events themselves, not
//                   from Notification/Stop guesses; plus @cc_ctx/@cc_agents
//   panes           /flow /graph /side /outputs /policy, toggled like /diff,
//                   docked as tabs (ctrl+x tab), Esc closes
//   band            credential radar, the session's PRs, neighbors, fork offer
//   policy          only a person changes session policy; Claude's Bash
//                   attempts to self-grant are refused
//   auth            expired SSO stops an aws/kubectl call before it fails
//   gh              a gh call runs as the account that owns the repo
//   autocomplete    kubectl contexts, AWS profiles, Jira keys, PRs, windows
//
// Judgment that already exists in ~/.claude/hooks (Jev attention, fork,
// neighbors) is reached through bin/cc-bridge.py rather than rewritten.
//
// Rule from `claude plugin validate`: `$` may only be passed to functions
// declared at the top level of this file, so every helper that touches the
// mods API lives here; hooks/lib and hooks/views are pure.

import { atom, read, update } from 'claude-code'
import type { Elements, RenderElement } from 'claude-code'

import { BROWSER_LABEL, resolveBrowser, browserArgv, parseBrowser, type BrowserChoice } from './lib/browser'
import { WEB_IDLE, engineForUrl, engineOfTarget, formatEngineRules, parseEngine, parseEngineRules, type EngineRule, urlPicks, urlsIn, type WebEngine, keyBytes, urlFromInput, sgrMouse, sgrWheel, toHex, type KeyMsg, type PointerMsg, type WebState } from './lib/web'
import { WEB_SETTINGS_ROWS, pickRows, renderWeb, type WebSettings } from './views/web'
import { renderWebSide } from './views/webside'
import { LINK_RENEW_MS, SIDE_EMPTY, linkArgv, linkOf, parseConsole, parseDaemonStatus, parseNetwork, parseTwebPanes, pickSidePane, sideArgv, splitArgv, twebMcpStep, twebSteps, type AutoStep, type SidePane, type SideWeb, type TwebLink } from './lib/webside'
import { renderHelp } from './views/help'
import { helpSections } from './lib/help'
import { COCKPIT_ACTION, GROW_ACTION, PALETTE_ACTION, catchAll, paletteNextKey, renderPalette } from './views/palette'
import { PALETTE_CLOSED, filterPalette, paletteItems, type PaletteItem, type PaletteState } from './lib/palette'
import { cacheGate, decide, resolveModel, routeLabel, type RouteLast, routeSettings, type RouteAnswer, type RouteDecision, type RouteSettings } from './lib/route'
import { parseJev, parseQuota, parseUsage, type JevUsage, type Quota, type Usage } from './lib/usage'
import { USAGE_WINDOWS, renderUsage, type UsageWindow } from './views/usage'
import { argocdItems, awsItem, clearedByCache, awsLoginReused, awsReusedItem, parseMcpList, sha1Hex, ssoProfile, ccproxyItems, coderLocalItems, credentialFor, daemonItem, ghItems, mcpItems, worst, type AuthItem, type Radar } from './lib/auth'
import { EMPTY, parseProfiles, suggest, type Sources } from './lib/complete'
import { BLOCK_TTL_MS, blockOf, grantLabel, nowAllowed, resumePrompt, type Blocked } from './lib/unblock'
import { alreadyIn, authUrl, connectorUrl, isCallbackUrl, isClaudeAi, loginError, loginSplitArgv, markLoggedIn, needsTerminalLogin, serverOf, textOf, type McpLogin } from './lib/mcpauth'
import { cockpitColumns } from './lib/layout'
import { RCA_MS, alertOf, rcaGrants, rcaSection, restoreArgvs, type Alert, type Grant, type RcaState } from './lib/rca'
import { identityText } from './lib/identity'
import type { LiveTurn } from './views/flow'
import { FORK_STALE_AFTER, forkEffect, forkPhase, forkPrompt, movedSection, setAsideMoved, type ForkOffer } from './lib/fork'
import { parseGoal, type Goal } from './lib/goal'
import { capAnswers, isHumanPrompt, parseStamps, rebuild, transcriptPath, type BackfillMessage } from './lib/backfill'
import { agentFlow, flowOf } from './lib/flow'
import { HELD_PREFIX, firstLine, heldNotification, holdDeadline, isWrite, parseExpiry, parseMonitor, shouldRearm, splitLines, startedTaskId, turnMattered, watchInput, weigh, type MonitorState, type WatchInput, type Weight } from './lib/monitor'
import { K, PANES, PANE_TITLES, paneKey, paneOf, type PaneId } from './lib/keys'
import { CAPS, GOD_MS, godArgvs, slackDefaultTargets, isProdContext, parseChannelSearch, parseUserSearch, slackTargetKind, badge, hintsFromBlock, hintsFromCommand, isSelfGrant, parsePolicy, parsePolicyArgs, scopeHints, shortName, type Cap, type CapValue, type Policy, type ScopeHint } from './lib/policy'
import { ghAccountFor, gitopsCommentsArgv, gitopsFromComments, graphqlQuery, needsAttention, parseGraphql, parsePrKey, repoFromGh, repoFromRemote, setIacWindows, type PrStatus } from './lib/prs'
import { parseWindows } from './lib/iac'
import { answerFiles, dropUnsourcedTickets, isMade, outputKeysToDrop, prOutputs, ticketOutputs, mergeOutputs, workflowMeta, setSlackName, slackName, slackOutputs, textOutputs, toolOutputs, type AgentNode, type FlowEntry, type Output, type TurnRecord } from './lib/record'
import { clearArgv, isPaneId, publishArgv, type Attention, type CcState } from './lib/tmux'
import { clip, hhmm } from './lib/text'
import { isMcpTool, looksDisconnected, mcpServerKey, normalizeServer } from './lib/mcpheal'
import { clientItems, navItems, navTarget, skipHidden, type NavDir, type NavItem } from './lib/nav'
import { SUMS_CHECK, expFromAnswer, expFromTool, expPreview, lastMessage, parseOpen, parseSums, type ExpCheck } from './lib/exp'
import { focusWindowArgv, parseBrief, parseWindows as parseTmuxWindows, type Elsewhere, type Todo } from './lib/elsewhere'
import { ORG_PATH, org, parseOrg, setOrg } from './lib/org'
import { answerBody, freshItems, itemKey, parseAttention, parseRuns, resultPrompt, runOutputs, toastFor, type NarwhalItem, type NarwhalRun } from './lib/narwhal'
import { RESUME_SPREAD_MS, backoff, classify, decide as resumeDecide, slept, type Pending } from './lib/resume'
import { mayRun, parseLease, settled, spread, taken, type Lease, type LeaseTimes } from './lib/lease'
import { mcpText, newestTs, parseChannelName, parseThread, unseenReplies, type SlackThreadState, followDue, type SlackFollow } from './lib/slack'
import { unlockFor } from './lib/unlock'
import { renderBand, type Neighbor } from './views/band'
import { renderFlow, type FlowFilter } from './views/flow'
import { mermaid, renderGraph, type GraphMode } from './views/graph'
import { renderOutputs, type OutScope, type OutSide, type OutTab, type Preview } from './views/outputs'
import { renderPolicy, renderRoute } from './views/policy'
import { renderSide, type SideQA } from './views/side'
import { sidePrompt } from './lib/side'
import { renderSettings } from './views/settings'
import { col, tabRow, type Els } from './views/common'
import { FRAME_BOTTOM, FRAME_TOP, SPACER_ROWS, TABS, frame, renderHome, renderNarwhalRuns, renderWatch, tabOf, type HomeView, type View } from './views/home'
import { renderAuthTab } from './views/auth'
import { section } from './views/common'
import { PROCEED_MAX, PROCEED_POLICY, PROCEED_REPLY, closingAsk } from './lib/proceed'

const P = 'cc-mods'
const HOME_HOOKS = '/.claude/hooks/'
// The SSO session the Auth tab watches (org.json awsSsoStartUrl), and its
// token cache file, which the AWS CLI names sha1(start URL).json. None
// configured: no AWS row.
const ssoCacheFile = (h: string) => {
  const url = org().awsSsoStartUrl
  return url ? h + '/.aws/sso/cache/' + sha1Hex(url) + '.json' : undefined
}
// The office server's port (office/office.py); 8787 is taken by cco here.
const OFFICE_PORT = 8796
const IDLE_MS = 30 * 60_000
const RADAR_MS = 5 * 60_000
const PR_POLL_MS = 90_000
// One PR poll machine-wide per PR_POLL_MS; after failures, 90 s doubling to 15 min.
// runMs covers a slow run (20 s per account, more for GitOps comments); a
// success replaces it with freshMs.
const PR_LEASE: LeaseTimes = { runMs: 5 * 60_000, freshMs: PR_POLL_MS - 10_000, baseMs: PR_POLL_MS, capMs: 15 * 60_000 }
// Slack threads this session touched are re-read this often for new replies.
const SLACK_POLL_MS = 3 * 60_000
const SLACK_SERVER = 'claude.ai Slack'
const FLOW_CAP = 600

// ---- reactive state ------------------------------------------------------

const flowA = atom({ plugin: 'cc-mods', key: 'flow' }, [] as FlowEntry[])
// The main turn while it runs, for the Chat tab: what each step said and
// which tools it called. Flow entries come only when a turn completes, so a
// long turn showed nothing past its prompt.
const liveA = atom({ plugin: 'cc-mods', key: 'live' }, null as LiveTurn | null)
const answersA = atom({ plugin: 'cc-mods', key: 'answers' }, {} as Record<string, string>)
const turnsA = atom({ plugin: 'cc-mods', key: 'turns' }, [] as TurnRecord[])
const agentsA = atom({ plugin: 'cc-mods', key: 'agents' }, [] as AgentNode[])
const outputsA = atom({ plugin: 'cc-mods', key: 'outputs' }, [] as Output[])
const sideA = atom({ plugin: 'cc-mods', key: 'side' }, [] as SideQA[])
const policyA = atom({ plugin: 'cc-mods', key: 'policy' }, null as Policy | null)
const authA = atom({ plugin: 'cc-mods', key: 'auth' }, [] as AuthItem[])
const prsA = atom({ plugin: 'cc-mods', key: 'prs' }, [] as PrStatus[])
// Scopes this session's commands used or a guard blocked (lib/policy.ts
// ScopeHint). In $.state, so a module reload keeps them; backfilled from the
// transcript once per load.
const hintsA = atom({ plugin: 'cc-mods', key: 'hints' }, [] as ScopeHint[])
// Calls a policy guard refused, kept until a grant lets them through (lib/unblock.ts).
const blockedA = atom({ plugin: 'cc-mods', key: 'blocked' }, [] as Blocked[])
const rcaA = atom({ plugin: 'cc-mods', key: 'rca' }, null as RcaState)
const mcpLoginA = atom({ plugin: 'cc-mods', key: 'mcpLogin' }, null as McpLogin | null)
const slackA = atom({ plugin: 'cc-mods', key: 'slack' }, {} as Record<string, SlackThreadState>)
// Threads followed up automatically (lib/slack.ts SlackFollow), mirrored to the store.
const slackFollowA = atom({ plugin: 'cc-mods', key: 'slackFollow' }, {} as Record<string, SlackFollow>)
// Archive folders' checks, by path (lib/exp.ts): recomputed, never stored.
const expA = atom({ plugin: 'cc-mods', key: 'exp' }, {} as Record<string, ExpCheck>)
const elsewhereA = atom({ plugin: 'cc-mods', key: 'elsewhere' }, { windows: [], todos: [] } as { windows: Elsewhere[]; todos: Todo[] })
// What this session's narwhal runs need (lib/narwhal.ts): the items, and the
// keys already told (toast) or dismissed, so a poll does not repeat them.
const narwhalA = atom({ plugin: 'cc-mods', key: 'narwhal' }, { items: [], told: [], dismissed: [], runs: [] } as { items: NarwhalItem[]; told: string[]; dismissed: string[]; runs: NarwhalRun[] })
// A main turn that died on a connection problem, waiting for the network
// (lib/resume.ts); null when nothing is pending.
const resumeA = atom({ plugin: 'cc-mods', key: 'resume' }, null as Pending | null)
const neighborsA = atom({ plugin: 'cc-mods', key: 'neighbors' }, [] as Neighbor[])
const monitorsA = atom({ plugin: 'cc-mods', key: 'monitors' }, [] as MonitorState[])
const webA = atom({ plugin: 'cc-mods', key: 'web' }, WEB_IDLE as WebState)
// What Jev picked last; whether it runs is the session policy (auto_effort, auto_model).
const routeA = atom({ plugin: 'cc-mods', key: 'route' }, { last: undefined } as { last?: RouteDecision & { prompt: string; at: number } })
const webSettingsA = atom({ plugin: 'cc-mods', key: 'webSettings' }, { open: false, engine: 'electron', device: '', rate: 30 } as WebSettings)
const webKeyboardA = atom({ plugin: 'cc-mods', key: 'webKeyboard' }, 'controls' as 'controls' | 'page')
// The TWeb pane beside this one that the Web tab drives (browserEmbed off).
const sideWebA = atom({ plugin: 'cc-mods', key: 'webSide' }, SIDE_EMPTY as SideWeb)
// Browser commands agents ran this session (Bash `tweb …`, tweb MCP tools).
const webAutoA = atom({ plugin: 'cc-mods', key: 'webAuto' }, [] as AutoStep[])
// How long after a browser command the Web tab says Claude is driving.
const DRIVING_MS = 8000
const paletteA = atom({ plugin: 'cc-mods', key: 'palette' }, PALETTE_CLOSED as PaletteState)
// The key help (alt+/) is open; a session starts with it closed, as the palette.
const helpA = atom({ plugin: 'cc-mods', key: 'help' }, false as boolean)
const usageA = atom({ plugin: 'cc-mods', key: 'usage' }, { note: 'loading…', quota: [], window: 'session' } as { usage?: Usage; note?: string; quota: Quota[]; window: UsageWindow; jev?: JevUsage })
const goalA = atom({ plugin: 'cc-mods', key: 'goal' }, null as Goal | null)
const forkA = atom({ plugin: 'cc-mods', key: 'fork' }, null as ForkOffer | null)
// Lines of work handed to fork panes, which this session should leave alone.
const movedA = atom({ plugin: 'cc-mods', key: 'moved' }, [] as { prompt: string; pane: string }[])
const uiA = atom(
  { plugin: 'cc-mods', key: 'ui' },
  {
    flowFilter: 'all',
    flowProgress: false,
    flowSel: -1,
    graphMode: 'tree',
    graphSel: '',
    graphCollapsed: true,
    outTab: 'all',
    outScope: 'session',
    outSel: '',
    policyMsg: '',
    focus: false,
    view: 'home',
    open: false,
  },
)

// ---- module-level (lost on reload, which is fine for these) ---------------

let pane: string | undefined
let sid = ''
let cwd = ''
let repo: string | undefined
// Scopes seen in this session's commands and policy denials (lib/policy.ts
// ScopeHint), offered as one-press grants on the Policy tab.
let home = ''
let interactive = false
let idleTimer: { cancel: () => void } | undefined
let sources: Sources = EMPTY
let currentTurn = ''
let lastPrompt = ''
// The last prompt the person typed. turn.start carries no origin, so this is
// how it tells a real request from a task notification or an agent hand-back.
let pendingHuman = ''
// auto_continue (lib/proceed.ts): proceed questions answered in a row without
// the person typing, and the answer waiting to go out.
let proceedStreak = 0
let proceedTimer: { cancel: () => void } | undefined
// A moved request waiting to be set aside in this transcript (lib/fork.ts
// setAsideMoved), read by the session.compact hook this mod's own compaction
// runs through.
let setAside: { prompt: string; pane: string } | undefined
// The turn a Monitor event started, while it runs. Its tool rows and text are
// folded in the transcript unless, at turn.complete, it turns out to matter.
let quietTurn: { turnId: string; taskId: string; event: string; weight: Weight; wrote: boolean; tools: string[]; texts: string[] } | undefined
// The task a quiet re-arm replaces, while its Monitor call runs: the
// tool.call hook carries the Watch row over to the new task id.
let rearmingFrom: string | undefined
// Watches the cockpit runs itself (lib/monitor.ts, holdDeadline), by task id.
const holds = new Map<string, { stop: (why: 'stopped' | 'expired') => void }>()
const quietTools = new Set<string>()
const quietTexts: string[] = []
const quietFinal = new Map<string, string>() // answer head -> one-line outcome
// Routine Monitor events whose turn turned out to matter: their notification
// row comes back into the transcript. Keyed by task id + event line.
const shownEvents = new Set<string>()
const eventKey = (taskId: string, event: string) => taskId + '\u0000' + event
let preview: { id: string; p: Preview } | undefined
const policyTimers = new Map<string, { expiresAt: number; revert: string[]; timer: { cancel: () => void } }>()
let sideSeq = 0
// Session id the transcript was last replayed for, and the transcript file
// the classic SessionStart named (lib/backfill.ts).
let backfilled = ''
// The Web tab's bridge (bin/cc-browser): its socket and the engine it runs.
// One per session.
let webSock = ''
let webEngine: WebEngine | undefined
// URL pattern -> engine (lib/web.ts EngineRule): the Settings tab's list
// (this machine) over the browserEngineRules option.
let engineRules: EngineRule[] = []
let engineRulesOption: EngineRule[] = []
// The running page's engine was asked for by name (/web --chrome, the engine
// setting, a reload putting the page back): its loads do not switch engines.
let webExplicit = false
let webStopping = false
// Which bridge is current (see startWeb), and the frame rate it runs at.
let webGen = 0
let webRunRate = 0
// The bridge generation whose first page load has had the device applied.
let webDeviceGen = 0
// Where a synthetic terminal mouse click lands inside web-region, 1-based
// terminal cells. There is no plugin API that focuses a Client; terminal dock
// mode can click it by its rendered coordinates (lib/nav.ts clientItems).
let webClick: { x: number; y: number } | undefined
let webFocusPending = false
// What the open palette lists, from its last drawing: the arrows move the
// selection over these (ui.focus hook) without the focus leaving the field.
let paletteShown: PaletteItem[] = []
// The cockpit's last drawing laid out (lib/nav.ts) and where its ring is.
let navLast: NavItem[] = []
let navFocus: string | undefined
let paletteNext = ''
// How far the cockpit body is scrolled, per tab: the header stays and only
// the body moves (views/home.ts frame). The engine's own scroll is refused.
const bodyScroll = new Map<string, number>()
// The furthest each tab's body can scroll, from its last drawing.
const bodyMax = new Map<string, number>()
// Jev's effort pick per main turn, started at turn.start and read at the
// turn's first step (lib/route.ts). Dropped at turn.complete.
const routeJobs = new Map<string, Promise<RouteAnswer>>()
const ROUTE_WAIT_MS = 1500
// The region size last sent to the bridge (POST /region), as `${cols}x${rows}`.
let webRegion = ''
// userConfig.browserEmbed, read where startWeb runs (module scope, set by register).
let embedOn = false
// A `tweb panes` listing for the Web tab is under way: redraws do not stack them.
let sideListing = false
// The last `tweb link` renewal: kept off the atom, so a renewal every 20 s redraws nothing.
let sideLinkedAt = 0
let sideLinkedPane = ''
let sideAskedAt = 0
// The Settings tab's view of where links go, read when it is first drawn.
let settingsTarget: string | undefined
let settingsEnvBrowser = ''
// While the main prompt edits its first slash-command token, the engine's
// typeahead is full-terminal-width and paints over a docked Pane. Hide the
// cockpit until the token is completed (space), deleted or submitted; restore
// the same view without taking the keyboard. Stored per machine in Settings.
let slashHideEnabled = true
let slashHidCockpit = false
let slashHideBusy = false
let webRate = 30
// What this session set the pane's @browser to: the userConfig default, then
// /browser. 'inherit' means the pane holds no value of its own.
let browser: BrowserChoice = 'inherit'
let transcript = ''

// ---- helpers that use $ ---------------------------------------------------

async function tmux($: any, argvs: string[][]) {
  if (!isPaneId(pane)) return
  for (const argv of argvs) {
    try {
      await $.process.run(['tmux', ...argv], { timeoutMs: 3000 })
    } catch {
      // tmux socket gone (see tmux-socket-guard) — state publishing is best effort
    }
  }
}

// Last value written per tmux option, so a hook that fires on every redraw
// (the question dialog renders many times) does not spawn tmux each time.
const published = new Map<string, string>()

async function publish($: any, state: CcState | undefined, attention: Attention | null, extra?: Record<string, string>) {
  const want: Record<string, string> = { ...(extra ?? {}) }
  if (state) want['@cc_state'] = state
  if (attention) want['@cc_attention'] = attention
  const changed = Object.entries(want).filter(([k, v]) => published.get(k) !== v)
  if (changed.length === 0) return
  for (const [k, v] of changed) published.set(k, v)
  const keep = new Set(changed.map(([k]) => k))
  const extras = Object.fromEntries(changed.filter(([k]) => k !== '@cc_state' && k !== '@cc_attention'))
  await tmux(
    $,
    publishArgv(
      pane!,
      { state: keep.has('@cc_state') ? state : undefined, attention: keep.has('@cc_attention') ? attention : null, session: sid, extra: extras },
      Math.floor(Date.now() / 1000),
    ),
  )
}

// Run a credential's login command from a button. A failure is shown: before,
// a bad argv exited at once and the button looked like it did nothing.
// An MCP connector's login, run from the cockpit: its `authenticate` tool
// gives the OAuth URL, the system browser opens it (the person's SSO cookies
// live there), and Claude Code's localhost callback finishes it. The needs-auth
// cache losing the server is the sign it worked; a pasted callback URL
// (complete_authentication) covers a callback the browser could not reach.
let mcpPoll: { cancel: () => void } | undefined

async function startMcpLogin($: any, server: string) {
  mcpPoll?.cancel()
  await update($, mcpLoginA, () => ({ server, status: 'starting', at: Date.now(), claudeAi: isClaudeAi(server) }))
  if (isClaudeAi(server)) return startConnectorLogin($, server)
  let r: any
  try {
    r = await $.mcp.call(server, 'authenticate', {})
  } catch (err) {
    if (needsTerminalLogin(err) && isPaneId(pane)) return startTerminalLogin($, server)
    const msg = loginError(err, server)
    await update($, mcpLoginA, (l) => l && { ...l, status: 'failed', msg: clip(msg, 200) })
    return
  }
  if (alreadyIn(r)) return finishMcpLogin($, server, 'already logged in')
  const url = authUrl(r)
  if (!url || r?.isError) {
    await update($, mcpLoginA, (l) => l && { ...l, status: 'failed', msg: clip(textOf(r) || 'no login URL in the answer', 200) })
    return
  }
  await update($, mcpLoginA, (l) => l && { ...l, status: 'waiting', url })
  await openLoginPage($, url)
  $.ui.toast(server.replace(/^claude\.ai /, '') + ': log in in the browser that opened')
  const started = Date.now()
  const tick = async () => {
    const l = (await read($, mcpLoginA)) as McpLogin | null
    if (!l || l.server !== server || l.status !== 'waiting') return
    const cache = await readText($, home + '/.claude/mcp-needs-auth-cache.json')
    let stillNeeds = true
    try {
      stillNeeds = server in (cache ? JSON.parse(cache) : {})
    } catch {}
    if (!stillNeeds) return finishMcpLogin($, server, 'logged in')
    if (Date.now() - started > 10 * 60_000) return void update($, mcpLoginA, (x) => x && { ...x, status: 'failed', msg: 'no login seen in 10 minutes: paste the callback URL or start again' })
    mcpPoll = $.clock.after(3000, tick)
  }
  mcpPoll = $.clock.after(3000, tick)
}

// A claude.ai connector: its `authenticate` tool refuses ("run /mcp"), and its
// authorization lives on claude.ai. `claude mcp login --no-browser` prints the
// start-auth URL (it builds it from the signed-in org); the system browser
// opens it; `claude mcp get` health-checks the connector until it says
// Connected. The running session keeps the connection it made at start, so
// the card says to restart (or reconnect in /mcp) to use it here.
async function startConnectorLogin($: any, server: string) {
  let out = ''
  try {
    const r = await $.process.run(['claude', 'mcp', 'login', '--no-browser', server], { stdin: '', timeoutMs: 30_000 })
    out = (r.stdout || '') + (r.stderr || '')
  } catch (err) {
    out = String(err)
  }
  const url = connectorUrl(out)
  if (!url) return void update($, mcpLoginA, (l) => l && { ...l, status: 'failed', msg: clip(out.trim() || 'claude mcp login gave no URL', 200) })
  await update($, mcpLoginA, (l) => l && { ...l, status: 'waiting', url })
  await openLoginPage($, url)
  $.ui.toast(server.replace(/^claude\.ai /, '') + ': authorize it on claude.ai in the browser that opened')
  const started = Date.now()
  const tick = async () => {
    const l = (await read($, mcpLoginA)) as McpLogin | null
    if (!l || l.server !== server || l.status !== 'waiting') return
    const g = await $.process.run(['claude', 'mcp', 'get', server], { timeoutMs: 45_000 }).catch(() => undefined)
    if (g && /Status:\s*✔?\s*Connected/.test(g.stdout ?? '')) {
      authorizedAt.set(server, Date.now())
      return finishMcpLogin($, server, 'authorized on claude.ai · restart Claude Code (or /mcp → reconnect) to use it in this session')
    }
    if (Date.now() - started > 10 * 60_000) return void update($, mcpLoginA, (x) => x && { ...x, status: 'failed', msg: 'not authorized in 10 minutes: open the page again or start over' })
    mcpPoll = $.clock.after(10_000, tick)
  }
  mcpPoll = $.clock.after(10_000, tick)
}

// A server that needs login is not connected in this session, so it offers
// no `authenticate` tool, and `claude mcp login` gives up without a terminal
// (its localhost callback listener dies with it). So the login runs in a
// small tmux pane under this one: it prints the URL (opened here in the
// person's Chrome), keeps the callback listener up, and exits when the
// browser lands. Then `claude mcp get` says Connected, /mcp reconnect brings
// the server into this session, and the pane goes.
let loginPane: string | undefined

async function startTerminalLogin($: any, server: string) {
  const r = await $.process.run(['tmux', ...loginSplitArgv(pane!, server)], { timeoutMs: 5000 }).catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const id = String(r.stdout ?? '').trim()
  if (r.exitCode !== 0 || !isPaneId(id)) return void update($, mcpLoginA, (l) => l && { ...l, status: 'failed', msg: clip('could not open a login pane: ' + (r.stderr || r.stdout), 200) })
  loginPane = id
  await update($, mcpLoginA, (l) => l && { ...l, status: 'starting', msg: 'logging in from pane ' + id })
  const started = Date.now()
  let opened = false
  const tick = async () => {
    const l = (await read($, mcpLoginA)) as McpLogin | null
    if (!l || l.server !== server || (l.status !== 'starting' && l.status !== 'waiting')) return closeLoginPane($)
    if (!opened) {
      const cap = await $.process.run(['tmux', 'capture-pane', '-p', '-J', '-t', id], { timeoutMs: 3000 }).catch(() => undefined)
      const url = connectorUrl(cap?.stdout ?? '')
      if (url) {
        opened = true
        await update($, mcpLoginA, (x) => x && { ...x, status: 'waiting', url })
        await openLoginPage($, url)
        $.ui.toast(server + ': log in in the browser that opened')
      }
    }
    const g = await $.process.run(['claude', 'mcp', 'get', server], { timeoutMs: 45_000 }).catch(() => undefined)
    if (g && /Status:\s*✔?\s*Connected/.test(g.stdout ?? '')) {
      await closeLoginPane($)
      const text = await reconnectMcp($, server).catch((err: unknown) => String(err))
      const here = !/not connected|failed|error/i.test(text)
      return finishMcpLogin($, server, here ? 'logged in and reconnected here' : 'logged in · /mcp → reconnect ' + server + ' to use it here')
    }
    if (Date.now() - started > 10 * 60_000) {
      await closeLoginPane($)
      return void update($, mcpLoginA, (x) => x && { ...x, status: 'failed', msg: 'no login seen in 10 minutes: start again' })
    }
    mcpPoll = $.clock.after(opened ? 4000 : 1000, tick)
  }
  mcpPoll = $.clock.after(1000, tick)
}

async function closeLoginPane($: any) {
  const id = loginPane
  loginPane = undefined
  if (id) await $.process.run(['tmux', 'kill-pane', '-t', id], { timeoutMs: 3000 }).catch(() => undefined)
}

let mcpList: { at: number; items: AuthItem[] } | undefined
// Connectors logged in from this session, and when: shown ok over the list
// for LOGGED_IN_HOLD_MS (lib/mcpauth.ts markLoggedIn). Without it the band
// said "logged in and reconnected here" while Needs you still said expired.
const loggedInAt = new Map<string, number>()
const LOGGED_IN_HOLD_MS = 15 * 60_000
let mcpListRunning = false

// `claude mcp list` health-checks every MCP server (a claude process and each
// stdio server it starts): one session runs it for the machine and shares the
// list in $.store; on failure everyone waits 10 minutes, doubling to an hour.
const MCP_LIST_LEASE: LeaseTimes = { runMs: 120_000, freshMs: 10 * 60_000, baseMs: 10 * 60_000, capMs: 60 * 60_000 }

async function refreshMcpList($: any) {
  mcpListRunning = true
  try {
    await withLease($, 'mcp-list', MCP_LIST_LEASE, async () => {
      const r = await $.process.run(['claude', 'mcp', 'list'], { timeoutMs: 90_000 })
      const items = parseMcpList(r.stdout ?? '')
      if (!items.length) return false
      mcpList = { at: Date.now(), items }
      await $.store.set(K.mcpList, mcpList)
      await runRadar($, true)
      return true
    })
  } finally {
    mcpListRunning = false
  }
}

// The list another session ran, when it is newer than this one's.
async function sharedMcpList($: any) {
  const got = (await $.store.get(K.mcpList).catch(() => undefined)) as typeof mcpList
  if (got && Array.isArray(got.items) && typeof got.at === 'number' && (!mcpList || got.at > mcpList.at)) mcpList = got
}

// A login page in the person's own Chrome. Not `open URL`: a headless Chrome
// (a TWeb chrome-engine pane, a benchmark) shares Chrome's bundle id and macOS
// hands it the URL, so the page opened where nobody could see it — the
// "press does nothing" of the Auth tab. tmux-chrome adds the tab through the
// extension of the Chrome the person uses; outside tmux, `open` is all there is.
async function openLoginPage($: any, url: string) {
  if (isPaneId(pane)) {
    const r = await $.process.run(['tmux-chrome', 'open', url], { env: { TMUX_CHROME_BROWSER: 'chrome', TMUX_PANE: pane! }, timeoutMs: 10_000 }).catch(() => undefined)
    if (r?.exitCode === 0) return
  }
  await $.process.run(['open', url], { timeoutMs: 8000 }).catch(() => undefined)
}

// Connectors authorized from the cockpit in this module's life: the needs-auth
// cache keeps listing them until Claude Code restarts, so the radar marks them.
const authorizedAt = new Map<string, number>()

async function completeMcpLogin($: any, callbackUrl: string) {
  const l = (await read($, mcpLoginA)) as McpLogin | null
  if (!l) return
  if (!isCallbackUrl(callbackUrl)) return void $.ui.toast('that is not a localhost callback URL with a code')
  try {
    const r = await $.mcp.call(l.server, 'complete_authentication', { callback_url: callbackUrl.trim() })
    if (r?.isError) return void update($, mcpLoginA, (x) => x && { ...x, status: 'failed', msg: clip(textOf(r), 200) })
    await finishMcpLogin($, l.server, 'logged in')
  } catch (err) {
    await update($, mcpLoginA, (x) => x && { ...x, status: 'failed', msg: clip(String(err), 200) })
  }
}

async function mcpLoginAction($: any, action: 'paste' | 'reopen' | 'copy' | 'retry' | 'cancel', value?: string) {
  const l = (await read($, mcpLoginA)) as McpLogin | null
  if (action === 'paste') return completeMcpLogin($, value ?? '')
  if (action === 'reopen' && l?.url) return openLoginPage($, l.url)
  if (action === 'copy' && l?.url) return copyText($, l.url, 'the login link')
  if (action === 'retry' && l) return startMcpLogin($, l.server)
  if (action === 'cancel') {
    mcpPoll?.cancel()
    await closeLoginPane($)
    await update($, mcpLoginA, () => null)
  }
}

async function finishMcpLogin($: any, server: string, msg: string) {
  mcpPoll?.cancel()
  await update($, mcpLoginA, (l) => ({ server, status: 'done', msg, at: Date.now(), claudeAi: l?.claudeAi }))
  $.ui.toast(server.replace(/^claude\.ai /, '') + ': ' + msg)
  loggedInAt.set(server, Date.now())
  await runRadar($, true)
  $.clock.after(60_000, () => update($, mcpLoginA, (l) => (l?.status === 'done' && l.server === server ? null : l)))
}

async function runFix($: any, item: AuthItem): Promise<void> {
  const server = serverOf(item.id)
  if (server) return startMcpLogin($, server)
  if (!item.fix) return
  if (item.batch) return runBatch($, item.batch)
  $.ui.toast(item.label + ': opening the login page…')
  const before = item.id === 'aws-sso' ? item.expiresAt : undefined
  try {
    const r = await $.process.run(item.fix, { timeoutMs: 300_000 })
    if (r.exitCode !== 0) $.ui.toast(item.label + ' login failed: ' + clip(((r.stderr || r.stdout) as string).trim().split('\n').pop() ?? '', 160))
  } catch (err) {
    $.ui.toast(item.label + ' login did not finish: ' + clip(String(err), 160))
  }
  const after = (await runRadar($, true)).find((i) => i.id === 'aws-sso')?.expiresAt
  if (item.id === 'aws-sso' && awsLoginReused(before, after)) {
    awsReusedUntil = after
    $.ui.toast('AWS SSO: the login reused the running portal session; it still ends ' + hhmm(after!) + '. Sign out at the portal, then log in again, for a new one.')
    await runRadar($, true)
  }
}

// The logins of a folded row (foldArgocd), one after another: they share a
// callback port, so the next starts only when the last has returned.
async function runBatch($: any, batch: string[][]): Promise<void> {
  const failed: string[] = []
  for (const [n, argv] of batch.entries()) {
    const name = argv[2] ?? argv.join(' ')
    $.ui.toast('ArgoCD ' + (n + 1) + '/' + batch.length + ' ' + name + ': opening the login page…')
    const r = await $.process.run(argv, { timeoutMs: 300_000 }).catch((err: unknown) => ({ exitCode: 1, stderr: String(err) }))
    if (r.exitCode !== 0) failed.push(name)
  }
  $.ui.toast(failed.length ? 'ArgoCD: ' + failed.length + ' of ' + batch.length + ' failed (' + failed.join(', ') + ')' : 'ArgoCD: logged in to all ' + batch.length)
  await runRadar($, true)
}

// The AWS expiry a login left where it was (awsLoginReused): the radar notes
// it on the row until a later login moves it.
let awsReusedUntil: number | undefined

// ---- Slack threads: channel names and replies nobody has seen ----

let slackMe: { email?: string } = {}

// Marks a thread seen up to `ts` (default: its newest reply known now).
async function markSlackSeen($: any, id: string, ts?: string) {
  const key = id.replace(/^slack:/, '')
  const seen = ((await $.store.get(K.slackSeen)) ?? {}) as Record<string, string>
  const st = ((await read($, slackA)) as Record<string, SlackThreadState>)[id]
  const mark = ts ?? st?.newest
  if (!mark || (seen[key] && Number(seen[key]) >= Number(mark))) return
  seen[key] = mark
  await $.store.set(K.slackSeen, seen)
  await update($, slackA, (m) => (m[id] ? { ...m, [id]: { ...m[id]!, unseen: 0, lastFrom: undefined } } : m))
}

async function slackChannelName($: any, channel: string): Promise<string | undefined> {
  const names = ((await $.store.get(K.slackNames)) ?? {}) as Record<string, string>
  if (names[channel]) return names[channel]
  try {
    const r = await mcpTimed($, SLACK_SERVER, 'slack_read_channel', { channel_id: channel, limit: 1, response_format: 'concise' })
    const name = parseChannelName(mcpText(r))
    if (name) {
      names[channel] = name
      await $.store.set(K.slackNames, names)
    }
    return name
  } catch {
    return undefined
  }
}

// An MCP call bounded in time: $.mcp.call itself names no timeout, and a
// connector that hangs on a bad network must not hold the poll for ever.
const SLACK_CALL_MS = 20_000
function mcpTimed($: any, server: string, tool: string, args: unknown): Promise<any> {
  return Promise.race([$.mcp.call(server, tool, args), $.clock.sleep(SLACK_CALL_MS).then(() => Promise.reject(new Error(tool + ' timed out')))])
}

// One poll at a time: a slow connector would otherwise stack one more every
// SLACK_POLL_MS.
let slackPolling = false
async function pollSlack($: any) {
  if (slackPolling) return
  slackPolling = true
  try {
    // A bound on the whole poll, store reads included, so the flag cannot stay set.
    await Promise.race([pollSlackOnce($), $.clock.sleep(2 * 60_000)])
  } finally {
    slackPolling = false
  }
}

async function pollSlackOnce($: any) {
  const outs = ((await read($, outputsA)) as Output[]).filter((o) => o.kind === 'slack' && Date.now() - o.at < 3 * 86_400_000).slice(0, 10)
  if (!outs.length) return
  const seen = ((await $.store.get(K.slackSeen)) ?? {}) as Record<string, string>
  const prev = (await read($, slackA)) as Record<string, SlackThreadState>
  const next: Record<string, SlackThreadState> = { ...prev }
  let renamed = false
  for (const o of outs) {
    const [, channel, root] = o.id.split(':')
    if (!channel || !root) continue
    const name = await slackChannelName($, channel)
    if (name) {
      setSlackName(channel, name)
      if (!o.title.startsWith(name)) renamed = true
    }
    let text = ''
    try {
      text = mcpText(await mcpTimed($, SLACK_SERVER, 'slack_read_thread', { channel_id: channel, message_ts: root, limit: 200 }))
    } catch {
      continue
    }
    const t = parseThread(text)
    if (!t.parent && !t.replies.length) continue
    const key = channel + ':' + root
    const newest = newestTs(t)
    // First sight: what is there now is what the person brought in.
    if (!seen[key] && newest) {
      seen[key] = newest
      await $.store.set(K.slackSeen, seen)
    }
    const unseen = unseenReplies(t.replies, seen[key], slackMe)
    next[o.id] = { channel, root, name, replies: t.replies.length, unseen: unseen.length, lastFrom: unseen.at(-1)?.name, newest, checkedAt: Date.now() }
    const before = prev[o.id]?.unseen ?? 0
    if (unseen.length > before && interactive) $.ui.toast('Slack ' + (name ?? channel) + ': ' + (unseen.length - before) + ' new from ' + unseen.at(-1)!.name)
    // A followed thread with replies the follow-up has not run for yet.
    const follow = ((await read($, slackFollowA)) as Record<string, SlackFollow>)[key]
    if (interactive && o.url && followDue(next[o.id], follow)) {
      await setSlackFollow($, key, { lastRun: newest })
      void followUpSlack($, o.url, true)
    }
  }
  await update($, slackA, () => next)
  if (renamed) {
    // Re-title the threads now that their channel names are known.
    const all = (await read($, outputsA)) as Output[]
    await addOutputs($, all.filter((o) => o.kind === 'slack').map((o) => ({ ...o, title: o.title.replace(/^Slack · ([A-Z0-9]+)/, (m, c) => slackName(c) ?? m) })))
  }
}

// An arrow key in the cockpit: move the ring to the element in that direction
// by layout. With the palette open, up/down move its selection. Nothing that
// way: up/down scroll the body as the keys did before, left/right fall back
// to the engine's previous/next order.
async function navMove($: any, dir: NavDir, tab: string, bodyRows: number) {
  const pal = (await read($, paletteA)) as PaletteState
  if (pal.open && (dir === 'up' || dir === 'down')) {
    const n = paletteShown.length
    if (n) await update($, paletteA, (p) => ({ ...p, sel: (p.sel + (dir === 'down' ? 1 : -1) + n) % n }))
    return
  }
  const items = navLast.filter((i) => !i.hidden && !isHiddenKey(i.key))
  // Not knowing where the ring is (the cockpit just took the keys, or a tab
  // switch redrew it), start from the open tab's button in the header.
  const from = items.some((i) => i.key === navFocus) ? navFocus : 'cockpit-' + tab
  let target = navTarget(items, from, dir)
  if (!target && (dir === 'left' || dir === 'right')) {
    const i = items.findIndex((x) => x.key === from)
    target = items[i + (dir === 'right' ? 1 : -1)]
  }
  if (!target) {
    if (tab !== 'web') {
      const cur = bodyScroll.get(tab) ?? 0
      bodyScroll.set(tab, Math.max(0, Math.min(bodyMax.get(tab) ?? 400, cur + (dir === 'down' ? 3 : -3))))
      $.ui.invalidate('ui.render')
    }
    return
  }
  // A target off screen is not jumped to: that skipped whole answers (a long
  // side answer has nothing focusable until its buttons). Scroll toward it a
  // few rows instead, as the arrows did before; the focus follows once it
  // comes into view.
  if (tab !== 'web' && (dir === 'up' || dir === 'down')) {
    const top = FRAME_TOP + SPACER_ROWS
    // The header (status, tabs) above `top` never scrolls: always in view.
    const header = target.key.startsWith('cockpit-')
    const off = !header && (target.y < top || target.y >= top + bodyRows)
    if (off) {
      const cur = bodyScroll.get(tab) ?? 0
      bodyScroll.set(tab, Math.max(0, Math.min(bodyMax.get(tab) ?? 400, cur + (dir === 'down' ? 3 : -3))))
      $.ui.invalidate('ui.render')
      return
    }
  }
  navFocus = target.key
  noteCockpitUse($, target.key)
  try {
    await $.ui.focus({ requestId: COCKPIT, key: target.key })
  } catch {
    // the element went away between the drawing and the move: stay put
  }
}

// The person used the cockpit (moved its focus, typed into the page): what a
// reload hands the keyboard back to. Throttled: focus moves come in bursts.
let cockpitNoted = 0
function noteCockpitUse($: any, focusKey?: string) {
  const now = Date.now()
  if (now - cockpitNoted < 2000 && !focusKey) return
  cockpitNoted = now
  void update($, uiA, (u) => ({ ...u, cockpitAt: now, ...(focusKey ? { focusKey } : {}) }))
}

// The cockpit's invisible buttons: letter catchers, alt+letter relays and
// the palette chord.
function isHiddenKey(key: string): boolean {
  return key.startsWith('catch-') || key.startsWith('alt-') || key.startsWith('hk-') || key === 'palette-toggle'
}

// Letter -> what its visible hotkey Button does, from the last drawing (a
// built Button keeps its onPress). The later drawn wins, as the engine's own
// hotkey matching does.
let hotkeyPress = new Map<string, () => void>()
// The same keys with their labels, for the key help (alt+/, lib/help.ts).
let hotkeyLabels: { key: string; label: string }[] = []

function collectHotkeys(tree: any): Map<string, () => void> {
  const out = new Map<string, () => void>()
  const labels: { key: string; label: string }[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    const p = n.props ?? {}
    const key = String(p.key ?? n.key ?? '')
    // hk- buttons are hidden hotkeys that do something (the Chat tab's `i`);
    // catch-/alt- ones only relay, and must not relay to themselves.
    if (n.type === 'Button' && typeof p.hotkey === 'string' && /^[a-z]$/.test(p.hotkey) && !/^(catch-|alt-)/.test(key) && typeof n.onPress === 'function') {
      out.set(p.hotkey, n.onPress)
      labels.push({ key: p.hotkey, label: String(p.label ?? '') })
    }
    const kids = n.children ?? p.children
    for (const k of Array.isArray(kids) ? kids : kids ? [kids] : []) walk(k)
  }
  walk(tree)
  hotkeyLabels = labels
  return out
}

// A Slack target as the policy holds it: an id. A #channel or @person the
// person typed is looked up through the Slack MCP server; the name is kept
// so the Policy tab shows it instead of the id.
async function resolveSlackTarget($: any, s: string): Promise<{ id: string } | { error: string }> {
  const kind = slackTargetKind(s)
  if (kind === 'id') return { id: s.toUpperCase() }
  if (!kind) return { error: 'slack: give a #channel, an @person, or an id (C…, U…)' }
  try {
    if (kind === 'channel') {
      const names = ((await $.store.get(K.slackNames)) ?? {}) as Record<string, string>
      const known = Object.entries(names).find(([, n]) => n.toLowerCase() === s.toLowerCase())?.[0]
      if (known) return { id: known }
      const r = await $.mcp.call(SLACK_SERVER, 'slack_search_channels', { keywords: [s.slice(1)], natural_language_query: s.slice(1), channel_types: 'public_channel,private_channel', limit: 10, response_format: 'concise' })
      const id = parseChannelSearch(mcpText(r), s)
      if (!id) return { error: 'slack: no channel named ' + s }
      names[id] = s.toLowerCase()
      await $.store.set(K.slackNames, names)
      return { id }
    }
    const q = s.slice(1)
    const r = await $.mcp.call(SLACK_SERVER, 'slack_search_users', { keywords: [q], natural_language_query: q, limit: 5, response_format: 'concise' })
    const u = parseUserSearch(mcpText(r))
    if (!u) return { error: 'slack: nobody found for ' + s }
    const users = ((await $.store.get(K.slackUsers)) ?? {}) as Record<string, string>
    users[u.id] = '@' + u.name
    await $.store.set(K.slackUsers, users)
    return { id: u.id }
  } catch (err) {
    return { error: 'slack lookup failed: ' + clip(String(err), 120) }
  }
}

// A /policy argv with its slack target resolved to an id (argv and revert).
async function resolvePolicyArgv($: any, argv: string[], revert?: string[]): Promise<{ argv: string[]; revert?: string[] } | { error: string }> {
  if (argv[1] !== 'slack_send') return { argv, revert }
  const i = argv.indexOf('--scope')
  if (i < 0 || !argv[i + 1]) return { argv, revert }
  const r = await resolveSlackTarget($, argv[i + 1]!)
  if ('error' in r) return r
  const fix = (a?: string[]) => a?.map((x, j) => (j > 0 && a[j - 1] === '--scope' ? r.id : x))
  return { argv: fix(argv)!, revert: fix(revert) }
}

// Slack ids -> what to call them on the Policy tab.
async function slackLabels($: any): Promise<Record<string, string>> {
  const names = ((await $.store.get(K.slackNames)) ?? {}) as Record<string, string>
  const users = ((await $.store.get(K.slackUsers)) ?? {}) as Record<string, string>
  return { ...slackDefaultTargets(), ...names, ...users }
}

// Candidates beyond this session: prod contexts in the kubeconfig, repos of
// recent sessions and tracked PRs on this machine, Slack channels named so far.
// Listed under "known", after what this session itself touched.
async function knownHints($: any): Promise<ScopeHint[]> {
  const out: ScopeHint[] = []
  for (const c of sources.contexts ?? []) if (isProdContext(c)) out.push({ cap: 'prod_eks_access', scope: c, why: 'known' }, { cap: 'prod_eks_write', scope: c, why: 'known' })
  const sess = ((await $.store.get(K.sessions)) ?? {}) as Record<string, { repo?: string; at: number }>
  const prs = ((await $.store.get(K.prs)) ?? {}) as Record<string, PrStatus>
  const repos = new Set<string>([...Object.values(sess).sort((a, b) => b.at - a.at).map((x) => x.repo ?? '').filter(Boolean), ...Object.keys(prs).map((k) => parsePrKey(k)?.repo ?? '').filter(Boolean)])
  for (const r of repos) out.push({ cap: 'gh_merge', scope: r, why: 'known' })
  const names = ((await $.store.get(K.slackNames)) ?? {}) as Record<string, string>
  for (const id of Object.keys(names)) out.push({ cap: 'slack_send', scope: id, why: 'known' })
  return out
}

// What a resumed or reloaded session already did: its Bash commands' prod
// targets and merge repos, guard denials, Slack sends. Once per module load.
let hintsBackfilled = false
async function backfillHints($: any) {
  if (hintsBackfilled) return
  hintsBackfilled = true
  let msgs: BackfillMessage[] = []
  try {
    msgs = await $.session.messages()
  } catch {
    return
  }
  const add: ScopeHint[] = []
  for (const m of msgs) {
    for (const u of m.toolUses ?? []) {
      const input = (u.input ?? {}) as Record<string, unknown>
      if (u.tool === 'Bash' && typeof input.command === 'string') add.push(...hintsFromCommand(input.command, repoFromGh))
      const text = String(u.text ?? '') + (u.result ? JSON.stringify(u.result) : '')
      if (/BLOCKED by session policy/.test(text)) add.push(...hintsFromBlock(text))
      if (/slack_(send_message|send_message_draft|schedule_message)$/.test(u.tool) && typeof input.channel_id === 'string') add.push({ cap: 'slack_send', scope: input.channel_id.toUpperCase(), why: 'used' })
    }
  }
  if (add.length) await update($, hintsA, (hs) => [...add, ...hs].slice(-200))
}

async function bridge($: any, cmd: string, req: unknown): Promise<any> {
  try {
    const r = await $.process.run(['python3', $.plugin.root + '/bin/cc-bridge.py', cmd], {
      // The session goes along so Jev calls it makes are counted as this session's.
      stdin: JSON.stringify({ ...(req as object), session: sid }),
      timeoutMs: 8000,
    })
    return JSON.parse(r.stdout || '{}')
  } catch {
    return {}
  }
}

// Runs `fn` in one session at a time, machine-wide, with a shared backoff after
// a failure (lib/lease.ts). False when another session holds it or everyone is
// backing off; `fn` answers whether it succeeded. Two sessions that read a free
// lease in the same instant may both run: the second read narrows that to the
// gap between a write and a read, which is all this needs.
async function withLease($: any, name: string, t: LeaseTimes, fn: () => Promise<boolean>, opts: { overHold?: boolean } = {}): Promise<boolean> {
  if (!home || !sid) return (await fn().catch(() => false), true)
  const file = home + '/.claude/state/cc-mods/lease/' + name + '.json'
  // The engine's clock (wall time in a session; tests drive it).
  const now = await clockNow($)
  const before = parseLease(await readText($, file))
  if (!mayRun(before, sid, now) && !(opts.overHold && before!.failUntil <= now)) return false
  const mine = taken(before, sid, now, t)
  const write = (l: Lease) => $.fs.write(file, JSON.stringify(l)).catch(() => undefined)
  await write(mine)
  const check = parseLease(await readText($, file))
  if (check && check.by !== sid && !opts.overHold) return false
  const ok = await fn().catch(() => false)
  await write(settled(mine, await clockNow($), ok, t))
  return true
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

async function loadPolicy($: any) {
  const text = sid ? await readText($, home + '/.claude/state/session_policy/' + sid + '.json') : undefined
  const p = parsePolicy(text)
  await update($, policyA, () => p)
  void resumeUnblocked($, p)
  const unlocked = p.caps.gh_merge === 'allow' || p.caps.prod_eks_write === 'allow' || p.caps.tmux_window_escape === 'allow' || Object.keys(p.scopes).length > 0
  await publish($, undefined, null, { '@cc_policy': unlocked ? '1' : '' })
  return p
}

async function runPolicy($: any, argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run(['python3', home + HOME_HOOKS + 'session_policy.py', ...argv], {
      env: { CLAUDE_CODE_SESSION_ID: sid },
      timeoutMs: 8000,
    })
    return { ok: r.exitCode === 0, out: (r.stdout || r.stderr).trim() }
  } catch (err) {
    return { ok: false, out: String(err) }
  }
}

async function applyPolicy($: any, argv: string[], ttlMs?: number, revert?: string[]) {
  const r = await runPolicy($, argv)
  if (r.ok && ttlMs && revert) {
    const label = argv.slice(1).join(' ')
    policyTimers.get(label)?.timer.cancel()
    const timer = $.clock.after(ttlMs, async () => {
      policyTimers.delete(label)
      await runPolicy($, revert)
      await loadPolicy($)
      $.ui.toast('policy expired: ' + label)
    })
    policyTimers.set(label, { expiresAt: Date.now() + ttlMs, revert, timer })
  }
  await update($, uiA, (u) => ({ ...u, policyMsg: r.ok ? 'applied: ' + argv.join(' ') : 'failed: ' + clip(r.out, 200) }))
  await loadPolicy($)
  return r
}

// God mode (lib/policy.ts GOD_MS): the policy from before the press, and the
// timer that puts it back. Kept in the store too, so a reload of the mod
// still ends it on time.
let god: { until: number; before: Policy; timer?: { cancel: () => void } } | undefined

async function startGod($: any, minutes: number) {
  const before = (await read($, policyA)) as Policy | null
  if (!before) return void $.ui.toast('policy not loaded yet')
  let answer = 'cancel'
  try {
    answer = await $.ui.ask('Allow every capability (merge, prod EKS write, Slack to anyone, tmux outside this window …) for ' + minutes + ' minutes?', ['allow everything', 'cancel'])
  } catch {
    answer = 'cancel'
  }
  if (answer !== 'allow everything') return
  const prior = god?.before ?? before
  god?.timer?.cancel()
  for (const argv of godArgvs()) await runPolicy($, argv)
  const until = Date.now() + Math.min(minutes * 60_000, 2 * GOD_MS)
  god = { until, before: prior, timer: $.clock.after(until - Date.now(), () => void endGod($, 'time is up')) }
  await $.store.set(K.god(sid), { until, before: prior })
  await loadPolicy($)
  await update($, uiA, (u) => ({ ...u, policyMsg: 'god mode until ' + hhmm(until) }))
  $.ui.toast('⚡ god mode: everything allowed until ' + hhmm(until))
}

async function endGod($: any, why: string) {
  const g = god ?? (((await $.store.get(K.god(sid))) ?? undefined) as { until: number; before: Policy } | undefined)
  god?.timer?.cancel()
  god = undefined
  await $.store.set(K.god(sid), null)
  if (!g) return
  for (const argv of restoreArgvs(g.before)) await runPolicy($, argv)
  await loadPolicy($)
  await update($, uiA, (u) => ({ ...u, policyMsg: 'god mode ended (' + why + '): policy put back' }))
  $.ui.toast('god mode ended (' + why + '): policy put back')
}

// After a reload: an unexpired god mode keeps its end time; an expired one
// is put back now.
async function resumeGod($: any) {
  const g = (await $.store.get(K.god(sid))) as { until: number; before: Policy } | undefined
  if (!g) return
  if (g.until <= Date.now()) return endGod($, 'time is up')
  god = { ...g, timer: $.clock.after(g.until - Date.now(), () => void endGod($, 'time is up')) }
}

async function addOutputs($: any, add: Output[]) {
  if (add.length === 0) return
  // An archive folder spelled ~/exp/… is kept by its absolute path, one id.
  add = add.map((o) => (o.kind === 'exp' && o.path?.startsWith('~/') ? { ...o, path: home + o.path.slice(1), id: 'exp:' + home + o.path.slice(1) } : o))
  if (add.some((o) => o.kind === 'exp')) void refreshExp($, add.filter((o) => o.kind === 'exp').map((o) => o.path!))
  await update($, outputsA, (prev) => mergeOutputs(prev, add))
  const list = await read($, outputsA)
  await $.store.set(K.outputs(sid), list)
  // Track PRs this session touched so the shared poller fetches them.
  if (add.some((o) => o.kind === 'ticket' || o.kind === 'pr')) void loadSources($)
  // A thread Claude just read or replied to has been seen as of now.
  const slack = add.filter((o) => o.kind === 'slack')
  if (slack.length && interactive) {
    void pollSlack($).then(async () => {
      for (const o of slack) if (o.detail === 'read' || o.detail === 'replied' || o.detail === 'posted') await markSlackSeen($, o.id)
    })
  }
  // Only PRs this session acted on or was handed: the watch list is shared
  // by every session, and a mentioned PR is not one anyone here follows.
  const prs = add.filter((o) => o.kind === 'pr' && isMade(o))
  if (prs.length) {
    const watch = ((await $.store.get(K.prWatch)) ?? {}) as Record<string, { session: string; at: number }>
    for (const o of prs) watch[o.title] = { session: sid, at: Date.now() }
    await $.store.set(K.prWatch, watch)
    void pollPrs($)
  }
}

// One GraphQL query per owner account. False when any account's query failed
// (no answer, a non-zero exit, the rate limit): the lease backs everyone off.
// The shared cache is written only when a query answered, so a failed tick
// does not rewrite the store for nothing.
async function pollPrsOnce($: any, refs: NonNullable<ReturnType<typeof parsePrKey>>[], cache: Record<string, PrStatus>, now: number): Promise<boolean> {
  let ok = true
  let answered = false
  // One query per owner account, since a token only sees its own private repos.
  const byAcct = new Map<string, typeof refs>()
  for (const r of refs) {
    const a = ghAccountFor(r.repo) ?? ''
    byAcct.set(a, [...(byAcct.get(a) ?? []), r])
  }
  for (const [acct, group] of byAcct) {
    const env = acct ? await ghEnv($, acct) : {}
    try {
      const r = await $.process.run(['gh', 'api', 'graphql', '-f', 'query=' + graphqlQuery(group)], { env, timeoutMs: 20000 })
      const got = parseGraphql(r.stdout, group, now)
      if (got.length) answered = true
      // gh exits non-zero on a network error, with nothing on stdout.
      if (r.exitCode !== 0 && !got.length) ok = false
      for (const s of got) {
        // GitOps summaries come from comments, read apart and only when the
        // head moved or 5 minutes passed; otherwise keep the last ones.
        const old = cache[s.key]
        if (s.iac?.kind === 'gitops') {
          const due = !old?.iac || old.head !== s.head || now - (gitopsRead.get(s.key) ?? 0) > 300_000
          if (due) {
            try {
              const c = await $.process.run(['gh', ...gitopsCommentsArgv(parsePrKey(s.key)!)], { env, timeoutMs: 20000 })
              if (c.exitCode === 0) {
                Object.assign(s.iac, gitopsFromComments(c.stdout, s.head))
                gitopsRead.set(s.key, now)
              }
            } catch {}
          } else if (old?.iac) Object.assign(s.iac, { argodiff: old.iac.argodiff, codex: old.iac.codex })
        }
        cache[s.key] = s
      }
      // The account's GraphQL budget is shared with every gh call on this
      // machine (other sessions' PR monitors spend most of it). When it is
      // gone the rows would silently keep old values; say so instead.
      if (/RATE_LIMIT|rate limit/i.test(r.stdout + r.stderr)) {
        ok = false
        await notePrLimit($, acct, env)
      } else if (prLimit?.account === acct) prLimit = undefined
    } catch {
      // network blip (or the 20 s timeout): keep the cached rows, back off
      ok = false
    }
  }
  if (answered) await $.store.set(K.prs, cache)
  // Backed off only when nothing answered: one account with a dead token (or
  // one PR GitHub will not show) must not slow every other account's PRs.
  return ok || answered
}

async function pollPrs($: any) {
  const watch = ((await $.store.get(K.prWatch)) ?? {}) as Record<string, { session: string; at: number }>
  const cache = ((await $.store.get(K.prs)) ?? {}) as Record<string, PrStatus>
  const now = Date.now()
  // Poll what is open and was touched in the last 3 days; merged/closed stay cached.
  // This session's PRs first, then the most recently touched: the watch list
  // is shared by every session and grows, and the 25-PR cap used to drop
  // whatever was added last (a PR just opened here never got a status).
  const own = new Set(((await read($, outputsA)) as Output[]).filter((o) => o.kind === 'pr' && isMade(o)).map((o) => o.title))
  const keys = Object.keys(watch)
    .filter((k) => now - watch[k]!.at < 3 * 86_400_000 && (!cache[k] || cache[k]!.state === 'OPEN'))
    .sort((a, b) => Number(own.has(b)) - Number(own.has(a)) || watch[b]!.at - watch[a]!.at)
    .slice(0, 25)
  const refs = keys.map(parsePrKey).filter((r): r is NonNullable<typeof r> => !!r)
  const fresh = refs.length && keys.every((k) => cache[k] && now - cache[k]!.at < PR_POLL_MS / 2)
  if (refs.length && !fresh) {
    // A PR not polled yet (just opened here) goes over another session's hold;
    // a backoff after failures still stops it.
    // Only this session's own, once per PR: the watch list is shared, and a key
    // GitHub never answers for would otherwise let every session past the hold
    // on every tick.
    const unseen = keys.filter((k) => own.has(k) && !cache[k] && parsePrKey(k) && !overHeld.has(k))
    for (const k of unseen) overHeld.add(k)
    await withLease($, 'pr-poll', PR_LEASE, () => pollPrsOnce($, refs, cache, now), { overHold: unseen.length > 0 })
  }
  const mine = [...own].map((k) => cache[k]).filter((s): s is PrStatus => !!s)
  const before = (await read($, prsA)) as PrStatus[]
  await update($, prsA, () => mine)
  // A newly failing PR is worth telling, without starting a turn.
  for (const s of mine) {
    const old = before.find((b) => b.key === s.key)
    if (old && old.checks !== 'fail' && s.checks === 'fail') $.ui.toast('PR checks failing: ' + s.key)
    if (old && old.policy !== 'fail' && s.policy === 'fail') $.ui.toast('PR needs atlantis approve_policies: ' + s.key)
    if (old && old.state === 'OPEN' && s.state === 'MERGED') $.ui.toast('PR merged: ' + s.key)
  }
}

function workflowNode(id: string, runId: string | undefined, toolUseId: string, parentId: string | undefined, taskId: string | undefined, description: string): AgentNode {
  return {
    id,
    toolUseId,
    parentId,
    turnId: currentTurn,
    type: 'workflow',
    description: clip(description, 80),
    prompt: runId ? 'run ' + runId : '',
    status: 'background',
    startedAt: Date.now(),
    tools: 0,
    kind: 'workflow',
    runId,
    taskId,
  }
}

// PRs this session already polled past another session's hold (pollPrs).
const overHeld = new Set<string>()

// When each GitOps PR's comments were last read (pollPrs).
const gitopsRead = new Map<string, number>()

// The GitHub GraphQL limit, when the last poll hit it (shown on PR rows).
let prLimit: { account: string; until: number } | undefined

async function notePrLimit($: any, account: string, env: Record<string, string>) {
  let until = Date.now() + 3600_000
  try {
    const r = await $.process.run(['gh', 'api', 'rate_limit', '--jq', '.resources.graphql.reset'], { env, timeoutMs: 8000 })
    const reset = Number(r.stdout.trim())
    if (reset > 0) until = reset * 1000
  } catch {}
  const first = !prLimit
  prLimit = { account, until }
  if (first && interactive) $.ui.toast('GitHub API limit for ' + (account || 'gh') + ': PR status is stale until ' + new Date(until).toTimeString().slice(0, 5))
}

function prLimitNote(now: number): string | undefined {
  return prLimit && prLimit.until > now ? 'GitHub limit · resets ' + new Date(prLimit.until).toTimeString().slice(0, 5) : undefined
}

// A token read is a gh process (and through the shim, pass): kept 10 minutes,
// not read again on every poll.
const ghTokens = new Map<string, { env: Record<string, string>; at: number }>()
async function ghEnv($: any, account: string): Promise<Record<string, string>> {
  const kept = ghTokens.get(account)
  if (kept && Date.now() - kept.at < 10 * 60_000) return kept.env
  try {
    const r = await $.process.run(['gh', 'auth', 'token', '--user', account], { timeoutMs: 5000 })
    const token = r.stdout.trim()
    if (r.exitCode !== 0 || !token) return {}
    ghTokens.set(account, { env: { GH_TOKEN: token }, at: Date.now() })
    return { GH_TOKEN: token }
  } catch {
    return {}
  }
}

// A login done anywhere (a terminal, another session, the browser flow a
// button started) rewrites one of these files. Their mtimes are checked often
// and cheaply, so the radar follows a login within seconds instead of waiting
// out RADAR_MS with a stale "expired".
const CRED_WATCH_MS = 10_000
const credFiles = (h: string) => [
  ...(ssoCacheFile(h) ? [ssoCacheFile(h)!] : []),
  h + '/.config/argocd/config',
  h + '/.config/gh/hosts.yml',
  h + '/.claude/mcp-needs-auth-cache.json', // a /mcp login (clearedByCache)
  h + '/.claude/daemon-auth-status.json',
  h + '/Library/Application Support/coderv2/url',
  h + '/Library/Application Support/coderv2/session',
]
let credStamp: string | undefined
const RADAR_FORCE_LEASE: LeaseTimes = { runMs: 30_000, freshMs: 30_000, baseMs: 30_000, capMs: 5 * 60_000 }

async function watchCredentials($: any): Promise<void> {
  if (!home) return
  const stamps = await Promise.all(credFiles(home).map((f) => $.fs.stat(f).then((st: any) => String(st?.mtimeMs ?? 0)).catch(() => '-')))
  const stamp = stamps.join(',')
  const changed = credStamp !== undefined && stamp !== credStamp
  credStamp = stamp
  // Every session sees the same file change within CRED_WATCH_MS: one of them
  // refreshes the radar for all, the others read it a little later, each at
  // its own delay so a store that lags does not send them out together.
  if (changed && !(await withLease($, 'radar-force', RADAR_FORCE_LEASE, async () => (await runRadar($, true), true)))) {
    $.clock.after(5_000 + spread(sid, 20_000), () => void runRadar($))
  }
  // The policy file too: a grant made from another terminal (or this one's
  // Policy tab in another module load) should resume blocked work as well.
  if (sid) {
    const ps = await $.fs.stat(home + '/.claude/state/session_policy/' + sid + '.json').then((st: any) => String(st?.mtimeMs ?? 0)).catch(() => '-')
    const policyChanged = policyStamp !== undefined && ps !== policyStamp
    policyStamp = ps
    if (policyChanged) await loadPolicy($)
  }
}
let policyStamp: string | undefined

async function runRadar($: any, force = false): Promise<AuthItem[]> {
  const cached = (await $.store.get(K.radar)) as Radar | undefined
  const now = Date.now()
  if (!force && cached && now - cached.at < RADAR_MS / 2) {
    await update($, authA, () => cached.items)
    return cached.items
  }
  const items: AuthItem[] = []
  const ssoUrl = org().awsSsoStartUrl
  if (ssoUrl) {
    const aws = awsItem(await readText($, ssoCacheFile(home)!), ssoUrl, now, ssoProfile(await readText($, home + '/.aws/config'), ssoUrl))
    items.push(awsReusedUntil !== undefined && aws.expiresAt === awsReusedUntil && aws.state !== 'expired' ? awsReusedItem(aws, ssoUrl, hhmm(aws.expiresAt)) : aws)
  }
  try {
    const r = await $.process.run(['gh', 'auth', 'status'], { timeoutMs: 8000 })
    // `gh auth status` marks an account failed when its check of the API
    // fails for any reason (a timeout, a rate limit), not only a dead token:
    // live, both accounts read "expired" minutes after their tokens merged
    // PRs. Ask the API as that account before calling it expired.
    for (const it of ghItems(r.stdout + '\n' + r.stderr)) {
      if (it.state !== 'expired') {
        items.push(it)
        continue
      }
      const user = it.id.slice(3)
      const ok = await $.process
        .run(['sh', '-c', 'GH_TOKEN="$(gh auth token --user "$0")" gh api user --jq .login', user], { timeoutMs: 8000 })
        .then((x: any) => x.exitCode === 0 && x.stdout.trim().toLowerCase() === user.toLowerCase())
        .catch(() => false)
      items.push(ok ? { ...it, state: 'ok', detail: (it.detail ? it.detail + ' · ' : '') + 'token works (gh auth status failed its check)' } : it)
    }
  } catch {
    // gh missing or hung: leave gh out rather than report it expired
  }
  // `claude mcp list` (22s: it health-checks every server) runs in the
  // background at most every 10 minutes; until it has, the needs-auth cache.
  await sharedMcpList($)
  const listed = mcpList && Date.now() - mcpList.at < 30 * 60_000 ? mcpList.items : undefined
  if (!mcpListRunning && (!mcpList || Date.now() - mcpList.at > 10 * 60_000)) void refreshMcpList($)
  // A login finished here outranks the list for a while: the list may have
  // been read before it, and `claude mcp list` itself lags a fresh token.
  const fresh = [...loggedInAt].filter(([, at]) => now - at < LOGGED_IN_HOLD_MS).map(([s]) => s)
  const cacheFile = home + '/.claude/mcp-needs-auth-cache.json'
  const cache = await readText($, cacheFile)
  const cacheAt = await $.fs.stat(cacheFile).then((st: any) => st?.mtimeMs as number | undefined).catch(() => undefined)
  const mcp = listed ? clearedByCache(listed, cache, cacheAt, mcpList!.at) : mcpItems(cache)
  items.push(
    ...fresh.reduce(markLoggedIn, mcp as AuthItem[]).map((i) =>
      authorizedAt.has(serverOf(i.id) ?? '') ? { ...i, state: 'ok' as const, detail: 'authorized · restart to use', fix: undefined } : i,
    ),
  )
  const d = daemonItem(await readText($, home + '/.claude/daemon-auth-status.json'), await readText($, home + '/.claude/daemon.log'))
  if (d) items.push(d)
  items.push(...argocdItems(await readText($, home + '/.config/argocd/config'), now))
  const coderDir = home + '/Library/Application Support/coderv2/'
  items.push(...coderLocalItems(await readText($, coderDir + 'url'), await $.fs.exists(coderDir + 'session').catch(() => false), org().coderInstances ?? {}))
  try {
    const r = await $.process.run(['ccproxy', 'status', '--offline', '--json'], { timeoutMs: 8000 })
    // An older ccproxy rejects --json with a usage error: show nothing then.
    if (r.exitCode === 0) items.push(...ccproxyItems(r.stdout))
  } catch {
    // ccproxy missing or hung: leave it out
  }
  await $.store.set(K.radar, { at: now, items })
  await update($, authA, () => items)
  const w = worst(items)
  await publish($, undefined, null, { '@cc_auth': w === 'ok' ? '' : w })
  return items
}

// ---- auto-resume after a disconnect (lib/resume.ts) ----

// The engine's clock: a slept machine shows as a jump in it, and tests drive
// it. Date.now() where a host has no clock.now.
async function clockNow($: any): Promise<number> {
  try {
    const t = await $.clock.now()
    return typeof t === 'number' ? t : Date.now()
  } catch {
    return Date.now()
  }
}

// ---- held watches (lib/monitor.ts, HELD_PREFIX) ----

// Runs a long command watch past its Monitor's 30-minute life: each stdout
// line reaches the model as a Monitor event would, and nothing else does
// until the command exits, the deadline passes, or TaskStop names it. The
// module unloading kills the child; its row stays, and session.start runs it
// again.
function holdWatch($: any, id: string, input: WatchInput, summary: string, until: number, now: number): void {
  if (holds.has(id) || !input.command) return
  let reason: 'stopped' | 'expired' | undefined
  const child = $.process.spawn({ argv: ['/bin/bash', '-c', input.command] })
  let timer: { cancel: () => void } | undefined
  // A pending read may wait for output that never comes (a quiet PR watch):
  // stopping must not wait on it, so each read races this.
  let wakeStop = () => {}
  const stopped = new Promise<void>((r) => (wakeStop = r))
  const stop = (why: 'stopped' | 'expired') => {
    if (reason) return
    reason = why
    timer?.cancel()
    wakeStop()
    void Promise.resolve(child.return(undefined as any)).catch(() => undefined)
  }
  holds.set(id, { stop })
  const tell = (event: string) => $.prompt.submit({ text: heldNotification(id, summary, event) }).catch(() => undefined)
  void (async () => {
    timer = $.clock.after(Math.max(1, until - now), () => stop('expired'))
    let rest = ''
    let end: any
    try {
      for (;;) {
        const step: any = await Promise.race([child.next(), stopped.then(() => undefined)])
        if (step?.done) end = step.value
        if (reason || !step || step.done) break
        const chunk = step.value
        if (chunk.stream !== 'stdout') continue
        const cut = splitLines(rest + chunk.text)
        rest = cut.rest
        if (cut.lines.length) void tell(cut.lines.join('\n'))
      }
    } catch {
      // It could not start, or was closed under us: read below as an end.
    }
    timer?.cancel()
    holds.delete(id)
    // Killed from outside with nobody asking: the module unloading. Keep the
    // row for the next load to pick up, and say nothing.
    if (!reason && end?.signal) return
    try {
      await update($, monitorsA, (ms: MonitorState[]) => ms.filter((m) => m.taskId !== id))
      $.ui.invalidate('ui.render')
      if (reason === 'expired') await tell('[Monitor expired: the cockpit held it to the re-arm cap with no end. Re-arm it if you still need the watch.]')
      else if (!reason) await tell('[Monitor command exited' + (typeof end?.code === 'number' ? ' with code ' + end.code : '') + ']')
    } catch {
      // The session ended first.
    }
  })()
}

// A reload or restart killed the held watches' commands: run them again.
async function resumeHeldWatches($: any) {
  const now = await clockNow($)
  const ms = (await read($, monitorsA)) as MonitorState[]
  for (const m of ms) if (m.held && m.input && m.held.until > now) holdWatch($, m.taskId, m.input, m.summary, m.held.until, now)
}

let mainTurnAt = 0
// What the previous main step was sent with (routing's cache gate, lib/route.ts).
let routeLast: RouteLast | undefined
let mainTurnRunning = false
// MCP auto-reconnect (lib/mcpheal.ts): on unless Settings turned it off. Only
// a server that was in use and dropped is retried, one at a time; servers that
// never connected (needs sign-in, unused) are left alone.
let mcpHealEnabled = true
const mcpHealTries = new Map<string, { at: number; n: number }>()
// Tools whose call failed on a dropped server this turn. command.run cannot run
// from a tool.call hook (it would wait on the turn the hook holds), so the
// reconnect happens at turn.complete.
const mcpHealPending = new Set<string>()
const MCP_HEAL_GAP_MS = 2 * 60_000
const MCP_HEAL_MAX = 3

async function reconnectMcp($: any, server: string): Promise<string> {
  const r = await $.command.run({ command: 'mcp', args: 'reconnect ' + server })
  return String(r?.text ?? '').trim()
}

// A call on `tool` failed because its server dropped: reconnect that server.
async function healMcpTool($: any, tool: string) {
  if (!mcpHealEnabled) return
  const norm = mcpServerKey(tool)
  if (!norm) return
  const names = ((await read($, authA)) as AuthItem[]).map((i) => serverOf(i.id)).filter((x): x is string => !!x)
  const server = names.find((n) => normalizeServer(n) === norm)
  if (!server) return
  const t = mcpHealTries.get(server) ?? { at: -Infinity, n: 0 }
  if (t.n >= MCP_HEAL_MAX || Date.now() - t.at < MCP_HEAL_GAP_MS) return
  mcpHealTries.set(server, { at: Date.now(), n: t.n + 1 })
  try {
    const text = await reconnectMcp($, server)
    $.ui.log('mcp heal ' + server + ': ' + text, { to: 'debug' })
    if (!/not connected|failed|error/i.test(text)) $.ui.toast('MCP ' + server + ' reconnected')
  } catch (err) {
    $.ui.log('mcp heal ' + server + ' failed: ' + String(err), { to: 'debug' })
  }
}
let ownResume = false // the next main turn is our keep-going
let ownResumeAt = 0
let resumeTick = 0 // when the probe last ran, to notice the machine slept
let reachableAt = 0 // when the probe first found the API answering again (0: not answering)

// Is the API reachable over the path this session uses? The same host the
// request goes to (/etc/hosts sends it through the mesh), any HTTP status
// counts. -k: this carries no credentials and only asks whether the far end
// answers; the mesh re-signs TLS, and a trust failure is not the question.
async function apiReachable($: any): Promise<boolean> {
  try {
    const r = await $.process.run(['/usr/bin/curl', '-sk', '-m', '6', '-o', '/dev/null', '-w', '%{http_code}', '-I', 'https://api.anthropic.com/'], { timeoutMs: 9000 })
    return /^[1-5]\d\d$/.test(r.stdout.trim())
  } catch {
    return false
  }
}

async function resumeEnabled($: any): Promise<boolean> {
  const prefs = ((await $.store.get(K.cockpitSettings)) ?? {}) as { autoResume?: boolean }
  return prefs.autoResume !== false
}

async function resumeProbe($: any) {
  // The engine's clock, not Date: a slept machine shows as a jump in it, and
  // tests drive it.
  const now = await clockNow($)
  const woke = resumeTick && slept(15_000, now - resumeTick)
  resumeTick = now
  const p = (await read($, resumeA)) as Pending | null
  if (!p) {
    // Nothing waiting: the next outage starts its own "back since" clock.
    reachableAt = 0
    return
  }
  // Just woke: give Wi-Fi and the VPN a moment before deciding.
  if (woke) return
  if (mainTurnRunning) return
  // Our keep-going was sent and its turn has not started yet: one at a time.
  // A submit lost for two minutes frees the next try.
  if (ownResume && now - ownResumeAt < 120_000) return
  ownResume = false
  const reachable = await apiReachable($)
  // When the API first answered again in this streak of probes.
  if (!reachable) reachableAt = 0
  else if (!reachableAt) reachableAt = now
  const d = resumeDecide(p, now, {
    reachable,
    turnSince: mainTurnAt > p.at,
    enabled: await resumeEnabled($),
    reachableForMs: reachable ? now - reachableAt : 0,
    jitterMs: spread(sid, RESUME_SPREAD_MS),
  })
  if (d.act === 'wait') return
  if (d.act === 'drop') {
    await update($, resumeA, () => null)
    if (interactive && !/new turn/.test(d.why)) $.ui.toast('auto-resume stopped: ' + d.why)
    return
  }
  await update($, resumeA, (x) => (x ? { ...x, attempts: x.attempts + 1, nextAt: now + backoff(x.cls, x.attempts + 1), at: x.at } : x))
  if (interactive) $.ui.toast('connection is back: continuing the interrupted turn')
  ownResume = true
  ownResumeAt = now
  await $.prompt.submit({ text: 'keep going', asUser: true }).catch(() => undefined)
}

// auto_continue: a turn that ended on a plain "shall I go on?" gets "go on"
// in the person's place, after a short pause they can type over. True when it
// was sent for, so turn.complete keeps the window `working` instead of `ask`.
// Jev already judged the question (bin/cc-bridge.py attention with proceed).
async function proceedFor($: any, turnId: string, answer: string): Promise<boolean> {
  const v = { ask: closingAsk(answer) }
  if (proceedStreak >= PROCEED_MAX) {
    if (interactive) $.ui.toast('auto_continue: ' + PROCEED_MAX + ' answered in a row; this one is yours')
    return false
  }
  proceedStreak++
  await update($, flowA, (fs) => [...fs, { at: Date.now(), turnId, kind: 'decision' as const, text: 'auto_continue · answered "' + clip(v.ask, 80) + '" with go on' }].slice(-FLOW_CAP))
  if (interactive) $.ui.toast('auto_continue: going on in 3s ("' + clip(v.ask, 60) + '"); type to answer yourself')
  await publish($, 'working', 'none')
  proceedTimer?.cancel()
  proceedTimer = $.clock.after(3_000, () => {
    proceedTimer = undefined
    if (mainTurnRunning) return
    void $.prompt.submit({ text: PROCEED_REPLY, asUser: true }).catch(() => $.ui.toast('auto_continue: could not send; answer it yourself'))
  })
  return true
}

// ---- narwhal: what this session's runs need --------------------------------

// The items the Now tab shows: those not dismissed.
async function narwhalVisible($: any): Promise<NarwhalItem[]> {
  const s = (await read($, narwhalA)) as { items: NarwhalItem[]; dismissed: string[] }
  const gone = new Set(s.dismissed)
  return s.items.filter((it) => !gone.has(itemKey(it)))
}

async function narwhalURL($: any): Promise<string | undefined> {
  return (await readText($, home + '/.narwhal/daemon.url'))?.trim() || undefined
}

// Ask the narwhal daemon what the runs this session started need. A daemon
// that is not running is no runs: nothing to show, and nothing to report.
async function pollNarwhal($: any) {
  if (!sid) return
  const base = await narwhalURL($)
  if (!base) return
  let body: string | undefined
  try {
    const r = await $.process.run(['/usr/bin/curl', '-s', '-m', '5', base + '/api/v1/control/attention?session=' + encodeURIComponent(sid)], { timeoutMs: 8000 })
    body = r.stdout
  } catch {
    return
  }
  const items = parseAttention(body)
  // The runs themselves, for Work, and what they made, for Outputs.
  let runs: NarwhalRun[] = []
  try {
    const r = await $.process.run(['/usr/bin/curl', '-s', '-m', '5', base + '/api/v1/control/runs?session=' + encodeURIComponent(sid)], { timeoutMs: 8000 })
    runs = parseRuns(r.stdout)
  } catch {}
  const prev = (await read($, narwhalA)) as { items: NarwhalItem[]; told: string[]; dismissed: string[]; runs: NarwhalRun[] }
  const live = new Set(items.map(itemKey))
  const fresh = freshItems(items, prev.told)
  await update($, narwhalA, () => ({
    items,
    runs,
    // Forget what is no longer returned, so the lists do not grow forever.
    told: [...prev.told.filter((k) => live.has(k)), ...fresh.map(itemKey)],
    dismissed: prev.dismissed.filter((k) => live.has(k)),
  }))
  if (fresh.length && interactive) {
    for (const it of fresh.slice(0, 2)) $.ui.toast(toastFor(it))
    // A question or a stuck worker waits on the person: say so in tmux too,
    // where the other windows show it.
    if (fresh.some((it) => it.kind === 'question' || it.kind === 'stuck')) await publish($, undefined, 'ask')
  }
  // Only what is new: addOutputs polls GitHub for any PR it is handed, and
  // this runs every 20 seconds.
  const have = new Set(((await read($, outputsA)) as Output[]).map((o) => o.id))
  await addOutputs($, runOutputs(runs).filter((o) => !have.has(o.id)))
  if (fresh.length || prev.items.length !== items.length || JSON.stringify(prev.runs) !== JSON.stringify(runs)) $.ui.invalidate('ui.render')
}

// Answer a run's question from the cockpit, through the daemon's answer
// endpoint: the same one the monitor's questions view uses.
async function answerNarwhal($: any, it: NarwhalItem, answer: string) {
  const base = await narwhalURL($)
  if (!base || !it.question) return
  try {
    const r = await $.process.run(['/usr/bin/curl', '-s', '-m', '10', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', answerBody(it.run_id, it.question.id, answer), base + '/api/v1/control/answer'], { timeoutMs: 15000 })
    const j = JSON.parse(r.stdout || '{}')
    if (j.error || (Array.isArray(j.errors) && j.errors.length)) {
      $.ui.toast('narwhal: ' + (j.error ?? j.errors.join('; ')))
      return
    }
    $.ui.toast('answered #' + it.question.id + (Array.isArray(j.reopened) && j.reopened.length ? ' · reopened ' + j.reopened.join(', ') : ''))
  } catch (e) {
    $.ui.toast('narwhal answer failed: ' + String(e))
    return
  }
  await pollNarwhal($)
}

// A split in this window with the run's monitor: the graph, timeline and
// grounds are there, and the cockpit does not redraw them.
async function openNarwhalMonitor($: any, runId: string) {
  await tmux($, [['split-window', '-h', '-t', pane ?? '', 'narwhal monitor --run ' + runId]])
}

// What a press on a narwhal item does.
async function narwhalAction($: any, it: NarwhalItem, action: 'answer' | 'monitor' | 'result' | 'dismiss', value?: string) {
  switch (action) {
    case 'answer':
      // An option pressed, or what was written in the item's field.
      if (value?.trim()) await answerNarwhal($, it, value.trim())
      return
    case 'monitor':
      await openNarwhalMonitor($, it.run_id)
      return
    case 'result':
      await $.prompt.fill({ text: resultPrompt(it), mode: 'replace' })
      await update($, narwhalA, (s) => ({ ...s, dismissed: [...s.dismissed, itemKey(it)] }))
      return
    case 'dismiss':
      await update($, narwhalA, (s) => ({ ...s, dismissed: [...s.dismissed, itemKey(it)] }))
      $.ui.invalidate('ui.render')
  }
}

// Other windows' sessions and today's brief, for the Now tab's Elsewhere.
async function refreshElsewhere($: any) {
  let windows: Elsewhere[] = []
  try {
    const r = await $.process.run(['tmux', 'list-windows', '-a', '-F', '#{session_name}|#{window_index}|#{window_name}|#{@cc_state}|#{@cc_attention}|#{@title}|#{@cc_since}|#{@cc_session}|#{window_id}'], { timeoutMs: 3000 })
    windows = parseTmuxWindows(r.stdout, sid)
  } catch {}
  const d = new Date()
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  const todos = parseBrief(await readText($, home + '/.claude/daily-checkin/dayx-' + day + '.md'))
  await update($, elsewhereA, () => ({ windows, todos }))
}

// What each linked archive folder still owes, its sums, its last message
// (lib/exp.ts). Run for the folders named, or every linked one.
async function checkExp($: any, path: string): Promise<ExpCheck> {
  const readme = await readText($, path + '/README.md')
  const r = await $.process.run(['sh', '-c', SUMS_CHECK, path + '/attachments'], { timeoutMs: 20_000 }).catch(() => undefined)
  return { open: parseOpen(readme), sums: r ? parseSums(r.stdout) : undefined, last: lastMessage(await readText($, path + '/correspondence.md')), at: Date.now() }
}

let expCheckedAt = 0
async function refreshExp($: any, paths?: string[]) {
  const all = ((await read($, outputsA)) as Output[]).filter((o) => o.kind === 'exp' && o.path).map((o) => o.path!)
  const todo = paths ?? all
  if (!todo.length) return
  if (!paths) expCheckedAt = Date.now()
  const got = await Promise.all(todo.map(async (p) => [p, await checkExp($, p)] as const))
  await update($, expA, (cur) => ({ ...cur, ...Object.fromEntries(got) }))
}

// The office (office/office.py, /office): a reply the person sent this
// session from its quick-action card waits in a file named by session id;
// it goes in as their own prompt, so the model reads it as typed. Taken once
// (removed before submitting); one older than two minutes is dropped.
let officeBusy = false
async function officeInbox($: any) {
  if (officeBusy || !home) return
  const file = home + '/.claude/state/office/inbox/' + sid + '.json'
  if (!(await $.fs.exists(file).catch(() => false))) return
  officeBusy = true
  try {
    const raw = await readText($, file)
    await $.process.run(['rm', '-f', file], { timeoutMs: 3000 })
    let msg: { text?: unknown; at?: unknown } = {}
    try {
      msg = JSON.parse(raw ?? '{}')
    } catch {
      return
    }
    const text = typeof msg.text === 'string' ? msg.text.trim() : ''
    if (!text || Date.now() / 1000 - Number(msg.at ?? 0) > 120) return
    $.ui.toast('office: "' + clip(text, 60) + '"')
    await $.prompt.submit({ text, asUser: true }).catch(() => $.ui.toast('office: could not send the reply; type it here'))
  } finally {
    officeBusy = false
  }
}

async function refreshNeighbors($: any) {
  void refreshElsewhere($)
  // Sums read every attachment: every few minutes, not every refresh.
  if (Date.now() - expCheckedAt > 5 * 60_000) void refreshExp($)
  if (!isPaneId(pane)) return
  const r = await bridge($, 'neighbors', { pane, cwd })
  await update($, neighborsA, () => (Array.isArray(r.neighbors) ? r.neighbors : []))
}

async function loadSources($: any) {
  const shared = (await $.store.get(K.sources)) as (Sources & { at: number }) | undefined
  if (shared && Date.now() - shared.at < 6 * 3_600_000) {
    sources = shared
  } else {
    const next: Sources = { ...EMPTY }
    try {
      const r = await $.process.run(['kubectl', 'config', 'get-contexts', '-o', 'name'], { timeoutMs: 8000 })
      next.contexts = r.stdout.split('\n').filter(Boolean)
    } catch {
      next.contexts = []
    }
    next.profiles = parseProfiles((await readText($, home + '/.aws/config')) ?? '')
    sources = next
    await $.store.set(K.sources, { ...next, at: Date.now() })
  }
  // Per-session parts: tickets and PRs this machine has seen, tmux windows.
  const outs = ((await read($, outputsA)) as Output[])
  const cache = ((await $.store.get(K.prs)) ?? {}) as Record<string, PrStatus>
  sources = {
    ...sources,
    tickets: [...new Set(outs.filter((o) => o.kind === 'ticket').map((o) => o.title))],
    prs: Object.values(cache).filter((p) => p.state === 'OPEN').map((p) => ({ key: p.key, title: p.title })),
  }
  try {
    const r = await $.process.run(['tmux', 'list-windows', '-a', '-F', '#{window_name}\t#{@cc_state}'], { timeoutMs: 3000 })
    sources.windows = r.stdout.split('\n').filter(Boolean).map((l: string) => {
      const [name, state] = l.split('\t')
      return { name: name ?? '', state: state ?? '' }
    })
  } catch {
    sources.windows = []
  }
}

// The whole right side is one pane. Every command opens it at a view; the
// same command again on the view already showing closes it, like /diff.
// One pane per area used to stack five tabs and split attention.
const COCKPIT = 'cc-cockpit'
// Body rows above the Web tab's page while one is open: the status bar, a
// blank, the tab row, the rule, the address field and the page header (views/home.ts frame, views/web.ts).
const WEB_TOP = 7

// The terminal's width: the presentation's when a command gave it, else the
// Claude Code pane's from tmux, read once per load (session.start). Kept in a
// variable so opening the pane waits on nothing: an open that awaited tmux
// first ran after a test's teardown.
let termCols: number | undefined

async function readTermColumns($: any) {
  if (!isPaneId(pane)) return
  try {
    const r = await $.process.run(['tmux', 'display-message', '-p', '-t', pane!, '#{pane_width}'], { timeoutMs: 3000 })
    const n = Number(r.stdout.trim())
    if (n > 0) termCols = n
  } catch {
    // no tmux: the engine's share
  }
}

async function openCockpitPane($: any, args: { focus?: true; rows?: number }, given?: number) {
  if (given && given > 0) termCols = given
  const cols = termCols
  return $.ui.open({ id: COCKPIT, title: 'cockpit', ...args, ...(cols ? { columns: cockpitColumns(cols) } : {}) })
}

async function noteStep($: any, turnId: string, r: any) {
  if (!r || typeof r !== 'object') return
  const text = String(r.answer ?? '').trim()
  const tools = Array.isArray(r.toolUses) ? r.toolUses.map((u: any) => String(u.name ?? u.tool ?? '')).filter(Boolean) : []
  await update($, liveA, (l) => {
    const cur = l && l.turnId === turnId ? l : { turnId, steps: 0, tools: {}, at: Date.now() }
    const counts = { ...cur.tools }
    for (const t of tools) counts[t] = (counts[t] ?? 0) + 1
    return { ...cur, steps: cur.steps + 1, tools: counts, text: text || cur.text, lastTools: tools.length ? tools : cur.lastTools, at: Date.now() }
  })
}

// The Web tab's URL picker is open (mirrors uiA.webPick without a state read).
let pickerOpen = false

// alt+c from the prompt: the cockpit takes the keyboard, opened first if it is
// not, back on the element the ring was on.
async function cockpitChord($: any) {
  const panes = (await $.ui.panes()) as { id: string; isFocused?: boolean }[]
  if (panes.some((p) => p.id === COCKPIT && p.isFocused)) {
    webFocusPending = false
    await setWebKeyboard($, 'controls')
    if (isPaneId(pane)) await tmux($, [['send-keys', '-t', pane, 'M-c']])
    return
  }
  await focusCockpit($)
}

async function focusCockpit($: any) {
  webFocusPending = false
  await setWebKeyboard($, 'controls')
  const u = (await read($, uiA)) as any
  if (!u.open) await update($, uiA, (x) => ({ ...x, view: x.view ?? 'home', open: true }))
  const r = await openCockpitPane($, { focus: true })
  if (r?.isPlaced && u.focusKey) $.clock.after(200, () => void $.ui.focus({ requestId: COCKPIT, key: u.focusKey }).catch(() => undefined))
}

// alt+← / alt+→ from the prompt. The engine resizes a pane only while it
// holds the keyboard: pane:grow / pane:shrink are Pane-context actions, no
// plugin API sets a width, and a width the person keyed wins over one a
// plugin asks for. So the cockpit takes the keyboard, the same chord is
// replayed into it through tmux (Pane binds it to pane:grow / pane:shrink),
// and alt+c (abovePrompt:leave in Pane) hands the keyboard back. A draft in
// the composer refuses the focus: then the chord would come back here, so
// nothing is replayed. Closed, alt+← opens the cockpit without the keyboard.
let resizing = false
async function resizeFromPrompt($: any, dir: 'grow' | 'shrink') {
  if (resizing || !isPaneId(pane)) return
  resizing = true
  try {
    // Shown, as the engine sees it: uiA.open lags a close from the engine's mark.
    const before = (await $.ui.panes()) as { id: string; isShown?: boolean }[]
    if (!before.some((p) => p.id === COCKPIT && p.isShown)) {
      if (dir === 'grow') {
        await update($, uiA, (x) => ({ ...x, view: x.view ?? 'home', open: true }))
        await openCockpitPane($, {})
      }
      return
    }
    // Already holding the keyboard, so a text field inside it has the ring
    // (the go field, a filter): PaneField's pane:grow does not resize, and a
    // replay into the field would only come back here. Move the ring onto the
    // open tab's button, where Pane's binding resizes, and replay the chord
    // there; the keyboard stays in the cockpit.
    if (before.some((p) => p.id === COCKPIT && (p as { isFocused?: boolean }).isFocused)) {
      const u = (await read($, uiA)) as any
      const r = await $.ui.focus({ requestId: COCKPIT, key: 'cockpit-' + tabOf(u.view ?? 'home') }).catch((err: unknown) => ({ deny: String(err) }))
      if (r?.deny) return
      await tmux($, [['send-keys', '-t', pane!, dir === 'grow' ? 'M-Left' : 'M-Right']])
      return
    }
    await openCockpitPane($, { focus: true })
    const panes = (await $.ui.panes()) as { id: string; isFocused?: boolean }[]
    if (!panes.some((p) => p.id === COCKPIT && p.isFocused)) {
      $.ui.toast('cockpit width: the prompt has text; alt+tab into the cockpit, then alt+←/→')
      return
    }
    await tmux($, [['send-keys', '-t', pane!, dir === 'grow' ? 'M-Left' : 'M-Right'], ['send-keys', '-t', pane!, 'M-c']])
  } finally {
    // The replayed chords arrive after this returns: hold off a re-entry.
    $.clock.after(400, () => {
      resizing = false
    })
  }
}

function slashToken(text: string): boolean {
  return /^\/\S*$/.test(text)
}

async function setSlashCockpit($: any, hide: boolean) {
  if (slashHideBusy || (hide && !slashHideEnabled)) return
  slashHideBusy = true
  try {
    if (hide) {
      const panes = (await $.ui.panes()) as { id: string; isShown?: boolean }[]
      if (!panes.some((p) => p.id === COCKPIT && p.isShown)) return
      const result = await $.ui.close({ id: COCKPIT })
      if (!result?.deny) {
        slashHidCockpit = true
        // ui.close records open=false too, but doing this here makes the state
        // immediate for the edit that triggered the close.
        await update($, uiA, (u) => ({ ...u, open: false }))
      }
      return
    }
    if (!slashHidCockpit) return
    slashHidCockpit = false
    await update($, uiA, (u) => ({ ...u, open: true }))
    await openCockpitPane($, {})
  } finally {
    slashHideBusy = false
  }
}

async function openCockpit($: any, asked: string, columns: number, isFullscreen: boolean, toggle = true) {
  const view: View = tabOf(asked)
  const panes = (await $.ui.panes()) as { id: string; isShown: boolean }[]
  const open = panes.some((p) => p.id === COCKPIT && p.isShown)
  const ui = (await read($, uiA)) as any
  if (open && toggle && ui.view === view) {
    await $.ui.close({ id: COCKPIT })
    return {}
  }
  await update($, uiA, (u) => ({ ...u, view, open: true }))
  if (open) {
    if (asked === 'side') void $.ui.focus({ requestId: COCKPIT, key: 'side-input' }).catch(() => {})
    return {}
  }
  if (isFullscreen && columns < 100) return { text: 'Terminal too narrow: open at 100 columns or more.' }
  // No closeOnEscape: the key that hands the keyboard back (Esc, or alt+c bound to
  // abovePrompt:leave) then only leaves, so one chord flips prompt <-> cockpit
  // and the cockpit stays open. /cockpit and ctrl+x x close it.
  const r = await openCockpitPane($, { focus: true }, columns)
  // /side is for asking: the keyboard goes straight to the question field.
  if (r.isPlaced && asked === 'side') void $.ui.focus({ requestId: COCKPIT, key: 'side-input' }).catch(() => {})
  return r.isPlaced ? {} : { text: 'Pane is waiting: ' + r.reason }
}

// sb:slack-followup on one thread. The skill reads the new replies, checks
// the claims, and shows any reply for the person's approval before it is
// sent; this only starts it. Mid-turn it waits for the turn to end.
const slackFollowQueue = new Set<string>()
async function followUpSlack($: any, url: string, quiet = false) {
  if (mainTurnRunning) {
    slackFollowQueue.add(url)
    if (!quiet) $.ui.toast('Slack follow-up runs when this turn ends')
    return
  }
  try {
    await $.command.run({ command: 'sb:slack-followup', args: url })
    $.ui.toast('Slack follow-up started')
  } catch {
    await $.prompt.fill({ text: '/sb:slack-followup ' + url, mode: 'replace' })
    $.ui.toast('Could not start the Slack follow-up; press Enter to run it')
  }
}

// Stop a watch from the Now tab. TaskStop goes through the same tool chain the
// model's call would: a held watch is stopped by the cockpit's own TaskStop
// hook, an engine Monitor by the engine. The row goes either way, so a task
// the engine already forgot does not linger in the list.
async function stopMonitor($: any, taskId: string) {
  const m = ((await read($, monitorsA)) as MonitorState[]).find((x) => x.taskId === taskId)
  let ok = true
  try {
    const r: any = await $.tool.call({ tool: 'TaskStop', task_id: taskId })
    if (r?.deny) ok = false
  } catch {
    ok = false
  }
  holds.get(taskId)?.stop('stopped')
  await update($, monitorsA, (ms: MonitorState[]) => ms.filter((x) => x.taskId !== taskId))
  $.ui.toast((ok ? 'stopped: ' : 'removed (the engine no longer had it): ') + clip(m?.summary ?? taskId, 60))
}

async function setSlackFollow($: any, key: string, patch: Partial<SlackFollow>) {
  await update($, slackFollowA, (f) => {
    const cur = f[key] ?? { auto: false }
    const next = { ...cur, ...patch }
    const out = { ...f }
    if (!next.auto && !next.lastRun) delete out[key]
    else out[key] = next
    return out
  })
  await $.store.set(K.slackFollow, (await read($, slackFollowA)) as Record<string, SlackFollow>)
}

async function followUpPr($: any, pr: PrStatus) {
  try {
    await $.command.run({ command: 'sb:pr-followup', args: pr.url })
    $.ui.toast('PR follow-up queued')
  } catch {
    await $.prompt.fill({ text: '/sb:pr-followup ' + pr.url, mode: 'replace' })
    $.ui.toast('Could not start PR follow-up; press Enter to run it')
  }
}

async function openUrl($: any, url: string) {
  // Opening a thread from the cockpit is looking at it.
  if (url.includes('.slack.com/archives/')) {
    const o = ((await read($, outputsA)) as Output[]).find((x) => x.kind === 'slack' && x.url === url)
    if (o) void markSlackSeen($, o.id)
  }
  // The same opener Claude Code's own links use ($BROWSER): tmux-chrome-open
  // sends it where this pane's @browser says (TWeb, TWeb on Chrome, or the
  // window's tab group) and falls back to the OS opener outside tmux.
  try {
    const r = await $.process.run([home + '/.local/bin/tmux-chrome-open', url], { timeoutMs: 15000 })
    if (r.exitCode === 0) return
  } catch {
    // not installed: fall through
  }
  await $.process.run(['open', url], { timeoutMs: 8000 })
}

// The files an answer names (lib/record.ts answerFiles) that are there.
async function namedFiles($: any, answer: string, now: number): Promise<Output[]> {
  const fs: Output[] = []
  for (const o of answerFiles(answer, now).slice(0, 40)) {
    const path = o.path!.replace(/^~(?=\/)/, home)
    if (await $.fs.exists(path).catch(() => false)) fs.push({ ...o, id: o.kind + ':' + path, path })
  }
  return fs
}

// An archive reads as bytes: what is inside instead, its listing or its
// first lines, under its size.
const ARCHIVE = /\.(?:tar\.gz|tgz|tar|zip|gz)$/i
const ARCHIVE_PEEK = [
  'ls -lh -- "$1" | awk \'{print $5" "$9}\'; echo',
  'case "$1" in',
  '  *.tar.gz|*.tgz) tar -tzvf "$1" | head -60 ;;',
  '  *.tar) tar -tvf "$1" | head -60 ;;',
  '  *.zip) unzip -l "$1" | head -60 ;;',
  '  *.gz) gzip -l "$1"; echo; gzip -dc -- "$1" | head -c 16000 ;;',
  'esac',
].join('\n')

async function loadPreview($: any, o: Output) {
  let p: Preview = { kind: 'none', text: o.url ?? o.path ?? o.title }
  const path = o.path
  if (o.kind === 'exp' && path) {
    const c = await checkExp($, path)
    await update($, expA, (cur) => ({ ...cur, [path]: c }))
    p = { kind: 'markdown', text: expPreview(path, c, (await readText($, path + '/README.md'))?.slice(0, 20000)) }
  } else if (path) {
    if (/\.png$/i.test(path)) p = { kind: 'image', path }
    else if (ARCHIVE.test(path)) {
      const r = await $.process.run(['sh', '-c', ARCHIVE_PEEK, 'sh', path], { timeoutMs: 8000 })
      p = r.exitCode === 0 || r.stdout ? { kind: 'code', text: r.stdout.slice(0, 20000), path, language: 'text' } : { kind: 'none', text: 'No such file: ' + path }
    } else {
      const text = await readText($, path)
      if (text === undefined) p = { kind: 'none', text: 'No such file: ' + path }
      else if (o.kind === 'bg') p = { kind: 'tail', text: text.split('\n').slice(-30).join('\n'), running: !text.includes('exit code') }
      else if (/\.md$/i.test(path)) p = { kind: 'markdown', text: text.slice(0, 20000) }
      else p = { kind: 'code', text: text.slice(0, 20000), path, language: path.split('.').pop() }
    }
  } else if (o.kind === 'bg' && o.detail) {
    // Background Bash keeps its output at <tmp>/<project>/<sid>/tasks/<id>.output
    const guess = await $.process.run(['sh', '-c', 'ls -t /private/tmp/claude-*/*/' + sid + '/tasks/' + o.detail + '.output 2>/dev/null | head -1'], { timeoutMs: 3000 })
    const f = guess.stdout.trim()
    if (f) {
      const text = (await readText($, f)) ?? ''
      p = { kind: 'tail', text: text.split('\n').slice(-30).join('\n'), running: true }
    }
  }
  preview = { id: o.id, p }
}

async function exportOutputs($: any) {
  // ~/.claude/outputs/<date>/<sid>.json: what the session produced, for ccx,
  // dayx and the daily check-in, so they stop re-parsing transcripts.
  const day = new Date().toISOString().slice(0, 10)
  const data = {
    session: sid,
    cwd,
    repo,
    outputs: await read($, outputsA),
    flow: ((await read($, flowA)) as FlowEntry[]).filter((f) => f.kind !== 'progress'),
    agents: await read($, agentsA),
  }
  try {
    await $.fs.write(home + '/.claude/outputs/' + day + '/' + sid + '.json', JSON.stringify(data, null, 1))
  } catch {
    // disk full / permissions: the store copy is still there
  }
}

async function noteSession($: any) {
  const all = ((await $.store.get(K.sessions)) ?? {}) as Record<string, { cwd: string; repo?: string; window?: string; at: number }>
  let window = ''
  try {
    if (isPaneId(pane)) window = (await $.process.run(['tmux', 'display-message', '-p', '-t', pane, '#W'], { timeoutMs: 2000 })).stdout.trim()
  } catch {
    window = ''
  }
  all[sid] = { cwd, repo, window, at: Date.now() }
  // Forget sessions older than a week so the shared map stays small.
  for (const [k, v] of Object.entries(all)) if (Date.now() - v.at > 7 * 86_400_000) delete all[k]
  await $.store.set(K.sessions, all)
  await pruneOutputCopies($)
}

// Other sessions' outputs copies past their use (lib/record.ts outputKeysToDrop).
const OUTPUT_COPY_MAX_AGE_MS = 14 * 86_400_000
const OUTPUT_COPIES_BUDGET = 1.5 * 1024 * 1024
async function pruneOutputCopies($: any) {
  try {
    const keys = ((await $.store.keys()) as string[]).filter((k) => k.startsWith('outputs:'))
    const copies = await Promise.all(
      keys.map(async (k) => {
        const list = ((await $.store.get(k)) ?? []) as Output[]
        return { sid: k.slice('outputs:'.length), at: Math.max(0, ...list.map((o) => Number(o.at) || 0)), bytes: JSON.stringify(list).length }
      }),
    )
    for (const s of outputKeysToDrop(copies, sid, Date.now(), OUTPUT_COPY_MAX_AGE_MS, OUTPUT_COPIES_BUDGET)) await $.store.delete(K.outputs(s))
  } catch {
    // a store that cannot be listed: try again at the next session start
  }
}

async function scopedOutputs($: any, scope: OutScope): Promise<(Output & { session?: string; window?: string })[]> {
  const mine = (await read($, outputsA)) as Output[]
  if (scope === 'session') return mine
  const all = ((await $.store.get(K.sessions)) ?? {}) as Record<string, { cwd: string; repo?: string; window?: string; at: number }>
  const today = new Date().toDateString()
  const rows: (Output & { session?: string; window?: string })[] = []
  for (const [s, meta] of Object.entries(all)) {
    if (scope === 'repo' && meta.repo !== repo) continue
    const list = (s === sid ? mine : (((await $.store.get(K.outputs(s))) ?? []) as Output[])).filter((o) => new Date(o.at).toDateString() === today)
    rows.push(...list.map((o) => ({ ...o, session: s, window: meta.window })))
  }
  return rows.sort((a, b) => b.at - a.at)
}

async function sideAsk($: any, q: string) {
  const id = ++sideSeq
  const before = (await read($, sideA)) as SideQA[]
  await update($, sideA, (xs) => [...xs, { id, q, at: Date.now(), pending: true }])
  const r = await $.model.fork({ prompt: sidePrompt(before, q) })
  await update($, sideA, (xs) =>
    xs.map((x) =>
      x.id !== id
        ? x
        : r.isAnswered
          ? { ...x, pending: false, a: r.text, tokens: { input: r.usage.input_tokens, output: r.usage.output_tokens, cacheRead: r.usage.cache_read_input_tokens } }
          : { ...x, pending: false, error: r.reason === 'nothing-to-fork' ? 'Available after the first main turn finishes.' : 'answer failed: ' + r.reason },
    ),
  )
}

// Rebuild flow, turns, outputs and the work graph from the loaded transcript
// when this process did not live through it (resume, fork, the mod loading
// mid-session); see lib/backfill.ts. Once per session id, and only into empty
// state: a session with live turns already has better data than a replay.
async function backfillSession($: any, live: boolean) {
  const id = await $.session.id()
  if (backfilled === id) return
  backfilled = id
  if (((await read($, turnsA)) as TurnRecord[]).length > 0) return
  let msgs: BackfillMessage[] = []
  try {
    msgs = await $.session.messages()
  } catch {
    return
  }
  if (!msgs.some(isHumanPrompt)) return
  const h = home || ((await $.env.get('HOME')) ?? '')
  const jsonl = transcript || (h && cwd ? transcriptPath(h, cwd, id) : '')
  const text = jsonl ? await readText($, jsonl) : undefined
  const r = rebuild(msgs, text ? parseStamps(text) : undefined, live)
  // A subagent's own tool count lives in its transcript; bounded, since each
  // read is a call into the engine.
  await Promise.all(
    r.agents
      .filter((a) => a.kind === 'agent' && a.id !== a.toolUseId)
      .slice(-20)
      .map(async (a) => {
        try {
          const sub = await $.session.messages({ agentId: a.id })
          if (Array.isArray(sub)) a.tools = sub.reduce((n: number, m: BackfillMessage) => n + (m.toolUses?.length ?? 0), 0)
        } catch {
          // unreadable subagent transcript: leave the count at 0
        }
      }),
  )
  await update($, flowA, (cur) => (cur.length ? cur : r.flow.slice(-FLOW_CAP)))
  await update($, answersA, (cur) => (Object.keys(cur).length ? cur : r.answers))
  await update($, turnsA, (cur) => (cur.length ? cur : r.turns.slice(-80)))
  await update($, agentsA, (cur) => (cur.length ? cur : r.agents.slice(-200)))
  await addOutputs($, r.outputs)
  await publishAgents($)
}

// ---- the Web tab: a TWeb page drawn in this pane (bin/cc-browser) ----

function webCall($: any, path: string, body?: unknown) {
  if (!webSock) return Promise.resolve(undefined)
  return $.http
    .fetch('http://cc-browser' + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), socketPath: webSock })
    .catch(() => undefined)
}

// `restart` starts a new bridge even when one runs the same engine (a new
// frame rate); otherwise a running bridge on that engine just navigates.
async function startWeb($: any, url: string, engine: WebEngine, rate: number, restart = false, explicit = false) {
  if (!isPaneId(pane)) return 'Outside tmux there is no pane to draw a page in.'
  if ((await read($, webA)).running) {
    if (engine === webEngine && rate === webRunRate && !restart) {
      webExplicit = explicit
      await webCall($, '/cmd', { argv: ['navigate', url] })
      return ''
    }
    await stopWeb($)
  }
  // One socket and one generation per bridge: the bridge being replaced
  // unlinks its own socket and finishes after the new one starts, so sharing
  // a path or the state would let it take the new one down with it.
  const gen = ++webGen
  webSock = home + '/.claude/state/cc-browser-' + sid + '-' + gen + '.sock'
  webRunRate = rate
  webEngine = engine
  webExplicit = explicit
  webStopping = false
  webRegion = ''
  await update($, webA, () => ({ running: true, engine, url, asked: url, title: '' }))
  // tmux-chrome sends this pane's links here while it is set (and while the
  // bridge answers): see its try_cc_web.
  if (embedOn) await tmux($, [['set-option', '-p', '-t', pane, '@cc_web', webSock]])
  const argv = ['python3', $.plugin.root + '/bin/cc-browser', '--pane', pane, '--socket', webSock, '--engine', engine, '--url', url, '--frame-rate', String(rate), '--log', home + '/.claude/state/cc-browser-' + sid + '.log']
  void (async () => {
    let tail = ''
    try {
      const child = $.process.spawn({ argv })
      for await (const chunk of child) {
        if (chunk.stream === 'stderr') {
          tail = (tail + chunk.text).slice(-400)
          continue
        }
        for (const line of chunk.text.split('\n')) {
          let ev: any
          try {
            ev = line.trim() ? JSON.parse(line) : undefined
          } catch {
            ev = undefined
          }
          if (!ev || gen !== webGen) continue
          if (ev.event === 'ready') {
            // Its socket is up now: have the Web tab draw again and send the size.
            webRegion = ''
            $.ui.invalidate('ui.render')
          } else if (ev.event === 'loaded') {
            await update($, webA, (w) => ({ ...w, url: ev.url, title: ev.title }))
            // A page a rule puts on another engine (a link clicked, a URL
            // tmux-chrome sent straight to the bridge): reopen it there.
            const want = webExplicit ? undefined : engineForUrl(String(ev.url ?? ''), engineRules)
            if (want && want !== webEngine) {
              void startWeb($, ev.url, want, webRunRate)
              continue
            }
            // A restarted engine comes up with the pane's own viewport: put the
            // chosen device back once its page is up.
            const dev = ((await read($, webSettingsA)) as WebSettings).device
            if (dev && webDeviceGen !== gen && !/^data:/.test(ev.url)) {
              webDeviceGen = gen
              void webCall($, '/cmd', { argv: ['device', dev] })
            }
          }
          else if (ev.event === 'shown') await update($, webA, (w) => ({ ...w, shown: true }))
          else if (ev.event === 'hidden') await update($, webA, (w) => ({ ...w, shown: false }))
          // tmux left Page mode for the person (alt+w / alt+tab, ~/.tmux.conf
          // cc-web-leave): the engine already moved the keyboard off the page.
          else if (ev.event === 'leave') {
            webFocusPending = false
            await setWebKeyboard($, 'controls')
          }
        }
      }
    } catch (err) {
      tail = String(err)
    }
    // The bridge ended: on /web close (asked), or on its own (engine crash).
    // A bridge that was replaced has nothing left to say about the state.
    if (gen !== webGen) return
    const asked = webStopping
    webSock = ''
    // Caught: a bridge can end after the session it served is gone (the module
    // unloaded, a test torn down), and its state is gone with it.
    try {
      if (isPaneId(pane)) await tmux($, [['set-option', '-p', '-t', pane, '-u', '@cc_web']])
      webFocusPending = false
      await setWebKeyboard($, 'controls')
      await update($, webA, () => (asked ? WEB_IDLE : { running: false, error: clip(tail.trim().split('\n').pop() ?? 'exited', 160) || 'exited' }))
    } catch {
      // nothing left to tell
    }
  })()
  return ''
}

// Which engine a link should go to when this session draws pages itself:
// tmux-chrome's answer for this pane (pane, window, global @browser).
async function webTarget($: any): Promise<string> {
  const opt = async (scope: string) =>
    isPaneId(pane) ? ((await $.process.run(['tmux', 'show-options', scope, '-qv', '-t', pane, '@browser'], { timeoutMs: 3000 }).catch(() => undefined))?.stdout ?? '').trim() : ''
  // $.env.get takes literal names, so the module's env reads can be listed.
  const or = (p: Promise<unknown>) => p.then((v) => (typeof v === 'string' ? v : ''), () => '')
  return resolveBrowser({
    env: await or($.env.get('TMUX_CHROME_BROWSER')),
    pane: await opt('-p'),
    window: await opt('-w'),
    global: await opt('-g'),
    twebFlag: await or($.env.get('TMUX_CHROME_TWEB')),
  })
}

async function openWeb($: any, url: string, engine?: WebEngine) {
  const ws = (await read($, webSettingsA)) as WebSettings
  if (!embedOn) return openSide($, url, engine ?? engineForUrl(url, engineRules) ?? ws.engine)
  const err = await startWeb($, url, engine ?? engineForUrl(url, engineRules) ?? ws.engine, ws.rate || webRate, false, !!engine)
  if (err) return err
  await update($, uiA, (u) => ({ ...u, view: 'web', open: true }))
  const panes = (await $.ui.panes()) as { id: string; isShown: boolean }[]
  // focus is a request (true or absent): a link opened mid-turn leaves the
  // keyboard where it is. rows asks the inline block for room for the page.
  if (!panes.some((p) => p.id === COCKPIT && p.isShown)) await openCockpitPane($, { rows: 30 })
  return ''
}

// ---- the TWeb pane beside (browserEmbed off, the default) ----

// An agent's browser command starts: one log row, and the Web tab redraws
// with the driving badge (and again once the badge has run out).
async function autoStart($: any, id: string, step: { verb: string; detail: string; pane?: string }) {
  const at = await clockNow($)
  await update($, webAutoA, (xs) => [...xs, { id, at, state: 'running' as const, ...step }].slice(-60))
  $.ui.invalidate('ui.render')
  $.clock.after(DRIVING_MS + 100, () => $.ui.invalidate('ui.render'))
}

async function autoEnd($: any, id: string, ok: boolean) {
  await update($, webAutoA, (xs) => xs.map((x) => (x.id === id && x.state === 'running' ? { ...x, state: ok ? ('ok' as const) : ('failed' as const) } : x)))
  // What the command did shows in the pane's tabs at once, not at the next listing.
  void refreshSide($).then(() => $.ui.invalidate('ui.render'))
}

// The TWeb panes in this session's tmux window, and whether tweb answered.
async function listSide($: any): Promise<{ panes: SidePane[]; link?: TwebLink }> {
  if (!isPaneId(pane)) return { panes: [] }
  const at = Date.now()
  const [win, list, daemon] = await Promise.all([
    $.process.run(['tmux', 'list-panes', '-t', pane, '-F', '#{pane_id}'], { timeoutMs: 3000 }).catch(() => undefined),
    $.process.run(['tweb', 'panes', '--json'], { timeoutMs: 5000 }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    $.process.run(['tweb', 'daemon', 'status'], { timeoutMs: 3000 }).catch(() => undefined),
  ])
  const link = linkOf(list, at)
  if (link.state === 'ok') link.daemon = parseDaemonStatus(String(daemon?.stdout ?? ''))
  const ids = new Set<string>(String(win?.stdout ?? '').split('\n').map((x: string) => x.trim()).filter(Boolean))
  return { panes: list instanceof Error ? [] : parseTwebPanes(String(list.stdout ?? ''), ids, pane), link }
}

// Same content as before: no write, so no redraw. A listing every few seconds
// that rewrites the atom redraws the tab each time, and the panels blink.
function sameSide(a: SideWeb, b: SideWeb): boolean {
  const strip = ({ checked: _c, link, ...x }: SideWeb) => JSON.stringify({ ...x, link: link && { ...link, at: 0, daemon: link.daemon && { ...link.daemon, uptimeMs: 0 } } })
  return strip(a) === strip(b)
}

async function refreshSide($: any) {
  if (sideListing) return
  sideListing = true
  try {
    const { panes, link } = await listSide($)
    const before = (await read($, sideWebA)) as SideWeb
    const p = pickSidePane(panes, { prefer: before.pane })
    // The open panel's records, read from the pane each listing.
    let extra: Partial<SideWeb> = {}
    if (p && (before.panel === 'console' || before.panel === 'network')) {
      try {
        const r = await $.process.run(sideArgv(p.pane, [before.panel, '--json', '--limit', '40']), { timeoutMs: 5000 })
        extra = before.panel === 'console' ? { console: parseConsole(String(r.stdout ?? '')) } : { network: parseNetwork(String(r.stdout ?? '')) }
      } catch {
        // the pane went away mid-read: the next listing says so
      }
    }
    // The pane shows ⇄ cc-mods <this pane> while this session renews the link (tweb link), so the
    // person at the page knows the cockpit can drive it.
    if (p && !before.linkUnsupported && (p.pane !== sideLinkedPane || Date.now() - sideLinkedAt > LINK_RENEW_MS)) {
      const r = await $.process.run(linkArgv(p.pane, pane!), { timeoutMs: 3000 }).catch(() => undefined)
      if (r?.exitCode === 0) {
        sideLinkedAt = Date.now()
        sideLinkedPane = p.pane
      } else if (/unrecognized subcommand|unknown method/i.test(String(r?.stderr ?? '') + String(r?.stdout ?? ''))) {
        extra.linkUnsupported = true
      }
    }
    const next = (s: SideWeb): SideWeb => ({ ...s, ...extra, presence: p?.presence, pane: p?.pane, engine: p?.engine, tabs: p?.tabs ?? [], others: Math.max(0, panes.length - (p ? 1 : 0)), floating: !!p && p.pane === s.pane && !!s.floating, link: link ?? s.link, checked: Date.now() })
    if (!sameSide(before, next(before))) await update($, sideWebA, next)
  } finally {
    sideListing = false
  }
}

// The Web tab's badge in the tab row, from any tab. The link is checked now
// and then even off the Web tab (on the clock: drawing may not write), so a
// tweb that went away shows before the person looks.
async function webLinkBadge($: any): Promise<'ok' | 'down' | 'driving' | undefined> {
  const side = (await read($, sideWebA)) as SideWeb
  if (!sideListing && Date.now() - sideAskedAt > 60_000) {
    sideAskedAt = Date.now()
    $.clock.after(0, () => void refreshSide($).then(() => $.ui.invalidate('ui.render')))
  }
  const last = ((await read($, webAutoA)) as AutoStep[]).at(-1)
  if (last && (last.state === 'running' || (await clockNow($)) - last.at < DRIVING_MS)) return 'driving'
  if (side.presence?.driving) return 'driving'
  if (!side.link) return undefined
  return side.link.state === 'ok' ? 'ok' : 'down'
}

// A page asked for here (/web, the Web tab's go field, a palette pick): into
// the driven pane when it runs the engine the URL wants, else a new pane
// right of this one. Links Claude opens take tmux-chrome's own path to the
// same pane (its try_tweb_open), since @cc_web is not set in this mode.
async function openSide($: any, url: string, engine: WebEngine): Promise<string> {
  if (!isPaneId(pane)) return 'Outside tmux there is no window to open a TWeb pane in.'
  const s = (await read($, sideWebA)) as SideWeb
  const hit = pickSidePane((await listSide($)).panes, { engine, prefer: s.pane, strict: true })
  let err = ''
  try {
    if (hit) {
      const r = await $.process.run(sideArgv(hit.pane, ['navigate', url]), { timeoutMs: 20_000 })
      if (r.exitCode !== 0) err = clip(String(r.stderr || r.stdout).trim().split('\n').pop() ?? '', 160) || 'navigate failed'
      await update($, sideWebA, (x) => ({ ...x, pane: hit.pane }))
    } else {
      const r = await $.process.run(['tmux', ...splitArgv(pane, engine, url, cwd)], { timeoutMs: 5000 })
      const id = String(r.stdout ?? '').trim()
      if (r.exitCode !== 0 || !isPaneId(id)) err = clip(String(r.stderr).trim(), 160) || 'tmux split-window failed'
      else await update($, sideWebA, (x) => ({ ...x, pane: id, floating: false }))
    }
  } catch (e) {
    err = clip(String(e), 160)
  }
  await update($, sideWebA, (x) => ({ ...x, error: err || undefined }))
  // A new pane lists itself once its engine is up.
  $.clock.after(hit ? 300 : 2500, () => void refreshSide($).then(() => $.ui.invalidate('ui.render')))
  return err
}

// One tweb command for the driven pane, then a fresh listing.
async function sideCmd($: any, argv: string[]) {
  const s = (await read($, sideWebA)) as SideWeb
  if (!s.pane) return
  let err = ''
  try {
    const r = await $.process.run(sideArgv(s.pane, argv), { timeoutMs: 20_000 })
    if (r.exitCode !== 0) err = 'tweb ' + argv[0] + ': ' + (clip(String(r.stderr || r.stdout).trim().split('\n').pop() ?? '', 140) || 'failed')
  } catch (e) {
    err = clip(String(e), 160)
  }
  await update($, sideWebA, (x) => ({
    ...x,
    error: err || undefined,
    ...(err || (argv[0] !== 'float' && argv[0] !== 'pin') ? {} : { floating: argv[0] === 'float' }),
  }))
  await refreshSide($)
  $.ui.invalidate('ui.render')
}

// The keyboard goes to the beside pane: TWeb's own pane UI owns every key
// there, and tmux's pane keys come back.
async function focusSide($: any) {
  const s = (await read($, sideWebA)) as SideWeb
  if (!s.pane) return void $.ui.toast('Web: no TWeb pane beside this one; enter a URL in the go field')
  await tmux($, [['select-pane', '-t', s.pane]])
}

async function closeSide($: any) {
  const s = (await read($, sideWebA)) as SideWeb
  if (!s.pane) return
  await tmux($, [['kill-pane', '-t', s.pane]])
  await update($, sideWebA, (x) => ({ ...x, pane: undefined, tabs: [], floating: false }))
  await refreshSide($)
  $.ui.invalidate('ui.render')
}

// The Settings tab's rules, once set there, replace the option's.
async function loadEngineRules($: any) {
  try {
    const prefs = ((await $.store.get(K.cockpitSettings)) ?? {}) as { engineRules?: string }
    engineRules = typeof prefs.engineRules === 'string' ? parseEngineRules(prefs.engineRules) : engineRulesOption
  } catch {
    engineRules = engineRulesOption
  }
}

async function saveEngineRules($: any, rules: EngineRule[]) {
  engineRules = rules
  const cur = ((await $.store.get(K.cockpitSettings)) ?? {}) as Record<string, unknown>
  await $.store.set(K.cockpitSettings, { ...cur, engineRules: formatEngineRules(rules) })
  $.ui.invalidate('ui.render')
}

async function currentRoute($: any): Promise<RouteSettings> {
  return routeSettings(((await read($, policyA)) as Policy | null)?.caps)
}

// The Web tab's settings: engine and frame rate restart the page at its URL,
// the device switches the running page in place.
async function setWebSettings($: any, patch: Partial<WebSettings>) {
  const before = (await read($, webSettingsA)) as WebSettings
  await update($, webSettingsA, (s) => ({ ...s, ...patch }))
  const w = (await read($, webA)) as WebState
  if (!w.running) return
  const now = (await read($, webSettingsA)) as WebSettings
  if (now.engine !== before.engine || now.rate !== before.rate) {
    await startWeb($, w.url || 'about:blank', now.engine, now.rate, false, now.engine !== before.engine)
  } else if (patch.device !== undefined && now.device !== before.device) {
    await webCall($, '/cmd', { argv: now.device ? ['device', now.device] : ['device', '--reset'] })
  }
}

// Escape in TWeb Page mode. While a Client holds the keyboard, Claude Code
// takes Escape back before any hook or keybinding sees it (measured: no
// ui.focus/ui.close/ui.scroll/ui.message, and Pane/PaneField bindings do not
// fire). tmux reads keys before Claude Code does: ~/.tmux.conf binds root
// Escape to ~/.local/bin/cc-web-esc while this pane has @cc_web_page set, and
// passes it on unchanged everywhere else. This only keeps that option current.
const WEB_PAGE_OPT = '@cc_web_page'
async function setWebKeyboard($: any, mode: 'controls' | 'page') {
  await update($, webKeyboardA, () => mode)
  if (!isPaneId(pane)) return
  await tmux($, [mode === 'page' ? ['set-option', '-p', '-t', pane, WEB_PAGE_OPT, '1'] : ['set-option', '-p', '-t', pane, '-u', WEB_PAGE_OPT]])
}

// Switch keyboard ownership on the Web tab. A Client can only take the
// keyboard through a pointer press; $.ui.focus deliberately accepts only
// Button/Input/Select. In a terminal dock we know the rendered Client's cells,
// so alt+w sends one synthetic mouse press there. The actual onPointer event
// confirms Page mode; a missed coordinate times out without lying in the UI.
async function focusWebPage($: any) {
  const u = (await read($, uiA)) as any
  const w = (await read($, webA)) as WebState
  if (tabOf(u.view) !== 'web' || !w.running) return void $.ui.toast('Web keyboard: open a page in Web (6) first')
  if (!webClick || !isPaneId(pane)) return void $.ui.toast('Web keyboard: click the page once (shortcut entry needs a docked terminal pane)')
  webFocusPending = true
  const p = webClick
  const seq = `\x1b[<0;${p.x};${p.y}M\x1b[<0;${p.x};${p.y}m`
  // Raw bytes (-H), not -l: with extended-keys csi-u tmux encodes a literal
  // ESC as the Escape key (CSI 27u), which breaks the mouse sequence.
  const hex = [...new TextEncoder().encode(seq)].map((b) => b.toString(16).padStart(2, '0'))
  await tmux($, [['send-keys', '-t', pane, '-H', ...hex]])
  $.clock.after(500, () => {
    if (!webFocusPending) return
    webFocusPending = false
    $.ui.toast('Web keyboard: shortcut click missed; click the page to enter PAGE')
  })
}

async function focusWebControls($: any) {
  webFocusPending = false
  await setWebKeyboard($, 'controls')
  await $.ui.focus({ requestId: COCKPIT, key: 'web-keyboard' }).catch(() => undefined)
}

// Esc in the cockpit (views/palette.ts ESCAPE_ACTION). TWeb Page mode: byte
// 1b to the page. Open palette or help: close it. Otherwise the ring moves to
// the element before the focused one, as abovePrompt:previous did.
async function cockpitEscape($: any) {
  const mode = (await read($, webKeyboardA)) as 'controls' | 'page'
  const u = (await read($, uiA)) as any
  if (mode === 'page' && tabOf(u.view) === 'web') return void webCall($, '/input', { hex: '1b' })
  if (((await read($, helpA)) as boolean) === true) return void (await update($, helpA, () => false))
  if (((await read($, paletteA)) as PaletteState).open) return void (await togglePaletteOpen($))
  const items = navLast.filter((i) => !i.hidden && !isHiddenKey(i.key))
  const from = items.findIndex((i) => i.key === navFocus)
  const target = items[(from <= 0 ? items.length : from) - 1]
  if (!target) return
  navFocus = target.key
  noteCockpitUse($, target.key)
  await $.ui.focus({ requestId: COCKPIT, key: target.key }).catch(() => undefined)
}

async function toggleWebKeyboard($: any) {
  const u = (await read($, uiA)) as any
  if (tabOf(u.view) !== 'web') return void $.ui.toast('alt+w: Web keyboard is available in Web (6)')
  if (!embedOn) return focusSide($)
  const mode = (await read($, webKeyboardA)) as 'controls' | 'page'
  if (mode === 'page') await focusWebControls($)
  else await focusWebPage($)
}

// A palette pick that goes somewhere: switch the cockpit there and put the
// keyboard on that place. Without the focus the ring was left on the
// palette's query field, gone once the palette closed, so the next key went
// nowhere useful (the side question field needed a Tab or `i` first). The
// element is drawn only after the state change renders, so a refused focus
// is tried once more a moment later.
async function landOn($: any, patch: Record<string, unknown>, key: string) {
  await update($, uiA, (u) => ({ ...u, ...patch }))
  navFocus = key
  noteCockpitUse($, key)
  await focusSoon($, key)
}

// alt+s / k. The query field's autoFocus takes the ring only when the pane
// takes the keyboard; with the cockpit already holding it (alt+c first, the
// usual way in) the ring stayed where it was and typing went nowhere. Put it
// in the field, and back where it was when the palette closes.
let beforePalette: string | undefined
async function togglePaletteOpen($: any) {
  const was = (await read($, paletteA)) as PaletteState
  await update($, paletteA, () => (was.open ? PALETTE_CLOSED : { open: true, query: '', sel: 0 }))
  if (was.open) {
    const back = beforePalette
    beforePalette = undefined
    if (back) void $.ui.focus({ requestId: COCKPIT, key: back }).catch(() => undefined)
    return
  }
  beforePalette = navFocus
  // From the prompt (Global binds alt+s) the cockpit may be closed or not hold
  // the keyboard, and a focus into a site that does not hold it is refused:
  // open it with the keyboard first.
  const u = (await read($, uiA)) as any
  if (!u.open) await update($, uiA, (x) => ({ ...x, view: x.view ?? 'home', open: true }))
  await openCockpitPane($, { focus: true }).catch(() => undefined)
  await focusSoon($, 'palette-query')
}

// The element appears only once the state change renders: a refused focus is
// tried once more a moment later.
async function focusSoon($: any, key: string) {
  const give = async () => {
    try {
      const r = await $.ui.focus({ requestId: COCKPIT, key })
      return !r?.deny
    } catch {
      return false
    }
  }
  if (!(await give())) $.clock.after(150, () => void give())
}

// What a palette item does (lib/palette.ts ids). Policy changes go through
// the same CLI the Policy tab uses: the palette is the person's own input.
async function runPaletteItem($: any, item: PaletteItem) {
  await update($, paletteA, () => PALETTE_CLOSED)
  beforePalette = undefined
  const [kind, a, b] = item.id.split(':')
  if (kind === 'slack') return void (await openUrl($, item.id.slice('slack:'.length)))
  if (kind === 'slack-follow') return void (await followUpSlack($, item.id.slice('slack-follow:'.length)))
  if (kind === 'tab' && a) return landOn($, { view: a }, 'cockpit-' + a)
  if (kind === 'go' && a === 'side') return landOn($, { view: 'flow' }, 'side-input')
  if (kind === 'go' && a === 'scope') return landOn($, { view: 'policy' }, 'scope-input')
  if (kind === 'go' && a === 'out-filter') return landOn($, { view: 'outputs', outSel: '' }, 'out-filter')
  if (kind === 'out' && a) return landOn($, { view: 'outputs', outTab: a, outSel: '' }, 'tab-' + a)
  if (kind === 'out-side' && a) return landOn($, { view: 'outputs', outSide: a, outTab: 'all', outSel: '' }, 'side-' + a)
  if (kind === 'chat' && a) return landOn($, { view: 'flow', flowFilter: a, flowSel: -1 }, 'tab-' + a)
  if (kind === 'policy' && a && b) return void (await applyPolicy($, [a, b]))
  if (kind === 'route' && (a === 'effort' || a === 'model')) return void (await applyPolicy($, [b === 'on' ? 'allow' : 'inherit', a === 'effort' ? 'auto_effort' : 'auto_model']))
  if (kind === 'browser' && a && isPaneId(pane)) {
    const choice = parseBrowser(a)
    if (choice) await tmux($, [browserArgv(pane, choice)])
    return $.ui.toast('links open in ' + a)
  }
  if (kind === 'web') {
    if (a === 'open') return landOn($, { view: 'web' }, 'web-address')
    if (a === 'close') return stopWeb($)
    if (a === 'devtools') return webCall($, '/cmd', { argv: ['devtools'] })
    if (a === 'float') {
      const fl = !!((await read($, webA)) as WebState).floating
      await webCall($, '/cmd', { argv: [fl ? 'pin' : 'float'] })
      return update($, webA, (x) => ({ ...x, floating: !fl }))
    }
    if (a === 'engine' && parseEngine(b)) return setWebSettings($, { engine: parseEngine(b)! })
    if (a === 'device') return setWebSettings($, { device: b ?? '' })
    if (a === 'fps' && b) return setWebSettings($, { rate: Number(b) })
  }
  if (kind === 'cmd') {
    if (a === 'auth') return void (await runRadar($, true))
    if (a === 'share') return shareSession($)
    if (a === 'rca-end') return endRca($, 'ended by you')
    if (a === 'fold') return update($, uiA, (u) => ({ ...u, focus: !u.focus }))
    if (a === 'close') return $.ui.close({ id: COCKPIT })
  }
}

// The fork offer's answer, from the band or the cockpit (lib/fork.ts): while
// the prompt's turn runs, it is stopped here and moved; once answered, the
// topic carries on in the new pane and this session sets it aside. Either way
// the offer goes away.
async function answerFork($: any, yes: boolean) {
  const f = (await read($, forkA)) as ForkOffer | null
  await update($, forkA, () => null)
  if (!yes || !f) return
  const phase = forkPhase(f, (await read($, turnsA)) as TurnRecord[])
  if (phase.kind === 'running') await $.turn.abort({ turnId: phase.turnId }).catch(() => undefined)
  const file = home + '/.claude/state/fork/pending-' + sid + '.txt'
  await $.fs.write(file, forkPrompt(f, phase))
  const r = await $.process.run(['python3', home + HOME_HOOKS + 'cc_fork.py', '--prompt-file', file], {
    env: { CLAUDE_CODE_SESSION_ID: sid, TMUX_PANE: pane ?? '' },
    timeoutMs: 15000,
  })
  if (r.exitCode !== 0) return void $.ui.toast('fork failed: ' + clip(r.stderr, 120))
  const forked = r.stdout.trim()
  if (phase.kind !== 'unknown') {
    await update($, movedA, (ms) => [...ms, { prompt: f.prompt, pane: forked }].slice(-10))
    setAside = { prompt: f.prompt, pane: forked }
    $.clock.after(500, () => setAsideSoon($, 0))
  }
  $.ui.toast((phase.kind === 'running' ? 'moved to ' : 'fork: ') + forked + (phase.kind === 'running' ? ' (stopped here)' : ''))
}

// Compaction refuses while a turn runs: the stopped turn is still winding
// down right after a move (hence the half second before the first try), and a
// late fork may land mid-turn. Try again each second for a while, then leave
// the transcript as it is.
function setAsideSoon($: any, tries: number) {
  if (!setAside) return
  $.session.compact().catch(() => {
    if (tries < 60) $.clock.after(1000, () => setAsideSoon($, tries + 1))
    else setAside = undefined
  })
}

// A refused call, by its guard's words; main loop only (a subagent's block
// ends with its own run).
async function noteBlock($: any, text: string, what: string) {
  if (!/BLOCKED by session policy/.test(text)) return
  const b = blockOf(text, (await read($, policyA)) as Policy | null, what, currentTurn, Date.now())
  if (b) await update($, blockedA, (bs) => [...bs.filter((x) => grantLabel(x) !== grantLabel(b)), b].slice(-20))
}

// A grant that lets a refused call through picks the work back up: once the
// session is idle, a prompt names what is allowed now and the call to run
// again. Only this session's blocks from the last two hours, each once; off in
// Settings with the auto-resume switch. A prompt the person types meanwhile
// takes over (prompt.submit drops the pending blocks).
let unblockPending: Blocked[] = []

async function resumeUnblocked($: any, p: Policy) {
  const now = Date.now()
  // Claimed inside one update: the blocks a grant now lets through leave the
  // list in the same write that hands them here, so a second policy read
  // racing this one (a prompt, the file watcher) finds nothing to resume.
  // By key, not identity: the list in the callback is a fresh copy of state —
  // `includes` never matched it, and one grant resumed the work four times.
  let ready: Blocked[] = []
  await update($, blockedA, (bs) => {
    const live = bs.filter((b) => now - b.at < BLOCK_TTL_MS && b.fromDeny)
    ready = live.filter((b) => nowAllowed(b, p))
    const gone = new Set(ready.map(blockKey))
    return live.filter((b) => !gone.has(blockKey(b)))
  })
  if (!ready.length) return
  if (!interactive || !(await resumeEnabled($))) return
  const pending = new Set(unblockPending.map(blockKey))
  unblockPending = [...unblockPending, ...ready.filter((b) => !pending.has(blockKey(b)))]
  $.ui.toast('policy now allows ' + ready.map(grantLabel).join(', ') + (mainTurnRunning ? ': continuing after this turn' : ': continuing'))
  if (!mainTurnRunning) flushUnblocked($)
}

function blockKey(b: Blocked): string {
  return grantLabel(b) + '@' + b.at
}

function flushUnblocked($: any) {
  if (!unblockPending.length) return
  const bs = unblockPending
  unblockPending = []
  void $.prompt.submit({ text: resumePrompt(bs), asUser: true }).catch(() => $.ui.toast('could not continue the blocked work; ask again'))
}

// ---- RCA mode (lib/rca.ts) ----

let rcaTimer: { cancel: () => void } | undefined

// The person pasted an alert thread: grant what investigating it takes, each
// grant reverted when RCA ends (by its clock, a press, /rca off). Grants the
// policy already holds are left alone, so ending RCA never takes back one the
// person made themselves.
async function startRca($: any, alert: Alert) {
  const cur = (await read($, rcaA)) as RcaState
  if (cur && cur.alert.channel === alert.channel && cur.alert.ts === alert.ts) return
  if (cur) await endRca($, 'a new alert')
  const before = await loadPolicy($)
  const granted: Grant[] = []
  const grants = rcaGrants(alert, sources.contexts ?? [])
  // The mode first (it clears scopes), then what the person had granted, then
  // the alert's targets; ending RCA puts `before` back as it was.
  if ((await runPolicy($, grants[0]!.argv)).ok) granted.push(grants[0]!)
  for (const argv of restoreArgvs(before).filter((a) => a[0] === 'allow' && a.length > 2)) await runPolicy($, argv)
  for (const g of grants.slice(1)) {
    const cap = g.argv[1] as Cap
    const scope = g.argv[3]
    if (before.caps[cap] === 'allow' || (scope && (before.scopes[cap] ?? []).some((x) => x.toLowerCase() === scope.toLowerCase()))) continue
    if ((await runPolicy($, g.argv)).ok) granted.push(g)
  }
  const now = Date.now()
  await update($, rcaA, () => ({ alert, grants: granted, at: now, until: now + RCA_MS, before }))
  scheduleRcaEnd($, now + RCA_MS)
  await loadPolicy($)
  $.ui.toast('🚨 RCA mode: ' + clip(alert.title, 60) + (granted.length ? ' · granted ' + granted.map((g) => g.label).join(', ') : ''))
}

function scheduleRcaEnd($: any, until: number) {
  rcaTimer?.cancel()
  rcaTimer = $.clock.after(Math.max(0, until - Date.now()), () => void endRca($, 'its time ran out'))
}

async function endRca($: any, why: string) {
  rcaTimer?.cancel()
  const cur = (await read($, rcaA)) as RcaState
  if (!cur) return
  if (cur.before) for (const argv of restoreArgvs(cur.before)) await runPolicy($, argv)
  else for (const g of cur.grants) if (g.revert.length) await runPolicy($, g.revert)
  await update($, rcaA, () => null)
  await loadPolicy($)
  $.ui.toast('RCA mode ended (' + why + ')' + (cur.grants.length ? ': grants reverted' : ''))
}

async function rcaAction($: any, action: 'end' | 'extend' | 'thread') {
  const cur = (await read($, rcaA)) as RcaState
  if (!cur) return
  if (action === 'end') return endRca($, 'ended by you')
  if (action === 'thread') return openUrl($, cur.alert.url)
  const until = Math.max(cur.until, Date.now()) + 60 * 60_000
  await update($, rcaA, (r) => (r ? { ...r, until } : r))
  scheduleRcaEnd($, until)
}

// A Slack thread the person pasted: is it an alert? The thread is read before
// the prompt goes on (bounded), so the grants are in place for the first turn.
async function detectAlert($: any, outs: readonly Output[]): Promise<Alert | undefined> {
  for (const o of outs) {
    const [, channel, root] = o.id.split(':')
    if (!channel || !root || !o.url) continue
    try {
      const text = mcpText(await $.mcp.call(SLACK_SERVER, 'slack_read_thread', { channel_id: channel, message_ts: root, limit: 20 }))
      const a = alertOf(text, o.url, channel, root)
      if (a) return a
    } catch {
      // Slack unreachable: no RCA, the prompt goes on
    }
  }
  return undefined
}

// RCA on the alert this session was already handed: the person's own prompts,
// newest first, then the threads it touched; the first that reads as an alert.
// With none, the prompt gets `/rca ` back with room for the link.
async function rcaFromSession($: any): Promise<string> {
  const found = await threadsSeen($)
  const alert = found.length ? await detectAlert($, found) : undefined
  if (alert) {
    await startRca($, alert)
    return '🚨 RCA mode on for ' + alert.title + ' (from this session): see the cockpit Now tab.'
  }
  await $.prompt.fill({ text: '/rca ', mode: 'replace' }).catch(() => undefined)
  const msg = found.length ? 'None of the ' + found.length + ' Slack threads in this session reads as an alert. Paste the alert thread link after /rca.' : 'No Slack thread in this session yet. Paste the alert thread link after /rca.'
  $.ui.toast(msg)
  return msg
}

// Slack threads this session has seen, newest first: links in the person's own
// prompts (the transcript, so a resume or reload still has them), then the
// threads recorded in Outputs. One entry per thread.
async function threadsSeen($: any): Promise<Output[]> {
  const out: Output[] = []
  try {
    const msgs = (await $.session.messages()) as BackfillMessage[]
    for (const m of [...msgs].reverse()) if (isHumanPrompt(m)) out.push(...slackOutputs(String(m.text ?? ''), Date.now()))
  } catch {
    // no transcript: Outputs alone
  }
  out.push(...((await read($, outputsA)) as Output[]).filter((o) => o.kind === 'slack' && o.url))
  return out.filter((o, i) => out.findIndex((x) => x.id === o.id) === i).slice(0, 6)
}

// ---- session identity (lib/identity.ts) ----

async function copyText($: any, text: string, what: string) {
  await $.ui.copy({ text })
  if (isPaneId(pane)) await $.process.run(['tmux', 'load-buffer', '-'], { stdin: text, timeoutMs: 3000 }).catch(() => undefined)
  $.ui.toast('copied ' + what)
}

async function shareSession($: any) {
  let window: string | undefined
  if (isPaneId(pane)) {
    const r = await $.process.run(['tmux', 'display-message', '-p', '-t', pane!, '#{session_name}:#{window_index} #{window_name}'], { timeoutMs: 3000 }).catch(() => undefined)
    window = r?.stdout.trim() || undefined
  }
  const flow = (await read($, flowA)) as FlowEntry[]
  const rca = (await read($, rcaA)) as RcaState
  const outs = (await read($, outputsA)) as Output[]
  const h = home || ((await $.env.get('HOME')) ?? '')
  const text = identityText({
    session: sid,
    window,
    pane,
    cwd,
    topic: rca ? 'RCA: ' + rca.alert.title : published.get('@title') || flow.find((f) => f.kind === 'prompt')?.text,
    state: published.get('@cc_state') || undefined,
    transcript: transcript || (h && cwd ? transcriptPath(h, cwd, sid) : undefined),
    last: [...flow].reverse().find((f) => f.kind === 'conclusion')?.text,
    links: [...(rca ? [rca.alert.url] : []), ...outs.filter((o) => (o.kind === 'slack' || o.kind === 'pr') && o.url).map((o) => o.url!)].filter((u, i, a) => a.indexOf(u) === i),
  })
  await copyText($, text, "this session's identity")
}

async function shareOther($: any, x: Elsewhere) {
  if (!x.session) return
  const r = await $.process.run(['sh', '-c', 'ls "$HOME"/.claude/projects/*/"$0".jsonl 2>/dev/null | head -1', x.session], { timeoutMs: 3000 }).catch(() => undefined)
  const text = identityText({ session: x.session, window: x.where + ' ' + x.window.replace(/^\d+:/, ''), topic: x.title, state: x.attention, transcript: r?.stdout.trim() || undefined })
  await copyText($, text, x.window + "'s identity")
}

// The session's /goal, off the transcript (cc-bridge.py goal): Claude Code
// gives a hooks module no event for it, but writes every set, clear and
// evaluation there. Read at start, after a /goal command and after each turn
// (the evaluator runs on Stop, so its verdict lands a moment after the turn).
async function loadGoal($: any) {
  const h = home || ((await $.env.get('HOME')) ?? '')
  const jsonl = transcript || (h && cwd && sid ? transcriptPath(h, cwd, sid) : '')
  if (!jsonl) return
  const g = parseGoal(await bridge($, 'goal', { transcript: jsonl }))
  const cur = (await read($, goalA)) as Goal | null
  if (JSON.stringify(cur) !== JSON.stringify(g)) await update($, goalA, () => g)
}

function loadGoalSoon($: any, delays: number[]) {
  for (const d of delays) $.clock.after(d, () => loadGoal($))
}

// This session through ccproxy's eyes (ccproxy usage): read at
// start and after each main turn. An older ccproxy answers a usage error; the
// card then says to update it rather than going blank.
async function loadUsage($: any) {
  const win = USAGE_WINDOWS[((await read($, usageA)) as { window: UsageWindow }).window]
  void bridge($, 'jev_usage', { now: Date.now() / 1000 }).then((j: any) => update($, usageA, (s) => ({ ...s, jev: parseJev(j) ?? s.jev })))
  try {
    // Quota beside usage: the Usage tab draws each account's windows and resets.
    void $.process.run(['ccproxy', 'status', '--offline', '--json'], { timeoutMs: 8000 }).then((q: any) =>
      update($, usageA, (s) => ({ ...s, quota: q.exitCode === 0 ? parseQuota(q.stdout) : s.quota })),
    ).catch(() => undefined)
    let r = await $.process.run(['ccproxy', 'usage', '--session', sid, '--json', '--bucket', win.bucket, '--buckets', String(win.buckets)], { timeoutMs: 8000 })
    // `--bucket session` is ccproxy PR #265; an older one rejects it as a duration.
    const noSession = win.bucket === 'session' && r.exitCode !== 0 && /--bucket/.test(r.stderr)
    if (noSession) r = await $.process.run(['ccproxy', 'usage', '--session', sid, '--json', '--bucket', '30m', '--buckets', '12'], { timeoutMs: 8000 })
    const u = r.exitCode === 0 ? parseUsage(r.stdout) : undefined
    if (u && noSession) $.ui.toast('ccproxy is too old for the whole-session trend: showing 6h')
    // An older ccproxy prints its whole help for an unknown command.
    const tooOld = r.exitCode !== 0 && /Claude Code multi-account proxy/.test(r.stdout + r.stderr)
    const note = u ? undefined : tooOld ? 'ccproxy is too old for usage: install a newer ccproxy' : r.exitCode !== 0 ? 'ccproxy usage failed: ' + clip(r.stderr.trim(), 120) : 'No requests through ccproxy yet.'
    await update($, usageA, (s) => ({ ...s, usage: u && u.requests > 0 ? u : undefined, note: u && u.requests > 0 ? undefined : note }))
  } catch {
    await update($, usageA, (s) => ({ ...s, note: 'ccproxy not found' }))
  }
}

async function stopWeb($: any) {
  webFocusPending = false
  webClick = undefined
  await setWebKeyboard($, 'controls')
  if (!webSock) return
  webStopping = true
  await webCall($, '/quit', {})
}

function els(x: unknown): Els {
  return x as Els
}

// ---- register --------------------------------------------------------------

// A Monitor's notification row (see the ui.render hooks in register).
async function watchRow($: any, e: any, next: any) {
  if (e.props.isExpanded) return next(e)
  const ms = (await read($, monitorsA)) as MonitorState[]
  const ev = parseMonitor(e.props.text ?? '')
  const m = ms.find((x) => x.taskId === (ev?.taskId ?? e.props.task?.id))
  if (!m) return next(e)
  const { Text, Box } = $.ui.resolve(e)
  const w = ev ? weigh(ev) : { weight: 'routine' as Weight, label: m.label }
  if (w.weight === 'routine' && !(ev && shownEvents.has(eventKey(ev.taskId, ev.event)))) return Box({ display: 'none', children: [] })
  return Text({ color: 'warning', wrap: 'truncate-end', children: ['❗ watch · ' + clip(m.summary, 50) + ' · ' + w.label] })
}

// A held watch's events come in as this plugin's own prompts.
function heldWatchRow($: any, e: any, next: any) {
  return String(e.props.text ?? '').includes('<task-id>' + HELD_PREFIX) ? watchRow($, e, next) : next(e)
}

export function register(on: any, options: Record<string, unknown> = {}) {
  const browserDefault = parseBrowser(options.browser) ?? 'inherit'
  // Off by default: pages open in a TWeb pane beside this one, which draws
  // and takes keys natively; on draws them inside the Web tab.
  const embed = options.browserEmbed === true
  embedOn = embed
  webRate = Math.max(4, Math.min(60, Number(options.browserFrameRate) || 30))
  const cockpitOnStartDefault = options.cockpitOnStart !== false
  engineRulesOption = parseEngineRules(options.browserEngineRules)
  engineRules = engineRulesOption
  // ---- session lifecycle ----
  on('session.start', async ($: any, e: any, next: any) => {
    cwd = e.cwd
    interactive = e.isInteractive
    const cockpitPrefs = ((await $.store.get(K.cockpitSettings)) ?? {}) as { slashHide?: boolean; mcpHeal?: boolean }
    slashHideEnabled = cockpitPrefs.slashHide !== false
    mcpHealEnabled = cockpitPrefs.mcpHeal !== false
    mcpHealTries.clear()
    mcpHealPending.clear()
    slashHidCockpit = false
    await loadEngineRules($)
    // The palette is a one-off: a session (or a reload) starts with it closed.
    await update($, paletteA, () => PALETTE_CLOSED)
    await update($, helpA, () => false)
    await setWebKeyboard($, 'controls')
    webFocusPending = false
    webClick = undefined
    slackFollowQueue.clear()
    const savedFollow = ((await $.store.get(K.slackFollow)) ?? {}) as Record<string, SlackFollow>
    await update($, slackFollowA, () => savedFollow)
    await resumeHeldWatches($)
    home = (await $.env.get('HOME')) ?? ''
    // What this mod knows about the organisation (lib/org.ts): kept outside
    // the repository. No file, and the features that need it stay off.
    setOrg(parseOrg(await readText($, home + ORG_PATH)))
    pane = await $.env.get('TMUX_PANE')
    sid = await $.session.id()
    // Panes from before the single cockpit (cc-flow, cc-outputs, …) survive a
    // reload as tabs; their tabs are where the ring escaped to. Close them.
    try {
      const open = (await $.ui.panes()) as { id: string }[]
      for (const p of open) if (paneOf(p.id)) await $.ui.close({ id: p.id })
    } catch {}
    try {
      const r = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd, timeoutMs: 3000 })
      repo = r.exitCode === 0 ? repoFromRemote(r.stdout) : undefined
    } catch {
      repo = undefined
    }
    // Maintenance windows for the atlantis PRs' rows (lib/iac.ts), from the
    // region files org.json names; an earlier file wins a region both name.
    const regionFiles = org().regionFiles.map((f) => f.replace(/^~(?=\/)/, home))
    void Promise.all(regionFiles.map((f) => readText($, f))).then((texts) =>
      setIacWindows(Object.assign({}, ...texts.reverse().map((t) => parseWindows(t)))),
    )
    const saved = dropUnsourcedTickets(((await $.store.get(K.outputs(sid))) ?? []) as Output[])
    if (saved.length) await update($, outputsA, (cur) => (cur.length ? cur : saved))
    await loadPolicy($)
    await resumeGod($)
    void noteSession($)
    void loadUsage($)
    void loadGoal($)
    // RCA outlives a module reload in $.state; its end timer does not.
    const rcaNow = (await read($, rcaA)) as RcaState
    if (rcaNow) scheduleRcaEnd($, rcaNow.until)
    // A module reload (the plugin's files changed) kills the Web tab's bridge
    // with the module, while $.state still says a page is open: the tab then
    // drew an empty region. Bring the page back where it was, on its engine.
    const wasOpen = (await read($, webA)) as WebState
    const reloaded = wasOpen.running && !webSock
    if (isPaneId(pane) && !reloaded) {
      // The Web tab starts on the engine /browser points this pane at.
      const target = browserDefault !== 'inherit' ? browserDefault : await webTarget($)
      const engine: WebSettings['engine'] = engineOfTarget(target)
      await update($, webSettingsA, (s) => ({ ...s, engine, rate: webRate }))
    }
    if (interactive && isPaneId(pane) && reloaded) {
      await update($, webA, () => WEB_IDLE)
      const ws = (await read($, webSettingsA)) as WebSettings
      // The page's own URL, unless it is a data: page tweb drew (an error or a
      // placeholder): then what was asked for.
      const again = wasOpen.url && !/^data:/.test(wasOpen.url) ? wasOpen.url : (wasOpen as any).asked || wasOpen.url || 'about:blank'
      void startWeb($, again, wasOpen.engine ?? ws.engine, ws.rate || webRate, true, true)
    }
    // The reload also took the keyboard back to the prompt. If the person was
    // working in the cockpit (and has not typed a prompt since), give it back.
    // A focus request is refused over text in the composer, so typing is safe.
    if (interactive) {
      const u = (await read($, uiA)) as any
      const now = Date.now()
      if (u.open && (u.cockpitAt ?? 0) > (u.promptAt ?? 0) && now - (u.cockpitAt ?? 0) < 15 * 60_000) {
        // Back to the element the ring was on; the Web tab's fields are drawn
        // only once its restarted page is up, so try again a little later.
        const key = u.focusKey ?? (tabOf(u.view || 'home') === 'web' ? 'web-address' : undefined)
        const give = async () => {
          try {
            await openCockpitPane($, { focus: true })
            const r = key ? await $.ui.focus({ requestId: COCKPIT, key }) : {}
            return !r?.deny
          } catch {
            return false
          }
        }
        $.clock.after(1_500, async () => {
          if (!(await give())) $.clock.after(3_000, () => void give())
        })
      }
    }
    if (interactive && isPaneId(pane) && browserDefault !== 'inherit') {
      browser = browserDefault
      await tmux($, [browserArgv(pane, browser)])
    }
    // Loaded into a session with history (a hot reload into a fresh $.state,
    // or a resume whose SessionStart this module missed): rebuild it. A resume
    // the classic hook sees backfills there first, with live = false; the delay
    // lets it, since the two start events arrive in no promised order.
    $.clock.after(2_000, () => void backfillSession($, true))

    if (interactive) {
      // Shared probes: whichever session's timer fires first refreshes the store;
      // the others read it.
      void runRadar($)
      $.clock.every(RADAR_MS, () => void runRadar($))
      $.clock.every(CRED_WATCH_MS, () => void watchCredentials($))
      $.clock.every(PR_POLL_MS, () => void pollPrs($))
      $.clock.every(SLACK_POLL_MS, () => void pollSlack($))
      $.clock.every(20_000, () => void pollNarwhal($))
      void pollNarwhal($)
      $.clock.every(15_000, () => void resumeProbe($))
      void $.process
        .run(['git', 'config', '--global', 'user.email'], { timeoutMs: 3000 })
        .then((r: any) => {
          slackMe = { email: String(r.stdout ?? '').trim() || undefined }
        })
        .catch(() => {})
      $.clock.every(60_000, () => void refreshNeighbors($))
      $.clock.every(2_000, () => void officeInbox($))
      // Elapsed times on running work only move if something redraws; do it
      // while anything is running, and not at all otherwise.
      $.clock.every(5_000, async () => {
        const as = (await read($, agentsA)) as AgentNode[]
        if (as.some((a) => a.status === 'running' || a.status === 'background')) $.ui.invalidate('ui.render')
      })
      void pollPrs($)
      void refreshNeighbors($)
      void loadSources($)
      $.clock.after(2_500, () => void backfillHints($))
      // Open by default, without the keyboard: the prompt keeps it, alt+c
      // moves in. An open unasked waits for room (the engine seats it from
      // about 110-144 columns), so a narrow terminal just does not show it.
      // A resumed session that already holds the pane keeps it as it was.
      // The Settings tab's choice (this machine) over the plugin option.
      const prefs = ((await $.store.get(K.cockpitSettings)) ?? {}) as { onStart?: boolean; embed?: boolean; slashHide?: boolean; mcpHeal?: boolean }
      if (typeof prefs.embed === 'boolean') embedOn = prefs.embed
      await readTermColumns($)
      if (prefs.onStart ?? cockpitOnStartDefault) {
        void (async () => {
          try {
            const panes = (await $.ui.panes()) as { id: string }[]
            if (panes.some((p) => p.id === COCKPIT)) return
            await update($, uiA, (u) => ({ ...u, view: u.view ?? 'home', open: true }))
            await openCockpitPane($, {})
          } catch {}
        })()
      }
    }

    const cmds: [string, string, string?][] = [
      ['flow', 'cockpit Chat tab: requests and conclusions, no tool calls'],
      ['graph', 'cockpit Work tab: request → subagents and background tasks'],
      ['side', 'side question that stays out of the main chat', '[question]'],
      ['outputs', 'cockpit Outputs tab: PRs, artifacts, files, tickets, links, tasks, archive folders', '[pr|artifact|scratch|ticket|link|bg|exp]'],
      ['policy', 'session policy (only a person can change it)', '[allow|block|inherit <cap> [scope] [15m] | mode <m>]'],
      ['cockpit', 'open/close the cockpit'],
      ['watch', 'Monitor events (cockpit Work tab)'],
      ['auth', 'refresh the credential radar, or log in to an MCP connector', '[connector]'],
      ['rca', 'RCA mode: an alert thread grants read prod, write in its service, posting in its channel, for 2h; no link: the alert this session was handed', '[thread link | off]'],
      // Not /share: that name is the built-in /bug's alias.
      ['whoami', "copy this session's identity, for another session"],
      ['title', 'set this pane label in tmux (@title); no argument clears it', '[label]'],
      ['yank', 'copy the last (or n-th last) answer to the clipboard and a tmux buffer', '[n]'],
      ['fold', 'fold finished tool calls to one line (/focus is built in)'],
      ['route', 'let Jev pick each turn\'s effort (and model): on, off, model on|off', '[on|off|model on|off]'],
      ['office', 'every session in tmux as a character in a quarter-view office; click one to answer it', ''],
      ['web', 'open a page in the cockpit Web tab (TWeb drawn in this pane); no argument shows the tab, "close" stops it', '[url | close | --electron|--chrome|--webkit url]'],
      ['browser', 'where this session opens links: TWeb (Electron), TWeb on your Chrome or on WebKit, or the Chrome tab group', '[tweb|tweb-chrome|tweb-webkit|chrome|inherit]'],
    ]
    for (const [name, description, argumentHint] of cmds) {
      try {
        await $.command.register(argumentHint ? { name, description, argumentHint, immediate: true } : { name, description, immediate: true })
      } catch (err) {
        $.ui.log('command registration failed /' + name + ': ' + String(err))
      }
    }
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($: any, e: any, next: any) => {
    // /clear and friends reset $.state and change the session id.
    sid = await $.session.id()
    if (typeof e.transcript_path === 'string') transcript = e.transcript_path
    const saved = dropUnsourcedTickets(((await $.store.get(K.outputs(sid))) ?? []) as Output[])
    if (saved.length) await update($, outputsA, (cur) => (cur.length ? cur : saved))
    await loadPolicy($)
    // A resumed or forked process cannot hold the old one's background tasks.
    if (e.source !== 'clear') void backfillSession($, false)
    return next(e)
  })

  on('classic.SessionStart', { source: 'startup' }, async ($: any, e: any, next: any) => {
    if (typeof e.transcript_path === 'string') transcript = e.transcript_path
    return next(e)
  })

  // This mod's own compaction after a fork: the moved request becomes one
  // line, with no model call; the messages around it stay the engine's own.
  on('session.compact', { trigger: 'plugin' }, ($: any, e: any, next: any) => {
    if (!setAside || e.agentId !== undefined) return next(e)
    const moved = setAside
    setAside = undefined
    const messages = setAsideMoved(e.messages ?? [], moved)
    return messages ? { messages } : { skip: 'fork: the moved request is not in this transcript' }
  })

  on('session.end', async ($: any, e: any, next: any) => {
    idleTimer?.cancel()
    await stopWeb($)
    await exportOutputs($)
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      // The pane may outlive the session (a shell after `claude` exits): leave
      // it opening links the way the window does, not the way this session did.
      const unset = isPaneId(pane) && browser !== 'inherit' ? [browserArgv(pane, 'inherit')] : []
      await tmux($, isPaneId(pane) ? [...clearArgv(pane), ...unset] : [])
    }
    published.clear()
    return next(e)
  })

  // ---- turns: tmux state, flow, graph ----
  on('turn.start', async ($: any, e: any, next: any) => {
    idleTimer?.cancel()
    if (!e.agentId) {
      // Our own keep-going does not count as "someone else resumed it": its
      // streak (and attempt count) carries on until it answers.
      if (ownResume) ownResume = false
      else mainTurnAt = await clockNow($)
      mainTurnRunning = true
    }
    const ev = !e.agentId && e.text ? parseMonitor(e.text) : undefined
    if (ev) {
      const w = weigh(ev)
      quietTurn = { turnId: e.turnId, taskId: ev.taskId, event: ev.event, weight: w.weight, wrote: false, tools: [], texts: [] }
      await update($, monitorsA, (ms: MonitorState[]) => {
        const prev = ms.find((m) => m.taskId === ev.taskId)
        const row: MonitorState = { quiet: 0, acted: 0, ...prev, taskId: ev.taskId, summary: ev.summary, last: ev.event, label: w.label, at: Date.now(), pr: w.pr ?? prev?.pr, outcome: undefined, mattered: undefined }
        return [...ms.filter((m) => m.taskId !== ev.taskId), row].slice(-20)
      })
    }
    if (e.text && e.text === pendingHuman) {
      pendingHuman = ''
      currentTurn = e.turnId
      lastPrompt = e.text
      await update($, turnsA, (ts) => [...ts, { turnId: e.turnId, text: clip(e.text, 200), at: Date.now(), tools: {} }].slice(-80))
      await update($, flowA, (fs) => [...fs, { at: Date.now(), turnId: e.turnId, kind: 'prompt' as const, text: clip(e.text, 280) }].slice(-FLOW_CAP))
      const rs = await currentRoute($)
      if (rs.effort || rs.model) {
        // Started now, read at the first step: Jev runs while the engine builds the request.
        const recent = ((await read($, turnsA)) as TurnRecord[]).slice(-4, -1).map((t) => t.text)
        routeJobs.set(e.turnId, bridge($, 'route', { prompt: e.text, recent }))
      }
    }
    await publish($, 'working', 'none')
    return next(e)
  })

  on('turn.complete', async ($: any, e: any, next: any) => {
    if (!e.agentId) {
      routeJobs.delete(e.turnId)
      mainTurnRunning = false
      if (slackFollowQueue.size) {
        const urls = [...slackFollowQueue]
        slackFollowQueue.clear()
        $.clock.after(500, () => void (async () => {
          for (const u of urls) await followUpSlack($, u, true)
        })())
      }
      if (mcpHealPending.size) {
        const tools = [...mcpHealPending]
        mcpHealPending.clear()
        void (async () => {
          for (const t of tools) await healMcpTool($, t)
        })()
      }
      // Awaited: left running, it read $.state after the turn's caller moved on
      // (a test's environment torn down under it).
      await update($, liveA, (l) => (l && l.turnId === e.turnId ? null : l))
      // A grant that came in while this turn ran: continue now it is done.
      if (unblockPending.length) $.clock.after(500, () => flushUnblocked($))
      // An answered turn ends the streak: the next failure starts fresh.
      if (e.reason === 'answer') await update($, resumeA, () => null)
    }
    const result = await next(e)
    if (e.agentId) {
      // A subagent's own turn: close its graph node.
      await update($, agentsA, (as) =>
        as.map((a) =>
          a.id === e.agentId
            ? {
                ...a,
                status: e.isAborted ? ('killed' as const) : e.reason === 'error' ? ('failed' as const) : ('completed' as const),
                endedAt: Date.now(),
                answer: clip(e.answer ?? '', 2000),
                tokens: e.usage ? e.usage.input_tokens + e.usage.output_tokens : a.tokens,
              }
            : a,
        ),
      )
      await publishAgents($)
      // Its decisions and findings go to Chat under the main turn that spawned
      // it (a Workflow's agents: under the run's turn), labelled with the agent.
      const node = ((await read($, agentsA)) as AgentNode[]).find((a) => a.id === e.agentId)
      if (node && e.answer && !e.isAborted) {
        const run = node.runId ? ((await read($, agentsA)) as AgentNode[]).find((a) => a.kind === 'workflow' && a.runId === node.runId) : undefined
        const turnId = node.turnId ?? run?.turnId ?? currentTurn
        const add = agentFlow(e.answer, turnId, Date.now(), node.description || node.type, run ? run.description : undefined)
        if (add.length) await update($, flowA, (fs) => [...fs, ...add].slice(-FLOW_CAP))
      }
      return result
    }
    const now = Date.now()
    if (quietTurn && quietTurn.turnId === e.turnId) {
      const q = quietTurn
      quietTurn = undefined
      const answer = e.answer ?? ''
      const mattered = !e.isAborted && turnMattered(q.weight, q.wrote, answer)
      const outcome = clip(firstLine(answer), 160)
      await update($, monitorsA, (ms) =>
        ms.map((m: MonitorState) => (m.taskId === q.taskId ? { ...m, outcome, mattered, quiet: m.quiet + (mattered ? 0 : 1), acted: m.acted + (mattered ? 1 : 0) } : m)),
      )
      if (!mattered) {
        if (answer) quietFinal.set(answer.trim().slice(0, 120), outcome)
        void addOutputs($, textOutputs(answer, now).map((o) => ({ ...o, turnId: e.turnId })))
        await publish($, 'done', 'none')
        $.ui.invalidate('ui.render')
        return result
      }
      // It mattered: unfold what was folded while it ran, and give the flow
      // one entry naming the watch instead of the whole check-in.
      for (const id of q.tools) quietTools.delete(id)
      for (const t of q.texts) quietTexts.splice(quietTexts.indexOf(t), 1)
      shownEvents.add(eventKey(q.taskId, q.event))
      const m = ((await read($, monitorsA)) as MonitorState[]).find((x) => x.taskId === q.taskId)
      await update($, flowA, (fs) => [...fs, { at: now, turnId: e.turnId, kind: 'finding' as const, text: 'watch · ' + (m?.summary ?? '') + ' — ' + (m?.label ?? '') + (outcome ? ' → ' + outcome : '') }].slice(-FLOW_CAP))
      $.ui.invalidate('ui.render')
      const att = await bridge($, 'attention', { message: answer })
      const attention: Attention = att.attention === 'ask' || att.attention === 'action' ? att.attention : 'none'
      await publish($, attention === 'none' ? 'done' : 'waiting', attention)
      return result
    }
    await update($, turnsA, (ts) => ts.map((t) => (t.turnId === e.turnId ? { ...t, endedAt: now } : t)))
    if (e.answer) {
      await update($, flowA, (fs) => [...fs, ...flowOf(e.answer, e.turnId, now)].slice(-FLOW_CAP))
      await update($, answersA, (a) => capAnswers({ ...a, [e.turnId]: e.answer }))
      void addOutputs($, textOutputs(e.answer, now).map((o) => ({ ...o, turnId: e.turnId })))
      void namedFiles($, e.answer, now).then((fs) => addOutputs($, [...fs, ...expFromAnswer(e.answer, now)].map((o) => ({ ...o, turnId: e.turnId }))))
    }
    void loadUsage($)
    loadGoalSoon($, [3_000, 15_000])
    // ask/action/none from the same Jev classifier the Stop hook used.
    // With auto_continue on, the same Jev call also says whether the question is only "go on?".
    const autoOn = ((await read($, policyA)) as Policy | null)?.caps.auto_continue === 'allow'
    const att = e.isAborted ? { attention: 'none' } : await bridge($, 'attention', { message: e.answer ?? '', proceed: autoOn })
    const attention: Attention = att.attention === 'ask' || att.attention === 'action' ? att.attention : 'none'
    if (autoOn && att.proceed === true && !e.isAborted && (await proceedFor($, e.turnId, e.answer ?? ''))) {
      void exportOutputs($)
      return result
    }
    await publish($, attention === 'none' ? 'done' : 'waiting', attention)
    idleTimer = $.clock.after(IDLE_MS, () => {
      // 💤: done and untouched for 30 minutes. Keeps ask/action as they were.
      if (attention === 'none') void publish($, 'waiting', 'none')
    })
    void exportOutputs($)
    return result
  })

  // Text the quiet turn writes between tool calls, so its rows can fold.
  // Observed as rows are kept (session.append), not by wrapping the model's
  // stream: turn.step streams and a hook there sits on every response.
  on('session.append', { door: 'response' }, async ($: any, e: any, next: any) => {
    if (quietTurn && !e.agentId && e.message?.type === 'assistant') {
      const content = e.message.content
      const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')) : []
      for (const t of blocks.filter((x: string) => x.trim())) {
        quietTurn.texts.push(t)
        quietTexts.push(t)
      }
      if (quietTexts.length > 400) quietTexts.splice(0, quietTexts.length - 400)
    }
    return next(e)
  })

  // An MCP call that failed because its server dropped: reconnect that one
  // server when the turn ends.
  on('tool.call', { tool: /^mcp__/ }, async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (mcpHealEnabled && isMcpTool(e.tool) && (r?.isError || r?.deny) && looksDisconnected(r)) mcpHealPending.add(e.tool)
    return r
  })

  // Browser automation: Bash `tweb …` and tweb MCP tools, for the Web tab.
  on('tool.call', { tool: /^(Bash$|mcp__[^_]*tweb)/i }, async ($: any, e: any, next: any) => {
    const steps = e.tool === 'Bash' ? twebSteps(String(e.command ?? e.input?.command ?? '')) : [twebMcpStep(String(e.tool), e.input ?? e)].filter((x): x is NonNullable<typeof x> => !!x)
    if (!steps.length) return next(e)
    const base = String(e.tool_use_id ?? Date.now())
    for (const [i, st] of steps.entries()) await autoStart($, base + ':' + i, st)
    let ok = false
    try {
      const r = await next(e)
      ok = !(r?.isError || r?.deny)
      return r
    } finally {
      for (let i = 0; i < steps.length; i++) await autoEnd($, base + ':' + i, ok)
    }
  })

  on('tool.call', async ($: any, e: any, next: any) => {
    if (quietTurn && !e.agentId) {
      if (e.tool_use_id) {
        quietTurn.tools.push(e.tool_use_id)
        quietTools.add(e.tool_use_id)
      }
      if (isWrite(e.tool, e)) quietTurn.wrote = true
    }
    return next(e)
  })

  on('session.measure', async ($: any, e: any, next: any) => {
    const pct = e.context?.percent
    if (typeof pct === 'number') await publish($, undefined, null, { '@cc_ctx': String(Math.round(pct)) })
    return next(e)
  })

  // ---- subagents and background work ----
  on('agent.spawn', async ($: any, e: any, next: any) => {
    const result = await next(e)
    if (result.deny) return result
    // A workflow's agents hang under their run's node, made here if the
    // Workflow call's result has not landed yet (its agents can start first).
    let parentId = e.parentAgentId
    if (e.workflow?.runId) {
      const runNode = 'wf:' + e.workflow.runId
      const as = (await read($, agentsA)) as AgentNode[]
      if (!as.some((a) => a.id === runNode)) {
        await update($, agentsA, (xs) => [...xs, workflowNode(runNode, e.workflow.runId, e.tool_use_id, e.parentAgentId, undefined, 'workflow')].slice(-200))
      }
      parentId = runNode
    }
    const node: AgentNode = {
      id: result.agentId ?? e.tool_use_id,
      toolUseId: e.tool_use_id,
      parentId,
      turnId: currentTurn,
      type: e.isTeammate ? 'teammate' : e.workflow ? (e.subagentType || 'agent') + ' #' + e.workflow.agentIndex : e.subagentType || 'agent',
      description: e.description || clip(e.prompt, 60),
      prompt: clip(e.prompt, 4000),
      status: 'running',
      startedAt: Date.now(),
      tools: 0,
      kind: 'agent',
    }
    await update($, agentsA, (as) => [...as, node].slice(-200))
    await publishAgents($)
    return result
  })

  // ---- tool calls: policy self-grant, auth pre-check, gh account, outputs ----
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    const command = String(e.command ?? '')
    const grant = isSelfGrant(command)
    if (grant) {
      return {
        deny:
          grant +
          ' changes a safety gate, and only the user may do that. Do not run it or a variant of it. ' +
          'Tell the user what you need and that they can grant it by typing /policy themselves (for example `/policy allow merge owner/repo 15m`). ' +
          'Do not suggest running the script with `!` either: that path bypasses the timed, scoped grant.',
      }
    }
    const cred = credentialFor(command)
    if (cred && interactive) {
      const items = (await read($, authA)) as AuthItem[]
      const item = items.find((i) => i.id === cred)
      if (item && item.state === 'expired') {
        let answer = 'cancel'
        try {
          answer = await $.ui.ask(item.label + ' has expired; this command will fail.\n' + clip(command, 200), ['log in, then run', 'run anyway', 'cancel'])
        } catch {
          answer = 'cancel'
        }
        if (answer === 'log in, then run' && item.fix) {
          try {
            await $.process.run(item.fix, { timeoutMs: 300_000 })
          } catch {
            // login window closed: fall through to re-check
          }
          await runRadar($, true)
        } else if (answer === 'cancel') {
          return { deny: item.label + ' is expired and the user declined to log in now. Tell the user to run: ' + (item.fix ?? []).join(' ') }
        }
      }
    }
    // gh: run as the account that owns the target repo, without touching the
    // global active account other sessions rely on.
    let call = e
    if (/^\s*(\w+=\S+\s+)*gh\s/.test(command) && !/\bGH_TOKEN=/.test(command) && !/\bgh\s+auth\b/.test(command)) {
      const target = repoFromGh(command) ?? repo
      const acct = ghAccountFor(target)
      // An owner org.json maps to a login runs as that login; any other runs
      // as gh's active account. The active one needs no token, but which it is
      // is not known here, so a mapped owner always gets one.
      if (acct) {
        call = { ...e, command: 'GH_TOKEN="$(gh auth token --user ' + acct + ')" ' + command }
      }
    }
    const result = await approveGuard($, e, await next(call), () => next(call))
    let resultText = ''
    try {
      resultText = JSON.stringify(result) ?? ''
    } catch {}
    // Coder state is learned from real work, not periodic network probes. A
    // timeout stays unknown; only an explicit authentication error needs login.
    if (cred?.startsWith('coder:') && /(?:401|unauthenticated|authentication required|not logged in|session token[^\n"]*(?:invalid|expired))/i.test(resultText)) {
      const radar = ((await read($, authA)) as AuthItem[]).map((i) => i.id === cred ? { ...i, state: 'expired' as const, detail: 'login required' } : i)
      await $.store.set(K.radar, { at: Date.now(), items: radar })
      await update($, authA, () => radar)
    }
    // Only a refusal: the guard's deny. A command that ran and merely printed
    // the words (a grep over transcripts) is not a block — it was resumed as
    // one, a read-only script "continued" after an unrelated grant.
    const denied = typeof result?.deny === 'string' ? result.deny : ''
    const blocked = /BLOCKED by session policy/.test(denied) ? hintsFromBlock(denied) : []
    await noteBlock($, denied, clip(command.replace(/\s+/g, ' '), 200))
    const add = [...hintsFromCommand(command, repoFromGh), ...blocked]
    if (add.length) await update($, hintsA, (hs) => [...hs, ...add].slice(-200))
    if (blocked.length && interactive) $.ui.toast('Blocked by session policy: the Policy tab (5) grants ' + blocked[0]!.scope + ' with one press')
    void addOutputs($, [...toolOutputs('Bash', e, result, Date.now()), ...(result?.deny ? [] : expFromTool('Bash', e, Date.now()))].map((o) => ({ ...o, turnId: currentTurn, agentId: e.agentId })))
    if (result?.result?.backgroundTaskId) {
      const node: AgentNode = {
        id: 'bg:' + result.result.backgroundTaskId,
        toolUseId: e.tool_use_id,
        parentId: e.agentId,
        turnId: currentTurn,
        type: 'bg',
        description: clip(String(e.description ?? command), 60),
        prompt: clip(command, 1000),
        status: 'background',
        startedAt: Date.now(),
        tools: 0,
        kind: 'bg',
      }
      await update($, agentsA, (as) => [...as, node].slice(-200))
    }
    await countTool($, 'Bash', e.agentId)
    return result
  }).catch(async ($: any, e: any, next: any) => {
    // Fail closed only for the one thing this hook must never let through: a
    // self-grant. Anything else falls back to running the call as-is.
    if (next.called) return next(e)
    const grant = isSelfGrant(String(e.command ?? ''))
    return grant ? { deny: grant + ' changes a safety gate; only the user may run it.' } : next(e)
  })

  on('tool.call', { tool: /^(?!Bash$|AskUserQuestion$)/ }, async ($: any, e: any, next: any) => {
    const result = await approveGuard($, e, await next(e), () => next(e))
    void addOutputs($, [...toolOutputs(e.tool, e, result, Date.now()), ...(result?.deny ? [] : expFromTool(e.tool, e, Date.now()))].map((o) => ({ ...o, turnId: currentTurn, agentId: e.agentId })))
    // A Slack send to a target outside the allow list is a candidate for it
    // (the guard asked or denied); the review channel never needs one.
    if (typeof result?.deny === 'string') await noteBlock($, result.deny, e.tool + (typeof e.channel_id === 'string' ? ' → ' + e.channel_id : ''))
    if (/slack_(send_message|send_message_draft|schedule_message)$/.test(e.tool) && typeof e.channel_id === 'string' && e.channel_id) {
      const hint = { cap: 'slack_send' as Cap, scope: e.channel_id.toUpperCase(), why: result?.deny ? ('blocked' as const) : ('used' as const) }
      await update($, hintsA, (hs) => [...hs, hint].slice(-200))
    }
    // A Workflow run: one node, its agents under it (agent.spawn), closed by
    // the run's task notification.
    if (e.tool === 'Workflow' && !result?.deny) {
      const r = result?.result ?? {}
      const meta = workflowMeta(typeof e.script === 'string' ? e.script : undefined)
      const title = String(r.workflowName ?? meta.name ?? e.name ?? 'workflow') + (meta.description ? ' — ' + meta.description : '')
      const runId = typeof r.runId === 'string' ? r.runId : undefined
      const id = runId ? 'wf:' + runId : 'wf-task:' + (r.taskId ?? e.tool_use_id)
      await update($, agentsA, (as) => {
        const have = as.find((a) => a.id === id)
        const node = { ...workflowNode(id, runId, e.tool_use_id, e.agentId, r.taskId, title), ...(have ? { startedAt: have.startedAt } : {}) }
        return have ? as.map((a) => (a.id === id ? { ...a, ...node, status: a.status } : a)) : [...as, node].slice(-200)
      })
      await publishAgents($)
    }
    if (e.tool === 'Monitor' && !result?.deny && !result?.isError) {
      // The Watch card has the watch from its start, not from its first
      // event; the input is kept so an expiry can re-arm it without a turn.
      const taskId = startedTaskId(result)
      const input = watchInput(e)
      const from = rearmingFrom
      if (taskId) {
        await update($, monitorsA, (ms: MonitorState[]) => {
          const prev = from ? ms.find((m) => m.taskId === from) : undefined
          const row: MonitorState = prev
            ? { ...prev, taskId, firstTaskId: prev.firstTaskId ?? prev.taskId, input: input ?? prev.input, armedAt: Date.now(), rearms: (prev.rearms ?? 0) + 1 }
            : { taskId, firstTaskId: taskId, summary: String(e.description ?? 'monitor'), last: '', label: 'armed', at: Date.now(), quiet: 0, acted: 0, input, armedAt: Date.now(), rearms: 0 }
          return [...ms.filter((m) => m.taskId !== taskId && m.taskId !== from), row].slice(-20)
        })
      }
    }
    if (e.tool === 'Monitor' && !result?.deny) {
      await update($, agentsA, (as) =>
        [
          ...as,
          {
            id: 'mon:' + e.tool_use_id,
            toolUseId: e.tool_use_id,
            parentId: e.agentId,
            turnId: currentTurn,
            type: 'monitor',
            description: clip(String(e.description ?? 'monitor'), 60),
            prompt: clip(String(e.command ?? ''), 1000),
            status: 'background' as const,
            startedAt: Date.now(),
            tools: 0,
            kind: 'bg' as const,
          },
        ].slice(-200),
      )
    }
    await countTool($, e.tool, e.agentId)
    return result
  })

  // A background task or Monitor finished: the harness tells the session with
  // a task notification. Close the matching graph node.
  on('session.receive', { origin: { kind: 'task-notification' } }, async ($: any, e: any, next: any) => {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(e.text)?.[1]
    const status = /<status>([^<]+)<\/status>/.exec(e.text)?.[1] ?? 'completed'
    if (id) {
      await update($, agentsA, (as) =>
        as.map((a) =>
          a.id === 'bg:' + id || a.id === 'mon:' + id || (a.kind === 'workflow' && a.taskId === id) || (a.kind === 'bg' && a.toolUseId && e.text.includes(a.toolUseId))
            ? { ...a, status: /fail|error|kill/.test(status) ? ('failed' as const) : ('completed' as const), endedAt: Date.now() }
            : a,
        ),
      )
      await publishAgents($)
    }
    return next(e)
  })

  // The person answered a question: the session is working again.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($: any, e: any, next: any) => {
    const result = await next(e)
    await publish($, 'working', 'none')
    return result
  })

  // A permission prompt is about to be shown: that is ❗ in tmux, now, not
  // when a Notification eventually fires.
  on('tool.check', async ($: any, e: any, next: any) => {
    const decided = await next(e)
    if (decided?.decision === 'ask' && !e.agentId) await publish($, 'waiting', 'action')
    return decided
  })

  // A question to the user is ❓ the moment it is drawn.
  on('ui.render', { component: 'AskUserQuestion' }, async ($: any, e: any, next: any) => {
    void publish($, 'waiting', 'ask')
    return next(e)
  })

  // TaskStop for a held watch: the engine no longer knows the task (its
  // Monitor expired), so the cockpit stops it. The model may name the id its
  // own Monitor call returned, or the held one from an event.
  on('tool.call', { tool: 'TaskStop' }, async ($: any, e: any, next: any) => {
    const asked = String(e.task_id ?? e.shell_id ?? '')
    const m = asked ? ((await read($, monitorsA)) as MonitorState[]).find((x) => x.held && (x.taskId === asked || x.firstTaskId === asked || x.held.from === asked)) : undefined
    if (!m) return next(e)
    holds.get(m.taskId)?.stop('stopped')
    await update($, monitorsA, (ms: MonitorState[]) => ms.filter((x) => x.taskId !== m.taskId))
    $.ui.invalidate('ui.render')
    return { result: { message: 'Stopped the watch "' + m.summary + '" (held by the cockpit as ' + m.taskId + ')', task_id: m.taskId, task_type: 'local_bash' } }
  })

  // A long watch expired: start it again here and keep the notice out of the
  // conversation (see lib/monitor.ts, LONG_WATCH_MS). Dropped before `next`,
  // so the settings hook that used to tell the model to re-arm never runs for
  // it either. Anything this cannot re-arm (an unknown task, a short deadline,
  // the cap reached, the call refused) reaches the model as before.
  on('prompt.submit', { origin: { kind: 'task-notification' } }, async ($: any, e: any, next: any) => {
    const exp = parseExpiry(String(e.text ?? ''))
    if (!exp) return next(e)
    const m = ((await read($, monitorsA)) as MonitorState[]).find((x) => x.taskId === exp.taskId)
    if (!shouldRearm(m)) return next(e)
    if (m.input.command) {
      // Taken over rather than re-armed: this is the watch's last visible row.
      const now = await clockNow($)
      const id = HELD_PREFIX + m.taskId
      const until = holdDeadline(m, now)
      await update($, monitorsA, (ms: MonitorState[]) => [
        ...ms.filter((x) => x.taskId !== m.taskId && x.taskId !== id),
        { ...m, taskId: id, firstTaskId: m.firstTaskId ?? m.taskId, armedAt: now, held: { from: m.taskId, since: now, until } },
      ])
      holdWatch($, id, m.input, m.summary, until, now)
      $.ui.invalidate('ui.render')
      return { drop: '↻ watch held by the cockpit · ' + clip(m.summary, 60) + ' · ' + id + ' · no more expiry notes' }
    }
    rearmingFrom = m.taskId
    let started: string | undefined
    try {
      const r: any = await $.tool.call({ tool: 'Monitor', ...m.input })
      started = r?.deny || r?.isError ? undefined : startedTaskId(r)
    } catch {
      started = undefined
    } finally {
      rearmingFrom = undefined
    }
    if (!started) return next(e)
    $.ui.invalidate('ui.render')
    return { drop: '↻ watch re-armed · ' + clip(m.summary, 60) + ' · ' + started }
  })

  // ---- prompts: slash-command typeahead, fork offer, policy section ----
  on('prompt.edit', { origin: { kind: 'composer' } }, async ($: any, e: any, next: any) => {
    const r = await next(e)
    await setSlashCockpit($, slashToken(r.text))
    return r
  })

  // A plugin fill passes through its own chain before prompt.change. Observe
  // the text the chain actually landed, so it hides before autocomplete draws.
  on('prompt.fill', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (r.isFilled) await setSlashCockpit($, slashToken(e.text))
    return r
  })

  // History, undo and accepting a completion change the draft without
  // prompt.edit. Restore/hide from the resulting box too.
  on('prompt.change', async ($: any, e: any, next: any) => {
    await setSlashCockpit($, slashToken(e.text))
    return next(e)
  })

  // A fill/paste can ask autocomplete before prompt.change. It is a second,
  // idempotent signal to hide before the rows draw.
  on('prompt.autocomplete', { token: /^\// }, async ($: any, e: any, next: any) => {
    await setSlashCockpit($, slashToken(e.text))
    return next(e)
  })

  on('prompt.submit', async ($: any, e: any, next: any) => {
    if (e.origin?.kind === 'composer') await setSlashCockpit($, false)
    // A prompt the person types takes over from a resume we would have sent.
    if (e.origin?.kind === 'composer' && !String(e.text ?? '').startsWith('/')) unblockPending = []
    // The person answered (or asked something else): ours is not needed, and
    // the run of answers in their place ends.
    if (e.origin?.kind === 'composer' && e.text !== PROCEED_REPLY) {
      proceedTimer?.cancel()
      proceedTimer = undefined
      proceedStreak = 0
    }
    if (e.origin?.kind === 'composer' && !e.text.startsWith('<')) pendingHuman = e.text
    // A prompt to Claude takes the person's attention to the chat; a slash
    // command (/web, /reload-plugins) does not.
    if (e.origin?.kind === 'composer' && !String(e.text ?? '').startsWith('/')) void update($, uiA, (u) => ({ ...u, promptAt: Date.now() }))
    if (/^\/goal\b/.test(String(e.text ?? ''))) loadGoalSoon($, [1_000, 4_000])
    // A Slack thread pasted into a prompt is what the work is about: keep it
    // reachable from the cockpit (Outputs › Slack, the Now tab).
    const pasted = slackOutputs(String(e.text ?? ''), Date.now())
    if (pasted.length) void addOutputs($, pasted.map((o) => ({ ...o, detail: 'from your prompt', turnId: currentTurn })))
    // A PR the person pastes is one they want followed.
    const handed = prOutputs(String(e.text ?? ''), Date.now(), 'from your prompt')
    if (handed.length) void addOutputs($, handed.map((o) => ({ ...o, turnId: currentTurn })))
    // A ticket the person names is this session's.
    if (e.origin?.kind === 'composer') {
      const named = ticketOutputs(String(e.text ?? ''), Date.now(), 'from your prompt')
      if (named.length) void addOutputs($, named.map((o) => ({ ...o, turnId: currentTurn })))
    }
    // An offer the person has typed past a few times is history: drop it.
    if (e.origin?.kind === 'composer' && !String(e.text ?? '').startsWith('/'))
      await update($, forkA, (f) => (f && f.prompt !== e.text ? (f.later + 1 >= FORK_STALE_AFTER ? null : { ...f, later: f.later + 1 }) : f))
    // An alert thread the person pasted starts RCA mode. Only their own typing
    // does: a prompt Claude or a plugin submits never grants anything.
    if (pasted.length && e.origin?.kind === 'composer' && interactive) {
      const prefs = ((await $.store.get(K.cockpitSettings)) ?? {}) as { rcaAuto?: boolean }
      if (prefs.rcaAuto !== false) {
        const alert = await Promise.race([detectAlert($, pasted), new Promise<undefined>((r) => $.clock.after(5_000, () => r(undefined)))])
        if (alert) await startRca($, alert)
      }
    }
    if (e.origin?.kind !== 'composer' || !isPaneId(pane) || e.text.length < 15 || e.text.startsWith('/')) return next(e)
    const turns = (await read($, turnsA)) as TurnRecord[]
    const flow = (await read($, flowA)) as FlowEntry[]
    if (turns.length < 1) return next(e)
    // Judge in the background; the prompt goes through now. If it is a
    // separate line of work, the band offers a fork for the next decision.
    const recent = turns.slice(-3).map((t) => t.text)
    const answer = flow.filter((f) => f.kind === 'conclusion').slice(-1)[0]?.text ?? ''
    void bridge($, 'fork', { prompt: e.text, recent, answer }).then(async (r: any) => {
      if (typeof r.p === 'number' && r.p >= (r.threshold ?? 0.6)) await update($, forkA, () => ({ prompt: e.text, p: r.p, at: Date.now(), later: 0 }))
    })
    return next(e)
  })

  // Session policy reaches Claude once, in the system prompt, instead of as
  // additionalContext on every prompt. Lives in the `session` scope so a
  // policy change does not invalidate the shared cache prefix.
  on('prompt.compose', async ($: any, e: any, next: any) => {
    const r = await next(e)
    const p = (await read($, policyA)) as Policy | null
    if (!p) return r
    const caps = Object.entries(p.caps)
      .map(([k, v]) => k + '=' + v)
      .join(', ')
    const scopes = Object.entries(p.scopes)
      .map(([k, v]) => k + ' scoped-allow: ' + (v as string[]).join(', '))
      .join('; ')
    const rca = (await read($, rcaA)) as RcaState
    const moved = (await read($, movedA)) as { prompt: string; pane: string }[]
    const text =
      (rca ? rcaSection(rca) + '\n\n' : '') +
      (moved.length ? movedSection(moved) + '\n\n' : '') +
      '# Session policy (' + p.mode + ')\n' + caps + (scopes ? '\n' + scopes : '') +
      (p.caps.auto_continue === 'allow' ? '\n' + PROCEED_POLICY : '') +
      '\nOnly the user changes this policy, with /policy. Never run session_policy.py or *_unlock.py to change it yourself; if a gate blocks you, say what you need and stop.'
    return { sections: [...r.sections, { id: P + ':policy', text, scope: 'session' }] }
  })

  // ---- autocomplete ----
  on('prompt.autocomplete', async ($: any, e: any, next: any) => {
    const mine = suggest(e.token, e.text.slice(0, e.cursor), sources)
    if (mine.length === 0) return next(e)
    const r = await next(e)
    return { suggestions: [...(r?.suggestions ?? []), ...mine] }
  })

  // ---- commands ----
  on('command.run', { command: ['flow', 'graph', 'side', 'outputs', 'watch'] }, async ($: any, e: any) => {
    const id = e.command as PaneId | 'watch'
    await backfillSession($, true)
    if (id === 'side' && e.args.trim()) {
      void sideAsk($, e.args.trim())
      return openCockpit($, 'side', e.presentation.columns, e.presentation.isFullscreen, false)
    }
    if (id === 'outputs' && e.args.trim()) {
      await update($, uiA, (u) => ({ ...u, outTab: e.args.trim() }))
      return openCockpit($, 'outputs', e.presentation.columns, e.presentation.isFullscreen, false)
    }
    return openCockpit($, id, e.presentation.columns, e.presentation.isFullscreen)
  })

  on('command.run', { command: 'policy' }, async ($: any, e: any) => {
    // Only a person's own command changes policy. A prompt Claude or another
    // plugin submitted arrives with a different origin and is refused.
    const fromPerson = e.origin?.kind === 'composer'
    const cmd = parsePolicyArgs(e.args)
    if ('error' in cmd) return { text: cmd.error }
    if (cmd.argv[0] === 'show' && !e.args.trim()) return openCockpit($, 'policy', e.presentation.columns, e.presentation.isFullscreen)
    if (cmd.argv[0] !== 'show' && !fromPerson) return { text: 'Policy changes only through /policy typed by a person.' }
    const resolved = await resolvePolicyArgv($, cmd.argv, cmd.revert)
    if ('error' in resolved) return { text: resolved.error }
    const r = cmd.argv[0] === 'show' ? await runPolicy($, ['show']) : await applyPolicy($, resolved.argv, cmd.ttlMs, resolved.revert)
    const p = await loadPolicy($)
    return { text: (r.ok ? '' : 'failed: ') + badge(p) + (cmd.ttlMs ? ' · reverts in ' + Math.round(cmd.ttlMs / 60000) + 'm' : '') }
  })

  on('command.run', { command: 'web' }, async ($: any, e: any) => {
    const args = e.args.trim()
    if (args === 'close') {
      await stopWeb($)
      return { text: 'Web tab stopped.' }
    }
    if (!args) return openCockpit($, 'web', e.presentation.columns, e.presentation.isFullscreen, false)
    // `/web --chrome|--electron|--webkit|--tauri <url>` picks the engine for this page.
    const flag = /^--(\w+)\s+/.exec(args)
    const engine = flag ? parseEngine(flag[1]) : undefined
    if (flag && !engine) return { text: 'Unknown engine --' + flag[1] + '. Use --electron, --chrome or --webkit.' }
    let url = flag ? args.slice(flag[0].length) : args
    if (!/^[a-z][\w+.-]*:/i.test(url)) url = 'https://' + url
    const err = await openWeb($, url, engine)
    return { text: err || 'Opening ' + url + (embedOn ? ' in the Web tab (6).' : ' in a TWeb pane beside this one.') }
  })

  // The office: every session in tmux as a character in a quarter-view
  // office, with a quick-action card per session (office/office.py). The
  // server is shared by all sessions and outlives this one; started here when
  // nothing answers on its port.
  on('command.run', { command: 'office' }, async ($: any) => {
    const url = 'http://127.0.0.1:' + OFFICE_PORT + '/'
    const up = async () => (await $.process.run(['/usr/bin/curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '2', url], { timeoutMs: 4000 }).catch(() => ({ stdout: '' }))).stdout.trim() === '200'
    // A server started from older code than is on disk is restarted: the page
    // is read fresh on every request, so a new page against an old server
    // asks for routes it does not have (live: resources.js 404, an empty
    // office). The stamp is office.py's code_stamp(); an old server has no
    // /version and answers 404, which also counts as old.
    const want = (await Promise.all(['office.py', 'resources.py'].map((n) => $.fs.stat($.plugin.root + '/office/' + n).then((st: any) => n + ':' + Math.floor((st?.mtimeMs ?? 0) / 1000)).catch(() => n + ':?')))).join(',')
    const ver = (await $.process.run(['/usr/bin/curl', '-s', '-m', '2', url + 'version'], { timeoutMs: 4000 }).catch(() => ({ stdout: '' }))).stdout
    let running: { stamp?: string; pid?: number } | undefined
    try { running = JSON.parse(ver) } catch { running = undefined }
    if ((await up()) && running?.stamp !== want) {
      const pid = running?.pid
      // Without /version the old server's pid is found by its port.
      // Only a process running office.py is stopped, whatever holds the port.
      const script = pid ? 'p="$0"' : 'p=$(lsof -tiTCP:"$0" -sTCP:LISTEN | head -1)'
      await $.process.run(['sh', '-c', script + '; [ -n "$p" ] && ps -o command= -p "$p" | grep -q "office/office.py" && kill "$p"; true', String(pid ?? OFFICE_PORT)], { timeoutMs: 4000 }).catch(() => undefined)
      await $.process.run(['sh', '-c', 'for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null -m 1 "$0" || exit 0; sleep 0.3; done', url], { timeoutMs: 6000 }).catch(() => undefined)
    }
    if (!(await up())) {
      // Started detached, then given a moment (the sleep) to bind before the check.
      await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$2")"; nohup python3 "$0" --port "$1" >"$2" 2>&1 & sleep 1.5', $.plugin.root + '/office/office.py', String(OFFICE_PORT), home + '/.claude/state/office/server.log'], { timeoutMs: 6000 })
    }
    if (!(await up())) return { text: 'The office server did not start; see ~/.claude/state/office/server.log' }
    const err = await openWeb($, url, 'electron')
    return { text: err || 'Opening the office (' + url + ') beside this one.' }
  })

  // Pointer and keys over the Web tab's region, from views/web-region.ts.
  on('ui.message', { element: 'web-region' }, async ($: any, e: any, next: any) => {
    const d = e.data as PointerMsg | KeyMsg
    // Clicking and typing in the page is using the cockpit (see noteCockpitUse).
    if (d?.t === 'k' || (d?.t === 'p' && d.type === 'down')) {
      noteCockpitUse($)
      webFocusPending = false
      await setWebKeyboard($, 'page')
    }
    const bytes = d?.t === 'p' ? sgrMouse(d) : d?.t === 'k' ? keyBytes(d) : undefined
    if (bytes) void webCall($, '/input', { hex: toHex(bytes) })
    return next(e)
  })

  // The wheel over the region scrolls the page, not the cockpit: the region
  // starts at the Web tab's body row WEB_TOP (status bar, tab row, rule, header).
  on('ui.scroll', { requestId: COCKPIT }, async ($: any, e: any, next: any) => {
    const ui = (await read($, uiA)) as any
    const w = (await read($, webA)) as WebState
    const tab = tabOf(ui.view)
    // An arrow key (a one-line scroll with no pointer; the wheel has one)
    // moves the ring to the row above or below by layout, and scrolls only
    // when there is nothing that way. The engine's own order is one line, so
    // down on the Policy tab used to land on the element to the right.
    if (e.origin?.kind === 'person' && !e.pointer && Math.abs(e.by) === 1) {
      const bodyRows = Math.max(3, (e.bodyRows ?? 30) - FRAME_TOP - FRAME_BOTTOM)
      await navMove($, e.by > 0 ? 'down' : 'up', tab, bodyRows)
      return next({ ...e, offset: SPACER_ROWS })
    }
    // A plugin's scroll (the pin below) or anything else that would move the
    // engine's window lands back on the pinned row.
    if (e.origin?.kind !== 'person') return next({ ...e, offset: SPACER_ROWS })
    if (tab !== 'web') {
      // The cockpit scrolls its own body under the fixed header, up to where the
      // last drawing said the body ends (views/home.ts treeRows).
      const cur = bodyScroll.get(tab) ?? 0
      const by = e.by === e.contentRows ? 1e9 : e.by === -e.contentRows ? -1e9 : e.by
      bodyScroll.set(tab, Math.max(0, Math.min(bodyMax.get(tab) ?? 400, cur + by)))
      $.ui.invalidate('ui.render')
      return next({ ...e, offset: SPACER_ROWS })
    }
    // The Web tab does not scroll: a wheel over the page goes to the page,
    // anything else leaves the window pinned.
    if (!w.running || !e.pointer) return next({ ...e, offset: SPACER_ROWS })
    // WEB_TOP rows of status, tabs and page header, then the page.
    const ws = (await read($, webSettingsA)) as WebSettings
    const row = e.pointer.row - WEB_TOP - (ws.open ? WEB_SETTINGS_ROWS : 0)
    if (row < 0) return next({ ...e, offset: SPACER_ROWS })
    const ticks = Math.min(10, Math.abs(e.by))
    let seq = ''
    for (let i = 0; i < ticks; i++) seq += sgrWheel(e.by < 0, e.pointer.column, row)
    void webCall($, '/input', { hex: toHex(seq) })
    return {}
  })

  // Each main step of a turn whose prompt Jev judged: its effort (and model,
  // when asked) as decided at the first step. Subagents are left as they are.
  on('turn.step', async function* ($: any, e: any, next: any) {
    const job = e.agentId ? undefined : routeJobs.get(e.turnId)
    const now = await clockNow($)
    if (!job) {
      if (!e.agentId) routeLast = { effort: e.effort, model: String(e.model ?? ''), at: now }
      const r = yield* next(e)
      if (!e.agentId) void noteStep($, e.turnId, r)
      return r
    }
    const answer = await Promise.race([job, $.clock.sleep(ROUTE_WAIT_MS).then(() => undefined)])
    const picked = decide(await currentRoute($), answer, e.effort)
    // Light work to the smaller family, by its full id (an alias went out raw).
    // The engine wants env names spelled out; routing only ever picks Sonnet.
    const sonnetEnv = picked.model === 'sonnet' ? ((await $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')) ?? undefined) : undefined
    const model = picked.model ? resolveModel(picked.model, String(e.model ?? ''), sonnetEnv) : undefined
    let ctxTokens: number | undefined
    try {
      ctxTokens = (await $.session.usage()).context?.tokens
    } catch {}
    const d = cacheGate({ ...picked, model }, { stepEffort: e.effort, stepModel: String(e.model ?? ''), last: routeLast, ctxTokens, now })
    if (e.index === 0) await update($, routeA, (r) => ({ ...r, last: { ...d, prompt: clip(lastPrompt, 120), at: Date.now() } }))
    const rewrite = { ...(d.effort ? { effort: d.effort } : {}), ...(d.model && d.model !== e.model ? { model: d.model } : {}) }
    routeLast = { effort: rewrite.effort ?? e.effort, model: rewrite.model ?? String(e.model ?? ''), at: now }
    const r = yield* next(Object.keys(rewrite).length ? { ...e, ...rewrite } : e)
    void noteStep($, e.turnId, r)
    return r
  })

  // /route is shorthand for the auto_effort / auto_model policy rows, and like
  // /policy only a person's own command changes them.
  on('command.run', { command: 'route' }, async ($: any, e: any) => {
    const a = e.args.trim().split(/\s+/).filter(Boolean)
    const fromPerson = e.origin?.kind === 'composer'
    let argv: string[] | undefined
    if (a[0] === 'on' || a[0] === 'off') argv = [a[0] === 'on' ? 'allow' : 'inherit', 'auto_effort']
    else if (a[0] === 'model' && (a[1] === 'on' || a[1] === 'off')) argv = [a[1] === 'on' ? 'allow' : 'inherit', 'auto_model']
    else if (a.length) return { text: 'Use /route on|off, /route model on|off, or /route alone to see it.' }
    if (argv) {
      if (!fromPerson) return { text: 'Routing changes only through /route or /policy typed by a person.' }
      const r = await applyPolicy($, argv)
      if (!r.ok) return { text: 'failed: ' + clip(r.out, 200) }
    }
    const rs = await currentRoute($)
    const last = ((await read($, routeA)) as { last?: RouteDecision }).last
    return { text: 'Auto effort ' + (rs.effort ? 'on' : 'off') + ' · auto model ' + (rs.model ? 'on' : 'off') + ' (session policy) · last: ' + routeLabel(last) }
  })

  on('command.run', { command: 'browser' }, async ($: any, e: any) => {
    if (!isPaneId(pane)) return { text: 'Outside tmux links open in the system browser; there is no pane to set.' }
    const arg = e.args.trim()
    if (arg) {
      const choice = parseBrowser(arg)
      // `/browser tweb open google.com`: a page was wanted, not a setting.
      if (!choice) return { text: 'Unknown browser "' + arg + '". Use tweb, tweb-chrome, tweb-webkit, chrome or inherit.' + (/\s/.test(arg) ? ' To open a page, /web <url>.' : '') }
      browser = choice
      await tmux($, [browserArgv(pane, choice)])
    }
    // Resolved as tmux-chrome's open does, not echoed: with inherit the
    // window or global option may still pick TWeb.
    const target = await webTarget($)
    const label = (BROWSER_LABEL as Record<string, string>)[target] ?? target
    return { text: 'Links open in: ' + label + (browser === 'inherit' ? ' (inherited)' : ' (this session)') }
  })

  on('command.run', { command: 'cockpit' }, async ($: any, e: any) => {
    await backfillSession($, true)
    return openCockpit($, 'home', e.presentation.columns, e.presentation.isFullscreen)
  })

  on('command.run', { command: 'title' }, async ($: any, e: any) => {
    if (!isPaneId(pane)) return { text: 'Outside tmux there is no pane to label.' }
    const label = e.args.trim()
    // @title, not pane_title: Claude Code rewrites pane_title over OSC.
    await tmux($, [label ? ['set', '-p', '-t', pane, '@title', label] : ['set', '-p', '-t', pane, '-u', '@title']])
    return {}
  })

  on('command.run', { command: 'whoami' }, async ($: any) => {
    await shareSession($)
    return {}
  })

  on('command.run', { command: 'yank' }, async ($: any, e: any) => {
    const n = Math.max(1, Number(e.args.trim()) || 1)
    const msgs = ((await $.session.messages()) as { role: string; text: string }[]).filter((m) => m.role === 'assistant' && m.text.trim())
    const text = msgs[msgs.length - n]?.text
    if (!text) return { text: 'No answer to copy.' }
    await $.ui.copy({ text })
    if (isPaneId(pane)) {
      try {
        await $.process.run(['tmux', 'load-buffer', '-'], { stdin: text, timeoutMs: 3000 })
      } catch {
        // clipboard copy already happened; the tmux buffer is a convenience
      }
    }
    $.ui.toast('copied ' + text.length + ' chars')
    return {}
  })

  on('command.run', { command: 'fold' }, async ($: any) => {
    await update($, uiA, (u) => ({ ...u, focus: !u.focus }))
    const ui = (await read($, uiA)) as any
    $.ui.toast(ui.focus ? 'fold: finished tool calls on one line' : 'fold off')
    return {}
  })

  // Focus mode: a finished tool call draws as one dim line. Running and failed
  // calls keep Claude Code's own row, so nothing that needs attention hides.
  on('ui.render', { component: 'ToolUse' }, async ($: any, e: any, next: any) => {
    if (quietTools.has(e.props.tool_use_id) && !e.props.isErrored) return $.ui.resolve(e).Box({ display: 'none', children: [] })
    const ui = (await read($, uiA)) as any
    if (!ui.focus || e.props.isRunning || e.props.isErrored) return next(e)
    const { Text } = $.ui.resolve(e)
    const input = (e.props.input ?? {}) as Record<string, unknown>
    const hint = String(input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.url ?? '')
    return Text({ dimColor: true, wrap: 'truncate-end', children: ['· ' + String(e.props.tool).replace(/^mcp__[^_]+(_[^_]+)*__/, '') + (hint ? '  ' + clip(hint, 100) : '')] })
  })

  on('ui.render', { component: 'ToolResult' }, async ($: any, e: any, next: any) => {
    if (quietTools.has(e.props.tool_use_id) && !e.props.isErrored) return $.ui.resolve(e).Box({ display: 'none', children: [] })
    const ui = (await read($, uiA)) as any
    if (!ui.focus || e.props.isErrored) return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ children: [''] })
  })

  // A Monitor's notification row. Routine events (checks pending/passing,
  // pushes, comments) leave the transcript entirely: their status lives in the
  // cockpit (지금 › 진행, 작업 › 감시) and, while it is closed, one band row.
  // An event that matters, or whose turn turned out to, stays as one line.
  // ctrl+o still shows the engine's full row.
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'task-notification' } } }, watchRow)
  // A held watch's events come in as this plugin's own prompts.
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin' } } }, heldWatchRow)

  // The quiet turn's own text: folded between tool calls, its final answer one
  // muted line under the notification.
  on('ui.render', { component: 'AssistantMessage' }, async ($: any, e: any, next: any) => {
    const head = String(e.props.text ?? '').trim()
    if (!head) return next(e)
    const key = head.slice(0, 120)
    const outcome = quietFinal.get(key)
    const { Text, Box } = $.ui.resolve(e)
    if (outcome !== undefined) return Box({ display: 'none', children: [] })
    if (quietTexts.some((t) => t.includes(head.slice(0, 80)))) return Box({ display: 'none', children: [] })
    return next(e)
  })

  on('command.run', { command: 'rca' }, async ($: any, e: any) => {
    const arg = String(e.args ?? '').trim()
    const cur = (await read($, rcaA)) as RcaState
    if (arg === 'off' || arg === 'end') {
      if (!cur) return { text: 'RCA mode is off.' }
      await endRca($, 'ended by you')
      return {}
    }
    if (!arg && cur) return { text: '🚨 RCA: ' + cur.alert.title + ' · ' + cur.grants.map((g) => g.label).join(', ') + ' · ends ' + new Date(cur.until).toTimeString().slice(0, 5) }
    if (e.origin?.kind !== 'composer') return { text: 'Only a person starts RCA mode.' }
    if (!arg) return { text: await rcaFromSession($) }
    const outs = slackOutputs(arg, Date.now())
    if (!outs.length) return { text: 'Give the Slack link of the alert thread.' }
    const alert = await detectAlert($, outs)
    // Asked for by name: an RCA on a thread that does not read as an alert is still one.
    const [, channel, root] = outs[0]!.id.split(':')
    await startRca($, alert ?? { url: outs[0]!.url!, channel: channel!, ts: root!, title: outs[0]!.title, labels: {} })
    return { text: '🚨 RCA mode on: see the cockpit Now tab.' }
  })

  on('command.run', { command: 'auth' }, async ($: any, e: any) => {
    // `/auth <connector>`: log in to an MCP connector here, as its row's press does.
    const name = String(e.args ?? '').trim()
    if (name) {
      const items = (await read($, authA)) as AuthItem[]
      const hit = items.find((i) => serverOf(i.id) && (i.label.toLowerCase() === 'mcp ' + name.toLowerCase() || serverOf(i.id)!.toLowerCase() === name.toLowerCase()))
      const server = hit ? serverOf(hit.id)! : /^claude\.ai /i.test(name) ? name : 'claude.ai ' + name
      void startMcpLogin($, server)
      await openCockpit($, 'home', e.presentation.columns, e.presentation.isFullscreen, false)
      return { text: 'Logging in to ' + server + ': follow it on the cockpit Now tab.' }
    }
    const items = await runRadar($, true)
    return { text: items.map((i) => (i.state === 'ok' ? '✓' : i.state === 'soon' ? '⏳' : '✗') + ' ' + i.label + (i.detail ? ' (' + i.detail + ')' : '')).join('  ') }
  })

  // Esc on a drilled-in view goes back to home instead of closing. The close
  // is refused with { deny } and the pane reopened with focus, because Esc has
  // already handed the keys back to the prompt — the /diff list/detail
  // pattern. (Returning without next() is not a refusal: live, it closed.)
  // Keep the ring inside the cockpit. Past its first or last element, Tab and
  // the arrows move it onto one of the engine's stops — the close mark or
  // ANOTHER pane's tab — so Left on the first row switched screens. Refuse
  // those moves when the person makes them; ctrl+x x and the commands still
  // close the pane, and ctrl+x tab / Esc still move between it and the prompt.
  on('ui.focus', { requestId: COCKPIT }, async ($: any, e: any, next: any) => {
    // The Web tab's picker is open while the go field or one of its picks
    // holds the ring; anywhere else closes it (and forgets what was typed).
    // Only for the Web tab's own elements and while the picker is open: a focus
    // a page load can request control focus late, and must not touch state.
    const inPicker = e.element === 'web-address' || String(e.element ?? '').startsWith('web-pick-') // web-pick-fold too
    if (e.element && (inPicker || pickerOpen)) {
      pickerOpen = inPicker
      await update($, uiA, (u) => (!!u.webPick === inPicker ? u : { ...u, webPick: inPicker, ...(inPicker ? {} : { webQuery: '' }) })).catch(() => undefined)
    }
    // The palette's arrows: the engine moves the ring off the query field (down
    // to the element after it, up to the one before). Keep it on the field, so
    // typing keeps filtering, and move the selection instead.
    // A focus that lands after the module's session is gone (a page load's
    // late autoFocus) finds no state: treat the palette as closed.
    const helpOpen = !!(await Promise.resolve(read($, helpA)).catch(() => false))
    if (helpOpen && e.origin?.kind === 'person' && e.element && e.element !== 'help-close') {
      await update($, helpA, () => false)
      return { deny: 'Esc closed the key help' }
    }
    const pal = ((await Promise.resolve(read($, paletteA)).catch(() => PALETTE_CLOSED)) ?? PALETTE_CLOSED) as PaletteState
    // Tab is down; the move back (Esc, bound to abovePrompt:previous in a
    // field, or Shift+Tab) closes it and gives the ring back. The arrows
    // reach navMove as scrolls (PaneField binds them to pane:scroll*).
    if (pal.open && e.origin?.kind === 'person' && e.element && e.element !== 'palette-query') {
      const n = paletteShown.length
      if (e.element !== paletteNext) {
        await togglePaletteOpen($)
        return { deny: 'Esc closed the palette' }
      }
      if (n > 0) await update($, paletteA, (p) => ({ ...p, sel: (p.sel + 1) % n }))
      return { deny: 'the palette keeps the keyboard; the arrows move its selection' }
    }
    if (e.origin.kind === 'person' && !e.element) return { deny: 'focus stays in the cockpit' }
    // The hidden letter catchers are drawn first, so Tab from the last
    // element (or the first Tab in) wrapped onto 36 invisible buttons, and
    // Shift+Tab from the first went to the last of them. Land on a real
    // element instead, in the direction the person was going.
    if (e.origin.kind === 'person' && e.element && isHiddenKey(e.element)) {
      const to = skipHidden(navLast.map((i) => i.key), e.element, navFocus, (k) => isHiddenKey(k) || !!navLast.find((i) => i.key === k)?.hidden)
      if (to) {
        const r = await next({ ...e, element: to })
        if (!r?.deny) navFocus = to
        return r
      }
    }
    const r = await next(e)
    if (!r?.deny && e.element) navFocus = isHiddenKey(e.element) ? undefined : e.element
    if (!r?.deny && e.element && e.origin?.kind === 'person' && !isHiddenKey(e.element)) noteCockpitUse($, e.element)
    return r
  })

  // Typing in a cockpit field is using the cockpit (noteCockpitUse).
  on('ui.input', async ($: any, e: any, next: any) => {
    if (e.requestId === COCKPIT && e.element) noteCockpitUse($, e.element)
    return next(e)
  })

  on('ui.close', { id: COCKPIT }, async ($: any, e: any, next: any) => {
    const result = await next(e)
    if (result?.deny === undefined) {
      webFocusPending = false
      await setWebKeyboard($, 'controls')
      await update($, uiA, (u) => ({ ...u, open: false }))
    }
    return result
  })

  // ---- drawing: footer badge ----
  on('ui.render', { component: 'SessionMode' }, async ($: any, e: any, next: any) => {
    const p = (await read($, policyA)) as Policy | null
    if (!p) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, badge(p)] } })
  })

  // ---- drawing: band above the prompt ----
  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
    const auth = (await read($, authA)) as AuthItem[]
    const prs = (await read($, prsA)) as PrStatus[]
    const neighbors = (await read($, neighborsA)) as Neighbor[]
    const fork = (await read($, forkA)) as ForkOffer | null
    const ui = (await read($, uiA)) as any
    // While the cockpit is open the band shows only a fork offer, as text: the
    // cockpit's Now tab asks it. Anything else here duplicates the cockpit, and
    // a band with a Button takes abovePrompt:focus (ctrl+x tab, alt+c) ahead of
    // any open pane, so the chord went to the band instead of the cockpit.
    // alt+c from the prompt (COCKPIT_ACTION): the open cockpit's catcher takes
    // it; with the cockpit closed this hidden one does, and opens it.
    if (ui.open && !fork) return next(e)
    const E0 = els($.ui.resolve(e))
    // alt+s from the prompt with the cockpit closed: open it at the palette.
    const opener = E0.Box({
      display: 'none',
      children: [
        E0.Button({ key: 'hk-cockpit-open', label: 'cockpit', action: COCKPIT_ACTION, plain: true, onPress: () => void cockpitChord($), children: [E0.Text({ children: ['cockpit'] })] }),
        E0.Button({ key: 'hk-cockpit-grow', label: 'cockpit', action: GROW_ACTION, plain: true, onPress: () => void resizeFromPrompt($, 'grow'), children: [E0.Text({ children: ['cockpit'] })] }),
        E0.Button({ key: 'hk-palette-open', label: 'search', action: PALETTE_ACTION, plain: true, onPress: () => void togglePaletteOpen($), children: [E0.Text({ children: ['search'] })] }),
      ],
    })
    // With the cockpit open the fork row is the band's only row: drawing the
    // rest beside it made answering the fork take auth, PRs and peers away
    // with it (the band went back to empty), which read as a bug.
    const monitors = ui.open ? [] : ((await read($, monitorsA)) as MonitorState[])
    const E = els($.ui.resolve(e))
    const band = renderBand(E, {
      auth: ui.open ? [] : auth,
      prs: ui.open ? [] : prs,
      neighbors: ui.open ? [] : neighbors,
      monitors,
      now: Date.now(),
      fork: fork ?? undefined,
      forkEffect: fork ? forkEffect(forkPhase(fork, (await read($, turnsA)) as TurnRecord[])) : undefined,
      forkInCockpit: !!ui.open,
      width: e.props.bodyColumns,
      onFix: (item) => {
        if (!item.fix) return
        void runFix($, item)
      },
      onPr: (pr, action) => {
        if (action === 'open') void openUrl($, pr.url)
        else if (action === 'followup') void followUpPr($, pr)
        else void $.prompt.fill({ text: '/sb:slack-review-request ' + pr.url, mode: 'replace' })
      },
      onFork: (yes) => void answerFork($, yes),
    })
    const theirs = await next(e)
    if (!band) return ui.open ? theirs : E.Box({ flexDirection: 'column', children: [opener, ...(theirs ? [theirs] : [])] })
    return E.Box({ flexDirection: 'column', children: [...(ui.open ? [] : [opener]), band, theirs] })
  })

  // ---- drawing: cockpit panes ----
  // Where each focusable element of the cockpit sits, for the arrow keys
  // (lib/nav.ts): read off the tree the drawing hook below returns.
  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    const tree = await next(e)
    if (e.requestId === COCKPIT) {
      // Every letter hotkey drawn, so alt+<letter> can press it too (the
      // IME-proof way: under Korean input a bare letter types Hangul).
      hotkeyPress = collectHotkeys(tree)
      try {
        navLast = navItems(tree, e.props.bodyColumns)
        const region = clientItems(tree, e.props.bodyColumns).find((i) => i.key === 'web-region')
        if (e.surface === 'terminal') {
          if (region && e.props.placement === 'dock' && e.viewport) {
            // Pane body is the rightmost bodyColumns cells. Aim well inside the
            // region, so a one-cell frame offset cannot miss it.
            const left = e.viewport.columns - e.props.bodyColumns
            webClick = { x: Math.max(1, left + region.x + Math.max(2, Math.floor(region.w / 2))), y: Math.max(1, region.y + Math.min(3, Math.max(1, (region.h ?? 2) - 1))) }
          } else webClick = undefined
        }
      } catch {
        navLast = []
        webClick = undefined
      }
      // Keep the engine's window on the pinned row (views/home.ts frame): a
      // fresh open or a tab switch starts it at 0, showing the top spacer.
      const sc = e.props.scroll
      const web = tabOf(((await read($, uiA)) as any).view || 'home') === 'web'
      if (sc && sc.offset !== SPACER_ROWS) void $.ui.scroll({ in: COCKPIT, to: 'start' }).catch(() => {})
    }
    return tree
  })

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== COCKPIT) return next(e)
    const E = els($.ui.resolve(e))
    const width = e.props.bodyColumns as number
    const ui = (await read($, uiA)) as any
    const setUi = (patch: Record<string, unknown>) => void update($, uiA, (u) => ({ ...u, ...patch }))
    const now = Date.now()
    const id = tabOf(ui.view || 'home')
    // Every tab draws the status bar and the tab row, which need the whole
    // session; 지금 draws only from this.
    const hv: HomeView = {
      width,
      now,
      state: published.get('@cc_state') ?? '',
      keyboard: e.props.isFocused ? ((await read($, webKeyboardA)) === 'page' ? 'TWeb' : 'Cockpit') : 'Claude',
      ctx: published.has('@cc_ctx') ? Number(published.get('@cc_ctx')) : undefined,
      auth: (await read($, authA)) as AuthItem[],
      prs: (await read($, prsA)) as PrStatus[],
      flow: (await read($, flowA)) as FlowEntry[],
      outputs: (await read($, outputsA)) as Output[],
      elsewhere: ((await read($, elsewhereA)) as { windows: Elsewhere[] }).windows,
      todos: ((await read($, elsewhereA)) as { todos: Todo[] }).todos,
      narwhal: await narwhalVisible($),
      onNarwhal: (it, action, value) => void narwhalAction($, it, action, value),
      onWindow: (target) => void (isPaneId(pane) ? $.process.run(focusWindowArgv(pane, target), { timeoutMs: 5000 }).catch(() => undefined) : tmux($, [['select-window', '-t', target]])),
      resume: (await read($, resumeA)) as Pending | null,
      onResume: async (now) => {
        await update($, resumeA, () => null)
        if (now) await $.prompt.submit({ text: 'keep going', asUser: true }).catch(() => undefined)
      },
      slack: (await read($, slackA)) as Record<string, SlackThreadState>,
      agents: (await read($, agentsA)) as AgentNode[],
      monitors: (await read($, monitorsA)) as MonitorState[],
      follows: await (async () => {
        const f = (await read($, slackFollowA)) as Record<string, SlackFollow>
        const outs = (await read($, outputsA)) as Output[]
        return Object.entries(f)
          .filter(([, x]) => x.auto)
          .map(([key]) => {
            const o = outs.find((x) => x.kind === 'slack' && x.id === 'slack:' + key)
            return { key, title: o?.title ?? key, url: o?.url }
          })
      })(),
      watchSel: ui.watchSel ?? '',
      onWatchSelect: (id) => setUi({ watchSel: id }),
      onStopMonitor: (taskId) => {
        setUi({ watchSel: '' })
        void stopMonitor($, taskId)
      },
      onStopFollow: (key) => {
        setUi({ watchSel: '' })
        void setSlackFollow($, key, { auto: false }).then(() => $.ui.toast('auto follow-up off'))
      },
      policy: (await read($, policyA)) as Policy | null,
      onView: (view) => {
        if (view !== 'web') void setWebKeyboard($, 'controls')
        setUi({ view })
      },
      onFix: (item) => {
        if (!item.fix) return
        void runFix($, item)
      },
      onPr: (pr, action) => void (action === 'open' ? openUrl($, pr.url) : followUpPr($, pr)),
      onOpenUrl: (url) => void openUrl($, url),
      exp: (await read($, expA)) as Record<string, ExpCheck>,
      onExp: (o) => void loadPreview($, o).then(() => setUi({ view: 'outputs', outTab: 'exp', outSide: 'out', outSel: o.id })),
      webOn: ((await read($, webA)) as WebState).running,
      webLink: embedOn ? undefined : await webLinkBadge($),
      usage: ((await read($, usageA)) as { usage?: Usage }).usage,
      usageNote: ((await read($, usageA)) as { note?: string }).note,
      goal: (await read($, goalA)) as Goal | null,
      onShare: () => void shareSession($),
      onShareOther: (x) => void shareOther($, x),
      rca: (await read($, rcaA)) as RcaState,
      onRca: (action) => void rcaAction($, action),
      fork: (await read($, forkA)) as ForkOffer | null,
      forkEffect: await (async () => {
        const f = (await read($, forkA)) as ForkOffer | null
        return f ? forkEffect(forkPhase(f, (await read($, turnsA)) as TurnRecord[])) : undefined
      })(),
      onFork: (yes) => void answerFork($, yes),
      login: (await read($, mcpLoginA)) as McpLogin | null,
      onLogin: (action, value) => void mcpLoginAction($, action, value),
      onGoal: (action) => {
        // Filled, not sent: ending the goal is the person's Enter to press.
        if (action === 'clear') void $.prompt.fill({ text: '/goal clear', mode: 'replace' }).then(() => $.ui.toast('/goal clear is in the prompt: Enter ends the goal'))
      },
    }
    // The Web tab lays its page out to the row, so it keeps the flowing frame;
    // every other tab scrolls inside a window under the fixed header.
    const bodyRows = Math.max(3, (e.props.scroll?.bodyRows ?? 30) - FRAME_TOP - FRAME_BOTTOM)
    // Clamped here too: a tab whose body shrank since (a list emptied) shows its end.
    const max = bodyMax.get(id)
    const offset = Math.min(bodyScroll.get(id) ?? 0, max ?? Infinity)
    hv.win = id === 'web' ? undefined : { rows: bodyRows, offset, onMax: (m) => bodyMax.set(id, m) }
    // Stray letters stay in the cockpit and do nothing, so a key meant for the
    // prompt never drops into it. The palette opens only on purpose: k, or
    // alt+s from anywhere in the cockpit, which also closes it. Opening it on
    // any stray letter left it up all the time. The letter catchers are off
    // while it is open, so its field takes the typing; the chord stays.
    const pal = (await read($, paletteA)) as PaletteState
    const togglePalette = () => void togglePaletteOpen($)
    // alt+<letter> presses that letter's hotkey (k: the palette, as bare k does).
    const altPress = (k: string) => (k === 'k' ? togglePalette() : hotkeyPress.get(k)?.())
    const helpOpen = (await read($, helpA)) as boolean
    const toggleHelp = () =>
      void update($, helpA, (h) => !h).then(() => {
        if (!helpOpen) void focusSoon($, 'help-close')
      })
    const toggleWebKeys = () => void toggleWebKeyboard($)
    const onEscape = () => void cockpitEscape($)
    hv.catcher = pal.open
      ? catchAll(E, () => {}, togglePalette, false, altPress, () => void cockpitChord($), undefined, undefined, toggleWebKeys, onEscape)
      : catchAll(E, (k) => (k === 'k' ? togglePalette() : undefined), togglePalette, true, altPress, () => void cockpitChord($), toggleHelp, (dir) => void resizeFromPrompt($, dir), toggleWebKeys, onEscape)
    if (helpOpen) {
      const tabLabel = TABS.find((t) => t.id === id)?.label ?? id
      hv.help = renderHelp(E, { sections: helpSections(tabLabel, hotkeyLabels), width, onClose: toggleHelp })
    }
    if (pal.open) {
      const p = (await read($, policyA)) as Policy | null
      const caps = CAPS.map((c) => ({ cap: c, label: shortName(c), value: p?.caps[c] ?? 'inherit' }))
      const rs = routeSettings(p?.caps)
      const ws = (await read($, webSettingsA)) as WebSettings
      const wr = (await read($, webA)) as WebState
      const slackState = (await read($, slackA)) as Record<string, SlackThreadState>
      const slack = ((await read($, outputsA)) as Output[])
        .filter((o) => o.kind === 'slack' && o.url)
        .slice(-8)
        .reverse()
        .map((o) => {
          const n = slackState[o.id]?.unseen ?? 0
          return { url: o.url!, title: o.title, detail: n ? n + ' new' : o.detail }
        })
      const items = paletteItems({ tabs: TABS, caps, route: rs, browser, web: { running: wr.running, engine: ws.engine, device: ws.device, rate: ws.rate }, slack })
      paletteShown = filterPalette(items, pal.query)
      paletteNext = paletteNextKey(items, pal.query)
      hv.palette = renderPalette(E, {
        state: pal,
        items,
        width,
        onQuery: (q) => void update($, paletteA, (s) => ({ ...s, query: q, sel: 0 })),
        onRun: (item) => void runPaletteItem($, item),
        onClose: () => void update($, paletteA, () => PALETTE_CLOSED),
      })
    }
    const wrap = (body: any, legend?: [string, string][]) => frame(E, hv, id, body, legend, hv.win)
    const stack = (...parts: any[]) => E.Box({ flexDirection: 'column', children: parts })

    if (id === 'home') return renderHome(E, hv)

    const sideNode = async () =>
      renderSide(E, {
        embedded: true,
        items: (await read($, sideA)) as SideQA[],
        width,
        onAsk: (q) => void sideAsk($, q),
        onSend: (qa) => void $.prompt.submit({ text: 'side 질문에서 이어지는 내용입니다.\nQ: ' + qa.q + '\nA: ' + (qa.a ?? ''), asUser: true }),
        onFill: (qa) => void $.prompt.fill({ text: qa.q + '\n\n(side 답변: ' + clip(qa.a ?? '', 400) + ')', mode: 'replace' }),
        onCopy: (qa) => void $.ui.copy({ text: qa.a ?? '' }),
        onAgent: (qa) => {
          void $.agent.spawn({ prompt: qa.q, description: 'side: ' + clip(qa.q, 40), subagentType: 'general-purpose' })
          $.ui.toast('handed to a subagent; see cockpit Work (3)')
        },
        onClear: () => void update($, sideA, () => []),
        onFocusInput: () => void $.ui.focus({ requestId: COCKPIT, key: 'side-input' }).catch(() => {}),
      })

    if (id === 'flow') {
      const flowNode = renderFlow(E, {
        embedded: true,
        entries: (await read($, flowA)) as FlowEntry[],
        answers: (await read($, answersA)) as Record<string, string>,
        live: (await read($, liveA)) as LiveTurn | null,
        now,
        filter: ui.flowFilter as FlowFilter,
        showProgress: ui.flowProgress,
        selected: ui.flowSel >= 0 ? ui.flowSel : undefined,
        width,
        onFilter: (f) => setUi({ flowFilter: f, flowSel: -1 }),
        onToggleProgress: () => setUi({ flowProgress: !ui.flowProgress }),
        onSelect: (i) => setUi({ flowSel: ui.flowSel === i ? -1 : i }),
        onAsk: (text) => {
          // The answer lands in the side section above the flow.
          void sideAsk($, '이 판단을 자세히 설명해 줘: ' + text)
        },
        onCopy: (text) => void $.ui.copy({ text }),
      })
      // Side questions first: the field stays on screen however long the
      // flow below grows. It sat under the flow and every answer, so after one
      // answer the field was below the fold and looked gone.
      return wrap(stack(section(E, 'Side questions', 'stay out of the main chat'), await sideNode(), section(E, 'Flow'), flowNode), [['i', 'ask'], ['a c d g', 'filter'], ['p', 'progress']])
    }

    if (id === 'graph') {
      const turns = (await read($, turnsA)) as TurnRecord[]
      const agents = (await read($, agentsA)) as AgentNode[]
      const graphNode = renderGraph(E, {
        embedded: true,
        turns,
        agents,
        mode: ui.graphMode as GraphMode,
        now,
        width,
        selected: ui.graphSel || undefined,
        collapsedDone: ui.graphCollapsed,
        onMode: (m) => setUi({ graphMode: m }),
        onSelect: (sel) => setUi({ graphSel: ui.graphSel === sel ? '' : sel }),
        onToggleCollapsed: () => setUi({ graphCollapsed: !ui.graphCollapsed }),
        onCopyMermaid: () => {
          void $.ui.copy({ text: mermaid(turns, agents) })
          $.ui.toast('Mermaid copied')
        },
      })
      const nwRuns = ((await read($, narwhalA)) as { runs: NarwhalRun[] }).runs
      return wrap(
        stack(
          graphNode,
          ...(nwRuns.length
            ? [section(E, 'narwhal', 'runs this session started · press to open the monitor'), renderNarwhalRuns(E, { runs: nwRuns, now, width, onOpen: (r) => void openNarwhalMonitor($, r.run_id) })]
            : []),
          section(E, 'Watch', 'Monitor events'),
          renderWatch(E, { monitors: (await read($, monitorsA)) as MonitorState[], now, width }),
        ),
        [['t l', 'view'], ['f', 'collapse'], ['m', 'Mermaid']],
      )
    }


    if (id === 'outputs') {
      const scope = ui.outScope as OutScope
      const list = await scopedOutputs($, scope)
      const prs = ((await $.store.get(K.prs)) ?? {}) as Record<string, PrStatus>
      const sel = list.find((o) => o.id === ui.outSel)
      const slackNow = (await read($, slackA)) as Record<string, SlackThreadState>
      return wrap(renderOutputs(E, {
        embedded: true,
        outputs: list,
        slack: slackNow,
        prs,
        prNote: prLimitNote(now),
        tab: ui.outTab as OutTab,
        query: ui.outQuery ?? '',
        onQuery: (q) => setUi({ outQuery: q, outSel: '' }),
        onFocusQuery: () => void $.ui.focus({ requestId: COCKPIT, key: 'out-filter' }).catch(() => undefined),
        side: (ui.outSide ?? 'out') as OutSide,
        onSide: (sd) => setUi({ outSide: sd, outSel: '' }),
        scope,
        selected: ui.outSel || undefined,
        preview: sel && preview?.id === sel.id ? preview.p : undefined,
        exp: (await read($, expA)) as Record<string, ExpCheck>,
        width,
        now,
        onTab: (t) => setUi({ outTab: t, outSel: '' }),
        onScope: (s) => setUi({ outScope: s, outSel: '' }),
        onSelect: (oid) => {
          const o = list.find((x) => x.id === oid)
          if (!o) return
          void loadPreview($, o).then(() => setUi({ outSel: ui.outSel === oid ? '' : oid }))
        },
        onOpen: (o) => void (o.url ? openUrl($, o.url) : $.process.run(['open', o.path!], { timeoutMs: 5000 })),
        // Finder on its folder with the file selected: the move for an
        // attachment is dragging it from there.
        onReveal: (o) => void $.process.run(['open', '-R', o.path!], { timeoutMs: 5000 }),
        onCopy: (o) => void $.ui.copy({ text: o.url ?? o.path ?? o.title }),
        onContext: (o) => void $.prompt.fill({ text: (o.url ?? o.path ?? o.title) + ' ', mode: 'append' }),
        follow: (await read($, slackFollowA)) as Record<string, SlackFollow>,
        onFollowUp: (o) => void (o.url && followUpSlack($, o.url)),
        onAutoFollow: (o, enabled) => {
          const key = o.id.split(':').slice(1).join(':')
          // Turning it on marks what is there now as handled: only replies
          // after this point start a follow-up on their own.
          const st = slackNow[o.id]
          void setSlackFollow($, key, enabled ? { auto: true, lastRun: st?.newest } : { auto: false })
          $.ui.toast(enabled ? 'auto follow-up on: new replies start sb:slack-followup' : 'auto follow-up off')
        },
        onKeep: async (o) => {
          if (!o.path) return
          const dest = home + '/.claude/kept/' + sid + '/' + o.path.split('/').pop()
          await $.process.run(['mkdir', '-p', home + '/.claude/kept/' + sid], { timeoutMs: 3000 })
          const r = await $.process.run(['cp', o.path, dest], { timeoutMs: 10000 })
          $.ui.toast(r.exitCode === 0 ? 'kept: ' + dest : 'copy failed')
        },
        onDelete: async (o) => {
          if (!o.path) return
          let answer = 'cancel'
          try {
            answer = await $.ui.ask('Delete ' + o.path + '?', ['delete', 'cancel'])
          } catch {
            answer = 'cancel'
          }
          if (answer !== 'delete') return
          await $.process.run(['rm', '-f', '--', o.path], { timeoutMs: 5000 })
          await update($, outputsA, (xs) => xs.filter((x) => x.id !== o.id))
          setUi({ outSel: '' })
        },
      }), [['a p d f j l b', 'kind'], ['g', 'filter'], ['o', 'open'], ['r', 'folder'], ['u w', 'slack follow-up'], ['y', 'copy']])
    }

    // policy
    const p = (await read($, policyA)) as Policy | null
    const timers: Record<string, number> = {}
    for (const [k, v] of policyTimers) timers[k] = v.expiresAt
    if (id === 'auth') {
      return wrap(
        renderAuthTab(E, {
          auth: hv.auth,
          now,
          onFix: hv.onFix,
          login: (await read($, mcpLoginA)) as McpLogin | null,
          onLogin: (action, value) => void mcpLoginAction($, action, value),
          mcpOpen: !!ui.authMcp,
          onMcpOpen: () => setUi({ authMcp: !ui.authMcp }),
          onRefresh: () => void runRadar($, true),
          onAlt: (argv) => void $.process.run(argv, { timeoutMs: 8000 }).catch(() => undefined),
        }),
      )
    }

    if (id === 'settings') {
      const prefs = ((await $.store.get(K.cockpitSettings)) ?? {}) as { onStart?: boolean; embed?: boolean; slashHide?: boolean; mcpHeal?: boolean }
      const savePrefs = async (patch: Record<string, boolean>) => {
        const cur = ((await $.store.get(K.cockpitSettings)) ?? {}) as Record<string, boolean>
        await $.store.set(K.cockpitSettings, { ...cur, ...patch })
        $.ui.invalidate('ui.render')
      }
      if (settingsTarget === undefined) {
        settingsTarget = ''
        void webTarget($).then(async (t) => {
          settingsTarget = t
          settingsEnvBrowser = (await $.env.get('BROWSER')) ?? ''
          $.ui.invalidate('ui.render')
        })
      }
      const rs = routeSettings(((await read($, policyA)) as Policy | null)?.caps)
      return wrap(
        renderSettings(E, {
          width,
          browser,
          target: settingsTarget ? ((BROWSER_LABEL as Record<string, string>)[settingsTarget] ?? settingsTarget) : undefined,
          envBrowser: settingsEnvBrowser,
          embed: embedOn,
          web: (await read($, webSettingsA)) as WebSettings,
          onStart: prefs.onStart ?? cockpitOnStartDefault,
          autoResume: (prefs as { autoResume?: boolean }).autoResume !== false,
          onAutoResume: (enabled) => void savePrefs({ autoResume: enabled }),
          rcaAuto: (prefs as { rcaAuto?: boolean }).rcaAuto !== false,
          slashHide: prefs.slashHide !== false,
          mcpHeal: prefs.mcpHeal !== false,
          onMcpHeal: (enabled) => {
            mcpHealEnabled = enabled
            void savePrefs({ mcpHeal: enabled })
          },
          onSlashHide: (enabled) => {
            slashHideEnabled = enabled
            if (!enabled) void setSlashCockpit($, false)
            void savePrefs({ slashHide: enabled })
          },
          onRcaAuto: (enabled) => void savePrefs({ rcaAuto: enabled }),
          route: rs,
          onBrowser: async (b) => {
            const choice = parseBrowser(b)
            if (!choice || !isPaneId(pane)) return
            browser = choice
            await tmux($, [browserArgv(pane, choice)])
            settingsTarget = await webTarget($)
            $.ui.invalidate('ui.render')
          },
          onEmbed: (enabled) => {
            embedOn = enabled
            void savePrefs({ embed: enabled })
          },
          onWeb: (patch) => void setWebSettings($, patch),
          engineRules,
          onEngineRuleAdd: (text) => {
            const add = parseEngineRules(text)
            if (!add.length) return void $.ui.toast('Rule needs a pattern and an engine: claude.ai chrome')
            // A pattern given again replaces its old rule, at the front.
            const keep = engineRules.filter((r) => !add.some((a) => a.pattern === r.pattern))
            void saveEngineRules($, [...add, ...keep])
          },
          onEngineRuleRemove: (pattern) => void saveEngineRules($, engineRules.filter((r) => r.pattern !== pattern)),
          onStartChange: (enabled) => void savePrefs({ onStart: enabled }),
          onRoute: (which, enabled) => void applyPolicy($, [enabled ? 'allow' : 'inherit', which === 'effort' ? 'auto_effort' : 'auto_model']),
        }),
      )
    }

    if (id === 'usage') {
      const us = (await read($, usageA)) as { usage?: Usage; note?: string; quota: Quota[]; window: UsageWindow; jev?: JevUsage }
      return wrap(
        renderUsage(E, {
          width,
          now,
          usage: us.usage,
          note: us.note,
          quota: us.quota,
          jev: us.jev,
          window: us.window,
          onWindow: (w) => void update($, usageA, (s) => ({ ...s, window: w })).then(() => loadUsage($)),
          onRefresh: () => void loadUsage($),
        }),
        [['h w s', 'window'], ['r', 'refresh']],
      )
    }

    if (id === 'web' && !embedOn) {
      const side = (await read($, sideWebA)) as SideWeb
      // Listed while the tab is drawn, at most every few seconds: a pane the
      // person closed or navigated by hand shows here without a press.
      // On the clock, not inline: drawing may not write state.
      if (!sideListing && Date.now() - sideAskedAt > (side.panel && side.panel !== 'auto' ? 2000 : 3000)) {
        sideAskedAt = Date.now()
        $.clock.after(0, () => void refreshSide($).then(() => $.ui.invalidate('ui.render')))
      }
      const ws = (await read($, webSettingsA)) as WebSettings
      const auto = (await read($, webAutoA)) as AutoStep[]
      const last = auto.at(-1)
      const driving = (!!last && (last.state === 'running' || (await clockNow($)) - last.at < DRIVING_MS)) || !!side.presence?.driving
      return wrap(
        renderWebSide(E, {
          self: pane ?? '',
          now: Date.now(),
          width,
          side,
          auto,
          driving,
          panelRows: Math.max(4, (e.props.scroll?.bodyRows ?? 30) - 12 - side.tabs.length),
          onPanel: (panel) => void update($, sideWebA, (x) => ({ ...x, panel })).then(() => refreshSide($)).then(() => $.ui.invalidate('ui.render')),
          onClearPanel: () => {
            if (!side.pane || !side.panel || side.panel === 'auto') return
            void $.process.run(sideArgv(side.pane, [side.panel, '--clear', '--limit', '1']), { timeoutMs: 5000 }).catch(() => undefined).then(() => update($, sideWebA, (x) => ({ ...x, console: x.panel === 'console' ? [] : x.console, network: x.panel === 'network' ? [] : x.network })))
          },
          engine: ws.engine,
          onOpen: (text) => {
            const url = urlFromInput(text)
            if (url) void openSide($, url, engineForUrl(url, engineRules) ?? ws.engine)
          },
          onCmd: (argv) => void sideCmd($, argv),
          onFocus: () => void focusSide($),
          onClose: () => void closeSide($),
          onEngine: (en) => void update($, webSettingsA, (x) => ({ ...x, engine: en })),
          onTab: (i) => void sideCmd($, ['tab', 'switch', String(i)]),
          onNewTab: () => void sideCmd($, ['tab', 'new']),
          onCloseTab: (i) => void sideCmd($, ['tab', 'close', String(i)]),
        }),
        [['alt+w', 'focus the pane'], ['enter', 'open'], ['click', 'tab']],
      )
    }

    if (id === 'web') {
      const w = (await read($, webA)) as WebState
      // WEB_TOP rows above the page, the key legend below it.
      const ws = (await read($, webSettingsA)) as WebSettings
      const keyboard = (await read($, webKeyboardA)) as 'controls' | 'page'
      // Outputs first (they carry titles), then any other URL the answers and
      // prompts held, newest turns first.
      const said = Object.values((await read($, answersA)) as Record<string, string>).flatMap((t, i) => urlsIn(t, i))
      const asked = ((await read($, flowA)) as FlowEntry[]).filter((f) => f.kind === 'prompt').flatMap((f) => urlsIn(f.text, f.at))
      const picks = urlPicks([...((await read($, outputsA)) as Output[]).map((o) => ({ ...o, at: o.at + 1e13 })), ...said, ...asked], ui.webQuery ?? '')
      const pickOpen = !!ui.webPick && picks.length > 0
      // Folded is a preference: it holds across opens of the field.
      const pickFolded = !!ui.webPickFolded
      const top = WEB_TOP + (ws.open && w.running ? WEB_SETTINGS_ROWS : 0) + (pickOpen && w.running ? pickRows(picks.length, pickFolded) : 0)
      const rows = Math.max(8, (e.props.scroll?.bodyRows ?? 30) - top - 2)
      // The bridge finds where the page goes from the header row; how big it is
      // only this drawing knows, so it says so whenever that changes.
      // Recorded only once the bridge took it: the first draw comes before its
      // socket is up, and a lost POST would leave the page undrawn for good.
      // The docked cockpit's left edge: the bridge looks for its anchor only
      // right of it, so transcript text quoting "│ go:" never matches.
      const minCol = e.props.placement === 'dock' && e.viewport ? Math.max(0, e.viewport.columns - width - 2) : 0
      const size = width + 'x' + rows + '@' + minCol
      if (w.running && webRegion !== size) {
        void webCall($, '/region', { cols: width, rows, minCol }).then((r: any) => {
          if (r?.ok) webRegion = size
        })
      }
      return wrap(
        renderWeb(E, {
          width,
          rows,
          web: w,
          embed: embedOn,
          target: w.running ? '' : await webTarget($),
          onCmd: (argv) => {
            // TWeb's own `w` key reaches it only from its own pane UI; hosted in
            // the Web tab every key goes to the page, so float/pin is a command.
            if (argv[0] === 'float' || argv[0] === 'pin') {
              void webCall($, '/cmd', { argv }).then(() => update($, webA, (x) => ({ ...x, floating: argv[0] === 'float' })))
              return
            }
            void webCall($, '/cmd', { argv })
          },
          floating: !!w.floating,
          onClose: () => void stopWeb($),
          onOpen: (text) => {
            const url = urlFromInput(text)
            if (!url) return
            void openWeb($, url).then(() => {
              // Page mode is the browser experience; wait for the redraw that
              // gives focusWebPage the new Client coordinates.
              $.clock.after(150, () => void focusWebPage($))
            })
          },
          settings: ws,
          onSettings: (patch) => void setWebSettings($, patch),
          onDevtools: () => void webCall($, '/cmd', { argv: ['devtools'] }),
          keyboard,
          onPageKeyboard: () => void focusWebPage($),
          onControlsKeyboard: () => void focusWebControls($),
          picks,
          pickOpen,
          pickFolded,
          onPickFold: () => setUi({ webPickFolded: !pickFolded }),
          onAddress: (value) => setUi({ webQuery: value }),
        }),
        [['alt+w', keyboard === 'page' ? 'controls' : 'page'], ['⚙', 'settings'], ['✕', 'close'], ['click', 'page keyboard']],
      )
    }

    const policyNode = renderPolicy(E, {
      embedded: true,
      policy: p ?? parsePolicy(undefined),
      timers,
      now,
      width,
      message: ui.policyMsg,
      onSet: (cap: Cap, v: CapValue) => void applyPolicy($, [v, cap]),
      // RCA is a mode with a subject: picking it starts RCA on this session's
      // alert thread (as /rca does), so ending it can put the policy back.
      onMode: (m) => void (m === 'rca' ? rcaFromSession($) : applyPolicy($, ['mode', m])),
      onScope: async (cap: Cap, scope) => {
        const r = await resolvePolicyArgv($, ['allow', cap, cap === 'gh_merge' ? '--repo' : '--scope', scope])
        if ('error' in r) return setUi({ policyMsg: 'failed: ' + r.error })
        await applyPolicy($, r.argv)
      },
      onUnscope: (cap: Cap, scope) => void applyPolicy($, ['inherit', cap, cap === 'gh_merge' ? '--repo' : '--scope', scope]),
      labels: await slackLabels($),
      onTimed: (cap: Cap, minutes) => void applyPolicy($, ['allow', cap], minutes * 60_000, ['inherit', cap]),
      god: god?.until,
      onGod: (minutes?: number) => void (minutes && !god ? startGod($, minutes) : endGod($, 'ended by you')),
      hints: scopeHints(
        [
          ...(repo ? [{ cap: 'gh_merge' as Cap, scope: repo, why: 'cwd' as const }] : []),
          ...((await read($, prsA)) as PrStatus[]).flatMap((x) => {
            const r = parsePrKey(x.key)?.repo
            return r && x.state === 'OPEN' ? [{ cap: 'gh_merge' as Cap, scope: r, why: 'pr' as const }] : []
          }),
          ...((await read($, outputsA)) as Output[])
            .filter((o) => o.kind === 'slack')
            .map((o) => ({ cap: 'slack_send' as Cap, scope: o.id.split(':')[1]!, why: 'thread' as const })),
          ...((await read($, hintsA)) as ScopeHint[]),
          ...(await knownHints($)),
        ],
        p ?? parsePolicy(undefined),
      ),
      more: ui.policyMore,
      onMore: (cap: Cap) => setUi({ policyMore: ui.policyMore === cap ? '' : cap }),
      // Write access is the one a guard suggests timing; a press grants it for 15m.
      onHint: (h) => {
        const cmd = parsePolicyArgs('allow ' + h.cap + ' ' + h.scope + (h.cap === 'prod_eks_write' ? ' 15m' : ''))
        if ('argv' in cmd) void applyPolicy($, cmd.argv, cmd.ttlMs, cmd.revert)
      },
    })
    const routeNode = renderRoute(E, { settings: routeSettings(p?.caps), last: ((await read($, routeA)) as { last?: RouteDecision }).last })
    return wrap(stack(policyNode, section(E, 'Routing', 'Jev picks each turn\'s effort'), routeNode))
  })

  // Re-read policy when the settings-hook CLI changes it behind our back
  // (e.g. the user ran `! python3 session_policy.py ...`).
  // A main turn ended on an API error: note it, so the probe can continue it
  // once the connection is back. Subagents' failures are their parent's to
  // handle; ones that will not clear (login, billing, a bad request) are left.
  on('classic.StopFailure', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (!e.agent_id && interactive) {
      const message = String(e.last_assistant_message ?? e.error_details ?? '')
      const cls = classify(e.error, message)
      if (cls !== 'never') {
        const prev = (await read($, resumeA)) as Pending | null
        const now = await clockNow($)
        // A failure of our own keep-going keeps the streak (and its count).
        const attempts = prev ? prev.attempts : 0
        await update($, resumeA, () => ({ at: now, cls, message: clip(message, 200), attempts, nextAt: now + backoff(cls, attempts) }))
        if (!prev) $.ui.toast('turn interrupted (' + clip(message.replace(/^API Error:\s*/, ''), 60) + '): continuing when the connection is back')
      }
    }
    return r
  })

  on('classic.UserPromptSubmit', async ($: any, e: any, next: any) => {
    // The policy prompt for this same turn must observe an out-of-band grant.
    // Without the await, prompt.compose can race this read and tell Claude that
    // a grant is still blocked even though the CLI guard already allows it.
    await loadPolicy($)
    return next(e)
  })
}

// A settings-hook guard refused the call. If the person can lift that guard,
// ask them now; on yes, run the unlock as them and retry the call once.
async function approveGuard($: any, e: any, result: any, retry: () => Promise<any>): Promise<any> {
  if (!interactive || typeof result?.deny !== 'string') return result
  const u = unlockFor(result.deny, e.tool, e, home)
  if (!u) return result
  let answer = 'deny'
  try {
    answer = await $.ui.ask(u.label + '?', ['allow once', 'deny'])
  } catch {
    answer = 'deny'
  }
  if (answer !== 'allow once') return result
  const r = await $.process.run(u.argv, { timeoutMs: 10000 })
  if (r.exitCode !== 0) {
    $.ui.toast('unlock failed: ' + clip(r.stderr || r.stdout, 120))
    return result
  }
  $.ui.toast(u.label + ' (' + u.minutes + 'm)')
  return retry()
}

async function publishAgents($: any) {
  const n = ((await read($, agentsA)) as AgentNode[]).filter((a) => a.status === 'running' || a.status === 'background').length
  await publish($, undefined, null, { '@cc_agents': n ? String(n) : '' })
}

async function countTool($: any, tool: string, agentId: string | undefined) {
  if (agentId) {
    await update($, agentsA, (as) => as.map((a) => (a.id === agentId ? { ...a, tools: a.tools + 1 } : a)))
    return
  }
  if (!currentTurn) return
  await update($, turnsA, (ts) => ts.map((t) => (t.turnId === currentTurn ? { ...t, tools: { ...t.tools, [tool]: (t.tools[tool] ?? 0) + 1 } } : t)))
}

export type { Elements, RenderElement }
void tabRow
void col
void needsAttention
void lastPrompt
