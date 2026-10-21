// /side: questions about the main conversation that never enter it.
//
// Answers come from $.model.fork, which replays the session's own transcript
// with the question appended, shares the main thread's prompt cache, and has
// no tools. Nothing from here is stored in the main transcript unless the
// person presses "send to main".

import { clip, hhmm, kTokens } from '../lib/text'
import { C, col, empty, field, header, keys, row, type Els, type Node } from './common'

export type SideQA = {
  id: number
  q: string
  a?: string
  at: number
  pending?: boolean
  error?: string
  tokens?: { input: number; output: number; cacheRead: number }
}

export type SideView = {
  // Drawn inside a cockpit tab: the tab bar is the header and the legend.
  embedded?: boolean
  items: readonly SideQA[]
  width: number
  onAsk: (q: string) => void
  onSend: (qa: SideQA) => void
  onFill: (qa: SideQA) => void
  onCopy: (qa: SideQA) => void
  onAgent: (qa: SideQA) => void
  onClear: () => void
  onFocusInput?: () => void // `i` in the Chat tab: the keyboard to the field
}

export function renderSide(els: Els, v: SideView): Node {
  const { Text, Input, Markdown, Button, Box } = els
  const total = v.items.reduce((n, x) => n + (x.tokens ? x.tokens.input + x.tokens.output : 0), 0)
  const top = v.embedded ? undefined : header(els, 'side', v.items.length ? v.items.length + ' questions · ' + kTokens(total) + ' tok' : 'questions that stay out of the main chat', v.width)
  const input = field(els, Input({
    key: 'side-input',
    label: 'ask',
    placeholder: 'ask without touching the main chat (Enter)',
    value: '',
    submitLabel: 'ask',
    // The side pane always lands here. The Chat tab does once a question has
    // been asked, so alt+c goes straight to asking the next one (Tab leaves).
    ...(!v.embedded || v.items.length ? { autoFocus: true as const } : {}),
    onSubmit: (value) => {
      if (value.trim()) v.onAsk(value.trim())
    },
  }))
  // `i` from anywhere in the Chat tab puts the keyboard in the field. Hidden
  // (inside display none: the cockpit skips it on Tab) and drawn after the letter
  // catchers, so it wins the key.
  const ask = v.embedded && v.onFocusInput
    ? [Box({ display: 'none', children: [Button({ key: 'hk-side-ask', label: 'ask', hotkey: 'i', plain: true, onPress: v.onFocusInput, children: [Text({ children: ['ask'] })] })] })]
    : []
  if (v.items.length === 0) {
    return col(els, [...ask, ...(top ? [top] : []), input, empty(els, 'Answers with the whole main chat as context.', 'No tools, nothing written to the main transcript; send an answer to the main chat if you want it there.')])
  }
  const blocks: Node[] = []
  // Embedded (the Chat tab): the field first and the newest answer under it,
  // so asking again never needs a scroll. The side pane keeps reading order.
  const shown = v.embedded ? v.items.slice(-3).reverse() : v.items.slice(-8)
  for (const qa of shown) {
    const tone = qa.error ? C.bad : qa.pending ? C.warn : C.accent
    const body: Node[] = [
      row(els, [Text({ color: C.muted, children: [hhmm(qa.at)] }), Text({ bold: true, color: C.accent, children: ['Q  ' + clip(qa.q, v.width * 2)] })], 2),
    ]
    if (qa.pending) body.push(Text({ color: C.warn, children: ['⏳ answering…'] }))
    else if (qa.error) body.push(Text({ color: C.bad, children: ['✗ ' + qa.error] }))
    else if (qa.a) {
      body.push(Box({ marginTop: 1, children: [Markdown({ key: 'side-a-' + qa.id, text: qa.a })] }))
      body.push(
        Box({
          marginTop: 1,
          children: [
            row(els, [
              Button({ key: 'side-send-' + qa.id, label: 'send to main', variant: 'primary', onPress: () => v.onSend(qa) }),
              Button({ key: 'side-fill-' + qa.id, label: 'fill prompt', onPress: () => v.onFill(qa) }),
              Button({ key: 'side-copy-' + qa.id, label: 'copy', onPress: () => v.onCopy(qa) }),
              Button({ key: 'side-agent-' + qa.id, label: 'redo as subagent', onPress: () => v.onAgent(qa) }),
              ...(qa.tokens ? [Text({ color: C.faint, children: [kTokens(qa.tokens.input + qa.tokens.output) + ' tok'] })] : []),
            ], 2),
          ],
        }),
      )
    }
    blocks.push(Box({ marginBottom: 1, borderStyle: 'quote', borderColor: tone, paddingLeft: 1, flexDirection: 'column', children: body }))
  }
  return col(els, [
    ...ask,
    ...(top ? [top] : []),
    ...(v.embedded ? [input, ...blocks] : [...blocks, input]),
    row(els, [
      Button({ key: 'side-clear', label: 'clear', plain: true, onPress: v.onClear, children: [Text({ color: C.muted, children: ['clear history'] })] }),
    ]),
    ...(v.embedded
      ? []
      : [
          keys(els, [
      ['Enter', 'ask'],
      ['Tab', 'buttons'],
      ['Esc', 'close'],
          ]),
        ]),
  ])
}
