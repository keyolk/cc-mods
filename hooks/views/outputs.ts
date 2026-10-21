// /outputs: what this session (or every session today) produced — PRs,
// artifacts, scratch files, tickets, links, background tasks — with a preview.
//
// One row per item: a kind label in a fixed column, the title in normal text,
// a colored status for PRs and background tasks, and the age in muted text.
// The selected row is marked ▸ and its preview and actions open under the list.

import type { PrStatus } from '../lib/prs'
import { needLabel, needsAttention, prIacDetail, prLine } from '../lib/prs'
import type { SlackFollow, SlackThreadState } from '../lib/slack'
import { IN_ANSWER, isMade, type Output, type OutputKind } from '../lib/record'
import { ago, clip, pad } from '../lib/text'
import { expStatus, type ExpCheck } from '../lib/exp'
import { C, col, empty, field, header, keys, prTone, row, section, tabRow, type Els, type Node } from './common'

export type OutTab = 'all' | 'pr' | 'artifact' | 'scratch' | 'ticket' | 'slack' | 'link' | 'bg' | 'exp'
// Outputs: what the session made. Inputs: what it was handed, read or
// mentioned (lib/record.ts isMade). The kind tabs filter either side.
export type OutSide = 'out' | 'in'
export type OutScope = 'session' | 'repo' | 'today'

export type Preview =
  | { kind: 'markdown'; text: string }
  | { kind: 'code'; text: string; language?: string; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'tail'; text: string; running: boolean }
  | { kind: 'none'; text: string }

export type OutputsView = {
  // Drawn inside a cockpit tab: the tab bar is the header and the legend.
  embedded?: boolean
  outputs: readonly (Output & { session?: string; window?: string })[]
  prs: Record<string, PrStatus>
  slack?: Readonly<Record<string, SlackThreadState>>
  prNote?: string // why PR status is missing or stale (the GitHub API limit)
  tab: OutTab
  // Words typed in the filter field (matchOutput): narrows every kind tab and
  // both sides, and their counts.
  query?: string
  onQuery?: (q: string) => void
  onFocusQuery?: () => void // `g`: the keyboard to the filter field
  side?: OutSide
  onSide?: (s: OutSide) => void
  scope: OutScope
  selected?: string
  preview?: Preview
  width: number
  now: number
  onTab: (t: OutTab) => void
  onScope: (s: OutScope) => void
  onSelect: (id: string) => void
  onOpen: (o: Output) => void
  onReveal?: (o: Output) => void // its folder in Finder, the file selected
  exp?: Readonly<Record<string, ExpCheck>> // archive folders' checks, by path (lib/exp.ts)
  onCopy: (o: Output) => void
  onContext: (o: Output) => void
  // Slack threads: run sb:slack-followup now, or on each new batch of replies.
  follow?: Readonly<Record<string, SlackFollow>>
  onFollowUp?: (o: Output) => void
  onAutoFollow?: (o: Output, on: boolean) => void
  onKeep: (o: Output) => void
  onDelete: (o: Output) => void
}

// Kind column: glyph + word, padded to one width so titles line up.
const KIND: Record<OutputKind, string> = {
  pr: '⇄ PR     ',
  artifact: '◰ doc    ',
  scratch: '✎ file   ',
  ticket: '◇ Jira   ',
  slack: '# Slack  ',
  link: '↗ link   ',
  bg: '⚙ task   ',
  commit: '● commit ',
  file: '✎ edit   ',
  exp: '▣ archive',
}

const TABS: { id: OutTab; label: string; hotkey: string }[] = [
  { id: 'all', label: 'All', hotkey: 'a' },
  { id: 'pr', label: 'PR', hotkey: 'p' },
  { id: 'artifact', label: 'Docs', hotkey: 'd' },
  { id: 'scratch', label: 'Files', hotkey: 'f' },
  { id: 'ticket', label: 'Jira', hotkey: 'j' },
  { id: 'slack', label: 'Slack', hotkey: 's' },
  { id: 'link', label: 'Links', hotkey: 'l' },
  { id: 'bg', label: 'Tasks', hotkey: 'b' },
  { id: 'exp', label: 'Archive', hotkey: 'e' },
]

const SIDES: { id: OutSide; label: string; hint: string; hotkey: string }[] = [
  { id: 'out', label: 'Outputs', hint: 'made here', hotkey: 'm' },
  { id: 'in', label: 'Inputs', hint: 'brought in, read, mentioned', hotkey: 'n' },
]

