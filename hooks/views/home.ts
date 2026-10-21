// The cockpit: one pane, five tabs. Each tab groups the areas that answer the
// same question, so nothing needs its own pane or a drill-in:
//
//   지금    what needs me, what is happening now, what this session did
//   대화    the flow of requests and conclusions, with side questions under it
//   작업    subagents and background tasks, with the Monitors watching them
//   산출물  PRs, artifacts, files, tickets, links
//   권한    session policy, with the credential radar
//
// A status bar and the tab row sit above every tab; digits 1-5 switch tabs,
// Esc on any tab but 지금 comes back to it.

import { ICON as AUTH_ICON, type AuthItem } from '../lib/auth'
import type { MonitorState } from '../lib/monitor'
import type { Policy } from '../lib/policy'
import type { SlackThreadState } from '../lib/slack'
import { since, type Elsewhere, type Todo } from '../lib/elsewhere'
import { itemKey, runProgress, type NarwhalItem, type NarwhalRun } from '../lib/narwhal'
import { STUCK, needLabel, needsAttention, prLine, type PrStatus } from '../lib/prs'
import { isMade, type AgentNode, type FlowEntry, type Output, type OutputKind } from '../lib/record'
import { ago, clip, duration, hhmm, kTokens } from '../lib/text'
import { share, shortModel, sparkline, type Usage } from '../lib/usage'
import { goalChip, goalVisible, type Goal } from '../lib/goal'
import type { RcaState } from '../lib/rca'
import { forkAge, type ForkOffer } from '../lib/fork'
import type { McpLogin } from '../lib/mcpauth'
import { mcpLoginCard } from './auth'
import { C, field, keys, prTone, rule, type Els, type Node } from './common'

export type View = 'home' | 'flow' | 'graph' | 'outputs' | 'policy' | 'web' | 'usage' | 'auth' | 'settings'

export const TABS: { id: View; label: string; hotkey: string }[] = [
  { id: 'home', label: 'Now', hotkey: '1' },
  { id: 'flow', label: 'Chat', hotkey: '2' },
  { id: 'graph', label: 'Work', hotkey: '3' },
  { id: 'outputs', label: 'In/Out', hotkey: '4' },
  { id: 'policy', label: 'Policy', hotkey: '5' },
  { id: 'web', label: 'Web', hotkey: '6' },
  { id: 'usage', label: 'Usage', hotkey: '7' },
  { id: 'auth', label: 'Auth', hotkey: '8' },
  { id: 'settings', label: 'Settings', hotkey: '9' },
]

// Views that used to be their own areas, and the tab that holds them now.
export function tabOf(view: string): View {
  if (view === 'side') return 'flow'
  if (view === 'watch') return 'graph'
  return (TABS.some((t) => t.id === view) ? view : 'home') as View
}

export type HomeView = {
  width: number
  // What this session's narwhal runs need (lib/narwhal.ts), and a press on one.
  narwhal?: NarwhalItem[]
  onNarwhal?: (it: NarwhalItem, action: 'answer' | 'monitor' | 'result' | 'dismiss', value?: string) => void
  // ccproxy's view of this session (lib/usage.ts); undefined when ccproxy is
  // too old to answer `usage` or nothing was captured.
  usage?: Usage
  usageNote?: string // why there is none, when there is none
  // Drawn first in every tab (views/palette.ts catchAll): claims stray letters.
  // Absent while the palette is open, so typing reaches its search field.
  catcher?: Node
  // Drawn under the header while open (views/palette.ts renderPalette).
  palette?: Node
  help?: Node // alt+/: drawn in place of the body while open (views/help.ts)
  // The body window under the fixed header: rows it shows and how far it is
  // scrolled. Absent, the body flows with the header (tests, other surfaces).
  win?: { rows: number; offset: number; onMax?: (max: number) => void }
  now: number
  state: string // working | waiting | done | ''
  keyboard?: 'Claude' | 'Cockpit' | 'TWeb'
  ctx?: number
  auth: readonly AuthItem[]
  prs: readonly PrStatus[]
  flow: readonly FlowEntry[]
  outputs: readonly Output[]
  elsewhere?: readonly Elsewhere[] // other windows' sessions waiting on the person
  todos?: readonly Todo[] // today's dayx brief
  onWindow?: (target: string) => void // jump to that tmux window
  onShare?: () => void // copy this session's identity (lib/identity.ts)
  onShareOther?: (x: Elsewhere) => void // copy another window's session identity
  rca?: RcaState // RCA mode (lib/rca.ts)
  onRca?: (action: 'end' | 'extend' | 'thread') => void
  resume?: { at: number; message: string; attempts: number } | null // a turn waiting to auto-resume
  onResume?: (now: boolean) => void // continue now (true) or give up (false)
  slack?: Readonly<Record<string, SlackThreadState>> // thread id -> replies nobody has seen
  agents: readonly AgentNode[]
  monitors: readonly MonitorState[]
  policy: Policy | null
  webOn?: boolean // a Web tab page is running
  webLink?: 'ok' | 'down' | 'driving' // the TWeb pane beside: tweb answered, did not, or Claude is driving it
  onView: (v: View) => void
  onFix: (a: AuthItem) => void
  onPr: (pr: PrStatus, action: 'open' | 'followup') => void // a press opens the PR page
  onOpenUrl: (url: string) => void
  goal?: Goal | null // the session's /goal (lib/goal.ts)
  // A fork offer (Jev thinks the prompt is a separate task): asked here while
  // the cockpit is open, so the band holds nothing that takes alt+c.
  fork?: ForkOffer | null
  forkEffect?: string // what a press does now (lib/fork.ts forkEffect)
  onFork?: (yes: boolean) => void
  // Watches this session runs, each stoppable from Now: Monitors (PR, Slack,
  // anything) and threads on automatic Slack follow-up. A first press selects
  // the row; the stop button under it ends the watch.
  follows?: readonly { key: string; title: string; url?: string }[]
  watchSel?: string
  onWatchSelect?: (id: string) => void
  onStopMonitor?: (taskId: string) => void
  onStopFollow?: (key: string) => void
  // An MCP connector login in progress (lib/mcpauth.ts): shown on Now too, so
  // a login started from the band is followed where the person looks first.
  login?: McpLogin | null
  onLogin?: (action: 'paste' | 'reopen' | 'copy' | 'retry' | 'cancel', value?: string) => void
  onGoal?: (action: 'clear') => void
}

