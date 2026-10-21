// The cockpit's Web tab: one address field with keyboard-context, settings and
// settings and close beside them, and the region the TWeb page is drawn over
// (views/web-region.ts). TWeb draws its own title, URL and history controls,
// so the tab does not repeat them.

import { WEB_ENGINES, WEB_ENGINE_LABEL, type UrlPick, type WebEngine } from '../lib/web'
import type { WebState } from '../lib/web'
import { clip } from '../lib/text'
import { C, field, type Els, type Node } from './common'

export type WebView = {
  width: number
  rows: number // the region's height in cells
  web: WebState
  embed: boolean // userConfig.browserEmbed
  target: string // what tmux-chrome resolves for this pane
  onCmd: (argv: string[]) => void
  floating?: boolean // the page shows as an OS window (TWeb float), not in the pane
  onClose: () => void
  onOpen: (text: string) => void // the address field's Enter
  settings: WebSettings
  onSettings: (patch: Partial<WebSettings> & { open?: boolean }) => void
  onDevtools: () => void
  keyboard: 'controls' | 'page' // which keyboard context owns keys now
  onPageKeyboard: () => void // alt+w / button: synthesize a page click
  onControlsKeyboard: () => void // alt+w / button: focus the controls
  // The go field's picker: open while the field (or a pick) holds the ring,
  // the session's URLs narrowed by what is typed (lib/web.ts urlPicks).
  picks?: readonly UrlPick[]
  pickOpen?: boolean
  pickFolded?: boolean // the person folded the list: one line with a count
  onPickFold?: () => void
  onAddress?: (value: string) => void // the go field changed
}

const PICK_GLYPH: Record<string, string> = { pr: '⇄', artifact: '◰', ticket: '◇', slack: '#', link: '↗' }

// Rows the picker takes when open with `n` picks: one per pick and a hint.
export function pickRows(n: number, folded = false): number {
  return n ? (folded ? 1 : n + 1) : 0
}

// What each engine is for, under the engine pick.
export const ENGINE_NOTE = 'Chrome: your managed Chrome (Okta device trust, extensions) · WebKit: macOS WebKit (Safari)'

export type WebSettings = {
  open: boolean // the settings rows are shown
  engine: WebEngine // what /web and links open in this session
  device: string // '' for the pane's own viewport, else a tweb device name
  rate: number // most frames a second
}

export const WEB_DEVICES = ['', 'iPhone 12', 'iPad', 'Pixel 5'] as const
export const WEB_RATES = [15, 30, 60] as const
// Rows the settings take while open: engine, device, frame rate, DevTools.
export const WEB_SETTINGS_ROWS = 4

