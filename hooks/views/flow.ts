// /flow: the session as prompts and conclusions only — no tool calls.
//
// Each request is a block: its time and text in bold, then the answer's
// conclusion, decisions and findings indented under it with a colored glyph.
// Background and progress lines stay readable but muted, so the eye lands on
// the request and the conclusion first.

import { FLOW_ICON } from '../lib/flow'
import type { FlowEntry, FlowKind } from '../lib/record'
import { clip, hhmm, width } from '../lib/text'
import { C, col, empty, header, keys, row, tabRow, type Els, type Node } from './common'

export type FlowFilter = 'all' | 'conclusions' | 'decisions' | 'agents'

export type FlowView = {
  // Drawn inside a cockpit tab: the tab bar is the header and the legend.
  embedded?: boolean
  entries: readonly FlowEntry[]
  filter: FlowFilter
  showProgress: boolean
  selected?: number
  // The turn in progress (register.ts noteStep): drawn under its prompt.
  live?: LiveTurn | null
  now?: number
  // Each turn's whole answer by turn id: what a selected entry opens.
  answers?: Readonly<Record<string, string>>
  width: number
  onFilter: (f: FlowFilter) => void
  onToggleProgress: () => void
  onSelect: (i: number) => void
  onAsk: (text: string) => void
  onCopy: (text: string) => void
}

const KEEP: Record<FlowFilter, ReadonlySet<FlowKind>> = {
  all: new Set(['prompt', 'conclusion', 'decision', 'finding', 'background', 'progress']),
  conclusions: new Set(['prompt', 'conclusion']),
  decisions: new Set(['prompt', 'decision', 'finding']),
  agents: new Set(['prompt', 'conclusion', 'decision', 'finding']),
}

// Glyph color per kind; the text itself stays normal except where noted.
const TONE: Record<FlowKind, string> = {
  prompt: C.accent,
  conclusion: C.ok,
  decision: C.warn,
  finding: C.merged,
  background: C.muted,
  progress: C.faint,
}

const LABEL: Partial<Record<FlowKind, string>> = { decision: 'decision', finding: 'finding' }

// "§ 원인 확인 결과 — body": draw the heading bold and drop the § marker,
// which is only how paragraphs() remembers a line was a heading.
function headed(els: Els, text: string, kind: FlowKind): Node[] {
  const { Text } = els
  const color = kind === 'background' ? C.muted : kind === 'progress' ? C.faint : undefined
  const bare = text.replace(/^§ /, '')
  if (!text.startsWith('§ ')) return [Text({ bold: kind === 'conclusion', color, children: [bare] })]
  const cut = bare.indexOf(' — ')
  if (cut < 0) return [Text({ bold: true, color, children: [bare] })]
  return [Text({ bold: true, color, children: [bare.slice(0, cut)] }), Text({ color, children: [bare.slice(cut)] })]
}

export type LiveTurn = { turnId: string; steps: number; tools: Record<string, number>; text?: string; lastTools?: string[]; at: number }

// Entries under the turn they belong to: a background agent or a Workflow run
// that finishes after the next prompt still lands under the turn that started
// it. Agents: only what subagents said, with their turns' prompts.
export function visibleFlow(entries: readonly FlowEntry[], filter: FlowFilter, showProgress: boolean): FlowEntry[] {
  const order = new Map<string, number>()
  entries.forEach((e, i) => {
    if (e.kind === 'prompt' && !order.has(e.turnId)) order.set(e.turnId, i)
  })
  const byAgent = new Set(entries.filter((e) => e.by).map((e) => e.turnId))
  return entries
    .map((e, i) => ({ e, i, t: order.get(e.turnId) ?? i }))
    .filter(({ e }) => KEEP[filter].has(e.kind) && (showProgress || e.kind !== 'progress'))
    .filter(({ e }) => filter !== 'agents' || !!e.by || (e.kind === 'prompt' && byAgent.has(e.turnId)))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ e }) => e)
}