const SCOPE_LABEL: Record<OutScope, string> = { session: 'this session', repo: 'this repo', today: 'all today' }

// One side (made, or brought in), then one kind. All leaves out edits and
// commits, which have their own places (the diff, git).
// Words each kind is also found by, beyond its own name: `jira` finds
// tickets, `doc` artifacts, `task` background tasks.
const KIND_WORDS: Record<OutputKind, string> = {
  pr: 'pr pull request github',
  artifact: 'doc docs artifact page',
  scratch: 'file files scratch',
  ticket: 'jira ticket issue',
  slack: 'slack thread channel',
  link: 'link links url',
  bg: 'task tasks bg background monitor',
  commit: 'commit',
  file: 'file files edit',
  exp: 'exp archive folder vendor ticket',
}

// The filter field: every word must appear somewhere in the item — its kind
// (and that kind's words), title, URL, path, detail, or the session window it
// came from — case-insensitive, in any order. `slack infra` is Slack threads
// whose channel or title says infra; `abc-12` is tickets by key.
export function matchOutput(o: Output & { window?: string }, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [o.kind, KIND_WORDS[o.kind], o.title, o.url, o.path, o.detail, o.window].filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}

export function filterOutputs<T extends Output>(list: readonly T[], tab: OutTab, side: OutSide = 'out', query = ''): T[] {
  const mine = list.filter((o) => isMade(o) === (side === 'out') && matchOutput(o, query))
  // A file an answer named (IN_ANSWER) is a deliverable wherever it lives;
  // other edits outside the scratchpad stay out of All and Files.
  const named = (o: Output) => o.kind === 'file' && o.detail === IN_ANSWER
  if (tab === 'all') return mine.filter((o) => (o.kind !== 'file' || named(o)) && o.kind !== 'commit')
  // Files: what an answer handed over first, then the rest, newest first.
  if (tab === 'scratch') {
    const fs = mine.filter((o) => o.kind === 'scratch' || named(o))
    return [...fs.filter((o) => o.detail === IN_ANSWER), ...fs.filter((o) => o.detail !== IN_ANSWER)]
  }
  return mine.filter((o) => o.kind === tab)
}

// Fixed width so the age column lines up whether or not a row has a status.
const STATUS_CELLS = 28

function status(els: Els, o: Output, pr: PrStatus | undefined, slack?: SlackThreadState, note?: string, exp?: ExpCheck): Node {
  const { Text } = els
  const cell = (t: string) => pad(clip(t, STATUS_CELLS), STATUS_CELLS)
  if (o.kind === 'exp' && exp) return Text({ color: exp.sums?.failed.length || exp.sums?.unlisted.length ? C.bad : exp.open.length ? C.warn : C.muted, children: [cell(expStatus(exp) || o.detail || '')] })
  if (o.kind === 'pr' && !pr && note) return Text({ color: C.warn, children: [cell(note)] })
  if (slack) return Text({ color: slack.unseen ? C.warn : C.muted, children: [cell(slack.unseen ? slack.unseen + ' new · ' + (slack.lastFrom ?? '') : slack.replies + ' replies')] })
  if (pr) {
    // The row has room for one thing: what it is stuck on, else where it lands
    // and its plan or diff; the full line is in the detail below the list.
    const bits = prLine(pr).split(' · ')
    const where = [bits.find((b) => b.startsWith('📍')), bits.find((b) => /^(plan |argodiff |✓ applied)/.test(b))].filter(Boolean).join(' · ')
    const short = needLabel(pr) ?? (where || bits[0]!)
    return Text({ color: prTone(pr), children: [cell(short)] })
  }
  return Text({ color: o.kind === 'bg' ? C.warn : C.muted, children: [cell(o.detail ?? (isMade(o) ? '' : 'mentioned'))] })
}