const KIND_GLYPH: Record<OutputKind, string> = { pr: '⇄', artifact: '◰', scratch: '✎', ticket: '◇', slack: '#', link: '↗', bg: '⚙', commit: '●', file: '✎' }

const isRunning = (a: AgentNode) => a.status === 'running' || a.status === 'background'

// ---- pieces ----------------------------------------------------------------

function statusBar(els: Els, v: HomeView): Node {
  const { Box, Button, Text } = els
  const st =
    v.state === 'working'
      ? { t: ' ⏳ working ', c: C.warn }
      : v.state === 'waiting'
        ? { t: ' ❓ waiting ', c: C.accent }
        : v.state === 'done'
          ? { t: ' ✓ done ', c: C.ok }
          : { t: ' · idle ', c: C.muted }
  const open = v.policy ? Object.entries(v.policy.caps).filter(([, x]) => x === 'allow').length + Object.keys(v.policy.scopes).length : 0
  return Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    children: [
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Text({ bold: true, color: C.claude, children: ['cockpit'] }),
          Text({ inverse: true, bold: true, color: st.c, children: [st.t] }),
          ...(v.keyboard ? [Text({ inverse: true, bold: true, color: v.keyboard === 'TWeb' ? C.accent : v.keyboard === 'Cockpit' ? C.claude : C.muted, children: [' ⌨ ' + v.keyboard + ' '] })] : []),
          // No context gauge: the status line under the prompt already shows it
          // in every pane, including when the cockpit is closed or too narrow.
          ...(open ? [Text({ color: C.warn, children: ['🔓 ' + open]})] : []),
          // A goal keeps the session going turn after turn: say so on every tab.
          ...(v.goal && goalVisible(v.goal, v.now) ? [Text({ color: v.goal.active ? C.accent : v.goal.met ? C.ok : C.muted, children: [goalChip(v.goal)] })] : []),
          ...(v.rca ? [Text({ inverse: true, bold: true, color: C.bad, children: [' 🚨 RCA '] })] : []),
        ],
      }),
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          // On every tab, at the top: this session's identity in one press, to
          // hand the work to another session (or tell someone where it is).
          ...(v.onShare
            ? [Button({ key: 'share-session', label: "copy this session's identity", plain: true, onPress: v.onShare, children: [Text({ color: C.accent, children: ['⧉ share'] })] })]
            : []),
          Text({ color: C.faint, children: [hhmm(v.now)] }),
        ],
      }),
    ],
  })
}

function line(els: Els, glyph: string, tone: string | undefined, text: string, meta?: string, bold = false): Node {
  const { Box, Text } = els
  return Box({
    flexDirection: 'row',
    justifyContent: 'space-between',
    children: [
      Box({ flexDirection: 'row', children: [Text({ color: tone, children: [glyph + ' '] }), Text({ bold, children: [text] })] }),
      ...(meta ? [Text({ color: C.faint, children: [' ' + meta] })] : []),
    ],
  })
}

function quiet(els: Els, text: string): Node {
  return els.Text({ color: C.muted, children: [text] })
}

