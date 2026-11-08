// The cockpit's Coord tab: the decisions briefs wait on, as text. The person
// answers them in the office's 지휘 view (or tells the coordinator); this tab
// only says what waits, so a terminal-only session sees it too.

import type { Decision } from '../lib/coord'
import { clip } from '../lib/text'
import { C, empty, section, type Els, type Node } from './common'

export type CoordTabView = {
  width: number
  items: readonly Decision[]
  note?: string
  onRefresh: () => void
}

export function renderCoordTab(els: Els, v: CoordTabView): Node {
  const { Box, Button, Text } = els
  const w = Math.max(30, v.width - 4)
  const rows: Node[] = [section(els, 'Decisions waiting', v.items.length + ' · oldest first')]
  if (v.note) rows.push(Text({ color: C.bad, children: [v.note] }))
  if (!v.items.length && !v.note) rows.push(empty(els, 'No brief waits on a decision.', 'A coordinator asks with `brief ask <brief>`.'))
  for (const d of v.items) {
    rows.push(
      Box({
        flexDirection: 'column',
        marginTop: 1,
        children: [
          Text({ bold: true, children: [clip('⏳ ' + d.title, w)] }),
          Text({ children: [clip('  ' + d.question, w)] }),
          ...d.options.map((o, i) => Text({ color: i === d.recommended ? C.ok : undefined, children: [clip('  ' + (i + 1) + '. ' + (i === d.recommended ? '★ ' : '') + o.label + (o.detail ? ' — ' + o.detail : ''), w)] })),
          Text({ color: C.muted, children: [clip('  ' + [d.coordinator ? '→ ' + d.coordinator : '', d.worker ? 'worker ' + d.worker : '', d.asked ?? '', d.file].filter(Boolean).join(' · '), w)] }),
        ],
      }),
    )
  }
  rows.push(Box({ marginTop: 1, flexDirection: 'row', columnGap: 2, children: [Text({ color: C.muted, children: ['Answer in /office → 🎖 지휘 (D), or tell the coordinator.'] }), Button({ key: 'coord-refresh', label: 'refresh', hotkey: 'r', plain: true, onPress: v.onRefresh, children: [Text({ color: C.muted, children: ['⟳ refresh'] })] })] }))
  return Box({ flexDirection: 'column', children: rows })
}