export function renderOutputs(els: Els, v: OutputsView): Node {
  const { Text, Button, Select, Markdown, Code, Image, Box, Input } = els
  const side = v.side ?? 'out'
  const q = v.query ?? ''
  const list = filterOutputs(v.outputs, v.tab, side, q)
  const all = filterOutputs(v.outputs, 'all', side, q)
  const prCount = all.filter((o) => o.kind === 'pr').length
  const failing = all.filter((o) => o.kind === 'pr' && v.prs[o.title] && needsAttention(v.prs[o.title]!) === 'fail').length
  const summary = all.length + ' items' + (prCount ? ' · PR ' + prCount : '') + (failing ? ' · failing ' + failing : '') + (v.prNote ? ' · PR status stale: ' + v.prNote : '')
  const scope = Select({
    key: 'out-scope',
    options: (Object.keys(SCOPE_LABEL) as OutScope[]).map((value) => ({ value, label: SCOPE_LABEL[value] })),
    value: v.scope,
    onSelect: (val) => v.onScope(val as OutScope),
  })
  const top = v.embedded ? undefined : header(els, 'outputs', summary, v.width, scope)
  const tabs = tabRow(
    els,
    TABS.map((t) => ({ ...t, count: t.id === 'all' ? undefined : filterOutputs(v.outputs, t.id, side, q).length || undefined })),
    v.tab,
    (id) => v.onTab(id as OutTab),
  )
  // Which side: outputs (made here) or inputs (brought in). Above the kind
  // tabs, which then filter that side.
  const sides = Box({
    flexDirection: 'row',
    columnGap: 3,
    children: SIDES.map((sd) =>
      Button({
        key: 'side-' + sd.id,
        label: sd.label,
        hotkey: sd.hotkey,
        plain: true,
        onPress: () => v.onSide?.(sd.id),
        children: [
          Text({ color: side === sd.id ? C.accent : C.muted, bold: side === sd.id, children: [(side === sd.id ? '● ' : '○ ') + sd.label + ' ' + filterOutputs(v.outputs, 'all', sd.id, q).length] }),
          Text({ color: C.faint, children: ['  ' + sd.hint] }),
        ],
      }),
    ),
  })
  // The filter field, with a hidden `g` that puts the keyboard in it (drawn
  // after the letter catchers, so it wins the key). Esc leaves the field.
  const filter = v.onQuery
    ? [
        field(
          els,
          Input({
            key: 'out-filter',
            label: 'filter',
            placeholder: 'words in kind, title, URL, path: slack infra · jira abc · pr infra',
            value: q,
            submitLabel: 'filter',
            onInput: (text) => v.onQuery!(text),
            onSubmit: (text) => v.onQuery!(text),
          }),
        ),
        ...(v.onFocusQuery ? [Box({ display: 'none', children: [Button({ key: 'hk-out-filter', label: 'filter', hotkey: 'g', plain: true, onPress: v.onFocusQuery, children: [Text({ children: ['filter'] })] })] })] : []),
        ...(q ? [Button({ key: 'out-filter-clear', label: 'clear filter', plain: true, onPress: () => v.onQuery!(''), children: [Text({ color: C.faint, children: ['  ✕ clear "' + clip(q, 30) + '"'] })] })] : []),
      ]
    : []
  if (list.length === 0) {
    if (q) return col(els, [...(top ? [top] : []), sides, tabs, ...filter, empty(els, 'Nothing matches "' + clip(q, 40) + '".', 'Every word must appear in the kind, title, URL, path or detail. ✕ clears it.')])
    return col(els, [...(top ? [top] : []), sides, tabs, ...filter, empty(els, side === 'in' ? 'No inputs in ' + SCOPE_LABEL[v.scope] + ' yet.' : 'Nothing produced in ' + SCOPE_LABEL[v.scope] + ' yet.', side === 'in' ? 'Slack threads pasted or read, tickets and links mentioned collect here.' : 'PRs, artifacts, scratch files, Jira tickets, links and background tasks collect here.')])
  }

  const titleWidth = Math.max(20, Math.min(70, v.width - 2 - 9 - 2 - 28 - 6))
  const rows: Node[] = list.slice(0, 60).map((o) => {
    const on = v.selected === o.id
    const where = v.scope !== 'session' && o.window ? '  [' + o.window + ']' : ''
    return Button({
      key: 'out-' + o.id,
      label: o.title,
      plain: true,
      onPress: () => v.onSelect(o.id),
      children: [
        Text({ color: on ? C.accent : C.faint, children: [on ? '▸ ' : '  '] }),
        Text({ color: C.muted, children: [KIND[o.kind]] }),
        Text({ bold: on, children: [pad(clip(o.title, titleWidth), titleWidth) + '  '] }),
        status(els, o, o.kind === 'pr' ? v.prs[o.title] : undefined, o.kind === 'slack' ? v.slack?.[o.id] : undefined, v.prNote, o.kind === 'exp' && o.path ? v.exp?.[o.path] : undefined),
        Text({ color: C.accent, children: [o.kind === 'slack' && v.follow?.[slackKey(o.id)]?.auto ? ' ⟳' : o.detail === IN_ANSWER ? ' ★' : '  '] }),
        Text({ color: C.faint, children: ['  ' + ago(o.at, v.now) + where] }),
      ],
    })
  })

  const sel = v.selected ? list.find((o) => o.id === v.selected) : undefined
  const detail: Node[] = []
  if (sel) {
    detail.push(section(els, sel.title, sel.url ?? sel.path))
    detail.push(
      row(els, [
        ...(sel.url || sel.path ? [Button({ key: 'out-open', label: 'open', hotkey: 'o', onPress: () => v.onOpen(sel), variant: 'primary' })] : []),
        ...(sel.path && !sel.url && v.onReveal ? [Button({ key: 'out-reveal', label: 'folder', hotkey: 'r', onPress: () => v.onReveal!(sel) })] : []),
        Button({ key: 'out-copy', label: 'copy', hotkey: 'y', onPress: () => v.onCopy(sel) }),
        Button({ key: 'out-ctx', label: 'add to context', hotkey: 'i', onPress: () => v.onContext(sel) }),
        ...(sel.kind === 'slack' && v.onFollowUp
          ? [
              Button({ key: 'out-follow', label: 'follow up', hotkey: 'u', onPress: () => v.onFollowUp!(sel) }),
              Button({
                key: 'out-auto-follow',
                label: v.follow?.[slackKey(sel.id)]?.auto ? 'auto follow-up: on' : 'auto follow-up: off',
                hotkey: 'w',
                onPress: () => v.onAutoFollow?.(sel, !v.follow?.[slackKey(sel.id)]?.auto),
              }),
            ]
          : []),
        ...(sel.kind === 'scratch'
          ? [Button({ key: 'out-keep', label: 'keep', hotkey: 'k', onPress: () => v.onKeep(sel) }), Button({ key: 'out-del', label: 'delete', onPress: () => v.onDelete(sel) })]
          : []),
      ], 2),
    )
    // An infra PR: its projects' plans and windows, or the apps it changes.
    const pr = sel.kind === 'pr' ? v.prs[sel.title] : undefined
    const iac = pr ? [prLine(pr), ...prIacDetail(pr)] : []
    if (iac.length) detail.push(Box({ marginTop: 1, flexDirection: 'column', children: iac.map((l) => Text({ color: /✗|⛔/.test(l) ? C.bad : /🕒|⏳|↻/.test(l) ? C.warn : C.muted, children: [clip(l, v.width - 2)] })) }))
    const p = v.preview
    if (p) {
      let body: Node | undefined
      if (p.kind === 'markdown') body = Markdown({ key: 'out-md', text: p.text })
      else if (p.kind === 'code') body = Code({ source: p.text, language: p.language, path: p.path, wrap: 'truncate-end' })
      else if (p.kind === 'image' && Image) body = Image({ key: 'out-img', source: { file: p.path, format: 'png' }, columns: Math.min(100, v.width - 4), rows: 24, alt: p.path })
      else if (p.kind === 'tail') body = col(els, [Text({ color: p.running ? C.warn : C.ok, children: [p.running ? '⏳ running · last 30 lines' : '✓ done · last 30 lines'] }), Code({ source: p.text, wrap: 'truncate-end' })])
      else if (p.kind === 'none') body = Text({ color: C.muted, children: [p.text] })
      if (body) detail.push(Box({ marginTop: 1, borderStyle: 'round', borderColor: C.faint, paddingX: 1, flexDirection: 'column', children: [body] }))
    }
  }

  return col(els, [
    ...(top ? [top] : []),
    sides,
    tabs,
    ...filter,
    Text({ children: [''] }),
    ...rows,
    ...(list.length > 60 ? [Text({ color: C.muted, children: ['… ' + (list.length - 60) + ' more'] })] : []),
    ...detail,
    ...(v.embedded
      ? []
      : [
          keys(els, [
      ['a p d f j l b', 'kind'],
      ['Enter', 'preview'],
      ['o', 'open'],
      ['r', 'folder'],
      ['y', 'copy'],
      ['i', 'context'],
      ['Esc', 'close'],
          ]),
        ]),
  ])
}

// A Slack output's id is slack:<channel>:<root>; the follow state is keyed by
// channel:root, as slackSeen is.
function slackKey(id: string): string {
  return id.split(':').slice(1).join(':')
}