function needsCard(els: Els, v: HomeView, w: number): Node | undefined {
  const { Box, Button, Text } = els
  const authBad = v.auth.filter((a) => (a.state === 'expired' || a.state === 'soon') && a.fix)
  const prNeed = v.prs.filter((p) => STUCK.includes(needsAttention(p)!))
  const watch = v.monitors.filter((m) => m.mattered && v.now - m.at < 30 * 60_000)
  // Slack threads with replies nobody has looked at: a press opens the thread
  // (and marks it seen).
  const slackNew = v.outputs.filter((o) => o.kind === 'slack' && o.url && (v.slack?.[o.id]?.unseen ?? 0) > 0)
  const nw = v.narwhal ?? []
  if (!authBad.length && !prNeed.length && !watch.length && !slackNew.length && !nw.length && !v.resume && !v.fork) return undefined
  const rows: Node[] = [
    ...(v.fork && v.onFork
      ? [
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Text({ color: C.warn, children: ['⑂ ' + clip(v.fork.prompt.replace(/\s+/g, ' '), 40) + ' · a separate task? ' + forkAge(v.fork, v.now)] }),
              Button({ key: 'home-fork-yes', label: 'fork to new pane', plain: true, onPress: () => v.onFork!(true), children: [Text({ color: C.accent, children: ['→ fork to new pane'] })] }),
              Button({ key: 'home-fork-no', label: 'continue here', plain: true, onPress: () => v.onFork!(false), children: [Text({ color: C.muted, children: ['continue here'] })] }),
            ],
          }),
          ...(v.forkEffect ? [Box({ paddingLeft: 2, children: [Text({ color: C.faint, children: [clip(v.forkEffect, w - 4)] })] })] : []),
        ]
      : []),
    ...(v.resume
      ? [
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Text({ color: C.warn, children: ['⏸ interrupted ' + ago(v.resume.at, v.now) + ' ago · continues when the connection is back' + (v.resume.attempts ? ' (try ' + (v.resume.attempts + 1) + ')' : '')] }),
              ...(v.onResume
                ? [
                    Button({ key: 'resume-now', label: 'continue now', plain: true, onPress: () => v.onResume!(true), children: [Text({ color: C.accent, children: ['→ continue now'] })] }),
                    Button({ key: 'resume-cancel', label: 'cancel', plain: true, onPress: () => v.onResume!(false), children: [Text({ color: C.muted, children: ['✕'] })] }),
                  ]
                : []),
            ],
          }),
        ]
      : []),
    ...authBad.map((a) =>
      Button({
        key: 'home-auth-' + a.id,
        label: a.label,
        plain: true,
        onPress: () => v.onFix(a),
        children: [Text({ color: a.state === 'expired' ? C.bad : C.warn, children: [AUTH_ICON[a.state] + ' '] }), Text({ bold: true, children: [a.label] }), Text({ color: C.muted, children: [a.state === 'expired' ? '  expired · press to log in' : '  expires soon'] })],
      }),
    ),
    // A press opens the PR page, as a link would; the follow-up skill is its
    // own button so a click to look never starts a turn.
    ...prNeed.map((p) =>
      Box({
        flexDirection: 'row',
        children: [
          Button({
            key: 'home-pr-' + p.key,
            label: p.key,
            plain: true,
            onPress: () => v.onPr(p, 'open'),
            children: [Text({ color: prTone(p), children: ['⇄ '] }), Text({ bold: true, children: [clip(p.key, Math.max(16, w - 44))] }), Text({ color: prTone(p), children: ['  ' + prLine(p)] })],
          }),
          Button({ key: 'home-pr-fu-' + p.key, label: 'follow up', plain: true, onPress: () => v.onPr(p, 'followup'), children: [Text({ color: C.accent, children: ['  → follow up'] })] }),
        ],
      }),
    ),
    ...slackNew.map((o) => {
      const st = v.slack![o.id]!
      return Button({
        key: 'home-slack-' + o.id,
        label: o.title,
        plain: true,
        onPress: () => v.onOpenUrl(o.url!),
        children: [
          Text({ color: C.warn, children: ['# '] }),
          Text({ bold: true, children: [clip(o.title, Math.max(16, w - 34))] }),
          Text({ color: C.warn, children: ['  ' + st.unseen + ' new' + (st.lastFrom ? ' · ' + clip(st.lastFrom, 18) : '')] }),
        ],
      })
    }),
    ...watch.map((m) => line(els, '❗', C.warn, clip(m.summary + ' — ' + (m.outcome || m.label), w - 6))),
    ...nw.map((it) => narwhalRow(els, it, w, v.onNarwhal)),
  ]
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: C.bad,
    paddingX: 1,
    children: [Text({ bold: true, color: C.bad, children: ['Needs you ' + rows.length] }), ...rows],
  })
}


// One narwhal item: what a run started from this session needs. A question
// carries its options as buttons (the recommended one starred) and a field
// for any other answer; a finished run offers to bring its result into the
// conversation. Every item opens the run's monitor beside this pane.
function narwhalRow(els: Els, it: NarwhalItem, w: number, on?: HomeView['onNarwhal']): Node {
  const { Box, Button, Input, Text } = els
  const press = (action: 'answer' | 'monitor' | 'result' | 'dismiss', value?: string) => () => on?.(it, action, value)
  const k = 'nw-' + itemKey(it)
  const tone = it.kind === 'failed' || it.kind === 'stuck' ? C.bad : it.kind === 'question' ? C.warn : C.ok
  const glyph = { question: '◆', stuck: '⚠', failed: '✗', done: '✓' }[it.kind]
  const head = Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Box({ flexGrow: 1, flexShrink: 1, children: [Text({ color: tone, children: [glyph + ' narwhal · '] }), Text({ bold: true, children: [clip(it.title, Math.max(20, w - 30))] })] }),
      Button({ key: k + '-mon', label: 'monitor', plain: true, onPress: press('monitor'), children: [Text({ color: C.accent, children: ['monitor'] })] }),
      Button({ key: k + '-x', label: 'dismiss', plain: true, onPress: press('dismiss'), children: [Text({ color: C.muted, children: ['✕'] })] }),
    ],
  })
  const rows: Node[] = [head, Text({ color: C.faint, children: ['   ' + clip(it.request, w - 6)] })]
  const q = it.question
  if (it.kind === 'question' && q) {
    // What the operator needs to answer: the asker's context, else what the
    // question's labels mean (narwhal finds those in what the asker read).
    for (const g of (q.context ? [q.context] : q.grounds ?? []).slice(0, 2)) rows.push(Text({ color: C.muted, children: ['   ↳ ' + clip(g, w - 8)] }))
    const opts = q.options ?? []
    if (opts.length) {
      rows.push(
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 2,
          children: [
            Text({ children: ['  '] }),
            ...opts.map((o, i) =>
              Button({
                key: k + '-o' + i,
                label: o,
                onPress: press('answer', o),
                children: [Text({ color: i + 1 === q.recommended ? C.accent : undefined, bold: i + 1 === q.recommended, children: [i + 1 + ' ' + clip(o, 40) + (i + 1 === q.recommended ? ' ★' : '')] })],
              }),
            ),
          ],
        }),
      )
    }
    rows.push(
      field(
        els,
        Input({
          key: k + '-in',
          label: 'answer',
          placeholder: q.assumed ? 'assumed: ' + clip(q.assumed, 60) : 'your answer',
          value: '',
          submitLabel: 'send',
          onSubmit: (text: string) => on?.(it, 'answer', text),
        }),
      ),
    )
  } else if (it.kind === 'done' || it.kind === 'failed') {
    if (it.summary) rows.push(Text({ color: C.muted, children: ['   ' + clip(it.summary, w - 6)] }))
    rows.push(
      Box({
        flexDirection: 'row',
        children: [
          Text({ children: ['   '] }),
          Button({ key: k + '-res', label: 'bring the result into the conversation', plain: true, onPress: press('result'), children: [Text({ color: C.accent, children: ['→ bring the result into the conversation'] })] }),
        ],
      }),
    )
  }
  return Box({ flexDirection: 'column', marginTop: 1, children: rows })
}

