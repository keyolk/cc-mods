// The quick-access palette drawn over the cockpit body, and the catch-all
// hotkeys that keep stray letters in the cockpit (lib/palette.ts).

import { filterPalette, type PaletteItem, type PaletteState } from '../lib/palette'
import { clip } from '../lib/text'
import { C, type Els, type Node } from './common'

// Every key a Button hotkey can take. The engine gives a focused pane's
// unclaimed printable keys to the prompt, which then takes the keyboard;
// a hotkey is the one thing that claims a printable key in a pane. These are
// drawn first so the cockpit's own hotkeys, drawn later, win their keys.
export const CATCH_KEYS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')

// The chord that opens and closes the palette, wherever the cockpit's focus
// is (its query field included, where a letter hotkey cannot reach). A Button
// presses on an engine action's chord; settings:search has no handler while
// the cockpit is up, and ~/.claude/keybindings.json binds alt+s to it in
// Pane and PaneField.
export const PALETTE_ACTION = 'settings:search'

// alt+<letter> relays: Korean input turns a bare letter into Hangul, so each
// cockpit hotkey letter is also reachable as alt+<letter> (Ghostty sends alt
// by physical key, ~/.config/ghostty/config). A Button presses on an engine
// action's chord, not on a key, so each letter borrows an action no cockpit
// screen handles; ~/.claude/keybindings.json binds alt+<letter> to it in Pane.
// Not c (leaves), s (palette) or h/j/k/l (tmux takes M-h..M-l). k: alt+s.
export const ALT_ACTIONS: Record<string, string> = {
  a: 'theme:editCustom',
  b: 'theme:toggleSyntaxHighlighting',
  d: 'plugin:cycleMarketplace',
  e: 'plugin:favorite',
  f: 'plugin:install',
  g: 'plugin:toggle',
  i: 'settings:periodDay',
  m: 'settings:periodWeek',
  n: 'settings:retry',
  o: 'settings:sortByTokens',
  p: 'modelPicker:decreaseEffort',
  q: 'modelPicker:increaseEffort',
  r: 'modelPicker:thisSessionOnly',
  t: 'effortSlider:decreaseEffort',
  u: 'effortSlider:increaseEffort',
  v: 'effortSlider:thisSessionOnly',
  w: 'effortSlider:toggleUltracode',
  x: 'agents:rename',
  y: 'agents:togglePin',
  z: 'historySearch:cycleScope',
}

// alt+c from the prompt: Global binds it to this borrowed action (a Chat
// binding to another context's action never dispatches: measured), Pane and
// the band rebind it to abovePrompt:leave, and a Button carrying it — the cockpit's while it is
// open, the band's while it is not — focuses the cockpit, opening it first.
// abovePrompt:focus did nothing with no pane open, and with a band button up
// it picked the band.
export const COCKPIT_ACTION = 'agents:setGroup'

// alt+← / alt+→ from the prompt: widen / narrow the cockpit (register.ts
// resizeFromPrompt). Global binds them to these borrowed actions; inside the
// cockpit Pane binds the same chords to the engine's pane:grow / pane:shrink.
export const GROW_ACTION = 'agents:previousGroup'
export const SHRINK_ACTION = 'agents:nextGroup'

// alt+/ (the ? key with alt) opens the key help. A bare `?` cannot: a hotkey
// takes only a-z and 0-9, and an action Button presses only on a chord or a
// modified key, so a bare `?` falls through to the prompt and opens Claude
// Code's own help. ~/.claude/keybindings.json binds alt+/ to this borrowed
// action in Pane and PaneField.
export const HELP_ACTION = 'agents:find'
// alt+w toggles the Web tab's keyboard between cockpit controls and the TWeb
// page. Borrowed: no cockpit screen handles agents:switchView.
export const WEB_KEYBOARD_ACTION = 'agents:switchView'
// Esc, on a cockpit screen. The engine handles Escape itself and raises no
// hook event for it (measured: no ui.focus, ui.close or ui.scroll), so a
// Client in Page mode could never see it. ~/.claude/keybindings.json binds
// escape in Pane and PaneField to this borrowed action; the hidden Button
// sends 1b to TWeb in Page mode and otherwise does what Esc did (move the ring
// to the element before).
export const ESCAPE_ACTION = 'tabs:next'

