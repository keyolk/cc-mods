// /graph: the requests of this session and the subagents, background tasks
// and forks each one started, as a tree or a timeline.

import type { AgentNode, TurnRecord } from '../lib/record'
import { clip, duration, hhmm, kTokens, pad } from '../lib/text'
import { C, col, empty, header, keys, row, tabRow, type Els, type Node } from './common'

export type GraphMode = 'tree' | 'timeline'

export type GraphView = {
  // Drawn inside a cockpit tab: the tab bar is the header and the legend.
  embedded?: boolean
  turns: readonly TurnRecord[]
  agents: readonly AgentNode[]
  mode: GraphMode
  now: number
  width: number
  selected?: string
  collapsedDone: boolean
  onMode: (m: GraphMode) => void
  onSelect: (id: string) => void
  onToggleCollapsed: () => void
  onCopyMermaid: () => void
}

const ICON: Record<AgentNode['status'], string> = {
  running: '⏳',
  background: '⏳',
  completed: '✅',
  failed: '❌',
  killed: '⨯',
}

const KIND: Record<AgentNode['kind'], string> = { agent: '●', bg: '⚙', workflow: '◇', fork: '⑂' }

const TONE: Record<AgentNode['status'], string> = {
  running: C.warn,
  background: C.warn,
  completed: C.ok,
  failed: C.bad,
  killed: C.muted,
}

export function childrenOf(agents: readonly AgentNode[], parent: string | undefined, turnId: string): AgentNode[] {
  return agents
    .filter((a) => (parent ? a.parentId === parent : !a.parentId && a.turnId === turnId))
    .sort((a, b) => a.startedAt - b.startedAt)
}

function nodeParts(els: Els, a: AgentNode, now: number, width: number, on: boolean): Node[] {
  const { Text } = els
  const took = duration((a.endedAt ?? now) - a.startedAt)
  const meta = [took, a.tokens ? kTokens(a.tokens) + ' tok' : '', a.tools ? a.tools + ' tools' : ''].filter(Boolean).join(' · ')
  return [
    Text({ color: TONE[a.status], children: [ICON[a.status] + ' '] }),
    Text({ color: C.muted, children: [KIND[a.kind] + ' ' + clip(a.type, 14) + '  '] }),
    Text({ bold: on || a.status === 'running' || a.status === 'failed', children: [clip(a.description, Math.max(12, width - 46))] }),
    Text({ color: C.faint, children: ['  ' + meta] }),
  ]
}

export function renderGraph(els: Els, v: GraphView): Node {
  const { Text, Button } = els
  const running = v.agents.filter((a) => a.status === 'running' || a.status === 'background').length
  const failed = v.agents.filter((a) => a.status === 'failed').length
  const summary =
    v.turns.length + ' requests · agent ' + v.agents.filter((a) => a.kind === 'agent').length + ' · bg ' + v.agents.filter((a) => a.kind === 'bg').length +
    (running ? ' · running ' + running : '') + (failed ? ' · failed ' + failed : '')
  const top = v.embedded ? undefined : header(els, 'graph', summary, v.width)
  const tabs = tabRow(
    els,
    [
      { id: 'tree', label: 'Tree', hotkey: 't' },
      { id: 'timeline', label: 'Timeline', hotkey: 'l' },
    ],
    v.mode,
    (id) => v.onMode(id as GraphMode),
  )
  if (v.turns.length === 0) return col(els, [...(top ? [top] : []), tabs, empty(els, 'No requests recorded yet.', 'Subagents, background tasks and Monitors are drawn here per request.')])

  const body = v.mode === 'tree' ? tree(els, v) : timeline(els, v)
  const sel = v.selected ? v.agents.find((a) => a.id === v.selected) : undefined
  const detail = sel
    ? els.Box({
        marginTop: 1,
        borderStyle: 'round',
        borderColor: TONE[sel.status],
        paddingX: 1,
        flexDirection: 'column',
        children: [
          Text({ bold: true, children: [ICON[sel.status] + ' ' + sel.type + ' · ' + sel.description] }),
          Text({ color: C.muted, children: ['prompt'] }),
          Text({ children: [clip(sel.prompt, 600)] }),
          ...(sel.answer ? [Text({ color: C.muted, children: ['result'] }), Text({ children: [clip(sel.answer, 800)] })] : []),
        ],
      })
    : Text({ children: [''] })
  return col(els, [
    ...(top ? [top] : []),
    tabs,
    Text({ children: [''] }),
    body,
    detail,
    row(els, [
      Button({ key: 'graph-collapse', label: v.collapsedDone ? 'expand finished' : 'collapse finished', hotkey: 'f', plain: true, onPress: v.onToggleCollapsed, children: [Text({ color: C.muted, children: [v.collapsedDone ? 'expand finished' : 'collapse finished'] })] }),
      Button({ key: 'graph-mermaid', label: 'copy Mermaid', hotkey: 'm', plain: true, onPress: v.onCopyMermaid, children: [Text({ color: C.muted, children: ['copy Mermaid'] })] }),
    ], 3),
    ...(v.embedded
      ? []
      : [
          keys(els, [
      ['t/l', 'view'],
      ['Enter', 'details'],
      ['f', 'collapse'],
      ['m', 'Mermaid'],
      ['Esc', 'close'],
          ]),
        ]),
  ])
}