// ---- frame: status bar + tab row, around every tab ------------------------

function tabBar(els: Els, v: HomeView, active: View): Node {
  const { Box, Button, Text } = els
  const running = v.agents.filter(isRunning).length
  const failed = v.agents.filter((a) => a.status === 'failed').length
  const outs = v.outputs.filter((o) => o.kind !== 'file' && o.kind !== 'commit' && isMade(o)).length
  const open = v.policy ? Object.values(v.policy.caps).filter((x) => x === 'allow').length + Object.keys(v.policy.scopes).length : 0
  const authBad = v.auth.filter((a) => a.state === 'expired').length
  const authSoon = v.auth.filter((a) => a.state === 'soon').length
  // Per tab: a count and the tone it deserves, so the row itself says where to look.
  const badge: Record<View, { n?: string; tone?: string }> = {
    home: {},
    flow: { n: String(v.flow.filter((f) => f.kind === 'prompt').length || '') },
    graph: { n: failed ? '✗' + failed : running ? '⏳' + running : '', tone: failed ? C.bad : running ? C.warn : undefined },
    outputs: { n: String(outs || '') },
    policy: { n: open ? '🔓' + open : '', tone: open ? C.warn : undefined },
    web: v.webLink ? { n: v.webLink === 'down' ? '✗' : v.webLink === 'driving' ? '◐' : '●', tone: v.webLink === 'down' ? C.bad : v.webLink === 'driving' ? C.claude : C.ok } : { n: v.webOn ? '●' : '' },
    usage: { n: v.usage?.last?.account ? shortModel(v.usage.last.model) : '' },
    auth: { n: authBad ? '✗' + authBad : authSoon ? '⏳' + authSoon : '', tone: authBad ? C.bad : authSoon ? C.warn : undefined },
    settings: {},
  }
  return Box({
    flexDirection: 'row',
    columnGap: 3,
    flexWrap: 'wrap',
    children: TABS.map((t) => {
      const on = t.id === active
      const b = badge[t.id]
      return Button({
        key: 'cockpit-' + t.id,
        label: t.label,
        hotkey: t.hotkey,
        plain: true,
        onPress: () => v.onView(t.id),
        children: [
          Text({ bold: on, underline: on, color: on ? C.accent : undefined, children: [t.label] }),
          ...(b.n ? [Text({ color: b.tone ?? C.faint, children: [' ' + b.n] })] : []),
        ],
      })
    }),
  })
}

// How many rows a tree takes, counted from its shape: a column stacks its
// children, a row takes its tallest, a border adds two, margins add theirs, a
// Text or Button is one row (two for a wrapped long one is not counted). An
// estimate, used only to stop the body's scroll near its end.
export function treeRows(n: any, width = 120): number {
  if (!n || typeof n !== 'object') return 0
  const p = n.props ?? {}
  // A built element keeps its children beside its props; a literal may nest them in props.
  const raw = n.children ?? p.children
  const kids = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((c: any) => c && typeof c === 'object')
  let rows: number
  if (n.type === 'Text' || n.type === 'Button' || n.type === 'Input' || n.type === 'Select') rows = 1
  else if (n.type === 'Client') rows = typeof p.height === 'number' ? p.height : 1
  else if (n.type === 'Code' || n.type === 'Markdown') rows = String(p.source ?? p.text ?? '').split('\n').length
  else if (p.flexDirection === 'row') rows = Math.max(0, ...kids.map((k: any) => treeRows(k, width)))
  else rows = kids.reduce((a: number, k: any) => a + treeRows(k, width), 0)
  if (p.borderStyle) rows += 2
  rows += (p.marginTop ?? p.marginY ?? p.margin ?? 0) + (p.marginBottom ?? p.marginY ?? p.margin ?? 0)
  rows += (p.paddingTop ?? p.paddingY ?? p.padding ?? 0) + (p.paddingBottom ?? p.paddingY ?? p.padding ?? 0)
  return Math.max(0, rows)
}

// Rows the frame takes above the body (status bar, blank, tab row, rule) and
// below it (blank, key legend), so the body window gets the rest.
export const FRAME_TOP = 4
export const FRAME_BOTTOM = 2

// The status bar and tab row stay put; only the body scrolls. The engine
// scrolls a pane's whole tree, so the body is drawn in a box `rows` tall with
// its overflow hidden and pulled up by `offset` rows (the cockpit's own
// scroll, moved in ui.scroll). Without `rows` the body flows as before.
export function frame(
  els: Els,
  v: HomeView,
  active: View,
  body: Node,
  legend: readonly [string, string][] = [],
  win?: { rows: number; offset: number; onMax?: (max: number) => void },
): Node {
  const { Box } = els
  // Tell the caller how far the body can scroll, so the wheel stops at its end.
  win?.onMax?.(Math.max(0, treeRows(body) - win.rows))
  const content = win
    ? Box({ height: win.rows, overflow: 'hidden', flexDirection: 'column', children: [Box({ marginTop: -win.offset, flexDirection: 'column', flexShrink: 0, children: [body] })] })
    : body
  return Box({
    flexDirection: 'column',
    children: [
      ...(v.catcher ? [v.catcher] : []),
      els.Text({ children: [' '] }),
      statusBar(els, v),
      Box({ marginTop: 1, children: [tabBar(els, v, active)] }),
      rule(els, v.width),
      ...(v.help ? [v.help] : [...(v.palette ? [v.palette] : []), content]),
      keys(els, [['1-9', 'tabs'], ['k', 'search'], ...legend, ['alt+/', 'keys'], ['alt+tab', 'back to the prompt']]),
      // A spacer row below (and one above, first): the tree is then always
      // taller than the pane, so the engine has rows to scroll and turns the
      // arrow keys into ui.scroll, which the cockpit answers by moving the
      // focus by layout. register.ts pins the engine's offset at SPACER_ROWS,
      // so neither spacer shows. Every tab, the Web tab too: its page region
      // fills the pane exactly, so without them its arrows did nothing.
      els.Text({ children: [' '] }),
    ],
  })
}