export function catchAll(els: Els, onKey: (key: string) => void, onToggle: () => void, letters = true, onAlt?: (key: string) => void, onCockpit?: () => void, onHelp?: () => void, onResize?: (dir: 'grow' | 'shrink') => void, onWebKeyboard?: () => void, onEscape?: () => void): Node {
  const { Box, Button, Text } = els
  return Box({
    display: 'none',
    children: [
      ...(letters ? CATCH_KEYS : []).map((k) => Button({ key: 'catch-' + k, label: k, hotkey: k, plain: true, onPress: () => onKey(k), children: [Text({ children: [k] })] })),
      Button({ key: 'palette-toggle', label: 'search', action: PALETTE_ACTION, plain: true, onPress: onToggle, children: [Text({ children: ['search'] })] }),
      ...(onHelp ? [Button({ key: 'hk-help', label: 'keys', action: HELP_ACTION, plain: true, onPress: onHelp, children: [Text({ children: ['?'] })] })] : []),
      ...(onEscape ? [Button({ key: 'hk-escape', label: 'escape', action: ESCAPE_ACTION, plain: true, onPress: onEscape, children: [Text({ children: ['escape'] })] })] : []),
      ...(onWebKeyboard ? [Button({ key: 'hk-web-keyboard', label: 'web keyboard', action: WEB_KEYBOARD_ACTION, plain: true, onPress: onWebKeyboard, children: [Text({ children: ['web keyboard'] })] })] : []),
      ...(onResize
        ? [
            Button({ key: 'hk-grow', label: 'wider', action: GROW_ACTION, plain: true, onPress: () => onResize('grow'), children: [Text({ children: ['wider'] })] }),
            Button({ key: 'hk-shrink', label: 'narrower', action: SHRINK_ACTION, plain: true, onPress: () => onResize('shrink'), children: [Text({ children: ['narrower'] })] }),
          ]
        : []),
      ...(onCockpit ? [Button({ key: 'hk-cockpit-focus', label: 'cockpit', action: COCKPIT_ACTION, plain: true, onPress: onCockpit, children: [Text({ children: ['cockpit'] })] })] : []),
      ...(onAlt ? Object.entries(ALT_ACTIONS).map(([k, action]) => Button({ key: 'alt-' + k, label: 'alt+' + k, action, plain: true, onPress: () => onAlt(k), children: [Text({ children: ['alt+' + k] })] })) : []),
    ],
  })
}

// The key of the element right after the query field: the first result, or
// the close row when nothing matches. An arrow from the field moves the focus
// ring there (down) or to anything else (up); register.ts reads that to move
// the selection instead (see its ui.focus hook).
export function paletteNextKey(items: readonly PaletteItem[], query: string): string {
  const first = filterPalette(items, query)[0]
  return first ? 'palette-' + first.id : 'palette-close'
}

export function renderPalette(
  els: Els,
  v: { state: PaletteState; items: readonly PaletteItem[]; width: number; onQuery: (q: string) => void; onRun: (item: PaletteItem) => void; onClose: () => void },
): Node {
  const { Box, Button, Input, Text } = els
  const shown = filterPalette(v.items, v.state.query)
  const sel = Math.min(v.state.sel, Math.max(0, shown.length - 1))
  const w = Math.max(30, v.width - 6)
  return Box({
    key: 'palette',
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: C.accent,
    paddingX: 1,
    children: [
      Input({
        key: 'palette-query',
        label: '⌘',
        placeholder: 'search settings and actions · ↑↓ pick · Enter runs · Esc closes',
        value: v.state.query,
        autoFocus: true,
        submitLabel: 'run',
        onInput: (q) => v.onQuery(q),
        onSubmit: () => {
          const item = shown[sel]
          if (item) v.onRun(item)
        },
      }),
      ...(shown.length
        ? shown.map((item, i) =>
            Button({
              key: 'palette-' + item.id,
              label: item.title,
              plain: true,
              onPress: () => v.onRun(item),
              children: [
                Text({ color: i === sel ? C.accent : C.muted, children: [(i === sel ? '› ' : '  ') + item.group.padEnd(8)] }),
                Text({ bold: i === sel, children: [clip(item.title, Math.max(10, w - 30))] }),
                Text({ color: C.faint, children: [item.hint ? '  ' + clip(item.hint, 18) : ''] }),
              ],
            }),
          )
        : [Text({ color: C.muted, children: ['  nothing matches "' + clip(v.state.query, 40) + '"'] })]),
      Button({ key: 'palette-close', label: 'close', plain: true, onPress: v.onClose, children: [Text({ color: C.faint, children: ['  ↑↓ pick · Enter runs · Esc / alt+s / ✕ close'] })] }),
    ],
  })
}
