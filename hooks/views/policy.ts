// /policy: session capabilities as rows you can flip, mode presets, scoped
// grants, and timed grants. Only a person reaches this pane, which is the
// point: a change here is a human decision, never Claude's.
//
// Each row says what is in force now as a colored chip — 🔓 허용 (warning: a
// gate is open), 🔒 차단 (success: safe), · 기본 (muted: existing guards
// decide) — followed by three buttons. The first version showed a Select
// reading `inherit ▾ → block`, which mixed the setting with its effect.

import { CAPS, MODES, SCOPED, slackDefaultTargets, resolveCap, shortName, type Cap, type CapValue, type Policy, type ScopeHint } from '../lib/policy'
import { routeLabel, type RouteDecision, type RouteSettings } from '../lib/route'
import { C, col, field, header, keys, row, section, type Els, type Node } from './common'

export type PolicyView = {
  // Drawn inside a cockpit tab: the tab bar is the header and the legend.
  embedded?: boolean
  policy: Policy
  timers: Record<string, number> // label -> expiresAt
  now: number
  message?: string
  width: number
  onSet: (cap: Cap, v: CapValue) => void
  onMode: (mode: string) => void
  onScope: (cap: Cap, scope: string) => void
  onTimed: (cap: Cap, minutes: number) => void
  hints?: readonly ScopeHint[] // scopes this session used or was blocked on
  onHint?: (h: ScopeHint) => void
  onUnscope?: (cap: Cap, scope: string) => void // a ✕ on an allowed target
  labels?: Readonly<Record<string, string>> // Slack id -> #channel / @person
  more?: string // the capability whose "known" candidates are listed in full
  onMore?: (cap: Cap) => void
}

const WHY: Record<ScopeHint['why'], string> = { blocked: 'just blocked', used: 'used here', pr: 'PR here', thread: 'thread here', cwd: 'this repo', known: 'known' }

const HELP: Record<Cap, string> = {
  gh_merge: 'gh pr merge',
  prod_eks_access: 'prod EKS kubectl (read)',
  prod_eks_write: 'prod EKS kubectl (write)',
  auto_continue: 'continue obvious next steps; a plain "shall I?" is answered for you',
  auto_effort: 'Jev picks each turn\'s effort (allow = on)',
  auto_model: 'light work to Sonnet too; re-caches on a switch (allow = on)',
  tmux_window_escape: 'tmux outside my window',
  slack_send: 'Slack sends without asking (review channel always)',
}

const MODE_HELP: Record<string, string> = {
  default: 'defaults',
  locked: 'all locked',
  autopilot: 'auto-continue+effort',
  'pr-merge': 'merge',
  'prod-readonly': 'prod read',
  'prod-write': 'prod write',
  release: 'merge+prod read+auto+effort',
}

function effect(els: Els, v: CapValue, scoped: boolean): Node {
  const { Text } = els
  if (v === 'allow') return Text({ color: C.warn, bold: true, children: ['🔓 allow  '] })
  if (v === 'block') return Text({ color: scoped ? C.warn : C.ok, children: [scoped ? '◐ scoped ' : '🔒 block  '] })
  return Text({ color: C.muted, children: ['·  inherit'] })
}

export function renderPolicy(els: Els, v: PolicyView): Node {
  const { Text, Button, Input, Box } = els
  const open = CAPS.filter((c) => v.policy.caps[c] === 'allow' || v.policy.scopes[c]).length
  const top = v.embedded ? undefined : header(els, 'policy', 'mode ' + v.policy.mode + (open ? ' · ' + open + ' open gates' : ' · all default/blocked'), v.width)

  const modes = Box({
    flexDirection: 'row',
    columnGap: 2,
    flexWrap: 'wrap',
    children: MODES.map((m) => {
      const on = v.policy.mode === m
      return Button({
        key: 'mode-' + m,
        label: m,
        plain: true,
        onPress: () => v.onMode(m),
        children: [Text({ bold: on, underline: on, color: on ? C.accent : undefined, children: [m] }), Text({ color: C.faint, children: [' ' + (MODE_HELP[m] ?? '')] })],
      })
    }),
  })

  const caps: Node[] = CAPS.map((cap) => {
    const set = v.policy.explicit[cap] ?? 'inherit'
    const eff = v.policy.caps[cap]
    const scopes = v.policy.scopes[cap]
    const choice = (value: CapValue, label: string) =>
      Button({
        key: 'cap-' + cap + '-' + value,
        label,
        plain: true,
        onPress: () => v.onSet(cap, value),
        children: [Text({ bold: set === value, color: set === value ? C.accent : C.muted, children: [(set === value ? '[' + label + ']' : ' ' + label + ' ')] })],
      })
    return Box({
      key: 'cap-' + cap,
      flexDirection: 'column',
      children: [
        row(els, [
          Text({ bold: true, children: [shortName(cap).padEnd(7)] }),
          effect(els, eff, !!scopes),
          choice('allow', 'allow'),
          choice('block', 'block'),
          choice('inherit', 'inherit'),
          ...(cap !== 'tmux_window_escape' && cap !== 'auto_continue' && cap !== 'auto_effort' && cap !== 'auto_model' && cap !== 'slack_send'
            ? [Button({ key: 'timed-' + cap, label: '15m', plain: true, onPress: () => v.onTimed(cap, 15), children: [Text({ color: C.muted, children: ['  ⏱ 15m only'] })] })]
            : []),
        ]),
        Box({
          paddingLeft: 8,
          children: [Text({ color: C.muted, children: [HELP[cap] + (scopes ? '  ·  ' + scopes.length + ' allowed below' : '')] })],
        }),
      ],
    })
  })

  const timed = Object.entries(v.timers).filter(([, t]) => t > v.now)
  return col(els, [
    ...(top ? [top] : []),
    section(els, 'Mode'),
    modes,
    section(els, 'Capabilities', 'in effect · set to'),
    ...caps,
    section(els, 'Allowed targets', '✕ removes · + allows'),
    ...SCOPED.map(({ cap }) => targetRows(els, v, cap)),
    field(
      els,
      Input({
        key: 'scope-input',
        label: 'allow',
        placeholder: 'merge owner/repo · prod ctx/ns · prod-w ctx/ns · slack #channel · slack @person',
        value: '',
        submitLabel: 'allow',
        onSubmit: (text) => {
          const [c, ...rest] = text.trim().split(/\s+/)
          const cap = resolveCap(c)
          const scope = rest.join(' ')
          if (cap && scope) v.onScope(cap, scope)
        },
      }),
    ),
    ...(timed.length
      ? [Text({ color: C.warn, children: ['⏱ ' + timed.map(([k, t]) => k + ' · ' + Math.ceil((t - v.now) / 60000) + 'm until revert').join('   ')] })]
      : []),
    ...(v.message ? [Text({ color: v.message.startsWith('failed') ? C.bad : C.ok, children: [v.message] })] : []),
    ...(v.embedded
      ? []
      : [
          keys(els, [
      ['Tab', 'move'],
      ['Enter', 'select'],
      ['Esc', 'close'],
          ]),
        ]),
  ])
}