export function renderFlow(els: Els, v: FlowView): Node {
  const { Text, Button, Box, Markdown } = els
  const list = visibleFlow(v.entries, v.filter, v.showProgress)
  const turns = new Set(v.entries.filter((e) => e.kind === 'prompt').map((e) => e.turnId)).size
  const decisions = v.entries.filter((e) => e.kind === 'decision' || e.kind === 'finding').length
  const top = v.embedded ? undefined : header(els, 'flow', turns + ' requests · ' + decisions + ' decisions/findings', v.width)
  const tabs = tabRow(
    els,
    [
      { id: 'all', label: 'All', hotkey: 'a' },
      { id: 'conclusions', label: 'Conclusions', hotkey: 'c' },
      { id: 'decisions', label: 'Decisions', hotkey: 'd' },
      { id: 'agents', label: 'Agents', hotkey: 'g' },
    ],
    v.filter,
    (id) => v.onFilter(id as FlowFilter),
  )
  if (list.length === 0) return col(els, [...(top ? [top] : []), tabs, empty(els, 'No flow yet.', 'Each finished turn adds its request and conclusion here.')])

  const rows: Node[] = []
  list.forEach((e, i) => {
    const sel = v.selected === i
    const isPrompt = e.kind === 'prompt'
    // Cells left after this row's prefix: "HH:MM  ❯ " for a request, the
    // 7-cell indent + glyph + optional label for the rest. Clipping to a fixed
    // width wrapped every row that carried a 판단/발견 label.
    // A subagent's entry: who said it, indented one step further.
    const who = e.by ? '⤷ ' + clip(e.by, 24) + (e.run ? ' · ' + clip(e.run, 16) : '') + ' ' : ''
    const prefix = isPrompt ? 9 : 7 + (e.by ? 2 : 0) + 2 + (LABEL[e.kind] ? width(LABEL[e.kind]!) + 1 : 0) + width(who)
    // One line per row; the selected entry's full text is drawn under it.
    const text = sel && isPrompt ? e.text : clip(e.text.replace(/\s*\n\s*/g, ' '), Math.max(20, v.width - prefix - 1))
    if (isPrompt) {
      rows.push(
        Box({
          marginTop: rows.length ? 1 : 0,
          children: [
            Button({
              key: 'flow-' + i,
              label: e.text,
              plain: true,
              onPress: () => v.onSelect(i),
              children: [Text({ color: C.muted, children: [hhmm(e.at) + '  '] }), Text({ bold: true, color: C.accent, children: ['❯ ' + text] })],
            }),
          ],
        }),
      )
    } else {
      const tag = LABEL[e.kind]
      rows.push(
        Box({
          paddingLeft: e.by ? 9 : 7,
          children: [
            Button({
              key: 'flow-' + i,
              label: e.text,
              plain: true,
              onPress: () => v.onSelect(i),
              children: [
                ...(who ? [Text({ color: C.faint, children: [who] })] : []),
                Text({ color: TONE[e.kind], bold: e.kind === 'conclusion' && !e.by, children: [FLOW_ICON[e.kind] + ' '] }),
                ...(tag ? [Text({ color: TONE[e.kind], children: [tag + ' '] })] : []),
                ...headed(els, text, e.kind),
              ],
            }),
          ],
        }),
      )
    }
    // A selected entry opens its turn's whole answer as Markdown: the rows keep
    // only paragraphs (tables and code are left out, ten per turn at most), so
    // the paragraph alone was all a press could ever show.
    // A subagent's entry opens its own paragraph, not the main answer.
    const whole = !isPrompt ? (e.by ? e.text : (v.answers?.[e.turnId] ?? e.text)) : undefined
    if (sel) {
      if (whole !== undefined && (whole !== e.text || e.text.length > Math.max(20, v.width - prefix - 1) || e.text.includes('\n'))) {
        rows.push(Box({ paddingLeft: 9, marginTop: 1, children: [Text({ color: C.faint, children: [whole !== e.text ? '— whole answer —' : '— whole paragraph —'] })] }))
        rows.push(Box({ paddingLeft: 9, children: [Markdown({ key: 'flow-full-' + i, text: whole })] }))
      }
      rows.push(
        Box({
          paddingLeft: 9,
          children: [
            row(els, [
              Button({ key: 'flow-ask', label: 'ask in side', onPress: () => v.onAsk(e.text) }),
              Button({ key: 'flow-copy', label: whole !== undefined && whole !== e.text ? 'copy answer' : 'copy', onPress: () => v.onCopy(whole ?? e.text) }),
            ], 2),
          ],
        }),
      )
    }
  })
  // The running turn, under the newest prompt: its step count, the tools it
  // has called, and what it said last.
  if (v.live) {
    const l = v.live
    const tools = Object.entries(l.tools).sort((a, b) => b[1] - a[1]).map(([t, n]) => t.replace(/^mcp__\w+?__/, '') + (n > 1 ? ' ×' + n : '')).join(' · ')
    const age = v.now ? Math.max(0, Math.round((v.now - l.at) / 1000)) : 0
    rows.push(
      Box({
        paddingLeft: 7,
        flexDirection: 'column',
        children: [
          Text({ color: C.warn, children: ['⏳ working · step ' + l.steps + (tools ? ' · ' + clip(tools, Math.max(20, v.width - 30)) : '') + (age > 5 ? ' · ' + age + 's ago' : '')] }),
          ...(l.text ? [Box({ paddingLeft: 2, children: [Text({ color: C.muted, wrap: 'wrap', children: [clip(l.text.replace(/\s*\n\s*/g, ' '), Math.max(80, (v.width - 12) * 3))] })] })] : []),
        ],
      }),
    )
  }
  const progress = v.entries.filter((e) => e.kind === 'progress').length
  return col(els, [
    ...(top ? [top] : []),
    tabs,
    Text({ children: [''] }),
    ...rows,
    row(els, [
      Button({ key: 'flow-progress', label: v.showProgress ? 'hide progress' : 'show progress', hotkey: 'p', plain: true, onPress: v.onToggleProgress, children: [Text({ color: C.muted, children: [(v.showProgress ? 'hide progress' : 'show ' + progress + ' progress lines')] })] }),
    ]),
    ...(v.embedded
      ? []
      : [
          keys(els, [
      ['a/c/d', 'filter'],
      ['Enter', 'expand'],
      ['p', 'progress'],
      ['Esc', 'close'],
          ]),
        ]),
  ])
}