function tree(els: Els, v: GraphView): Node {
  const { Text, Button } = els
  const rows: Node[] = []
  const walk = (a: AgentNode, depth: number, last: boolean) => {
    rows.push(
      row(els, [
        Text({ color: C.faint, children: ['       ' + '   '.repeat(Math.max(0, depth - 1)) + (last ? '└─ ' : '├─ ')] }),
        Button({ key: 'node-' + a.id, label: a.description, plain: true, onPress: () => v.onSelect(a.id), children: nodeParts(els, a, v.now, v.width - depth * 3, v.selected === a.id) }),
      ], 0),
    )
    const kids = childrenOf(v.agents, a.id, a.turnId ?? '')
    kids.forEach((k, i) => walk(k, depth + 1, i === kids.length - 1))
  }
  for (const t of v.turns) {
    const kids = childrenOf(v.agents, undefined, t.turnId)
    const done = !!t.endedAt && kids.every((k) => k.status !== 'running' && k.status !== 'background')
    const toolSum = Object.entries(t.tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => k.replace(/^mcp__[^_]+(_[^_]+)*__/, '') + '×' + n)
      .join(' ')
    rows.push(
      row(els, [Text({ color: C.muted, children: [hhmm(t.at)] }), Text({ bold: true, color: C.accent, children: ['❯ ' + clip(t.text, Math.max(20, v.width - 20))] })], 2),
    )
    if (v.collapsedDone && done && !kids.some((k) => k.status === 'failed')) {
      if (kids.length || toolSum) rows.push(Text({ color: C.muted, children: ['       ✓ ' + (toolSum || 'no tools') + (kids.length ? '  · agent ' + kids.length + ' (f to expand)' : '')] }))
      continue
    }
    rows.push(Text({ color: C.muted, children: ['       ◆ main' + (toolSum ? '  ' + toolSum : '')] }))
    kids.forEach((k, i) => walk(k, 1, i === kids.length - 1))
  }
  return col(els, rows)
}

// One bar per node on a shared time axis, so parallel work shows as overlap
// and serial waiting shows as gaps.
export function timelineBars(agents: readonly AgentNode[], now: number, cols: number): { a: AgentNode; bar: string }[] {
  if (agents.length === 0) return []
  const t0 = Math.min(...agents.map((a) => a.startedAt))
  const t1 = Math.max(now, ...agents.map((a) => a.endedAt ?? now))
  const span = Math.max(1, t1 - t0)
  return agents
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((a) => {
      const s = Math.floor(((a.startedAt - t0) / span) * cols)
      const e = Math.max(s + 1, Math.ceil((((a.endedAt ?? now) - t0) / span) * cols))
      const ch = a.status === 'failed' ? '▒' : a.status === 'running' || a.status === 'background' ? '▓' : '█'
      return { a, bar: ' '.repeat(s) + ch.repeat(e - s) + ' '.repeat(Math.max(0, cols - e)) }
    })
}

function timeline(els: Els, v: GraphView): Node {
  const { Text } = els
  const cols = Math.max(20, Math.min(120, v.width - 34))
  const bars = timelineBars(v.agents, v.now, cols)
  if (bars.length === 0) return empty(els, 'No agents or background tasks in this session.')
  return col(
    els,
    bars.map(({ a, bar }) =>
      row(els, [
        Text({ color: TONE[a.status], children: [ICON[a.status] + ' '] }),
        Text({ children: [pad(KIND[a.kind] + ' ' + clip(a.description, 26), 29)] }),
        Text({ color: TONE[a.status], children: [bar] }),
      ], 1),
    ),
  )
}

export function mermaid(turns: readonly TurnRecord[], agents: readonly AgentNode[]): string {
  const id = (s: string) => 'n' + s.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)
  const esc = (s: string) => clip(s, 40).replace(/"/g, "'")
  const lines = ['flowchart TD']
  for (const t of turns) {
    lines.push(`  ${id(t.turnId)}["❯ ${esc(t.text)}"]`)
    for (const a of agents.filter((x) => !x.parentId && x.turnId === t.turnId)) lines.push(`  ${id(t.turnId)} --> ${id(a.id)}["${a.type}: ${esc(a.description)}"]`)
  }
  for (const a of agents.filter((x) => x.parentId)) lines.push(`  ${id(a.parentId!)} --> ${id(a.id)}["${a.type}: ${esc(a.description)}"]`)
  return lines.join('\n')
}