// One capability's targets, as a list a person picks from: what is allowed
// now (✓, ✕ takes it back), then what this session touched (+, one press to
// allow: blocked commands, prod contexts used, PR and cwd repos, Slack threads
// and sends), then what this machine knows (kubeconfig prod contexts, recent
// sessions' repos, Slack channels seen) folded behind "N known ▸".
function targetRows(els: Els, v: PolicyView, cap: Cap): Node {
  const { Box, Button, Text } = els
  const label = (s: string) => v.labels?.[s.toUpperCase()] ?? v.labels?.[s] ?? s
  const eff = v.policy.caps[cap]
  const allowed = v.policy.scopes[cap] ?? []
  const fixed = cap === 'slack_send' ? Object.entries(slackDefaultTargets()) : []
  const hints = (v.hints ?? []).filter((h) => h.cap === cap)
  const seen = hints.filter((h) => h.why !== 'known')
  const known = hints.filter((h) => h.why === 'known')
  const open = v.more === cap
  const item = (key: string, parts: Node[], press?: () => void) =>
    Box({ paddingLeft: 8, children: [press ? Button({ key, label: key, plain: true, onPress: press, children: parts }) : Box({ key, flexDirection: 'row', children: parts })] })
  const hintRow = (h: ScopeHint) =>
    item(
      'hint-' + h.cap + '-' + h.scope,
      [
        Text({ color: h.why === 'blocked' ? C.warn : C.accent, children: ['+ '] }),
        Text({ children: [label(h.scope)] }),
        Text({ color: h.why === 'blocked' ? C.warn : C.faint, children: ['  ' + WHY[h.why] + (h.cap === 'prod_eks_write' ? ' · 15m' : '')] }),
      ],
      v.onHint ? () => v.onHint!(h) : undefined,
    )
  const state = eff === 'allow' ? 'every target allowed' : eff === 'block' ? 'blocked except the list' : 'existing guards ask'
  return Box({
    key: 'targets-' + cap,
    flexDirection: 'column',
    children: [
      Box({ flexDirection: 'row', columnGap: 1, children: [Box({ width: 7, flexShrink: 0, children: [Text({ bold: true, children: [shortName(cap)] })] }), Text({ color: eff === 'allow' ? C.warn : C.faint, children: [state] })] }),
      ...fixed.map(([id, name]) => item('scope-fixed-' + id, [Text({ color: C.ok, children: ['✓ '] }), Text({ children: [name] }), Text({ color: C.faint, children: ['  default'] })])),
      ...allowed.map((s) =>
        item('scope-rm-' + cap + '-' + s, [Text({ color: C.ok, children: ['✓ '] }), Text({ bold: true, children: [label(s)] }), Text({ color: C.faint, children: ['  ✕ remove'] })], v.onUnscope ? () => v.onUnscope!(cap, s) : undefined),
      ),
      ...seen.slice(0, 8).map(hintRow),
      ...(known.length
        ? [
            ...(open ? known.slice(0, 30).map(hintRow) : []),
            item('more-' + cap, [Text({ color: C.muted, children: [open ? '▾ hide known' : '▸ ' + known.length + ' known' + (cap === 'gh_merge' ? ' repos' : cap === 'slack_send' ? ' channels' : ' prod contexts')] })], v.onMore ? () => v.onMore!(cap) : undefined),
          ]
        : []),
    ],
  })
}

// The Routing section under the policy: what Jev picked last. On and off are
// the auto_effort / auto_model rows above (lib/route.ts routeSettings).
export function renderRoute(els: Els, v: { settings: RouteSettings; last?: RouteDecision }): Node {
  const { Text } = els
  const state = v.settings.effort ? (v.settings.model ? 'effort and model' : 'effort') : 'off'
  return Text({ color: C.faint, children: ['routing ' + state + ' · last: ' + routeLabel(v.last)] })
}