// Rows above the frame that the pinned engine offset hides (see frame()).
export const SPACER_ROWS = 1

// ---- 지금 --------------------------------------------------------------------

// A group: rounded border and a title; the title switches to the tab that has
// the full view, so a group is a summary, never a dead end.
function group(els: Els, v: HomeView, key: string, title: string, to: View, note: string, body: Node[], tone?: string): Node {
  const { Box, Button, Text } = els
  return Box({
    key: 'group-' + key,
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: tone ?? C.faint,
    paddingX: 1,
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [
          Button({
            key: 'home-' + key,
            label: title,
            plain: true,
            onPress: () => v.onView(to),
            children: [Text({ bold: true, color: tone, children: [title] }), Text({ color: C.faint, children: [' › ' + TABS.find((t) => t.id === to)!.label] })],
          }),
          Text({ color: C.muted, children: [note] }),
        ],
      }),
      ...body,
    ],
  })
}

function sub(els: Els, text: string): Node {
  return els.Box({ marginTop: 1, children: [els.Text({ color: C.muted, children: [text] })] })
}

// 진행: the current request and its answer, the work running for it, and what
// the Monitors last saw — one picture of "now" instead of three cards.
function nowGroup(els: Els, v: HomeView, w: number): Node {
  const prompts = v.flow.filter((f) => f.kind === 'prompt')
  const last = prompts[prompts.length - 1]
  const working = v.state === 'working'
  const body: Node[] = []
  if (last) {
    body.push(line(els, working ? '⏳' : '❯', working ? C.warn : C.accent, clip(last.text, w - 10), hhmm(last.at), true))
    const answer = v.flow.filter((f) => f.turnId === last.turnId && f.kind !== 'prompt' && f.kind !== 'progress').slice(0, 2)
    for (const f of answer) {
      const tone = f.kind === 'conclusion' ? C.ok : f.kind === 'decision' ? C.warn : f.kind === 'finding' ? C.merged : C.muted
      body.push(els.Box({ paddingLeft: 2, children: [line(els, f.kind === 'conclusion' ? '◆' : f.kind === 'decision' ? '⚖' : '·', tone, clip(f.text.replace(/^§ /, ''), w - 6))] }))
    }
  } else body.push(quiet(els, 'No requests yet.'))

  const running = v.agents.filter(isRunning)
  const failed = v.agents.filter((a) => a.status === 'failed' && v.now - (a.endedAt ?? a.startedAt) < 30 * 60_000)
  if (running.length || failed.length) {
    body.push(sub(els, 'Work'))
    for (const a of [...failed, ...running].slice(0, 4)) {
      const bad = a.status === 'failed'
      body.push(line(els, bad ? '✗' : a.kind === 'bg' ? '⚙' : '●', bad ? C.bad : C.warn, clip(a.description, w - 14), duration((a.endedAt ?? v.now) - a.startedAt)))
    }
  }

  // Every watch still running, not only the recent ones: a quiet watch is the
  // one most easily forgotten.
  const live = [...v.monitors].sort((a, b) => b.at - a.at)
  const follows = v.follows ?? []
  if (live.length || follows.length) {
    body.push(sub(els, 'Watch'))
    const row = (id: string, glyph: string, tone: string, text: string, meta: string, onStop?: () => void) => {
      const on = v.watchSel === id
      body.push(
        els.Button({
          key: 'home-watch-' + id,
          label: text,
          plain: true,
          onPress: () => v.onWatchSelect?.(on ? '' : id),
          children: [
            els.Text({ color: tone, children: [(on ? '▸ ' : '') + glyph + ' '] }),
            els.Text({ bold: on, children: [clip(text, w - 16)] }),
            els.Text({ color: C.faint, children: ['  ' + meta] }),
          ],
        }),
      )
      if (on && onStop)
        body.push(
          els.Box({
            paddingLeft: 2,
            children: [els.Button({ key: 'home-watch-stop-' + id, label: 'stop this watch', variant: 'primary', onPress: onStop, children: [els.Text({ children: ['■ stop'] })] })],
          }),
        )
    }
    for (const m of live)
      row('m:' + m.taskId, m.mattered ? '❗' : '⟳', m.mattered ? C.warn : C.accent, m.summary, ago(m.at, v.now) + (m.held ? ' · held' : ''), v.onStopMonitor ? () => v.onStopMonitor!(m.taskId) : undefined)
    for (const f of follows) row('f:' + f.key, '💬', C.accent, 'auto follow-up · ' + f.title, 'slack', v.onStopFollow ? () => v.onStopFollow!(f.key) : undefined)
  }
  const note = working ? 'working' : v.state === 'waiting' ? 'waiting' : last ? 'done' : ''
  return group(els, v, 'now', 'In progress', 'flow', note, body, failed.length ? C.bad : working || running.length ? C.warn : undefined)
}