export function renderWeb(els: Els, v: WebView): Node {
  const { Box, Button, Input, Text } = els
  // The address field: a URL, a host, or words to search; Enter opens it here.
  const address = Input({
    key: 'web-address',
    label: 'go',
    // Clipped: a placeholder longer than the half-width field wraps it onto a
    // second line and the two fields stop lining up.
    placeholder: v.web.running ? clip(v.web.url ?? '', Math.max(10, Math.floor(v.width / 2) - 14)) : 'URL, host or search — Enter opens it here',
    value: '',
    submitLabel: 'open',
    // With no page the field is all the tab offers: the keyboard lands on it.
    ...(v.web.running ? {} : { autoFocus: true as const }),
    onInput: (value) => v.onAddress?.(value),
    onSubmit: (value) => {
      if (value.trim()) v.onOpen(value)
    },
  })
  // URLs from this session, one press to open; typing in the field narrows them.
  const picker = v.pickOpen && v.picks?.length
    ? [
        Box({
          flexDirection: 'column',
          paddingX: 1,
          children: [
            Button({
              key: 'web-pick-fold',
              label: v.pickFolded ? 'show the session URLs' : 'fold the list',
              plain: true,
              onPress: () => v.onPickFold?.(),
              children: [Text({ color: C.faint, children: [(v.pickFolded ? '▸ ' + v.picks.length + ' URLs from this session' : '▾ from this session · ↓ to pick, or type to narrow / enter a URL')] })],
            }),
            ...(v.pickFolded ? [] : v.picks).map((p, i) =>
              Button({
                key: 'web-pick-' + i,
                label: p.url,
                plain: true,
                onPress: () => v.onOpen(p.url),
                children: [Text({ color: C.accent, children: [(PICK_GLYPH[p.kind] ?? '↗') + ' '] }), Text({ children: [clip(p.title, 40) + '  '] }), Text({ color: C.muted, children: [clip(p.url, Math.max(20, v.width - 50))] })],
              }),
            ),
          ],
        }),
      ]
    : []
  if (!v.web.running) {
    const why = !v.embed
      ? 'The Web tab is off (browserEmbed). Links open where /browser says.'
      : v.target === 'chrome'
        ? 'Links open in the Chrome tab group here. /browser tweb (or tweb-chrome, tweb-webkit) draws them in this tab.'
        : 'No page. /web <url> opens one here; links this session opens land here too.'
    return Box({ flexDirection: 'column', children: [field(els, address), ...picker, Box({ paddingX: 1, children: [Text({ color: C.muted, children: [v.web.error ? 'Browser stopped: ' + v.web.error : why] })] })] })
  }
  // This row is the anchor bin/cc-browser finds the page by (lib/web.ts
  // WEB_ANCHOR). The page starts below the address field's bottom border.
  return Box({
    flexDirection: 'column',
    children: [
      // Settings sit above the field row: the row is the page's anchor and
      // must stay directly over it.
      ...(v.settings.open ? settingsRows(els, v) : []),
      // The picker too: below the row it would sit under the page.
      ...picker,
      Box({
        flexDirection: 'row',
        alignItems: 'center',
        columnGap: 1,
        children: [
          field(els, address, true),
          Button({
            key: 'web-keyboard',
            label: v.keyboard === 'page' ? 'TWeb page keyboard' : 'cockpit controls keyboard',
            variant: v.keyboard === 'page' ? 'primary' : undefined,
            ...(v.keyboard === 'page' ? {} : { plain: true as const }),
            onPress: v.keyboard === 'page' ? v.onControlsKeyboard : v.onPageKeyboard,
            children: [Text({ color: v.keyboard === 'page' ? undefined : C.muted, bold: v.keyboard === 'page', children: [v.keyboard === 'page' ? '⌨ PAGE' : '⌘ CTRL'] })],
          }),
          Button({
            key: 'web-float',
            label: v.floating ? 'pin the page back into the pane' : 'float the page as a desktop window',
            plain: true,
            onPress: () => v.onCmd([v.floating ? 'pin' : 'float']),
            children: [Text({ color: v.floating ? C.accent : C.muted, children: [v.floating ? '⧉ pin' : '⧉ float'] })],
          }),
          Button({
            key: 'web-settings',
            label: 'settings',
            plain: true,
            onPress: () => v.onSettings({ open: !v.settings.open }),
            children: [Text({ color: v.settings.open ? C.accent : C.muted, children: ['⚙'] })],
          }),
          Button({ key: 'web-close', label: '✕', plain: true, onPress: () => v.onClose(), children: [Text({ color: C.accent, children: ['✕'] })] }),
        ],
      }),
      els.Client({
        key: 'web-region',
        module: './web-region.ts',
        props: { hint: v.web.shown ? '' : 'drawing the page…' },
        width: v.width,
        height: v.rows,
      }),
    ],
  })
}

// One row per setting; the picked value is marked. Engine and frame rate
// restart the page (same URL); device switches the running page in place.
function settingsRows(els: Els, v: WebView): Node[] {
  const { Box, Button, Text } = els
  const pick = (group: string, label: string, on: boolean, press: () => void) =>
    Button({ key: 'web-' + group + '-' + label, label, plain: true, onPress: press, children: [Text({ color: on ? C.accent : C.muted, bold: on, children: [(on ? '● ' : '○ ') + label] })] })
  const row = (name: string, items: Node[], note = '') =>
    Box({ flexDirection: 'row', columnGap: 2, children: [Text({ color: C.muted, children: [name.padEnd(8)] }), ...items, ...(note ? [Text({ color: C.faint, children: [note] })] : [])] })
  const s = v.settings
  const chrome = s.engine === 'chrome'
  return [
    row('engine', WEB_ENGINES.map((en) => pick('engine', WEB_ENGINE_LABEL[en], s.engine === en, () => v.onSettings({ engine: en }))), ENGINE_NOTE),
    row('device', WEB_DEVICES.map((d) => pick('device', d || 'Pane', s.device === d, () => v.onSettings({ device: d })))),
    row('fps', WEB_RATES.map((r) => pick('fps', String(r), s.rate === r, () => v.onSettings({ rate: r }))), 'drops to 4 at rest'),
    row('devtools', [
      chrome
        ? Button({ key: 'web-devtools', label: 'open DevTools', plain: true, onPress: v.onDevtools, children: [Text({ color: C.accent, children: ['open DevTools beside this pane'] })] })
        : Text({ color: C.faint, children: ['Chrome engine only'] }),
    ]),
  ]
}
