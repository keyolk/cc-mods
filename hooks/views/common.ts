// Shared pieces for the cockpit panes. Views are pure: they get the element
// constructors from `$.ui.resolve(e)`, the data, and callbacks that
// register.ts builds (closures over `$`), and return a tree.
//
// Visual rules, so every pane reads the same way:
//   - Colors are theme keys, never raw names, so light and dark themes both
//     stay legible. Raw 'cyan'/'yellow' were unreadable on a light theme.
//   - Emphasis has three levels: normal text for what you came to read, `C.muted`
//     for metadata (times, counts, paths), dimColor only for truly folded
//     content. The first version dimmed nearly everything, so nothing stood out.
//   - Every pane opens with `header()`: a bold title, a one-line summary, a rule.
//   - Status is a colored glyph + word (`✓ 통과`), never color alone.

import type { Elements, RenderElement, RenderNode } from 'claude-code'
import { needsAttention, type PrStatus } from '../lib/prs'

export type Els = Elements['terminal'] & Partial<Elements['desktop']>
export type Node = RenderElement

export const C = {
  accent: 'suggestion',
  ok: 'success',
  warn: 'warning',
  bad: 'error',
  muted: 'subtle',
  faint: 'inactive',
  merged: 'merged',
  claude: 'claude',
} as const

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'accent'

export type Tab = { id: string; label: string; hotkey: string; count?: number }

export function header(els: Els, title: string, summary: string | undefined, width: number, right?: RenderNode): Node {
  const { Box, Text } = els
  return Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Text({ bold: true, color: C.claude, children: [title] }),
              ...(summary ? [Text({ color: C.muted, wrap: 'truncate-end', children: [summary] })] : []),
            ],
          }),
          right ?? Text({ children: [''] }),
        ],
      }),
      rule(els, width),
    ],
  })
}

// Tabs: the active one is bold, underlined and accent-colored; the others
// are plain muted text with their hotkey (the Button draws `a: ` itself), so the row reads at a glance and the
// counts never make the active tab look inactive.
export function tabRow(els: Els, tabs: readonly Tab[], active: string, onPick: (id: string) => void): Node {
  const { Box, Button, Text } = els
  return Box({
    flexDirection: 'row',
    columnGap: 2,
    flexWrap: 'wrap',
    children: tabs.map((t) => {
      const on = t.id === active
      return Button({
        key: 'tab-' + t.id,
        label: t.label,
        hotkey: t.hotkey,
        plain: true,
        onPress: () => onPick(t.id),
        children: [
          Text({ bold: on, underline: on, color: on ? C.accent : C.muted, children: [t.label] }),
          ...(t.count ? [Text({ color: on ? C.accent : C.faint, children: [' ' + t.count] })] : []),
        ],
      })
    }),
  })
}

export function rule(els: Els, width: number): Node {
  return els.Text({ color: C.faint, children: ['─'.repeat(Math.max(4, Math.min(width, 200)))] })
}

export function section(els: Els, title: string, note?: string): Node {
  const { Box, Text } = els
  return Box({
    flexDirection: 'row',
    columnGap: 1,
    marginTop: 1,
    children: [Text({ bold: true, children: [title] }), ...(note ? [Text({ color: C.muted, children: [note] })] : [])],
  })
}

export function empty(els: Els, text: string, hint?: string): Node {
  const { Box, Text } = els
  return Box({
    flexDirection: 'column',
    paddingY: 1,
    children: [Text({ color: C.muted, children: [text] }), ...(hint ? [Text({ color: C.faint, children: [hint] })] : [])],
  })
}

export function chip(els: Els, text: string, tone: Tone, bold = false): Node {
  return els.Text({ color: C[tone], bold, children: [text] })
}

export function muted(els: Els, text: string): Node {
  return els.Text({ color: C.muted, wrap: 'truncate-end', children: [text] })
}

export function col(els: Els, children: RenderNode[], gap = 0): Node {
  return els.Box({ flexDirection: 'column', rowGap: gap, children })
}

export function row(els: Els, children: RenderNode[], gap = 1): Node {
  return els.Box({ flexDirection: 'row', columnGap: gap, children })
}

// A key legend for the bottom of a pane: `o 열기 · y 복사`.
export function keys(els: Els, items: readonly [string, string][]): Node {
  const { Box, Text } = els
  return Box({
    flexDirection: 'row',
    columnGap: 2,
    marginTop: 1,
    flexWrap: 'wrap',
    children: items.map(([k, label]) => Text({ color: C.faint, children: [k + ' ' + label] })),
  })
}

// A text field drawn so it reads as a place to type: a rounded accent border
// around the Input. A bare Input is one line of label and dim placeholder that
// looks like any other text, so people missed where they could type.
export function field(els: Els, input: Node, grow = false): Node {
  return els.Box({ borderStyle: 'round', borderColor: C.accent, paddingX: 1, ...(grow ? { flexGrow: 1, flexShrink: 1, width: 0 } : {}), children: [input] })
}

// One PR's color everywhere it is drawn: red when it is broken (checks,
// conflict), amber when it waits on someone (policy approval, threads, base,
// review), green when it can merge.
export function prTone(pr: PrStatus): string {
  if (pr.state === 'MERGED') return C.merged
  const need = needsAttention(pr)
  if (need === 'fail' || need === 'conflict') return C.bad
  if (need === 'policy' || need === 'threads' || need === 'behind' || need === 'review') return C.warn
  return need === 'ready' ? C.ok : C.muted
}