// Model: which account and model served the last request (ccproxy), how this
// session splits across them, its output over the last hour, and each
// account's remaining quota (the ccproxy rows of the auth radar).
function modelGroup(els: Els, v: HomeView, w: number): Node {
  const body: Node[] = []
  const u = v.usage
  if (u?.last) {
    const l = u.last
    body.push(line(els, '◆', C.accent, (l.account ?? '?') + ' · ' + shortModel(l.model) + (l.effort ? ' · ' + l.effort : ''), ago(l.at * 1000, v.now), true))
    body.push(els.Box({ paddingLeft: 2, children: [els.Text({ color: C.muted, children: [clip((l.reason ? 'why: ' + l.reason + ' · ' : '') + (l.ms / 1000).toFixed(1) + 's · out ' + kTokens(l.tokens.output) + ' · cache ' + kTokens(l.tokens.cache_read), w - 4)] })] }))
    const split = (title: string, gs: Usage['accounts'], name: (n: string) => string) =>
      body.push(els.Box({ paddingLeft: 2, children: [els.Text({ color: C.muted, children: [clip(title + gs.slice(0, 3).map((g) => name(g.name) + ' ' + share(g.requests, u.requests)).join(' · '), w - 4)] })] }))
    split('accounts  ', u.accounts, (n) => n)
    split('models    ', u.models, shortModel)
    const out = u.trend.map((b) => b.output)
    const mins = Math.round((u.trend.length * u.bucket_seconds) / 60)
    body.push(els.Box({ paddingLeft: 2, flexDirection: 'row', children: [els.Text({ color: C.muted, children: ['output    '] }), els.Text({ color: C.accent, children: [sparkline(out)] }), els.Text({ color: C.faint, children: ['  last ' + mins + 'm · ' + u.requests + ' requests'] })] }))
  } else {
    body.push(quiet(els, v.usageNote ?? 'No requests through ccproxy yet.'))
  }
  const quota = v.auth.filter((a) => a.id.startsWith('ccproxy:'))
  if (quota.length) {
    body.push(sub(els, 'Quota'))
    const lastAccount = u?.last?.account
    for (const q of quota) {
      const name = q.id.slice('ccproxy:'.length)
      const tone = q.state === 'expired' ? C.bad : q.state === 'soon' ? C.warn : name === lastAccount ? C.accent : C.muted
      body.push(line(els, name === lastAccount ? '●' : '○', tone, clip(name + '  ' + (q.detail ?? ''), w - 4)))
    }
  }
  return group(els, v, 'model', 'Model', 'usage', u ? u.requests + ' requests' : '', body)
}

// 이번 세션: earlier requests with their conclusion, then what came out of
// them — the history and the results side by side with "now".
function sessionGroup(els: Els, v: HomeView, w: number): Node {
  const prompts = v.flow.filter((f) => f.kind === 'prompt')
  const earlier = prompts.slice(-4, -1).reverse()
  const body: Node[] = []
  for (const p of earlier) {
    const concl = v.flow.find((f) => f.turnId === p.turnId && (f.kind === 'conclusion' || f.kind === 'decision'))
    body.push(line(els, '❯', C.muted, clip(p.text, w - 10), hhmm(p.at)))
    if (concl) body.push(els.Box({ paddingLeft: 2, children: [quiet(els, '↳ ' + clip(concl.text.replace(/^§ /, ''), w - 6))] }))
  }
  const outs = v.outputs.filter((o) => o.kind !== 'file' && o.kind !== 'commit' && isMade(o))
  const related = v.outputs.filter((o) => !isMade(o)).length
  if (outs.length || related) {
    body.push(sub(els, 'Outputs ' + outs.length + (related ? ' · inputs ' + related : '')))
    for (const o of outs.slice(-4).reverse()) {
      const pr = o.kind === 'pr' ? v.prs.find((x) => x.key === o.title) : undefined
      const tone = pr ? prTone(pr) : C.muted
      const meta = pr ? (needLabel(pr) ?? prLine(pr).split(' · ')[0]!) : ago(o.at, v.now)
      const url = o.url ?? pr?.url
      // A row with a link opens it on a press. A Button holds only Text, so it
      // carries the glyph, title and meta inline instead of line()'s boxes.
      body.push(
        url
          ? els.Box({
              flexDirection: 'row',
              children: [
                els.Button({ key: 'home-out-' + o.id, label: o.title, plain: true, onPress: () => v.onOpenUrl(url), children: [els.Text({ color: tone, children: [KIND_GLYPH[o.kind] + ' '] }), els.Text({ children: [clip(o.title, w - 16)] })] }),
                els.Box({ flexGrow: 1 }),
                els.Text({ color: C.faint, children: [' ' + meta] }),
              ],
            })
          : line(els, KIND_GLYPH[o.kind], tone, clip(o.title, w - 16), meta),
      )
    }
  }
  const done = v.agents.filter((a) => a.status === 'completed').length
  const note = [prompts.length ? prompts.length + ' requests' : '', done ? done + ' tasks' : ''].filter(Boolean).join(' · ')
  return group(els, v, 'session', 'This session', 'outputs', note, body.length ? body : [quiet(els, 'Nothing recorded yet.')])
}

// Beyond this session: other windows whose Claude waits on the person (a
// press jumps there), and today's to-dos from the dayx brief.
const ATTN = { action: { g: '❗', t: 'needs action', c: C.bad }, ask: { g: '❓', t: 'waiting for you', c: C.warn }, idle: { g: '💤', t: 'idle', c: C.faint }, working: { g: '⏳', t: 'working', c: C.muted } } as const

