// The key help drawn over the cockpit body (lib/help.ts), opened by alt+/.

import type { HelpSection } from '../lib/help'
import { clip } from '../lib/text'
import { C, type Els, type Node } from './common'

export function renderHelp(els: Els, v: { sections: readonly HelpSection[]; width: number; onClose: () => void }): Node {
  const { Box, Button, Text } = els
  const keyW = Math.min(20, Math.max(...v.sections.flatMap((s) => s.rows.map(([k]) => k.length))) + 2)
  const textW = Math.max(10, v.width - keyW - 8)
  return Box({
    key: 'help',
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: C.accent,
    paddingX: 1,
    children: [
      ...v.sections.flatMap((s, i) => [
        Text({ bold: true, color: C.accent, children: [(i ? '\n' : '') + s.title] }),
        ...s.rows.map(([k, what]) =>
          Box({ flexDirection: 'row', children: [Box({ width: keyW, flexShrink: 0, children: [Text({ bold: true, children: [k] })] }), Text({ color: C.muted, children: [clip(what, textW)] })] }),
        ),
      ]),
      // Focused when help opens: Esc (a move off it) or Enter closes.
      Button({ key: 'help-close', label: 'close', plain: true, onPress: v.onClose, children: [Text({ color: C.faint, children: ['\n  alt+/ / Esc / Enter close'] })] }),
    ],
  })
}