function elsewhereGroup(els: Els, v: HomeView, w: number): Node | undefined {
  const { Box, Button, Text } = els
  const ws = (v.elsewhere ?? []).filter((x) => x.attention === 'action' || x.attention === 'ask')
  const busy = (v.elsewhere ?? []).filter((x) => x.attention === 'working')
  const idle = (v.elsewhere ?? []).filter((x) => x.attention === 'idle').length
  const todos = (v.todos ?? []).filter((t) => t.kind !== 'summary')
  const summary = (v.todos ?? []).find((t) => t.kind === 'summary')
  if (!ws.length && !busy.length && !todos.length && !summary) return undefined
  const rows: Node[] = []
  // ⧉ beside each: that session's identity, for handing it to another session.
  const copy = (x: Elsewhere) =>
    v.onShareOther && x.session ? [Button({ key: 'share-' + x.target, label: 'copy ' + x.window + "'s identity", plain: true, onPress: () => v.onShareOther!(x), children: [Text({ color: C.accent, children: ['⧉'] })] })] : []
  const row = (x: Elsewhere, parts: Node[]) =>
    Box({ flexDirection: 'row', columnGap: 1, children: [...copy(x), v.onWindow ? Button({ key: 'win-' + x.target, label: x.window, plain: true, onPress: () => v.onWindow!(x.target), children: parts }) : Box({ flexDirection: 'row', children: parts })] })
  for (const x of [...ws.slice(0, 8), ...busy.slice(0, 6)]) {
    const a = ATTN[x.attention]
    const parts = [
      Text({ color: a.c, children: [a.g + ' '] }),
      Text({ bold: true, children: [clip(x.window, 22).padEnd(22)] }),
      Text({ color: a.c, children: [' ' + a.t] }),
      Text({ color: C.muted, children: [x.title ? ' · ' + clip(x.title, Math.max(10, w - 60)) : ''] }),
      Text({ color: C.faint, children: [x.since ? '  ' + since(x.since, v.now) : ''] }),
    ]
    rows.push(row(x, parts))
  }
  if (ws.length > 8) rows.push(Text({ color: C.muted, children: ['  +' + (ws.length - 8) + ' more windows waiting'] }))
  if (idle) rows.push(Text({ color: C.faint, children: ['💤 ' + idle + ' idle sessions'] }))
  if (todos.length || summary) {
    rows.push(Box({ marginTop: rows.length ? 1 : 0, flexDirection: 'row', children: [Text({ bold: true, children: ['Today'] }), Text({ color: C.faint, children: [summary ? '  ' + clip(summary.text, w - 8) : ''] })] }))
    const ICON = { due: '⏰', open: '◻', turn: '→', summary: '' } as const
    for (const t of todos.slice(0, 6)) rows.push(Text({ color: t.kind === 'due' ? C.warn : undefined, children: [ICON[t.kind] + ' ' + clip(t.text, w - 3)] }))
  }
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: ws.some((x) => x.attention === 'action') ? C.bad : C.faint,
    paddingX: 1,
    children: [Text({ bold: true, children: ['Elsewhere'] }), ...rows],
  })
}

export function renderHome(els: Els, v: HomeView): Node {
  const { Box } = els
  const two = v.width >= 96
  const colW = two ? Math.floor((v.width - 1) / 2) - 4 : v.width - 4
  const needs = needsCard(els, v, v.width - 4)
  const goal = goalCard(els, v, v.width - 4)
  const rca = rcaCard(els, v, v.width - 4)
  const login = v.login && v.onLogin ? mcpLoginCard(els, v.login, v.onLogin) : undefined
  const groups = [nowGroup(els, v, colW), sessionGroup(els, v, colW)]
  const model = modelGroup(els, v, v.width - 4)
  const away = elsewhereGroup(els, v, v.width - 4)
  const body = Box({
    flexDirection: 'column',
    children: [
      ...(rca ? [Box({ marginTop: 1, children: [rca] })] : []),
      ...(login ? [Box({ marginTop: 1, children: [login] })] : []),
      ...(goal ? [Box({ marginTop: 1, children: [goal] })] : []),
      ...(needs ? [Box({ marginTop: 1, children: [needs] })] : []),
      Box({
        marginTop: 1,
        flexDirection: two ? 'row' : 'column',
        columnGap: 1,
        children: two ? groups.map((g) => Box({ flexDirection: 'column', width: '50%', children: [g] })) : groups,
      }),
      Box({ marginTop: 1, flexDirection: 'column', children: [model] }),
      ...(away ? [Box({ marginTop: 1, flexDirection: 'column', children: [away] })] : []),
    ],
  })
  return frame(els, v, 'home', body, [['Tab', 'move']], v.win)
}

// RCA mode's card: the alert, what was granted for it and until when, and
// the way out. On top of the Now tab while it is on.
function rcaCard(els: Els, v: HomeView, w: number): Node | undefined {
  const r = v.rca
  if (!r || !v.onRca) return undefined
  const { Box, Button, Text } = els
  const left = Math.max(0, Math.round((r.until - v.now) / 60_000))
  const labels = ['env', 'product', 'sbregion', 'service', 'severity'].map((k) => r.alert.labels[k]).filter(Boolean).join(' · ')
  return Box({
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: C.bad,
    paddingX: 1,
    children: [
      Text({ bold: true, color: C.bad, children: ['🚨 RCA  ' + (left >= 60 ? Math.floor(left / 60) + 'h' + (left % 60 ? (left % 60) + 'm' : '') : left + 'm') + ' left'] }),
      Button({ key: 'rca-thread', label: 'open the alert thread', plain: true, onPress: () => v.onRca!('thread'), children: [Text({ bold: true, wrap: 'wrap', children: [clip(r.alert.title, 300)] })] }),
      ...(labels ? [Text({ color: C.muted, children: [clip(labels, w)] })] : []),
      Text({ color: C.faint, children: ['granted for it:'] }),
      ...r.grants.map((g) => Text({ color: C.warn, children: ['  ✓ ' + clip(g.label, w - 4)] })),
      Box({
        flexDirection: 'row',
        columnGap: 3,
        children: [
          Button({ key: 'rca-extend', label: 'extend 1h', plain: true, onPress: () => v.onRca!('extend'), children: [Text({ color: C.accent, children: ['+1h'] })] }),
          Button({ key: 'rca-end', label: 'end RCA', plain: true, onPress: () => v.onRca!('end'), children: [Text({ color: C.muted, children: ['✕ end RCA (revert the grants)'] })] }),
        ],
      }),
    ],
  })
}

// The /goal card: the condition, how long it has run, how many turns the
// evaluator has judged and its words on the last one. Claude Code shows the
// verdict only in the transcript, folded; this keeps it in sight.
function goalCard(els: Els, v: HomeView, w: number): Node | undefined {
  const g = v.goal
  if (!goalVisible(g ?? null, v.now) || !g) return undefined
  const { Box, Button, Text } = els
  const tone = g.active ? C.accent : g.met ? C.ok : C.muted
  const state = g.active
    ? 'pursuing · set ' + ago(g.setAt * 1000, v.now) + ' ago' + (g.checks ? ' · ' + g.checks + ' checks, last ' + ago(g.lastAt * 1000, v.now) + ' ago' : ' · not checked yet')
    : g.ended === 'met'
      ? 'met ' + ago(g.endedAt * 1000, v.now) + ' ago after ' + g.checks + ' checks'
      : g.ended === 'error'
        ? 'stopped by an error ' + ago(g.endedAt * 1000, v.now) + ' ago: run /goal again to continue'
        : 'cleared ' + ago(g.endedAt * 1000, v.now) + ' ago'
  const rows: Node[] = [
    Text({ bold: true, wrap: 'wrap', children: ['🎯 ' + clip(g.condition, 400)] }),
    Text({ color: C.muted, children: [clip(state, w)] }),
  ]
  if (g.reason) {
    rows.push(Text({ color: C.faint, children: [g.met ? 'evaluator:' : 'not yet, says the evaluator:'] }))
    // The verdict is what to work on next: show it whole, wrapped.
    rows.push(Box({ paddingLeft: 2, children: [Text({ wrap: 'wrap', children: [clip(g.reason, 600)] })] }))
  }
  if (g.active && v.onGoal) {
    rows.push(
      Box({
        flexDirection: 'row',
        columnGap: 3,
        children: [
          Button({ key: 'goal-clear', label: 'clear goal', plain: true, onPress: () => v.onGoal!('clear'), children: [Text({ color: C.muted, children: ['✕ clear goal'] })] }),
        ],
      }),
    )
  }
  return Box({ flexDirection: 'column', borderStyle: 'round', borderColor: tone, paddingX: 1, children: [Text({ bold: true, color: tone, children: ['Goal'] }), ...rows] })
}

// ---- 감시 detail -------------------------------------------------------------

export function renderWatch(els: Els, v: { monitors: readonly MonitorState[]; now: number; width: number }): Node {
  const { Box, Text } = els
  const ms = [...v.monitors].sort((a, b) => b.at - a.at)
  if (!ms.length) return quiet(els, 'No Monitors.')
  const w = v.width - 6
  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      Text({ color: C.muted, children: ['The model reads every Monitor event. Routine ones (nothing changed, nothing for you) stay out of the transcript.'] }),
      ...ms.map((m) =>
        Box({
          key: 'watch-' + m.taskId,
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: m.mattered ? C.warn : C.faint,
          paddingX: 1,
          children: [
            line(els, m.mattered ? '❗' : m.mattered === false ? '✓' : '⟳', m.mattered ? C.warn : C.accent, clip(m.summary, w - 14), ago(m.at, v.now), true),
            Text({ color: C.muted, children: ['last event  ' + clip(m.label, w - 14)] }),
            ...(m.outcome ? [Text({ children: ['outcome     ' + clip(m.outcome, w - 14)] })] : []),
            Text({
              color: C.faint,
              children: ['shown ' + m.acted + ' · folded ' + m.quiet + (m.held ? ' · held by cockpit' : m.rearms ? ' · ↻ re-armed ' + m.rearms + '×' : '') + (m.armedAt ? ' · up ' + ago(m.armedAt, v.now) : '') + (m.pr ? ' · ' + m.pr : '')],
            }),
          ],
        }),
      ),
    ],
  })
}


// The narwhal runs this session started, in the Work tab beside its
// subagents and Monitors: each run's state and progress, and its tasks one
// line each. A press opens the run's monitor, where the graph, timeline
// and grounds are; the cockpit does not redraw them.
const RUN_TONE: Record<string, string> = { active: C.warn, done: C.ok, failed: C.bad, cancelled: C.muted }
const TASK_ICON: Record<string, string> = { pending: '·', ready: '○', dispatched: '⏳', completed: '✅', failed: '❌' }

export function renderNarwhalRuns(els: Els, v: { runs: readonly NarwhalRun[]; now: number; width: number; onOpen: (r: NarwhalRun) => void }): Node {
  const { Box, Button, Text } = els
  if (!v.runs.length) return quiet(els, 'No narwhal runs from this session.')
  const w = v.width - 6
  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: v.runs.map((r) => {
      const tone = r.waiting ? C.warn : RUN_TONE[r.state] ?? C.muted
      const started = Date.parse(r.started_at) || v.now
      return Box({
        key: 'nwrun-' + r.run_id,
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: r.state === 'active' ? C.warn : C.faint,
        paddingX: 1,
        children: [
          Button({
            key: 'nwrun-open-' + r.run_id,
            label: r.request,
            plain: true,
            onPress: () => v.onOpen(r),
            children: [
              Text({ color: tone, children: [(r.state === 'active' ? '⏳ ' : r.state === 'done' ? '✅ ' : r.state === 'failed' ? '❌ ' : '⨯ ')] }),
              Text({ bold: true, children: [clip(r.request, Math.max(16, w - 30))] }),
              Text({ color: C.faint, children: ['  ' + ago(started, v.now)] }),
            ],
          }),
          Text({ color: tone, children: ['   ' + runProgress(r) + '  ·  ' + r.run_id] }),
          ...r.tasks.map((t) =>
            Text({
              color: t.state === 'failed' ? C.bad : t.state === 'completed' ? undefined : C.muted,
              children: ['   ' + (TASK_ICON[t.state] ?? '·') + ' ' + clip(t.name || t.id, 24) + (t.model ? '  ' + t.model : '') + (t.outcome ? '  — ' + clip(t.outcome, Math.max(10, w - 44)) : '')],
            }),
          ),
          ...(r.answer ? [Text({ color: C.muted, children: ['   ↳ ' + clip(r.answer, w - 6)] })] : []),
        ],
      })
    }),
  })
}
